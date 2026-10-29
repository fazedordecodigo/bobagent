import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Agent, Turn } from "@upbot/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  startDaemon,
  stopTestChildren,
  tmp,
} from "./helpers";

const TOKEN = `runtime-logging-${crypto.randomUUID()}`;
const LOG_TIMEOUT_MS = 15000;

describe("runtime turn-lifecycle logging", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let daemon: DaemonHandle;
  let client: DaemonClient;
  let stderrText = "";
  let stderrDone: Promise<void> = Promise.resolve();

  async function newAgent(name: string): Promise<Agent> {
    return (await client.request("agents.create", {
      name,
      provider: "devin",
      instructions: "",
    })) as Agent;
  }

  async function sendAndWait(agentId: string, text: string): Promise<Turn> {
    const queue = (await client.request("chat.send", { agentId, text })) as { queueId: string };
    return (await client.waitForEventWhere(
      "turn.ended",
      (event) => (event as Turn).agentId === agentId && (event as Turn).queueId === queue.queueId,
      LOG_TIMEOUT_MS,
    )) as Turn;
  }

  async function waitForLog(event: string, turnId: string): Promise<string> {
    const deadline = Date.now() + LOG_TIMEOUT_MS;
    const marker = `[upbotd] ${event}`;
    while (Date.now() < deadline) {
      const start = stderrText.indexOf(marker);
      if (start >= 0) {
        const next = stderrText.indexOf("[upbotd] ", start + marker.length);
        const entry = stderrText.slice(start, next < 0 ? undefined : next);
        if (entry.includes(turnId)) return entry;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`daemon stderr did not contain [upbotd] ${event} for turn ${turnId}`);
  }

  beforeAll(async () => {
    dataDir = tmp("runtime-logging-data-");
    agentsRoot = tmp("runtime-logging-agents-");
    stateDir = tmp("runtime-logging-fake-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      UPBOT_CANCEL_GRACE_MS: "500",
    });
    const stderr = daemon.proc.stderr;
    if (!stderr || typeof stderr === "number") throw new Error("daemon stderr is unavailable");
    stderrDone = (async () => {
      const reader = stderr.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        stderrText += decoder.decode(value, { stream: true });
      }
      stderrText += decoder.decode();
    })();
    client = await DaemonClient.connect(daemon.port, TOKEN);
  });

  afterAll(async () => {
    client?.close();
    try {
      daemon.proc.kill("SIGKILL");
    } catch {}
    await daemon.proc.exited;
    await stderrDone;
    await stopTestChildren(stateDir);
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(agentsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("failed prompt logs turn failed with bounded error fields", async () => {
    const secret = `canary-${crypto.randomUUID()}`;
    const agent = await newAgent("Runtime logging failure");
    const turn = await sendAndWait(agent.id, `fail-secret:${secret}`);
    expect(turn.status).toBe("failed");

    const entry = await waitForLog("turn failed:", turn.id);
    expect(entry).toContain(`agent=${agent.id}`);
    expect(entry).toContain("provider=devin");
    expect(entry).toContain("errorType=");
    expect(stderrText.includes(secret)).toBe(false);
  });

  test("skipping invalid saved config does not log the value or provider option ID", async () => {
    const secret = "sk-test-SECRETVALUE123";
    const agent = await newAgent("Runtime logging invalid config");
    const db = new Database(join(dataDir, "upbot.db"));
    try {
      db.query("UPDATE agents SET config_json = ? WHERE id = ?").run(
        JSON.stringify({ mode: secret }),
        agent.id,
      );
    } finally {
      db.close();
    }

    const turn = await sendAndWait(agent.id, "echo:invalid config");
    expect(turn.status).toBe("completed");

    const entry = await waitForLog("skipping invalid config", agent.id);
    expect(entry).toContain("option#0");
    expect(stderrText).not.toContain(secret);
    expect(stderrText).not.toContain("option=");
  });

  test("provider crash logs provider exited without stderr detail", async () => {
    const secret = `canary-${crypto.randomUUID()}`;
    const agent = await newAgent("Runtime logging crash");
    const turn = await sendAndWait(agent.id, `crash-secret:${secret}`);
    expect(turn.status).toBe("failed");

    const entry = await waitForLog("provider exited:", turn.id);
    expect(entry).toContain(`agent=${agent.id}`);
    expect(entry).toContain("exit=");
    expect(entry).toContain("detail=yes");
    expect(stderrText.includes(secret)).toBe(false);
  });

  test("failed turn auto-pauses the queue and logs it", async () => {
    const secret = `canary-${crypto.randomUUID()}`;
    const agent = await newAgent("Runtime logging auto-pause");
    await client.request("queue.pause", { agentId: agent.id });
    const first = (await client.request("chat.send", {
      agentId: agent.id,
      text: `fail-secret:${secret}`,
    })) as { queueId: string };
    const second = (await client.request("chat.send", {
      agentId: agent.id,
      text: "echo",
    })) as { queueId: string };
    await client.request("queue.resume", { agentId: agent.id });
    const ended = (await client.waitForEventWhere(
      "turn.ended",
      (event) => (event as Turn).queueId === first.queueId,
      LOG_TIMEOUT_MS,
    )) as Turn;
    expect(ended.status).toBe("failed");

    const entry = await waitForLog("queue auto-paused:", ended.id);
    expect(entry).toContain("reason=failed");
    expect(entry).toContain("queued=1");

    const queue = (await client.request("queue.get", { agentId: agent.id })) as {
      paused: boolean;
      items: { id: string }[];
    };
    expect(queue.paused).toBe(true);
    expect(queue.items.map((i) => i.id)).toContain(second.queueId);
  });

  test("ignored cancel logs grace expiry before the hard-kill", async () => {
    const agent = await newAgent("Runtime logging cancel");
    const streaming = client.waitForEventWhere(
      "item.delta",
      (event) => (event as { agentId?: string }).agentId === agent.id,
      LOG_TIMEOUT_MS,
    );
    const queue = (await client.request("chat.send", {
      agentId: agent.id,
      text: "ignorecancel",
    })) as { queueId: string };
    await streaming;
    await client.request("chat.cancel", { agentId: agent.id });
    const ended = (await client.waitForEventWhere(
      "turn.ended",
      (event) => (event as Turn).queueId === queue.queueId,
      LOG_TIMEOUT_MS,
    )) as Turn;
    expect(ended.status).toBe("cancelled");

    const entry = await waitForLog("cancel grace expired; killing provider:", ended.id);
    expect(entry).toContain("graceMs=500");
  }, 20000);
});
