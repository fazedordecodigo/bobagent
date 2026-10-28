import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Agent } from "@upbot/protocol";
import { spawnProvider } from "../src/providers/process";
import { DaemonClient, type DaemonHandle, startDaemon, tmp } from "./helpers";

const TOKEN = `spawn-errors-${crypto.randomUUID()}`;

describe("asynchronous child spawn errors", () => {
  let dataDir: string;
  let agentsRoot: string;
  let daemon: DaemonHandle;
  let client: DaemonClient;
  let agent: Agent;

  beforeAll(async () => {
    dataDir = tmp("spawn-errors-data-");
    agentsRoot = tmp("spawn-errors-agents-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      UPBOT_TTS_COMMAND: JSON.stringify(["definitely-missing-upbot-cmd"]),
      UPBOT_PROVIDER_COMMAND_CLAUDE: JSON.stringify(["definitely-missing-upbot-cmd"]),
    });
    client = await DaemonClient.connect(daemon.port, TOKEN);
    agent = (await client.request("agents.create", {
      name: "Missing provider",
      provider: "claude",
      instructions: "",
    })) as Agent;
  });

  afterAll(async () => {
    client?.close();
    try {
      daemon.proc.kill("SIGKILL");
    } catch {}
    await daemon.proc.exited;
    for (const directory of [dataDir, agentsRoot]) {
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
        spawnProvider(`${process.execPath}-missing-upbot.exe`, [], process.cwd()),
      ).toThrow(/failed to start: spawn .* ENOENT/);
      return;
    }
    const proc = spawnProvider(`${process.execPath}-missing-upbot.exe`, [], process.cwd());
    await expect(proc.waitForSpawn()).rejects.toThrow();
    proc.markClosed();
  });
});
