import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIT_FIELD_MAX, AUDIT_LIMIT, AUDIT_WINDOW_MS, auditField, startRelay } from "../src/main";

type RelayFrame = {
  type?: string;
  requestId?: string;
  members?: Array<{ id: string; agents: Array<{ id: string }> }>;
  [key: string]: unknown;
};

type Member = { id: string; name: string; token: string };

function nextFrame(
  ws: WebSocket,
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
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
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
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
  });
}

describe("relay audit logging", () => {
  let relay: ReturnType<typeof startRelay>;
  let dataDir: string;
  let baseUrl: string;
  let clock = 1000;
  let ana: Member;
  let bob: Member;
  const sockets: WebSocket[] = [];
  const lines: Record<string, unknown>[] = [];
  const rawLines: string[] = [];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "upbot-relay-audit-"));
    relay = startRelay({
      dataDir,
      port: 0,
      host: "127.0.0.1",
      adminToken: "admin-secret",
      log: (line) => {
        rawLines.push(line);
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
      now: () => clock,
    });
    baseUrl = `http://127.0.0.1:${relay.server.port}`;

    const invite = async (name: string) => {
      const response = await fetch(`${baseUrl}/members`, {
        method: "POST",
        headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      expect(response.ok).toBe(true);
      return (await response.json()) as Member;
    };
    ana = await invite("Ana");
    bob = await invite("Bob");
  });

  afterAll(async () => {
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    }
    await relay.server.stop(true);
    await rm(dataDir, { recursive: true, force: true });
  });

  test("bounds logged fields and throttles by actor without changing routed frames", async () => {
    const connect = async (member: Member) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${relay.server.port}/ws?token=${encodeURIComponent(member.token)}`,
      );
      sockets.push(ws);
      const welcome = await nextFrame(ws, (frame) => frame.type === "welcome");
      expect((welcome.member as { id: string }).id).toBe(member.id);
      return ws;
    };
    const anaWs = await connect(ana);
    const bobWs = await connect(bob);
    const hugeRequestId = "r".repeat(900_000);
    const failedReply = nextFrame(
      anaWs,
      (frame) => frame.type === "reply" && frame.requestId === hugeRequestId,
    );
    anaWs.send(
      JSON.stringify({
        type: "send",
        requestId: hugeRequestId,
        to: { memberId: "offline-member", agentId: "offline-agent" },
        text: "secret-text",
      }),
    );
    const failedFrame = await failedReply;
    expect(failedFrame.requestId).toBe(hugeRequestId);
    const destinationReply = nextFrame(
      anaWs,
      (frame) => frame.type === "reply" && frame.requestId === "destination-bounds",
    );
    anaWs.send(
      JSON.stringify({
        type: "send",
        requestId: "destination-bounds",
        to: {
          memberId: "m".repeat(100_000),
          agentId: "a".repeat(100_000),
        },
      }),
    );
    await destinationReply;
    const initialRoute = lines.find(
      (line) => line.event === "relay.route_failed" && line.requestId === auditField(hugeRequestId),
    );
    const destinationRoute = lines.find(
      (line) => line.event === "relay.route_failed" && line.requestId === "destination-bounds",
    );
    expect(initialRoute?.requestId).toBe(`${"r".repeat(AUDIT_FIELD_MAX)}…(+899936)`);
    expect(destinationRoute?.toMemberId).toBe(`${"m".repeat(AUDIT_FIELD_MAX)}…(+99936)`);
    expect(destinationRoute?.agentId).toBe(`${"a".repeat(AUDIT_FIELD_MAX)}…(+99936)`);
    expect(initialRoute?.reason).toBe("offline");

    clock += AUDIT_WINDOW_MS;
    const lastVolumeReply = nextFrame(
      anaWs,
      (frame) => frame.type === "reply" && frame.requestId === "ana-volume-49",
    );
    for (let i = 0; i < 50; i++) {
      anaWs.send(
        JSON.stringify({
          type: "send",
          requestId: `ana-volume-${i}`,
          to: { memberId: "offline-member", agentId: "offline-agent" },
        }),
      );
    }
    await lastVolumeReply;
    const anaRouteLines = () =>
      lines.filter((line) => line.event === "relay.route_failed" && line.fromMemberId === ana.id);
    expect(anaRouteLines()).toHaveLength(AUDIT_LIMIT + 2);

    const bobFailedReply = nextFrame(
      bobWs,
      (frame) => frame.type === "reply" && frame.requestId === "bob-while-ana-throttled",
    );
    bobWs.send(
      JSON.stringify({
        type: "send",
        requestId: "bob-while-ana-throttled",
        to: { memberId: "offline-member", agentId: "offline-agent" },
      }),
    );
    await bobFailedReply;
    expect(
      lines.some(
        (line) =>
          line.event === "relay.route_failed" &&
          line.fromMemberId === bob.id &&
          line.requestId === "bob-while-ana-throttled",
      ),
    ).toBe(true);

    clock += AUDIT_WINDOW_MS;
    const rolloverReply = nextFrame(
      anaWs,
      (frame) => frame.type === "reply" && frame.requestId === "ana-rollover",
    );
    anaWs.send(
      JSON.stringify({
        type: "send",
        requestId: "ana-rollover",
        to: { memberId: "offline-member", agentId: "offline-agent" },
      }),
    );
    await rolloverReply;
    const suppressedIndex = lines.findIndex(
      (line) =>
        line.event === "relay.audit_suppressed" && line.actor === ana.id && line.suppressed === 30,
    );
    const rolloverIndex = lines.findIndex(
      (line) => line.event === "relay.route_failed" && line.requestId === "ana-rollover",
    );
    expect(suppressedIndex).toBeGreaterThanOrEqual(0);
    expect(lines[suppressedIndex]?.suppressedEvent).toBe("relay.route_failed");
    expect(lines[suppressedIndex]?.suppressed).toBe(30);
    expect(lines[suppressedIndex + 1]?.event).toBe("relay.route_failed");
    expect(rolloverIndex).toBe(suppressedIndex + 1);

    const badMessageBarrier = nextFrame(
      bobWs,
      (frame) => frame.type === "reply" && frame.requestId === "bob-bad-message-barrier",
    );
    for (let i = 0; i < 25; i++) bobWs.send("{");
    bobWs.send(
      JSON.stringify({
        type: "send",
        requestId: "bob-bad-message-barrier",
        to: { memberId: "offline-member", agentId: "offline-agent" },
      }),
    );
    await badMessageBarrier;
    expect(
      lines.filter((line) => line.event === "relay.bad_message" && line.memberId === bob.id),
    ).toHaveLength(AUDIT_LIMIT);

    const routeCountBeforeShare = lines.filter(
      (line) => line.event === "relay.route_failed",
    ).length;
    const roster = nextFrame(
      bobWs,
      (frame) =>
        frame.type === "roster" &&
        frame.members?.some(
          (member) => member.id === bob.id && member.agents.some((agent) => agent.id === "b1"),
        ) === true,
    );
    bobWs.send(
      JSON.stringify({
        type: "share",
        agents: [{ id: "b1", name: "B", provider: "devin" }],
      }),
    );
    await roster;
    const longRequestId = `success-${"l".repeat(100_000)}`;
    const incoming = nextFrame(
      bobWs,
      (frame) => frame.type === "incoming" && frame.requestId === longRequestId,
    );
    anaWs.send(
      JSON.stringify({
        type: "send",
        requestId: longRequestId,
        to: { memberId: bob.id, agentId: "b1" },
        text: "hello bob",
      }),
    );
    const incomingFrame = await incoming;
    expect(incomingFrame.requestId).toBe(longRequestId);
    expect(incomingFrame.text).toBe("hello bob");
    const routedReply = nextFrame(
      anaWs,
      (frame) => frame.type === "reply" && frame.requestId === longRequestId,
    );
    bobWs.send(
      JSON.stringify({
        type: "reply",
        requestId: longRequestId,
        toMemberId: ana.id,
        text: "hello ana",
      }),
    );
    expect((await routedReply).text).toBe("hello ana");
    expect(lines.filter((line) => line.event === "relay.route_failed")).toHaveLength(
      routeCountBeforeShare,
    );

    const longPath = `/members/${"x".repeat(4000)}`;
    const rejectedDelete = await fetch(`${baseUrl}${longPath}`, { method: "DELETE" });
    expect(rejectedDelete.status).toBe(401);
    const pathLog = [...lines]
      .reverse()
      .find((line) => line.event === "relay.auth_rejected" && line.reason === "admin_token");
    expect(pathLog?.path).toBe(auditField(longPath));
    expect(String(pathLog?.path).length).toBeLessThan(longPath.length);

    clock += AUDIT_WINDOW_MS;
    for (let i = 0; i < 25; i++) {
      const response = await fetch(`${baseUrl}/ws?token=bad`);
      expect(response.status).toBe(401);
    }
    const badTokenLogs = lines.filter(
      (line) => line.event === "relay.auth_rejected" && line.reason === "member_token",
    );
    expect(badTokenLogs.length).toBeLessThanOrEqual(AUDIT_LIMIT);

    const tokenHashes = [ana.token, bob.token, "admin-secret"].map((token) =>
      createHash("sha256").update(token).digest("hex"),
    );
    for (const value of ["secret-text", ana.token, bob.token, "admin-secret", ...tokenHashes]) {
      expect(rawLines.some((line) => line.includes(value))).toBe(false);
    }
  });

  test("auditField preserves short fields and caps longer values", () => {
    expect(auditField("short")).toBe("short");
    expect(auditField(null)).toBe("");
    expect(auditField("x".repeat(AUDIT_FIELD_MAX))).toBe("x".repeat(AUDIT_FIELD_MAX));
    expect(auditField("x".repeat(AUDIT_FIELD_MAX + 1))).toBe(`${"x".repeat(64)}…(+1)`);
  });
});
