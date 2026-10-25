import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Agent, AgentUsage, ChatItem, Turn } from "@bobagent/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  readLog,
  readPids,
  startDaemon,
  tmp,
} from "./helpers";

const TOKEN = `usage-test-${crypto.randomUUID()}`;

describe("usage + compaction e2e", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  let a: Agent;

  async function turn(agentId: string, text: string): Promise<Turn> {
    const { queueId } = (await c.request("chat.send", { agentId, text })) as { queueId: string };
    return (await c.waitForEventWhere(
      "turn.ended",
      (d) => (d as Turn).queueId === queueId,
      20000,
    )) as Turn;
  }

  const compactionDone = (agentId: string, reason: string) =>
    c.waitForEventWhere(
      "item.updated",
      (d) => {
        const i = d as ChatItem;
        return (
          i.agentId === agentId &&
          i.kind === "compaction" &&
          i.status !== "running" &&
          i.reason === reason
        );
      },
      20000,
    ) as Promise<Extract<ChatItem, { kind: "compaction" }>>;

  const lastPrompt = () => {
    const prompts = readLog(stateDir).filter((l) => l.method === "session/prompt");
    return JSON.stringify(prompts[prompts.length - 1]!.params);
  };

  beforeAll(async () => {
    dataDir = tmp("us-data-");
    agentsRoot = tmp("us-agents-");
    stateDir = tmp("us-fake-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      BOBAGENT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      BOBAGENT_COMPACT_THRESHOLD: "0.8",
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
    a = (await c.request("agents.create", {
      name: "U",
      provider: "devin",
      instructions: "",
    })) as Agent;
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

  test("compact with no history is rejected", async () => {
    await expect(c.request("agents.compact", { agentId: a.id })).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  test("usage updates are accumulated, broadcast and persisted", async () => {
    const ev = c.waitForEventWhere(
      "agent.usage",
      (d) => (d as AgentUsage).inputTokens === 100,
      20000,
    );
    await turn(a.id, "usage:1000/10000");
    await ev;
    const u = (await c.request("agents.usage", { agentId: a.id })) as AgentUsage;
    expect(u).toMatchObject({
      usedTokens: 1000,
      contextWindow: 10000,
      inputTokens: 100,
      outputTokens: 20,
    });
    await turn(a.id, "usage:2000/10000");
    const u2 = (await c.request("agents.usage", { agentId: a.id })) as AgentUsage;
    expect(u2).toMatchObject({
      usedTokens: 2000,
      inputTokens: 200,
      outputTokens: 40,
      compactions: 0,
    });
  });

  test("manual compaction summarizes and seeds a fresh session", async () => {
    const newsBefore = readLog(stateDir).filter((l) => l.method === "session/new").length;
    const done = compactionDone(a.id, "manual");
    await c.request("agents.compact", { agentId: a.id });
    const item = await done;
    expect(item.status).toBe("completed");
    expect(item.summary).toBe("SUMMARY: 2 earlier prompts");
    const u = (await c.request("agents.usage", { agentId: a.id })) as AgentUsage;
    expect(u.usedTokens).toBeNull();
    expect(u.compactions).toBe(1);
    await turn(a.id, "echo:after");
    expect(readLog(stateDir).filter((l) => l.method === "session/new").length).toBe(newsBefore + 1);
    const p = lastPrompt();
    expect(p).toContain("conversation_summary");
    expect(p).toContain("SUMMARY: 2 earlier prompts");
    expect(p).not.toContain("usage:1000/10000");
  });

  test("auto compaction runs when the context passes the threshold", async () => {
    const done = compactionDone(a.id, "auto");
    await turn(a.id, "usage:9000/10000");
    expect((await done).status).toBe("completed");
    const u = (await c.request("agents.usage", { agentId: a.id })) as AgentUsage;
    expect(u.compactions).toBe(2);
    expect((await turn(a.id, "echo:still works")).status).toBe("completed");
  });

  test("queued messages wait for compaction to finish", async () => {
    const done = compactionDone(a.id, "auto");
    await c.request("chat.send", { agentId: a.id, text: "usage:9500/10000" });
    const { queueId } = (await c.request("chat.send", { agentId: a.id, text: "echo:queued" })) as {
      queueId: string;
    };
    const ended = c.waitForEventWhere("turn.ended", (d) => (d as Turn).queueId === queueId, 20000);
    await done;
    expect(((await ended) as Turn).status).toBe("completed");
    expect(lastPrompt()).toContain("conversation_summary");
  });
});
