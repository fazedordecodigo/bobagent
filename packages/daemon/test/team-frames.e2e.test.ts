import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Agent, TeamMessage, TeamStatus } from "@upbot/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  startDaemon,
  stopTestChildren,
  tmp,
} from "./helpers";

setDefaultTimeout(30000);

const TOKEN = `team-frames-${crypto.randomUUID()}`;
type Json = Record<string, unknown>;

async function until<T>(fn: () => Promise<T | undefined>, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value !== undefined) return value;
    await Bun.sleep(50);
  }
  throw new Error("timed out");
}

describe("team relay frame validation e2e", () => {
  let dataDir: string | undefined;
  let agentsRoot: string | undefined;
  let stateDir: string | undefined;
  let daemon: DaemonHandle | undefined;
  let c: DaemonClient | undefined;
  let agent: Agent;
  let fake: ReturnType<typeof Bun.serve> | undefined;
  let sendFrame: ((frame: Json) => void) | null = null;
  const received: Json[] = [];

  async function outgoing(predicate: (frame: Json) => boolean, ms = 15000): Promise<Json> {
    return until(async () => received.find(predicate), ms);
  }

  async function status(predicate: (value: TeamStatus) => boolean): Promise<TeamStatus> {
    const client = c;
    if (!client) throw new Error("daemon client is not connected");
    return until(async () => {
      const value = (await client.request("team.status", {})) as TeamStatus;
      return predicate(value) ? value : undefined;
    });
  }

  async function userStatus(): Promise<TeamStatus> {
    return status(
      (value) =>
        value.connected &&
        value.me?.id === "me" &&
        value.members.some((member) => member.id === "m2"),
    );
  }

  async function sendRoster() {
    relay({ type: "welcome", member: { id: "me", name: "Me" } });
    relay({
      type: "roster",
      members: [
        {
          id: "m2",
          name: "Ana",
          online: true,
          agents: [{ id: "ana-agent", name: "Ana's Agent", provider: "devin", avatar: null }],
        },
      ],
    });
    await userStatus();
  }

  function relay(frame: Json) {
    if (!sendFrame) throw new Error("daemon has not connected to fake relay");
    sendFrame(frame);
  }

  beforeEach(async () => {
    received.length = 0;
    sendFrame = null;
    fake = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, server) {
        if (new URL(req.url).pathname === "/ws")
          return server.upgrade(req, { data: {} })
            ? undefined
            : new Response("websocket upgrade failed", { status: 400 });
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          sendFrame = (frame) => ws.send(JSON.stringify(frame));
        },
        message(_ws, raw) {
          received.push(JSON.parse(String(raw)) as Json);
        },
        close() {
          sendFrame = null;
        },
      },
    });
    dataDir = tmp("team-frames-data-");
    agentsRoot = tmp("team-frames-agents-");
    stateDir = tmp("team-frames-fake-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      UPBOT_VAULT_KEY: "ef".repeat(32),
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
    agent = (await c.request("agents.create", {
      name: "Shared Agent",
      provider: "devin",
      instructions: "",
    })) as Agent;
    await c.request("team.connect", {
      url: `http://127.0.0.1:${fake.port}`,
      token: "fake-relay-token",
    });
    await outgoing((frame) => frame.type === "share");
    await c.request("team.share", { agentIds: [agent.id] });
    await outgoing(
      (frame) =>
        frame.type === "share" &&
        Array.isArray(frame.agents) &&
        (frame.agents as Json[]).some((shared) => shared.id === agent.id),
    );
  });

  afterEach(async () => {
    if (c) c.close();
    fake?.stop(true);
    if (daemon) {
      try {
        daemon.proc.kill("SIGKILL");
      } catch {}
      await daemon.proc.exited;
    }
    await stopTestChildren(stateDir);
    for (const dir of [dataDir, agentsRoot, stateDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    c = undefined;
    daemon = undefined;
    fake = undefined;
    dataDir = undefined;
    agentsRoot = undefined;
    stateDir = undefined;
  });

  test("ignores invalid welcome and roster frames without replacing valid state", async () => {
    relay({ type: "welcome", member: { id: "me", name: "Me" } });
    relay({
      type: "roster",
      members: [
        {
          id: "m2",
          name: "Ana",
          online: true,
          agents: [{ id: "ana-agent", name: "Ana's Agent", provider: "devin", avatar: null }],
        },
      ],
    });
    const initial = await userStatus();
    relay({ type: "welcome", member: { id: "x" } });
    relay({ type: "roster", members: "nope" });
    await Bun.sleep(100);
    expect(initial.me?.name).toBe("Me");
    const current = (await c!.request("team.status", {})) as TeamStatus;
    expect(current.members.map((member) => member.name)).toEqual(["Ana"]);
    expect(current).toMatchObject({
      connected: true,
      me: { id: "me", name: "Me" },
      members: [{ id: "m2", name: "Ana" }],
    });
  });

  test("ignores invalid incoming frames and handles a subsequent valid request", async () => {
    await sendRoster();
    relay({
      type: "incoming",
      requestId: "bad-1",
      from: { memberId: "m2", name: "Ana" },
      text: "echo:must be ignored",
    });
    relay({
      type: "incoming",
      requestId: "ok-1",
      from: { memberId: "m2", name: "Ana" },
      agentId: agent.id,
      text: "echo:pong",
    });
    const reply = await outgoing((frame) => frame.type === "reply" && frame.requestId === "ok-1");
    expect(reply).toMatchObject({ status: "completed", text: "pong" });
    expect(received.some((frame) => frame.requestId === "bad-1")).toBe(false);
    expect(
      ((await c!.request("team.messages", {})) as TeamMessage[]).some(
        (message) => message.requestId === "bad-1",
      ),
    ).toBe(false);
  });

  test("ignores invalid replies and accepts a later valid reply", async () => {
    await sendRoster();
    const sent = (await c!.request("team.send", {
      memberId: "m2",
      agentId: "ana-agent",
      text: "hello",
    })) as TeamMessage;
    const sendFrame = await outgoing(
      (frame) => frame.type === "send" && frame.requestId === sent.requestId,
    );
    expect(sendFrame).toMatchObject({ to: { memberId: "m2", agentId: "ana-agent" } });
    relay({
      type: "reply",
      requestId: sent.requestId,
      status: "weird",
      text: "bad",
    });
    relay({
      type: "incoming",
      requestId: "ok-2",
      from: { memberId: "m2", name: "Ana" },
      agentId: agent.id,
      text: "echo:sentinel",
    });
    const sentinel = await outgoing(
      (frame) => frame.type === "reply" && frame.requestId === "ok-2",
    );
    expect(sentinel).toMatchObject({ status: "completed", text: "sentinel" });
    const pending = (await c!.request("team.messages", {})) as TeamMessage[];
    expect(pending.find((message) => message.requestId === sent.requestId)).toMatchObject({
      status: "pending",
      reply: null,
    });

    relay({
      type: "reply",
      requestId: sent.requestId,
      status: "completed",
      text: "real",
    });
    const completed = await until(async () => {
      const messages = (await c!.request("team.messages", {})) as TeamMessage[];
      return messages.find(
        (message) => message.requestId === sent.requestId && message.status === "completed",
      );
    });
    expect(completed.reply).toBe("real");
  });
});
