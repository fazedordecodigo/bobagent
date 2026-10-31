import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Agent, Routine } from "@boto/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  startDaemon,
  stopTestChildren,
  tmp,
} from "./helpers";

const TOKEN = `bad-request-${crypto.randomUUID()}`;
const FAKE_SSH = join(import.meta.dir, "fixtures/fake-ssh.ts");
const REPO_MARKET = join(import.meta.dir, "..", "..", "..", "marketplace");

describe("bad request RPC codes e2e", () => {
  let dataDir: string;
  let agentsRoot: string;
  let sharedRoot: string;
  let stateDir: string;
  let sshHome: string;
  let sshLogDir: string;
  let sshLog: string;
  let market: string;
  let marketIndex: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  let agent: Agent;
  let daemonStderr = "";
  let stderrDone: Promise<void> = Promise.resolve();

  beforeAll(async () => {
    dataDir = tmp("bad-request-data-");
    agentsRoot = tmp("bad-request-agents-");
    sharedRoot = tmp("bad-request-shared-");
    stateDir = tmp("bad-request-fake-");
    sshHome = tmp("bad-request-ssh-home-");
    sshLogDir = tmp("bad-request-ssh-log-");
    sshLog = join(sshLogDir, "ssh.jsonl");
    market = tmp("bad-request-market-");
    cpSync(REPO_MARKET, market, { recursive: true });
    marketIndex = pathToFileURL(join(market, "index.json")).href;

    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      FAKE_ACP_STATE_DIR: stateDir,
      FAKE_SSH_HOME: sshHome,
      FAKE_SSH_LOG: sshLog,
      BOTO_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      BOTO_MARKETPLACE_URL: marketIndex,
      BOTO_SHARED_ROOT: sharedRoot,
      BOTO_SSH_COMMAND: JSON.stringify(["bun", FAKE_SSH]),
      BOTO_STT_COMMAND: JSON.stringify(["definitely-missing-boto-cmd", "{file}"]),
      BOTO_TTS_COMMAND: JSON.stringify(["definitely-missing-boto-cmd"]),
    });
    const stderr = daemon.proc.stderr;
    if (!(stderr instanceof ReadableStream)) throw new Error("daemon stderr stream unavailable");
    stderrDone = (async () => {
      const reader = stderr.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        daemonStderr += decoder.decode(value, { stream: true });
      }
      daemonStderr += decoder.decode();
    })();
    c = await DaemonClient.connect(daemon.port, TOKEN);
    agent = (await c.request("agents.create", {
      name: "Bad request test",
      provider: "devin",
      instructions: "",
    })) as Agent;
  });

  afterAll(async () => {
    c?.close();
    try {
      daemon.proc.kill("SIGKILL");
    } catch {}
    await daemon.proc.exited;
    await stderrDone;
    await stopTestChildren(stateDir);
    for (const directory of [
      dataDir,
      agentsRoot,
      sharedRoot,
      stateDir,
      sshHome,
      sshLogDir,
      market,
    ]) {
      if (directory)
        rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    expect(daemonStderr).not.toContain("[botod] handler error");
  });

  test("routines convert invalid schedules and preserve not-found codes", async () => {
    await expect(
      c.request("routines.create", {
        agentId: agent.id,
        name: "Invalid schedule",
        prompt: "test",
        schedule: "whenever",
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message: 'schedule must look like "every 30m", "daily 09:00" or "weekly mon 09:00"',
    });

    const routine = (await c.request("routines.create", {
      agentId: agent.id,
      name: "Valid schedule",
      prompt: "test",
      schedule: "every 1m",
    })) as Routine;
    await expect(
      c.request("routines.update", { id: routine.id, schedule: "every 0m" }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message: "the shortest interval is 1 minute",
    });
    await expect(
      c.request("routines.create", {
        agentId: "missing-agent",
        name: "Unknown agent",
        prompt: "test",
        schedule: "daily 09:00",
      }),
    ).rejects.toMatchObject({ code: "not_found", message: "agent not found" });
  });

  test("skills.save converts service validation errors", async () => {
    await expect(
      c.request("skills.save", { name: "!!!", description: "", body: "body" }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message: "skill name must contain letters or digits",
    });
    await expect(
      c.request("skills.save", { name: "empty-body", description: "", body: "   " }),
    ).rejects.toMatchObject({ code: "bad_request", message: "skill body is empty" });
  });

  test("placements convert validation errors and preserve not-found codes", async () => {
    await expect(
      c.request("placements.set", {
        agentId: agent.id,
        hostId: null,
        isolation: "firecracker",
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message: "Firecracker microVMs need a remote Linux host with KVM",
    });

    const host = (await c.request("hosts.create", {
      name: "Uninstalled",
      target: "uninstalled.example",
    })) as { id: string };
    await expect(
      c.request("placements.set", { agentId: agent.id, hostId: host.id, isolation: "none" }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringContaining("is not installed yet (Install first)"),
    });
    await expect(
      c.request("placements.set", {
        agentId: "missing-agent",
        hostId: null,
        isolation: "none",
      }),
    ).rejects.toMatchObject({ code: "not_found", message: "agent not found" });
  });

  test("marketplace install converts unknown sources and preserves missing item codes", async () => {
    await expect(
      c.request("marketplace.install", {
        source: "https://unknown.example/index.json",
        id: "missing",
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message: "unknown marketplace source",
    });
    await expect(
      c.request("marketplace.install", { source: marketIndex, id: "missing-item" }),
    ).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringContaining('no item "'),
    });
  });

  test("voice reports missing speech commands as bad requests", async () => {
    await expect(c.request("voice.speak", { text: "hello" })).rejects.toMatchObject({
      code: "bad_request",
      message: "text-to-speech command not found: definitely-missing-boto-cmd",
    });
    await expect(
      c.request("voice.transcribe", {
        audioBase64: Buffer.from("audio").toString("base64"),
        mime: "audio/wav",
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
      message: "speech-to-text command not found: definitely-missing-boto-cmd",
    });
  });

  describe.skipIf(process.platform === "win32")("host errors", () => {
    test("hosts.check and hosts.install convert SSH failures and preserve not-found codes", async () => {
      const host = (await c.request("hosts.create", {
        name: "Unreachable",
        target: "unreachable.example",
      })) as { id: string };
      await expect(c.request("hosts.check", { id: host.id })).rejects.toMatchObject({
        code: "bad_request",
        message: expect.stringContaining("Connection refused"),
      });
      await expect(c.request("hosts.install", { id: host.id })).rejects.toMatchObject({
        code: "bad_request",
        message: expect.stringMatching(/^install failed:/),
      });
      await expect(c.request("hosts.check", { id: "missing-host" })).rejects.toMatchObject({
        code: "not_found",
        message: "host not found",
      });
    });
  });
});
