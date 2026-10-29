import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIT_LIMIT, AUDIT_WINDOW_MS, startRelay } from "../src/main";

type RelayFrame = {
  type?: string;
  requestId?: string;
  text?: string;
  member?: { id: string; name: string };
  members?: Array<{ id: string; agents: Array<{ id: string }> }>;
  [key: string]: unknown;
};

type RelayLine = {
  event?: string;
  actor?: string;
  suppressed?: number;
  events?: Record<string, number>;
  [key: string]: unknown;
};

type Member = { id: string; name: string; token: string };

const SECRET_MARKER = "SECRET-MARKER-7f3a";

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

describe("relay audit logging", () => {
  let relay: ReturnType<typeof startRelay>;
  let dataDir: string;
  let baseUrl: string;
  let clock = 1000;
  let ana: Member;
  let bob: Member;
  const sockets: WebSocket[] = [];
  const lines: RelayLine[] = [];
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
        lines.push(JSON.parse(line) as RelayLine);
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
    await relay.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("limits all actor events together, sweeps quiet summaries, and never logs frame secrets", async () => {
    const connect = async (member: Member) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${relay.server.port}/ws?token=${encodeURIComponent(member.token)}`,
      );
      sockets.push(ws);
      const welcome = await nextFrame(ws, (frame) => frame.type === "welcome");
      expect(welcome.member).toEqual({ id: member.id, name: member.name });
      return ws;
    };
    const anaWs = await connect(ana);
    const bobWs = await connect(bob);

    const rosterBarrier = nextFrame(
      anaWs,
      (frame) =>
        frame.type === "roster" &&
        frame.members?.some(
          (member) => member.id === ana.id && member.agents.some((agent) => agent.id === "barrier"),
        ) === true,
    );
    for (let i = 0; i < 15; i++) {
      const toMemberId = i === 0 ? SECRET_MARKER : i === 1 ? bob.id : `offline-${i}`;
      anaWs.send(
        JSON.stringify({
          type: "send",
          requestId: i === 0 ? SECRET_MARKER : `failed-${i}`,
          to: {
            memberId: toMemberId,
            agentId: i < 2 ? SECRET_MARKER : `agent-${i}`,
          },
          text: i === 0 ? SECRET_MARKER : "not logged",
        }),
      );
    }
    for (let i = 0; i < 15; i++) anaWs.send("{");
    anaWs.send(
      JSON.stringify({
        type: "share",
        agents: [{ id: "barrier", name: "Barrier", provider: "test" }],
      }),
    );
    await rosterBarrier;

    expect(actorLines(lines, ana.id)).toHaveLength(AUDIT_LIMIT);
    const anaRouteLines = lines.filter(
      (line) => line.event === "relay.route_failed" && line.fromMemberId === ana.id,
    );
    expect(anaRouteLines).toHaveLength(15);
    const unknownRoute = anaRouteLines.find((line) => line.reason === "offline");
    expect(unknownRoute?.toMemberId).toBeNull();
    expect(Object.hasOwn(unknownRoute ?? {}, "requestId")).toBe(false);
    expect(Object.hasOwn(unknownRoute ?? {}, "agentId")).toBe(false);
    expect(anaRouteLines.find((line) => line.reason === "not_shared")?.toMemberId).toBe(bob.id);

    const bobFailedReply = nextFrame(
      bobWs,
      (frame) => frame.type === "reply" && frame.requestId === "bob-still-logs",
    );
    bobWs.send(
      JSON.stringify({
        type: "send",
        requestId: "bob-still-logs",
        to: { memberId: "offline-bob", agentId: "missing-agent" },
      }),
    );
    await bobFailedReply;
    expect(
      lines.some(
        (line) =>
          line.event === "relay.route_failed" &&
          line.fromMemberId === bob.id &&
          line.reason === "offline",
      ),
    ).toBe(true);

    const bobRosterBarrier = nextFrame(
      bobWs,
      (frame) =>
        frame.type === "roster" &&
        frame.members?.some(
          (member) =>
            member.id === bob.id && member.agents.some((agent) => agent.id === "reply-barrier"),
        ) === true,
    );
    bobWs.send(
      JSON.stringify({
        type: "reply",
        requestId: SECRET_MARKER,
        toMemberId: SECRET_MARKER,
        text: SECRET_MARKER,
      }),
    );
    bobWs.send(
      JSON.stringify({
        type: "share",
        agents: [{ id: "reply-barrier", name: "Reply barrier", provider: "test" }],
      }),
    );
    await bobRosterBarrier;
    const droppedReply = lines.find(
      (line) => line.event === "relay.reply_dropped" && line.fromMemberId === bob.id,
    );
    expect(droppedReply?.toMemberId).toBeNull();
    expect(Object.hasOwn(droppedReply ?? {}, "requestId")).toBe(false);

    const shareBarrier = nextFrame(
      anaWs,
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
    await shareBarrier;
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
        text: SECRET_MARKER,
      }),
    );
    const incomingFrame = await incoming;
    expect(incomingFrame.requestId).toBe(longRequestId);
    expect(incomingFrame.text).toBe(SECRET_MARKER);
    const routedReply = nextFrame(
      anaWs,
      (frame) => frame.type === "reply" && frame.requestId === longRequestId,
    );
    bobWs.send(
      JSON.stringify({
        type: "reply",
        requestId: longRequestId,
        toMemberId: ana.id,
        text: SECRET_MARKER,
      }),
    );
    expect((await routedReply).text).toBe(SECRET_MARKER);

    const wsRejected = await fetch(`${baseUrl}/ws?token=${SECRET_MARKER}`);
    expect(wsRejected.status).toBe(401);
    const membersRejected = await fetch(`${baseUrl}/members`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET_MARKER}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "not created" }),
    });
    expect(membersRejected.status).toBe(401);
    const memberPathRejected = await fetch(`${baseUrl}/members/${SECRET_MARKER}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${SECRET_MARKER}` },
    });
    expect(memberPathRejected.status).toBe(401);
    const authLines = lines.filter((line) => line.event === "relay.auth_rejected");
    expect(authLines.map((line) => line.route)).toEqual(["/ws", "/members", "/members/:id"]);

    expect(rawLines.some((line) => line.includes(SECRET_MARKER))).toBe(false);

    clock += AUDIT_WINDOW_MS + 1;
    relay.sweepAudit();
    const anaSummaries = lines.filter(
      (line) => line.event === "relay.audit_suppressed" && line.actor === ana.id,
    );
    expect(anaSummaries).toHaveLength(1);
    expect(anaSummaries[0]?.suppressed).toBe(11);
    expect(anaSummaries[0]?.events).toEqual({ "relay.bad_message": 11 });
    expect(
      Object.values(anaSummaries[0]?.events ?? {}).reduce((sum, count) => sum + count, 0),
    ).toBe(11);
  });
});
