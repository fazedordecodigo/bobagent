import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Agent, ChatItem, ConnectedApp, Turn } from "@upbot/protocol";
import { BRIDGE_TOOLS } from "../src/bridge";
import { openDatabase } from "../src/db";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  ROOT,
  startDaemon,
  stopTestChildren,
  tmp,
} from "./helpers";

const FAKE_MCP = join(ROOT, "packages/daemon/test/fixtures/fake-mcp-server.ts");
const APP_SECRET = "ghp_bridgeLogSecret4821";
const CONFIG_SECRET = "sk_corruptConfigSecret77";

/** Daemon with its stderr collected while it runs. */
async function launch(dataDir: string, agentsRoot: string, stateDir: string, token: string) {
  const daemon = await startDaemon(dataDir, agentsRoot, token, {
    UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
    FAKE_ACP_STATE_DIR: stateDir,
    UPBOT_VAULT_KEY: "ab".repeat(32),
  });
  const log = { text: "" };
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of daemon.proc.stderr as ReadableStream<Uint8Array>)
      log.text += decoder.decode(chunk);
  })();
  return { daemon, log, c: await DaemonClient.connect(daemon.port, token) };
}

async function reply(c: DaemonClient, agentId: string, text: string): Promise<string> {
  const { queueId } = (await c.request("chat.send", { agentId, text })) as { queueId: string };
  const t = (await c.waitForEventWhere(
    "turn.ended",
    (d) => (d as Turn).queueId === queueId,
    30000,
  )) as Turn;
  const { items } = (await c.request("chat.history", { agentId })) as { items: ChatItem[] };
  const msg = items.filter((i) => i.turnId === t.id && i.kind === "agent_message").pop();
  return msg && "text" in msg ? msg.text : "";
}

async function stderrEntry(log: { text: string }, marker: string, tool?: string) {
  for (let i = 0; i < 100; i++) {
    // console.error prints the metadata object over several lines, ending with "}".
    const entry = log.text
      .split(marker)
      .slice(1)
      .map((rest) => rest.slice(0, rest.indexOf("\n}") + 2))
      .find((e) => !tool || e.includes(`"${tool}"`));
    if (entry) return entry;
    await Bun.sleep(50);
  }
  throw new Error(`no stderr line ${marker} ${tool ?? ""}`);
}

async function stop(daemon: DaemonHandle, c: DaemonClient, stateDir: string, dirs: string[]) {
  c.close();
  try {
    daemon.proc.kill("SIGKILL");
  } catch {}
  await daemon.proc.exited;
  await stopTestChildren(stateDir);
  for (const d of dirs)
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

describe("bridge failure logging e2e", () => {
  const dirs = { data: "", agents: "", state: "" };
  let run: Awaited<ReturnType<typeof launch>>;
  let bot: Agent;

  beforeAll(async () => {
    dirs.data = tmp("brlog-data-");
    dirs.agents = tmp("brlog-agents-");
    dirs.state = tmp("brlog-fake-");
    run = await launch(dirs.data, dirs.agents, dirs.state, `brlog-${crypto.randomUUID()}`);
    bot = (await run.c.request("agents.create", {
      name: "Logger",
      provider: "devin",
      instructions: "",
    })) as Agent;
  });

  afterAll(() => stop(run.daemon, run.c, dirs.state, Object.values(dirs)));

  test("a failed built-in tool call is logged on daemon stderr", async () => {
    const text = await reply(run.c, bot.id, 'mcp:send_message {"to":"Nobody","text":"hi"}');
    expect(text).toStartWith("tool-error:");
    const line = await stderrEntry(run.log, "[upbotd] bridge tool failed", "send_message");
    expect(line).toContain(bot.id);
    expect(line).toContain('reason: "error"');
    expect(line).toContain("errorType:");
    expect(line).not.toContain("Nobody");
  }, 20_000);

  test("an app error echoing its credential is redacted for the bot and kept out of logs", async () => {
    const app = (await run.c.request("apps.connect", {
      catalogId: "custom-stdio",
      name: "Leaky",
      permissions: { write: "allow" },
      command: ["bun", FAKE_MCP],
      secrets: { FAKE_APP_TOKEN: APP_SECRET, FAKE_APP_LEAK: "leak-mode-on" },
      agentIds: [],
    })) as ConnectedApp;
    for (let i = 0; i < 100; i++) {
      const list = (await run.c.request("apps.list", {})) as ConnectedApp[];
      if (list.find((x) => x.id === app.id)?.status === "ready") break;
      await Bun.sleep(100);
    }
    const text = await reply(run.c, bot.id, "mcp:leaky-leak_token {}");
    expect(text).toStartWith("tool-error:");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain(APP_SECRET);
    const line = await stderrEntry(run.log, "[upbotd] bridge tool failed", "leaky-leak_token");
    expect(line).toContain("isApp: true");
    expect(line).toContain('errorType: "AppToolError"');
    expect(run.log.text).not.toContain(APP_SECRET);
  }, 30_000);
});

describe("bridge tools/list fallback logging e2e", () => {
  const dirs = { data: "", agents: "", state: "" };
  let run: Awaited<ReturnType<typeof launch>>;
  let bot: Agent;

  beforeAll(async () => {
    dirs.data = tmp("brlist-data-");
    dirs.agents = tmp("brlist-agents-");
    dirs.state = tmp("brlist-fake-");
    // A corrupt app row makes AppsService.toolsFor reject with a parse error that quotes it.
    const db = openDatabase(dirs.data);
    db.query(
      "INSERT INTO connected_apps (id, catalog_id, config_json, enabled, created_at) VALUES (?, ?, ?, 1, ?)",
    ).run("broken", "custom-stdio", `{"name": ${CONFIG_SECRET}}`, Date.now());
    db.close();
    run = await launch(dirs.data, dirs.agents, dirs.state, `brlist-${crypto.randomUUID()}`);
    bot = (await run.c.request("agents.create", {
      name: "Lister",
      provider: "devin",
      instructions: "",
    })) as Agent;
  });

  afterAll(() => stop(run.daemon, run.c, dirs.state, Object.values(dirs)));

  test("tools/list falls back to built-in tools and logs without the error text", async () => {
    const text = await reply(run.c, bot.id, "mcp-list");
    expect(text).toBe(`tools:${BRIDGE_TOOLS.map((t) => t.name).join(",")}`);
    const line = await stderrEntry(run.log, "[upbotd] bridge tools/list failed");
    expect(line).toContain(bot.id);
    expect(line).toContain('errorType: "SyntaxError"');
    expect(run.log.text).not.toContain(CONFIG_SECRET);
  }, 20_000);
});
