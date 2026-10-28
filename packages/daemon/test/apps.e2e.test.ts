import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Agent, ChatItem, ConnectedApp, Turn } from "@upbot/protocol";
import { appToolNames } from "../src/apps";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  ROOT,
  readPids,
  startDaemon,
  tmp,
} from "./helpers";

const TOKEN = `apps-test-${crypto.randomUUID()}`;
const APP_SECRET = "fake-app-secret-987";
const FAKE_MCP = join(ROOT, "packages/daemon/test/fixtures/fake-mcp-server.ts");

describe("connected apps (MCP) e2e", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  let a: Agent;
  let b: Agent;
  let app: ConnectedApp;

  async function tool(agent: Agent, name: string, args: Record<string, unknown> = {}) {
    const { queueId } = (await c.request("chat.send", {
      agentId: agent.id,
      text: `mcp:${name} ${JSON.stringify(args)}`,
    })) as { queueId: string };
    const t = (await c.waitForEventWhere(
      "turn.ended",
      (d) => (d as Turn).queueId === queueId,
      30000,
    )) as Turn;
    const { items } = (await c.request("chat.history", { agentId: agent.id })) as {
      items: ChatItem[];
    };
    const msg = items.filter((i) => i.turnId === t.id && i.kind === "agent_message").pop();
    return msg && "text" in msg ? msg.text : "";
  }

  beforeAll(async () => {
    dataDir = tmp("apps-data-");
    agentsRoot = tmp("apps-agents-");
    stateDir = tmp("apps-fake-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      UPBOT_VAULT_KEY: "ef".repeat(32),
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
    a = (await c.request("agents.create", {
      name: "A",
      provider: "devin",
      instructions: "",
    })) as Agent;
    b = (await c.request("agents.create", {
      name: "B",
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
    for (const pid of readPids(stateDir)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    for (const d of [dataDir, agentsRoot, stateDir]) rmSync(d, { recursive: true, force: true });
  });

  test("catalog lists built-in apps; catalog apps require their secret", async () => {
    const cat = (await c.request("apps.catalog", {})) as { id: string }[];
    expect(cat.map((x) => x.id)).toEqual(
      expect.arrayContaining(["notion", "github", "brave-search"]),
    );
    await expect(c.request("apps.connect", { catalogId: "notion", secrets: {} })).rejects.toThrow(
      /Integration token is required/,
    );
  });

  test("a custom stdio app starts, lists tools and keeps its secret out of the UI", async () => {
    app = (await c.request("apps.connect", {
      catalogId: "custom-stdio",
      name: "Fake App",
      command: ["bun", FAKE_MCP],
      secrets: { FAKE_APP_TOKEN: APP_SECRET },
      agentIds: [a.id],
    })) as ConnectedApp;
    expect(app.slug).toBe("fake_app");
    const ready = (await c.waitForEventWhere("apps.changed", () => true, 15000)) as unknown;
    expect(ready).toBeDefined();
    let list: ConnectedApp[] = [];
    for (let i = 0; i < 100; i++) {
      list = (await c.request("apps.list", {})) as ConnectedApp[];
      if (list[0]?.status === "ready") break;
      await Bun.sleep(100);
    }
    expect(list[0]).toMatchObject({ status: "ready", secretKeys: ["FAKE_APP_TOKEN"] });
    expect(list[0]!.tools.map((t) => t.name)).toEqual([
      "echo",
      "whoami",
      "create_note",
      "foo__bar",
      "foo_bar",
    ]);
    expect(JSON.stringify(list)).not.toContain(APP_SECRET);
    const vault = (await c.request("vault.list", {})) as { name: string }[];
    expect(vault.some((v) => v.name.startsWith("app."))).toBe(false);
  });

  test("allowed bots call app tools through the bridge; secrets are redacted", async () => {
    expect(await tool(a, "fake_app-echo", { text: "hi" })).toBe("tool-ok:echo:hi");
    const who = await tool(a, "fake_app-whoami");
    expect(who).toContain("token-present:true");
    expect(who).not.toContain(APP_SECRET);
    const collisionNames = appToolNames("fake_app", [{ name: "foo__bar" }, { name: "foo_bar" }]);
    const doubleName = [...collisionNames].find(([, t]) => t.name === "foo__bar")?.[0];
    expect(await tool(a, "fake_app-foo_bar")).toBe("tool-ok:single-underscore");
    expect(doubleName).toMatch(/^fake_app-foo_bar_[0-9a-f]{6}$/);
    if (!doubleName) throw new Error("expected a disambiguated foo__bar tool name");
    expect(await tool(a, doubleName)).toBe("tool-ok:double-underscore");
    expect(await tool(b, "fake_app-echo", { text: "hi" })).toContain("not available to you");
    const log = readFileSync(join(stateDir, "log.jsonl"), "utf8");
    expect(log).not.toContain(APP_SECRET);
  });

  test("disable and delete", async () => {
    const off = (await c.request("apps.update", { id: app.id, enabled: false })) as ConnectedApp;
    expect(off.status).toBe("stopped");
    expect(await tool(a, "fake_app-echo", { text: "x" })).toContain("not available to you");
    await c.request("apps.delete", { id: app.id });
    expect(await c.request("apps.list", {})).toEqual([]);
  });
});
