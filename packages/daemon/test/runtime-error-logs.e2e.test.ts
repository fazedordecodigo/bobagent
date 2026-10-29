import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, ChatItem, Turn } from "@upbot/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  startDaemon,
  stopTestChildren,
  tmp,
} from "./helpers";

const TOKEN = `runtime-error-logs-${crypto.randomUUID()}`;

describe("runtime failure logs e2e", () => {
  let tmpRoot: string;
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let blocker: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  let stderr = "";

  async function newAgent(name: string): Promise<Agent> {
    return (await c.request("agents.create", {
      name,
      provider: "devin",
      instructions: "",
    })) as Agent;
  }

  async function sendTurn(agentId: string, text: string): Promise<Turn> {
    const { queueId } = (await c.request("chat.send", { agentId, text })) as { queueId: string };
    return (await c.waitForEventWhere(
      "turn.ended",
      (event) => (event as Turn).queueId === queueId,
      20000,
    )) as Turn;
  }

  async function waitForStderr(re: RegExp, ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (re.test(stderr)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`stderr did not match ${re}: ${stderr}`);
  }

  beforeAll(async () => {
    tmpRoot = tmp("runtime-error-logs-");
    dataDir = join(tmpRoot, "data");
    agentsRoot = join(tmpRoot, "agents");
    stateDir = join(tmpRoot, "fake");
    blocker = join(tmpRoot, "dbg-DEBUGMARKER7f3a");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(agentsRoot, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(blocker, "not a directory");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      UPBOT_COMPACT_THRESHOLD: "0.8",
      UPBOT_DEBUG_PROMPTS_DIR: join(blocker, "sub"),
      FAKE_ACP_COMPACT_ERROR: "provider rejected key COMPACTMARKER9b2c",
    });
    const reader = (daemon.proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          stderr += decoder.decode(value, { stream: !done });
          if (done) return;
        }
      } finally {
        reader.releaseLock();
      }
    })().catch(() => {});
    c = await DaemonClient.connect(daemon.port, TOKEN);
  });

  afterAll(async () => {
    c?.close();
    try {
      daemon.proc.kill("SIGKILL");
    } catch {}
    await daemon.proc.exited;
    await stopTestChildren(stateDir);
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("debug prompt write failures log bounded fields", async () => {
    const agent = await newAgent("Debug failure");
    const turn = await sendTurn(agent.id, "echo:hi");
    expect(turn.status).toBe("completed");
    await waitForStderr(
      new RegExp(
        `\\[upbotd\\] failed to write debug prompt: agent=${agent.id} turn=${turn.id} errorType=\\w+ code=E[A-Z]+`,
      ),
      5000,
    );
    expect(stderr).not.toContain("DEBUGMARKER7f3a");
  }, 30000);

  test("auto-compaction failures log bounded fields", async () => {
    const agent = await newAgent("Auto-compaction failure");
    const compaction = c.waitForEventWhere(
      "item.updated",
      (event) => {
        const item = event as ChatItem;
        return (
          item.agentId === agent.id &&
          item.kind === "compaction" &&
          item.reason === "auto" &&
          item.status !== "running"
        );
      },
      20000,
    ) as Promise<Extract<ChatItem, { kind: "compaction" }>>;
    const turn = await sendTurn(agent.id, "usage:9000/10000");
    expect(turn.status).toBe("completed");
    expect((await compaction).status).toBe("failed");
    await waitForStderr(
      new RegExp(
        `\\[upbotd\\] auto-compaction failed: agent=${agent.id} errorType=RpcError code=internal`,
      ),
      5000,
    );
    expect(stderr).not.toContain("COMPACTMARKER9b2c");
  }, 30000);

  test("invalid queue meta logs bounded fields and the turn still runs", async () => {
    const agent = await newAgent("Run turn failure");
    const { queueId } = (await c.request("chat.send", {
      agentId: agent.id,
      text: "watchdog-delay:1500",
    })) as { queueId: string };
    const started = (await c.waitForEventWhere(
      "turn.started",
      (event) => (event as Turn).queueId === queueId,
      10000,
    )) as Turn;

    const badQueueId = crypto.randomUUID();
    const badEnded = c.waitForEventWhere(
      "turn.ended",
      (event) => (event as Turn).queueId === badQueueId,
      15000,
    ) as Promise<Turn>;
    const db = new Database(join(dataDir, "upbot.db"));
    db.exec("PRAGMA busy_timeout=5000");
    db.query(
      "INSERT INTO queue (id, agent_id, text, status, created_at, meta_json) VALUES (?, ?, ?, 'queued', ?, ?)",
    ).run(badQueueId, agent.id, "echo:unused", Date.now(), '{"x": RUNTURNMARKER5d1e}');
    db.close();

    const ended = (await c.waitForEventWhere(
      "turn.ended",
      (event) => (event as Turn).id === started.id,
      10000,
    )) as Turn;
    expect(ended.status).toBe("completed");
    await waitForStderr(
      new RegExp(`\\[upbotd\\] queue item ${badQueueId}: ignored invalid meta meta_json`),
      5000,
    );
    expect(stderr).not.toContain("RUNTURNMARKER5d1e");
    expect((await badEnded).status).toBe("completed");
  }, 30000);
});
