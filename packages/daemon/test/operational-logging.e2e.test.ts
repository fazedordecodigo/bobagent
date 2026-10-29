import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Agent, Routine, Turn } from "@upbot/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  readLog,
  startDaemon,
  stopTestChildren,
  tmp,
  waitForExit,
} from "./helpers";

const TOKEN = `operational-logging-${crypto.randomUUID()}`;

function stderrText(daemon: DaemonHandle): Promise<string> {
  if (!daemon.stderrText) throw new Error("stderr capture was not enabled");
  return daemon.stderrText;
}

describe("daemon operational logging", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let daemon: DaemonHandle;
  let client: DaemonClient;

  beforeEach(async () => {
    dataDir = tmp("operational-data-");
    agentsRoot = tmp("operational-agents-");
    stateDir = tmp("operational-fake-");
    daemon = await startDaemon(
      dataDir,
      agentsRoot,
      TOKEN,
      {
        UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
        FAKE_ACP_STATE_DIR: stateDir,
      },
      true,
    );
    client = await DaemonClient.connect(daemon.port, TOKEN);
  });

  afterEach(async () => {
    client?.close();
    try {
      (daemon.proc.stdin as { end: () => void }).end();
    } catch {}
    await daemon.proc.exited;
    await stopTestChildren(stateDir);
    for (const dir of [dataDir, agentsRoot, stateDir])
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("bridge errors log only an allowlisted error type", async () => {
    const agent = (await client.request("agents.create", {
      name: "Bridge logger",
      provider: "devin",
      instructions: "",
    })) as Agent;
    const { queueId } = (await client.request("chat.send", {
      agentId: agent.id,
      text: "echo:hi",
    })) as { queueId: string };
    await client.waitForEventWhere("turn.ended", (d) => (d as Turn).queueId === queueId, 20000);

    const sessions = readLog(stateDir).filter((entry) => entry.method === "session/new");
    const session = sessions.at(-1);
    if (!session) throw new Error("fake ACP session was not logged");
    const spec = (
      session.params as {
        mcpServers: { name: string; env: { name: string; value: string }[] }[];
      }
    ).mcpServers.find((server) => server.name === "upbot");
    if (!spec) throw new Error("upbot MCP server was not logged");
    const tokenEntry = spec.env.find((entry) => entry.name === "UPBOT_BRIDGE_TOKEN");
    if (!tokenEntry) throw new Error("bridge token was not logged");
    const bridgeToken = tokenEntry.value;
    const secret = `leak-${crypto.randomUUID()}`;
    const secret2 = `unknown_tool_${crypto.randomUUID()}`;
    const url = `http://127.0.0.1:${daemon.port}/bridge`;
    const headers = {
      authorization: `Bearer ${bridgeToken}`,
      "content-type": "application/json",
    };

    const rejected = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ method: secret }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain(secret);

    const toolCall = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        method: "tools/call",
        params: { name: secret2, arguments: {} },
      }),
    });
    expect(toolCall.status).toBe(200);

    (daemon.proc.stdin as { end: () => void }).end();
    await waitForExit(daemon.proc, 5000);
    const stderr = await stderrText(daemon);
    expect(stderr).toContain("bridge.error");
    expect(stderr).toMatch(/errorType.*Error/);
    expect(stderr).not.toContain(secret);
    expect(stderr).not.toContain(secret2);
  });

  test("webhook auth rejection logs are scoped to known routines", async () => {
    const agent = (await client.request("agents.create", {
      name: "Webhook logger",
      provider: "devin",
      instructions: "",
    })) as Agent;
    const createRoutine = (name: string) =>
      client.request("routines.create", {
        agentId: agent.id,
        name,
        prompt: "echo:hook",
        webhook: true,
      }) as Promise<Routine>;
    const routineA = await createRoutine("Webhook A");
    const routineB = await createRoutine("Webhook B");
    const post = (id: string) =>
      fetch(`http://127.0.0.1:${daemon.port}/hooks/${id}`, {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
      });

    expect((await post(routineA.id)).status).toBe(401);
    expect((await post(routineA.id)).status).toBe(401);
    expect((await post(routineB.id)).status).toBe(401);
    const secret3 = `not-a-routine-${crypto.randomUUID()}`;
    expect((await post(secret3)).status).toBe(401);

    (daemon.proc.stdin as { end: () => void }).end();
    await waitForExit(daemon.proc, 5000);
    const stderr = await stderrText(daemon);
    const rejectionLogs = stderr.match(/\[upbotd\] auth\.rejected \{[^}]*\}/g) ?? [];
    expect(stderr).toContain(routineA.id);
    expect(stderr).toContain(routineB.id);
    expect(rejectionLogs.filter((line) => line.includes(routineA.id))).toHaveLength(1);
    expect(stderr).not.toContain(secret3);
  });

  test.skipIf(process.platform === "win32")("SIGTERM logs the shutdown reason", async () => {
    daemon.proc.kill("SIGTERM");
    await waitForExit(daemon.proc, 5000);
    const stderr = await stderrText(daemon);
    expect(stderr).toContain("shutting down");
    expect(stderr).toContain("SIGTERM");
  });
});
