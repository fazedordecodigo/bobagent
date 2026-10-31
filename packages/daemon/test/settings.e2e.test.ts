import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Agent, ChatItem, Turn } from "@boto/protocol";
import { openDatabase } from "../src/db";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  startDaemon,
  stopTestChildren,
  tmp,
} from "./helpers";

setDefaultTimeout(30000);

const TOKEN = `settings-test-${crypto.randomUUID()}`;

function seedSettings(dataDir: string, rows: Record<string, string>): void {
  const db = openDatabase(dataDir);
  const insert = db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(rows)) insert.run(key, value);
  db.close();
}

describe("settings consumers e2e", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let marketDir: string;
  let marketIndex: string;
  let daemon: DaemonHandle | undefined;
  let c: DaemonClient | undefined;

  function getClient(): DaemonClient {
    if (!c) throw new Error("daemon client not connected");
    return c;
  }

  async function tool(agent: Agent, name: string, args: Record<string, unknown> = {}) {
    const client = getClient();
    const { queueId } = (await client.request("chat.send", {
      agentId: agent.id,
      text: `mcp:${name} ${JSON.stringify(args)}`,
    })) as { queueId: string };
    const turn = (await client.waitForEventWhere(
      "turn.ended",
      (d) => (d as Turn).queueId === queueId,
      30000,
    )) as Turn;
    const { items } = (await client.request("chat.history", { agentId: agent.id })) as {
      items: ChatItem[];
    };
    const msg = items.filter((i) => i.turnId === turn.id && i.kind === "agent_message").pop();
    return msg && "text" in msg ? msg.text : "";
  }

  beforeAll(async () => {
    dataDir = tmp("settings-data-");
    agentsRoot = tmp("settings-agents-");
    stateDir = tmp("settings-fake-");
    marketDir = tmp("settings-market-");
    marketIndex = pathToFileURL(join(marketDir, "index.json")).href;
    writeFileSync(join(marketDir, "index.json"), JSON.stringify({ items: [] }));
    seedSettings(dataDir, {
      mobile: '{"enabled":"yes"}',
      team: '{"url":5}',
      default_bot_seeded: "not-json",
      approval_rules: '[{"pattern":5}]',
      computer_use_agents: '{"a":1}',
      marketplace_sources: '"x"',
    });
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      BOTO_DEFAULT_BOT: "",
      BOTO_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      BOTO_MOBILE_HOST: "127.0.0.1",
      BOTO_VAULT_KEY: "12".repeat(32),
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
  });

  afterAll(async () => {
    c?.close();
    if (daemon) {
      try {
        daemon.proc.kill("SIGKILL");
      } catch {}
      await daemon.proc.exited;
    }
    await stopTestChildren(stateDir);
    for (const dir of [dataDir, agentsRoot, stateDir, marketDir])
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("starts despite malformed startup settings and repairs mobile/team settings", async () => {
    expect(await getClient().request("agents.list", {})).toEqual([]);
    expect(await getClient().request("mobile.status", {})).toEqual({
      enabled: false,
      urls: [],
      devices: [],
    });
    await expect(getClient().request("team.status", {})).rejects.toMatchObject({
      code: "internal",
      message: expect.stringMatching(/settings\.team/),
    });
    expect(await getClient().request("team.disconnect", {})).toEqual({ ok: true });
    expect(
      ((await getClient().request("team.status", {})) as { configured: boolean }).configured,
    ).toBe(false);

    const db = openDatabase(dataDir);
    db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("team", '{"url":5}');
    db.close();
    expect(
      await getClient().request("team.connect", {
        url: "http://127.0.0.1:1",
        token: "team-test-token",
      }),
    ).toMatchObject({ configured: true, sharedAgentIds: [] });
    await getClient().request("team.disconnect", {});

    const enabled = (await getClient().request("mobile.enable", { enabled: true })) as {
      enabled: boolean;
      urls: string[];
    };
    expect(enabled.enabled).toBe(true);
    expect(enabled.urls).toHaveLength(1);
    expect(await getClient().request("mobile.enable", { enabled: false })).toMatchObject({
      enabled: false,
      urls: [],
    });
  });

  test("surfaces corrupt consumer settings over RPC and permits explicit repair", async () => {
    await expect(getClient().request("approvals.rules", {})).rejects.toMatchObject({
      code: "internal",
      message: expect.stringMatching(/settings\.approval_rules/),
    });
    const agent = (await getClient().request("agents.create", {
      name: "Settings",
      provider: "devin",
      instructions: "",
    })) as Agent;
    expect(await tool(agent, "list_agents", {})).toMatch(/settings\.approval_rules/);
    await getClient().request("approvals.setRules", { rules: [] });
    expect(await tool(agent, "list_agents", {})).not.toMatch(/settings\.approval_rules/);

    await expect(getClient().request("computer.access", {})).rejects.toMatchObject({
      code: "internal",
      message: expect.stringMatching(/settings\.computer_use_agents/),
    });
    await getClient().request("computer.setAccess", { agentIds: [] });
    expect(await getClient().request("computer.access", {})).toMatchObject({ agentIds: [] });

    await expect(getClient().request("marketplace.list", {})).rejects.toMatchObject({
      code: "internal",
      message: expect.stringMatching(/settings\.marketplace_sources/),
    });
    await getClient().request("marketplace.setSources", { urls: [marketIndex] });
    expect(await getClient().request("marketplace.list", {})).toMatchObject({
      sources: [marketIndex],
      items: [],
      errors: [],
    });
  });
});

describe("malformed mobile setting e2e", () => {
  let dataDir: string;
  let agentsRoot: string;
  let daemon: DaemonHandle | undefined;
  let c: DaemonClient | undefined;
  const token = `settings-malformed-${crypto.randomUUID()}`;

  function getClient(): DaemonClient {
    if (!c) throw new Error("daemon client not connected");
    return c;
  }

  beforeAll(async () => {
    dataDir = tmp("settings-malformed-data-");
    agentsRoot = tmp("settings-malformed-agents-");
    seedSettings(dataDir, { mobile: "not-json" });
    daemon = await startDaemon(dataDir, agentsRoot, token, {
      BOTO_MOBILE_HOST: "127.0.0.1",
    });
    c = await DaemonClient.connect(daemon.port, token);
  });

  afterAll(async () => {
    c?.close();
    if (daemon) {
      try {
        daemon.proc.kill("SIGKILL");
      } catch {}
      await daemon.proc.exited;
    }
    for (const dir of [dataDir, agentsRoot])
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("starts with mobile disabled when stored JSON is malformed", async () => {
    expect(await getClient().request("mobile.status", {})).toEqual({
      enabled: false,
      urls: [],
      devices: [],
    });
  });
});
