import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Agent } from "@boto/protocol";
import { spawnProvider } from "../src/providers/process";
import { ProviderError } from "../src/providers/types";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  startDaemon,
  stopDaemon,
  tmp,
} from "./helpers";

const TOKEN = `spawn-errors-${crypto.randomUUID()}`;
// matches the AIza pattern in redactSecrets; only ever a fake test value
const FAKE_GEMINI_KEY = `AIzaSyFakeGemini${crypto.randomUUID().replaceAll("-", "")}`;

describe("asynchronous child spawn errors", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let daemon: DaemonHandle;
  let client: DaemonClient;
  let agent: Agent;
  let acpAgent: Agent;

  beforeAll(async () => {
    dataDir = tmp("spawn-errors-data-");
    agentsRoot = tmp("spawn-errors-agents-");
    stateDir = tmp("spawn-errors-fake-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      BOTO_TTS_COMMAND: JSON.stringify(["definitely-missing-boto-cmd"]),
      BOTO_PROVIDER_COMMAND_CLAUDE: JSON.stringify(["definitely-missing-boto-cmd"]),
      BOTO_PROVIDER_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      FAKE_ACP_STDERR: `fatal: API key ${FAKE_GEMINI_KEY}`,
      FAKE_ACP_NEW_ERROR: "session new unavailable",
    });
    client = await DaemonClient.connect(daemon.port, TOKEN);
    agent = await client.request("agents.create", {
      name: "Missing provider",
      provider: "claude",
      instructions: "",
    });
    acpAgent = await client.request("agents.create", {
      name: "Failing ACP provider",
      provider: "devin",
      instructions: "",
    });
  });

  afterAll(async () => {
    await stopDaemon(daemon, client, stateDir);
    for (const directory of [dataDir, agentsRoot, stateDir]) {
      if (directory)
        rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test("voice reports a missing command and the daemon remains responsive", async () => {
    await expect(client.request("voice.speak", { text: "hello" })).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(await client.request("voice.status")).toMatchObject({ tts: true });
  });

  test("provider command overrides report unavailable without stopping the daemon", async () => {
    await expect(
      client.request("chat.send", { agentId: agent.id, text: "hello" }),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(await client.request("voice.status")).toMatchObject({ tts: true });
  });

  test("provider startup exposes asynchronous spawn failures", async () => {
    if (process.platform === "win32") {
      expect(() =>
        spawnProvider(`${process.execPath}-missing-boto.exe`, [], process.cwd()),
      ).toThrow(/failed to start: spawn .* ENOENT/);
      return;
    }
    const proc = spawnProvider(`${process.execPath}-missing-boto.exe`, [], process.cwd());
    await expect(proc.waitForSpawn()).rejects.toThrow();
    proc.markClosed();
  });

  test("synchronous spawn errors never expose injected env values", () => {
    // not matched by redactSecrets' patterns, and NUL-terminated so the
    // runtime's env validation would quote it verbatim in an escaped form
    const secret = `plain-secret-${crypto.randomUUID()}`;
    let thrown: unknown;
    try {
      spawnProvider("bun", ["-e", "1"], process.cwd(), {
        OPENAI_API_KEY: `${secret}\u0000`,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderError);
    const message = (thrown as Error).message;
    expect(message).not.toContain(secret);
    expect(message).toContain("NUL");
  });

  test("ACP provider startup failure surfaces a sanitized stderr tail", async () => {
    const { queueId } = await client.request("chat.send", {
      agentId: acpAgent.id,
      text: "hello",
    });
    const turn = await client.waitForEventWhere("turn.ended", (event) => event.queueId === queueId);
    expect(turn.status).toBe("failed");
    expect(turn.error).toContain("devin failed to start");
    expect(turn.error).toContain("fatal: API key <redacted>");
    expect(turn.error ?? "").not.toContain(FAKE_GEMINI_KEY);
  });
});
