import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Agent, Channel, ChannelMessage, Turn } from "@bobagent/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  readLog,
  readPids,
  startDaemon,
  tmp,
} from "./helpers";

const TOKEN = `channels-test-${crypto.randomUUID()}`;

describe("channels e2e", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  let alice: Agent;
  let bob: Agent;
  let ch: Channel;

  const newAgent = async (name: string) =>
    (await c.request("agents.create", { name, provider: "devin", instructions: "" })) as Agent;

  const messageFrom = (
    authorAgentId: string | null,
    pred: (m: ChannelMessage) => boolean = () => true,
  ) =>
    c.waitForEventWhere(
      "channel.message",
      (d) => {
        const m = d as ChannelMessage;
        return m.channelId === ch.id && m.authorAgentId === authorAgentId && pred(m);
      },
      20000,
    ) as Promise<ChannelMessage>;

  beforeAll(async () => {
    dataDir = tmp("ch-data-");
    agentsRoot = tmp("ch-agents-");
    stateDir = tmp("ch-fake-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      BOBAGENT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      BOBAGENT_SHARED_ROOT: tmp("ch-shared-"),
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
    alice = await newAgent("Alice");
    bob = await newAgent("Bob");
  });

  afterAll(() => {
    c?.close();
    try {
      daemon.proc.kill("SIGKILL");
    } catch {}
    for (const pid of readPids(stateDir)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    for (const d of [dataDir, agentsRoot, stateDir]) rmSync(d, { recursive: true, force: true });
  });

  test("create validates members and defaults the owner", async () => {
    await expect(
      c.request("channels.create", { name: "X", memberIds: [alice.id], ownerId: bob.id }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      c.request("channels.create", { name: "X", memberIds: ["nope"] }),
    ).rejects.toMatchObject({ code: "not_found" });
    ch = (await c.request("channels.create", {
      name: "Team",
      memberIds: [alice.id, bob.id],
    })) as Channel;
    expect(ch.ownerId).toBe(alice.id);
    expect(ch.memberIds).toEqual([alice.id, bob.id]);
    expect(((await c.request("channels.list", {})) as Channel[]).map((x) => x.id)).toContain(ch.id);
  });

  test("user posts go to the owner and the reply lands in the channel", async () => {
    const reply = messageFrom(alice.id);
    await c.request("channels.post", { channelId: ch.id, text: "echo:hello team" });
    expect((await reply).text).toBe("hello team");
    const prompts = readLog(stateDir).filter((l) => l.method === "session/prompt");
    const raw = JSON.stringify(prompts[prompts.length - 1]!.params);
    expect(raw).toContain("channel_context");
    expect(raw).toContain('role=\\"owner\\"');
    const { messages } = (await c.request("channels.history", { channelId: ch.id })) as {
      messages: ChannelMessage[];
    };
    expect(messages.map((m) => m.authorKind)).toEqual(["user", "agent"]);
  });

  test("owner delegates; member reply is posted and forwarded to the owner", async () => {
    const delegated = messageFrom(alice.id, (m) => m.text.startsWith("@Bob"));
    const bobReply = messageFrom(bob.id);
    const ownerWrapUp = messageFrom(alice.id, (m) => m.text.startsWith("unhandled:"));
    const forwarded = c.waitForEventWhere(
      "turn.ended",
      (d) => (d as Turn).agentId === alice.id,
      20000,
    );
    const task = JSON.stringify({ channel: "team", to: "Bob", task: "echo:subtask done" });
    await c.request("channels.post", { channelId: ch.id, text: `mcp:delegate ${task}` });
    expect((await delegated).text).toBe("@Bob echo:subtask done");
    expect((await bobReply).text).toBe("subtask done");
    await forwarded; // Alice's own delegate turn
    const second = await c.waitForEventWhere(
      "turn.ended",
      (d) => (d as Turn).agentId === alice.id,
      20000,
    );
    expect((second as Turn).status).toBe("completed");
    const prompts = readLog(stateDir).filter((l) => l.method === "session/prompt");
    expect(JSON.stringify(prompts[prompts.length - 1]!.params)).toContain(
      "Bob replied in the channel",
    );
  });

  test("delegate rejects non-members", async () => {
    const carol = await newAgent("Carol");
    const reply = messageFrom(alice.id);
    const task = JSON.stringify({ channel: "Team", to: carol.name, task: "x" });
    await c.request("channels.post", { channelId: ch.id, text: `mcp:delegate ${task}` });
    expect((await reply).text).toContain("tool-error:");
  });

  test("stop cancels channel turns and blocks posts; resume reopens", async () => {
    const started = c.waitForEventWhere(
      "turn.started",
      (d) => (d as Turn).agentId === alice.id,
      20000,
    );
    await c.request("channels.post", { channelId: ch.id, text: "slow" });
    await started;
    const ended = c.waitForEventWhere("turn.ended", (d) => (d as Turn).agentId === alice.id, 20000);
    const stopped = (await c.request("channels.stop", { channelId: ch.id })) as Channel;
    expect(stopped.status).toBe("stopped");
    expect(((await ended) as Turn).status).toBe("cancelled");
    await expect(c.request("channels.post", { channelId: ch.id, text: "x" })).rejects.toMatchObject(
      {
        code: "bad_request",
      },
    );
    await c.request("queue.resume", { agentId: alice.id }).catch(() => {});
    expect(((await c.request("channels.resume", { channelId: ch.id })) as Channel).status).toBe(
      "active",
    );
  });

  test("reassign, archive and restore", async () => {
    const re = (await c.request("channels.reassign", {
      channelId: ch.id,
      ownerId: bob.id,
    })) as Channel;
    expect(re.ownerId).toBe(bob.id);
    const reply = messageFrom(bob.id);
    await c.request("channels.post", { channelId: ch.id, text: "echo:bob owns it" });
    expect((await reply).text).toBe("bob owns it");
    await c.request("channels.archive", { channelId: ch.id });
    expect(((await c.request("channels.list", {})) as Channel[]).map((x) => x.id)).not.toContain(
      ch.id,
    );
    expect(
      ((await c.request("channels.list", { includeArchived: true })) as Channel[]).find(
        (x) => x.id === ch.id,
      )?.status,
    ).toBe("archived");
    await expect(c.request("channels.resume", { channelId: ch.id })).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(((await c.request("channels.restore", { channelId: ch.id })) as Channel).status).toBe(
      "active",
    );
  });
});
