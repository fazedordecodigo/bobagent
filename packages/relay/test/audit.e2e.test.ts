import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type RelayFrame = {
  type?: string;
  requestId?: string;
  [key: string]: unknown;
};

type RelayLine = {
  event?: string;
  actor?: string;
  ip?: string;
  memberId?: string;
  fromMemberId?: string;
  reason?: string;
  route?: string;
  suppressed?: number;
  events?: Record<string, number>;
  [key: string]: unknown;
};

type Member = { id: string; name: string; token: string };

const SECRET_MARKER = "SECRET-MARKER-7f3a";
const AUDIT_LIMIT = 20;
let dataDir: string;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let stderrTask: Promise<void> | undefined;
let ws: WebSocket | undefined;
const stderrLines: string[] = [];

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function captureStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const complete = pending.split("\n");
    pending = complete.pop() ?? "";
    stderrLines.push(...complete.filter((line) => line.length > 0));
  }
  pending += decoder.decode();
  if (pending.length > 0) stderrLines.push(pending);
}

function parseLines(): RelayLine[] {
  return stderrLines.map((line) => JSON.parse(line) as RelayLine);
}

function actorLines(lines: RelayLine[], memberId: string): RelayLine[] {
  return lines.filter((line) => {
    if (
      ["relay.connected", "relay.disconnected", "relay.bad_message", "relay.send_error"].includes(
        String(line.event),
      )
    ) {
      return line.memberId === memberId;
    }
    return (
      ["relay.route_failed", "relay.reply_dropped"].includes(String(line.event)) &&
      line.fromMemberId === memberId
    );
  });
}

function nextFrame(
  socket: WebSocket,
  predicate: (frame: RelayFrame) => boolean,
  timeoutMs = 5000,
): Promise<RelayFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error("timed out waiting for websocket frame")),
      timeoutMs,
    );
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const finish = (error?: Error, frame?: RelayFrame) => {
      cleanup();
      if (error) reject(error);
      else if (frame) resolve(frame);
      else reject(new Error("websocket frame missing"));
    };
    const onMessage = (event: MessageEvent) => {
      let frame: RelayFrame;
      try {
        frame = JSON.parse(String(event.data)) as RelayFrame;
      } catch {
        return;
      }
      if (predicate(frame)) finish(undefined, frame);
    };
    const onError = () => finish(new Error("websocket errored before expected frame"));
    const onClose = () => finish(new Error("websocket closed before expected frame"));
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for relay audit summaries");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "upbot-relay-audit-cli-"));
});

