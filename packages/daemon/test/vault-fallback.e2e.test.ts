import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Agent, ChatItem, Turn } from "@upbot/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  startDaemon,
  stopTestChildren,
  tmp,
  waitForExit,
} from "./helpers";

const TOKEN = `vault-fallback-${crypto.randomUUID()}`;
type Platform = "darwin" | "win32" | "linux";

async function tool(
  client: DaemonClient,
  agent: Agent,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const { queueId } = (await client.request("chat.send", {
    agentId: agent.id,
    text: `mcp:${name} ${JSON.stringify(args)}`,
  })) as { queueId: string };
  const turn = (await client.waitForEventWhere(
    "turn.ended",
    (data) => (data as Turn).queueId === queueId,
    20000,
  )) as Turn;
  const { items } = (await client.request("chat.history", { agentId: agent.id })) as {
    items: ChatItem[];
  };
  const message = items
    .filter((item) => item.turnId === turn.id && item.kind === "agent_message")
    .pop();
  return message && "text" in message ? message.text : "";
}

async function testFallback(platform: Platform) {
  const dataDir = tmp("vault-fallback-data-");
  const agentsRoot = tmp("vault-fallback-agents-");
  const stateDir = tmp("vault-fallback-state-");
  const binDir = tmp("vault-fallback-bin-");
  const logFile = join(binDir, "security.log");
  const env: Record<string, string> = {
    UPBOT_VAULT_KEY: "",
    UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
    FAKE_ACP_STATE_DIR: stateDir,
  };
  if (platform === "darwin") {
    const security = join(binDir, "security");
    writeFileSync(
      security,
      '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "$KEYCHAIN_TEST_LOG"\ncase "$1" in\n  find-generic-password) exit 44 ;;\n  add-generic-password) exit 45 ;;\nesac\nexit 0\n',
      { mode: 0o700 },
    );
    chmodSync(security, 0o700);
    env.PATH = [binDir, process.env.PATH ?? ""].filter(Boolean).join(delimiter);
    env.KEYCHAIN_TEST_LOG = logFile;
  } else if (platform === "win32") {
    mkdirSync(join(dataDir, "vault.key.dpapi.tmp"), { recursive: true });
  } else {
    const secretTool = join(binDir, "secret-tool");
    writeFileSync(
      secretTool,
      '#!/bin/sh\nif [ "$1" = "lookup" ]; then exit 1; fi\nif [ "$1" = "store" ]; then cat >/dev/null; exit 1; fi\nexit 1\n',
      { mode: 0o700 },
    );
    chmodSync(secretTool, 0o700);
    env.PATH = [binDir, process.env.PATH ?? ""].filter(Boolean).join(delimiter);
    env.SHELL = "/bin/false";
  }

  const daemons: DaemonHandle[] = [];
  const clients: DaemonClient[] = [];
  const secret = `fallback-${crypto.randomUUID()}`;

  try {
    let agent: Agent | undefined;
    for (let run = 0; run < 2; run++) {
      const daemon = await startDaemon(dataDir, agentsRoot, TOKEN, env);
      daemons.push(daemon);
      const client = await DaemonClient.connect(daemon.port, TOKEN);
      clients.push(client);
      if (!agent) {
        agent = (await client.request("agents.create", {
          name: "Vault fallback",
          provider: "devin",
          instructions: "",
        })) as Agent;
        await client.request("vault.set", {
          name: "fallback.key",
          value: secret,
          agentIds: [agent.id],
        });
      }
      expect(await tool(client, agent, "vault_get", { name: "fallback.key" })).toBe(
        `tool-ok:${secret}`,
      );

      const keyHex = readFileSync(join(dataDir, "vault.key"), "utf8");
      expect(keyHex).toMatch(/^[0-9a-f]{64}$/);
      client.close();
      (daemon.proc.stdin as { end: () => void }).end();
      await waitForExit(daemon.proc, 60_000);
      const stderr = await new Response(daemon.proc.stderr as ReadableStream<Uint8Array>).text();
      expect(stderr).not.toContain(secret);
      expect(stderr).not.toContain(keyHex);

      if (run === 0) {
        if (platform === "darwin") {
          expect(stderr).toContain("[upbotd] keychain add failed (exit 45)");
          expect(stderr).toContain(
            "UpBot could not use the platform secure store; storing the vault key in a plaintext file.",
          );
        } else if (platform === "win32") {
          expect(stderr).toMatch(
            /UpBot could not use Windows DPAPI \(.+\); storing the vault key in a plaintext file\./,
          );
          expect(existsSync(join(dataDir, "vault.key.dpapi"))).toBe(false);
        } else {
          expect(stderr).toContain(
            "UpBot could not use the platform secure store; storing the vault key in a plaintext file.",
          );
        }
      } else {
        expect(stderr).not.toContain("storing the vault key in a plaintext file.");
      }
    }
  } finally {
    for (const client of clients) client.close();
    for (const daemon of daemons) {
      try {
        (daemon.proc.stdin as { end: () => void }).end();
      } catch {}
      try {
        await waitForExit(daemon.proc, 60_000);
      } catch {
        try {
          daemon.proc.kill("SIGKILL");
        } catch {}
        await daemon.proc.exited;
      }
    }
    await stopTestChildren(stateDir);
    for (const directory of [dataDir, agentsRoot, stateDir, binDir])
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test.skipIf(process.platform !== "darwin")(
  "daemon reports macOS Keychain fallback and reuses its plaintext key",
  () => testFallback("darwin"),
  60_000,
);

test.skipIf(process.platform !== "win32")(
  "daemon reports Windows DPAPI fallback and reuses its plaintext key",
  () => testFallback("win32"),
  60_000,
);

test.skipIf(process.platform !== "linux")(
  "daemon reports Linux Secret Service fallback and reuses its plaintext key",
  () => testFallback("linux"),
  60_000,
);
