import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type RelayFrame = {
  type?: string;
  [key: string]: unknown;
};

type Member = { id: string; name: string; token: string };

setDefaultTimeout(30000);

let dataDir: string;
let proc: ReturnType<typeof Bun.spawn> | undefined;
let stderrTask: Promise<void> | undefined;
const sockets: WebSocket[] = [];
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

function nextFrame(
  socket: WebSocket,
  predicate: (frame: RelayFrame) => boolean,
  timeoutMs = 30000,
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

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "boto-relay-share-cli-"));
});

afterAll(async () => {
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) socket.close();
  }
  if (proc) {
    try {
      proc.kill();
    } catch {}
    await proc.exited;
    await stderrTask;
  }
  await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("validates shared agents and avatars before broadcasting rosters", async () => {
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
      env: { ...process.env, RELAY_ADMIN_TOKEN: "share-test-admin" },
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
  const readyPattern = /Boto relay listening on 127\.0\.0\.1:(\d+)/;
  while (port === undefined) {
    const { value, done } = await withTimeout(
      stdoutReader.read(),
      30000,
      "timed out waiting for relay listening output",
    );
    if (done) throw new Error(`relay exited before listening: ${stdout}`);
    stdout += new TextDecoder().decode(value);
    const match = readyPattern.exec(stdout);
    if (match) port = Number(match[1]);
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  const invite = async (name: string) => {
    const response = await fetch(`${baseUrl}/members`, {
      method: "POST",
      headers: { authorization: "Bearer share-test-admin", "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect(response.ok).toBe(true);
    return (await response.json()) as Member;
  };
  const memberA = await invite("Fictional Alice 91c");
  const memberB = await invite("Fictional Bob 91c");
  const connect = async (member: Member) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(member.token)}`,
    );
    sockets.push(socket);
    const welcome = await nextFrame(socket, (frame) => frame.type === "welcome");
    expect(welcome.member).toEqual({ id: member.id, name: member.name });
    return socket;
  };
  const socketA = await connect(memberA);
  const socketB = await connect(memberB);

  const marker = "MARKER-share-91c";
  const deeplyNestedAvatar = "[".repeat(100_000) + "]".repeat(100_000);
  const oversizedId = "x".repeat(129);
  const oversizedProvider = "p".repeat(1000);
  const rosterPromise = nextFrame(
    socketB,
    (frame) =>
      frame.type === "roster" &&
      (frame.members as { id: string; agents: { id: string }[] }[] | undefined)?.some(
        (member) => member.id === memberA.id && member.agents.some((agent) => agent.id === "deep"),
      ) === true,
  );
  socketA.send(
    `{"type":"share","agents":[{"id":"deep","name":"${marker}","provider":"devin","avatar":${deeplyNestedAvatar}},{"id":"emoji","name":"Emoji","provider":"claude","avatar":{"emoji":"🦊","color":"#12abEF"}},{"id":"icon","name":"Icon","provider":"codex","avatar":{"icon":"mail"}},{"id":"strict-icon","name":"Strict icon","provider":"codex","avatar":{"icon":"mail","extra":1}},{"id":"${oversizedId}","name":"Oversized id","provider":"devin"},{"id":"long-provider","name":"Long provider","provider":"${oversizedProvider}"},null,{"id":{},"name":"Object id","provider":"devin"}]}`,
  );
  const roster = await rosterPromise;
  const memberRoster = (roster.members as { id: string; agents: unknown[] }[]).find(
    (member) => member.id === memberA.id,
  );
  expect(memberRoster?.agents).toEqual([
    { id: "deep", name: marker, provider: "devin", avatar: null },
    { id: "emoji", name: "Emoji", provider: "claude", avatar: { emoji: "🦊", color: "#12abEF" } },
    { id: "icon", name: "Icon", provider: "codex", avatar: { icon: "mail" } },
    { id: "strict-icon", name: "Strict icon", provider: "codex", avatar: null },
    { id: "long-provider", name: "Long provider", provider: "p".repeat(40), avatar: null },
  ]);

  const updatedRosterPromise = nextFrame(
    socketB,
    (frame) =>
      frame.type === "roster" &&
      (frame.members as { id: string; agents: { id: string }[] }[] | undefined)?.some(
        (member) =>
          member.id === memberA.id && member.agents.some((agent) => agent.id === "legit-agent"),
      ) === true,
  );
  socketA.send(
    JSON.stringify({
      type: "share",
      agents: [{ id: "legit-agent", name: "Legit agent", provider: "devin" }],
    }),
  );
  const updatedRoster = await updatedRosterPromise;
  const updatedMemberRoster = (updatedRoster.members as { id: string; agents: unknown[] }[]).find(
    (member) => member.id === memberA.id,
  );
  expect(updatedMemberRoster?.agents).toEqual([
    { id: "legit-agent", name: "Legit agent", provider: "devin", avatar: null },
  ]);

  const incomingPromise = nextFrame(
    socketA,
    (frame) => frame.type === "incoming" && frame.requestId === "share-regression-send",
  );
  socketB.send(
    JSON.stringify({
      type: "send",
      requestId: "share-regression-send",
      to: { memberId: memberA.id, agentId: "legit-agent" },
      text: "fictitious test message",
    }),
  );
  const incoming = await incomingPromise;
  expect(incoming.agentId).toBe("legit-agent");
  expect(incoming.text).toBe("fictitious test message");

  expect(stderrLines.some((line) => line.includes("relay.send_error"))).toBe(false);
  expect(stderrLines.join("\n")).not.toContain(marker);
}, 30000);