afterAll(async () => {
  if (ws?.readyState === WebSocket.OPEN) ws.close();
  if (proc) {
    try {
      proc.kill();
    } catch {}
    await proc.exited;
    await stderrTask;
  }
  await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("CLI periodically reports quiet actors' suppressed audit events without logging secrets", async () => {
  const child = Bun.spawn(
    [
      "bun",
      join(import.meta.dir, "..", "src", "main.ts"),
      "--data",
      dataDir,
      "--port",
      "0",
      "--host",
      "127.0.0.1",
    ],
    {
      env: {
        ...process.env,
        RELAY_ADMIN_TOKEN: "admin-secret",
        RELAY_AUDIT_WINDOW_MS: "3000",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  proc = child;
  if (!child.stderr || typeof child.stderr === "number") {
    throw new Error("relay stderr pipe unavailable");
  }
  if (!child.stdout || typeof child.stdout === "number") {
    throw new Error("relay stdout pipe unavailable");
  }
  stderrTask = captureStderr(child.stderr);

  const stdoutReader = child.stdout.getReader();
  let stdout = "";
  let port: number | undefined;
  const readyPattern = /UpBot relay listening on 127\.0\.0\.1:(\d+)/;
  while (port === undefined) {
    const { value, done } = await withTimeout(
      stdoutReader.read(),
      10_000,
      "timed out waiting for relay listening output",
    );
    if (done) throw new Error(`relay exited before listening: ${stdout}`);
    stdout += new TextDecoder().decode(value);
    const match = readyPattern.exec(stdout);
    if (match) port = Number(match[1]);
  }
  if (port === undefined) throw new Error("relay listening port missing");

  const baseUrl = `http://127.0.0.1:${port}`;
  const invite = await fetch(`${baseUrl}/members`, {
    method: "POST",
    headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify({ name: "Ana" }),
  });
  expect(invite.ok).toBe(true);
  const member = (await invite.json()) as Member;

  ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(member.token)}`);
  const welcome = await nextFrame(ws, (frame) => frame.type === "welcome");
  expect((welcome.member as { id: string }).id).toBe(member.id);

  const lastFailedReply = nextFrame(
    ws,
    (frame) => frame.type === "reply" && frame.requestId === "burst-final",
  );
  for (let i = 0; i < 15; i++) {
    ws.send(
      JSON.stringify({
        type: "send",
        requestId: i === 0 ? SECRET_MARKER : `failed-${i}`,
        to: {
          memberId: i === 0 ? SECRET_MARKER : `offline-${i}`,
          agentId: i === 0 ? SECRET_MARKER : `missing-${i}`,
        },
        text: i === 0 ? SECRET_MARKER : "not logged",
      }),
    );
  }
  for (let i = 0; i < 14; i++) ws.send("{");
  const badTokenRequests = Array.from({ length: 25 }, () =>
    fetch(`${baseUrl}/ws?token=${SECRET_MARKER}`),
  );
  ws.send(
    JSON.stringify({
      type: "send",
      requestId: "burst-final",
      to: { memberId: "offline-final", agentId: "missing-final" },
    }),
  );
  await lastFailedReply;
  for (const response of await Promise.all(badTokenRequests)) {
    expect(response.status).toBe(401);
  }

  await until(() => {
    const logs = parseLines();
    return (
      actorLines(logs, member.id).length >= AUDIT_LIMIT &&
      logs.filter((line) => line.event === "relay.auth_rejected" && line.route === "/ws").length >=
        AUDIT_LIMIT
    );
  }, 3000);

  await until(() => {
    const logs = parseLines();
    return (
      logs.some((line) => line.event === "relay.audit_suppressed" && line.actor === member.id) &&
      logs.some(
        (line) => line.event === "relay.audit_suppressed" && String(line.actor).startsWith("ip:"),
      )
    );
  }, 10_000);

  const logs = parseLines();
  const memberLogged = actorLines(logs, member.id).length;
  const memberSummaries = logs.filter(
    (line) => line.event === "relay.audit_suppressed" && line.actor === member.id,
  );
  const memberSuppressed = memberSummaries.reduce(
    (total, line) => total + (line.suppressed ?? 0),
    0,
  );
  expect(memberLogged).toBeLessThanOrEqual(AUDIT_LIMIT);
  expect(memberLogged + memberSuppressed).toBe(31);
  for (const summary of memberSummaries) {
    const suppressed = summary.suppressed ?? 0;
    expect(Object.values(summary.events ?? {}).reduce((sum, count) => sum + count, 0)).toBe(
      suppressed,
    );
  }

  const authLogs = logs.filter(
    (line) => line.event === "relay.auth_rejected" && line.route === "/ws",
  );
  const ip = String(authLogs[0]?.ip);
  const authActor = `ip:${ip}`;
  const authSummaries = logs.filter(
    (line) => line.event === "relay.audit_suppressed" && line.actor === authActor,
  );
  const authSuppressed = authSummaries.reduce((total, line) => total + (line.suppressed ?? 0), 0);
  expect(authLogs.length).toBeLessThanOrEqual(AUDIT_LIMIT);
  expect(authLogs.length + authSuppressed).toBe(25);
  expect(
    authSummaries.every((summary) => {
      const suppressed = summary.suppressed ?? 0;
      return (
        Object.values(summary.events ?? {}).reduce((sum, count) => sum + count, 0) === suppressed
      );
    }),
  ).toBe(true);
  expect(stderrLines.some((line) => line.includes(SECRET_MARKER))).toBe(false);
}, 20_000);
