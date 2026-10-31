import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Agent, Turn } from "@boto/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  readPids,
  startDaemon,
  stopTestChildren,
  tmp,
  waitForPidDead,
} from "./helpers";

const TOKEN = `cancel-grace-${crypto.randomUUID()}`;
const DEFAULT_GRACE_MS = 10_000;

describe("BOTO_CANCEL_GRACE_MS=0 (fake acp agent)", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;

  beforeAll(async () => {
    dataDir = tmp("boto-grace-data-");
    agentsRoot = tmp("boto-grace-agents-");
    stateDir = tmp("boto-grace-fake-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      BOTO_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      BOTO_CANCEL_GRACE_MS: "0",
      FAKE_ACP_STATE_DIR: stateDir,
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
  });

  afterAll(async () => {
    c?.close();
    try {
      daemon.proc.kill("SIGKILL");
    } catch {}
    await daemon.proc.exited;
    await stopTestChildren(stateDir);
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(agentsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("chat.cancel kills a provider that ignores session/cancel immediately", async () => {
    const agent = (await c.request("agents.create", {
      name: "ImmediateCancel",
      provider: "devin",
      instructions: "",
    })) as Agent;
    const { queueId } = (await c.request("chat.send", {
      agentId: agent.id,
      text: "ignorecancel",
    })) as { queueId: string };
    await c.waitForEventWhere("item.delta", (d) => (d as { agentId: string }).agentId === agent.id);
    const pid = readPids(stateDir).at(-1) ?? 0;
    expect(pid).toBeGreaterThan(0);

    const ended = c.waitForEventWhere(
      "turn.ended",
      (d) => (d as Turn).agentId === agent.id && (d as Turn).queueId === queueId,
      // Half the default grace: the old parser turned "0" into 10 s and
      // would miss this deadline.
      DEFAULT_GRACE_MS / 2,
    );
    await c.request("chat.cancel", { agentId: agent.id });
    const turn = (await ended) as Turn;
    expect(turn.status).toBe("cancelled");
    expect(turn.stopReason).toBe("cancelled");
    await waitForPidDead(pid);
  });
});
