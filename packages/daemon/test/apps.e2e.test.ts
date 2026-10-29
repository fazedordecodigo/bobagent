import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Agent, ChatItem, ConnectedApp, Turn } from "@upbot/protocol";
import { appToolNames } from "../src/apps";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  pidAlive,
  ROOT,
  startDaemon,
  stopTestChildren,
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
  let daemonStderr = "";
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
    const stderrReader = (daemon.proc.stderr as ReadableStream<Uint8Array>).getReader();
    const stderrDecoder = new TextDecoder();
    void (async () => {
      for (;;) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        daemonStderr += stderrDecoder.decode(value, { stream: true });
      }
    })().catch(() => {});
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
    await stopTestChildren(stateDir);
    for (const d of [dataDir, agentsRoot, stateDir])
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
      permissions: { write: "allow" },
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

  test("a failing stdio app surfaces its stderr tail in the error", async () => {
    const bad = (await c.request("apps.connect", {
      catalogId: "custom-stdio",
      name: "Bad App",
      command: [
        "bun",
        "-e",
        "console.error('boom-stderr-marker'); setTimeout(() => process.exit(1), 100)",
      ],
      secrets: {},
    })) as ConnectedApp;
    let failed: ConnectedApp | undefined;
    for (let i = 0; i < 100; i++) {
      const list = (await c.request("apps.list", {})) as ConnectedApp[];
      failed = list.find((x) => x.id === bad.id);
      if (failed?.status === "error") break;
      await Bun.sleep(100);
    }
    expect(failed?.status).toBe("error");
    expect(failed?.error).toContain("boom-stderr-marker");
    await c.request("apps.delete", { id: bad.id });
  });

  test("a long startup error retains the stderr tail within the error bound", async () => {
    const bad = (await c.request("apps.connect", {
      catalogId: "custom-stdio",
      name: "Long Error App",
      command: [
        "bun",
        "-e",
        String.raw`
console.error("long-stderr-marker");
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  const i = input.indexOf("\n");
  if (i < 0) return;
  const req = JSON.parse(input.slice(0, i));
  if (req.method !== "initialize") return;
  setTimeout(() => {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32000, message: "x".repeat(800) },
      }) + "\n",
    );
    setTimeout(() => process.exit(0), 25);
  }, 200);
});
`,
      ],
      secrets: {},
    })) as ConnectedApp;
    try {
      let failed: ConnectedApp | undefined;
      for (let i = 0; i < 100; i++) {
        const list = (await c.request("apps.list", {})) as ConnectedApp[];
        failed = list.find((x) => x.id === bad.id);
        if (failed?.status === "error") break;
        await Bun.sleep(100);
      }
      expect(failed?.status).toBe("error");
      expect(failed?.error).toContain("long-stderr-marker");
      expect(failed!.error!.length).toBeLessThanOrEqual(500);
    } finally {
      await c.request("apps.delete", { id: bad.id });
    }
  });

  test("redacts a credential split across stderr chunks", async () => {
    const secret = `splitcred-${crypto.randomUUID().replaceAll("-", "")}`;
    const firstHalf = secret.slice(0, Math.floor(secret.length / 2));
    const secondHalf = secret.slice(firstHalf.length);
    const bad = (await c.request("apps.connect", {
      catalogId: "custom-stdio",
      name: "Split Credential App",
      command: [
        "bun",
        "-e",
        "const token=process.env.SPLIT_TOKEN; const half=Math.floor(token.length/2); process.stderr.write('tok='+token.slice(0,half)); setTimeout(() => { process.stderr.write(token.slice(half)+'\\n'); setTimeout(() => process.exit(1),100); },150);",
      ],
      secrets: { SPLIT_TOKEN: secret },
    })) as ConnectedApp;
    try {
      let failed: ConnectedApp | undefined;
      for (let i = 0; i < 100; i++) {
        const list = (await c.request("apps.list", {})) as ConnectedApp[];
        failed = list.find((x) => x.id === bad.id);
        if (failed?.status === "error") break;
        await Bun.sleep(100);
      }
      const list = (await c.request("apps.list", {})) as ConnectedApp[];
      expect(failed?.status).toBe("error");
      expect(failed?.error).toContain("tok=[redacted]");
      expect(JSON.stringify(list)).not.toContain(firstHalf);
      expect(JSON.stringify(list)).not.toContain(secondHalf);
      expect(daemonStderr).not.toContain(firstHalf);
      expect(daemonStderr).not.toContain(secondHalf);
    } finally {
      await c.request("apps.delete", { id: bad.id });
    }
  });

  test("redacts the spawn credential after it is rotated during startup", async () => {
    const oldToken = `rotold-${crypto.randomUUID().replaceAll("-", "")}`;
    const newToken = `rotnew-${crypto.randomUUID().replaceAll("-", "")}`;
    const rotating = (await c.request("apps.connect", {
      catalogId: "custom-stdio",
      name: "Rotating Credential App",
      command: [
        "bun",
        "-e",
        "process.stderr.write('rot='+process.env.ROT_TOKEN+'\\n'); setTimeout(() => process.exit(1),1500);",
      ],
      secrets: { ROT_TOKEN: oldToken },
    })) as ConnectedApp;
    try {
      await c.request("apps.update", {
        id: rotating.id,
        secrets: { ROT_TOKEN: newToken },
      });
      let failedStarts = 0;
      for (let i = 0; i < 80; i++) {
        failedStarts = daemonStderr
          .split("[upbotd] app start failed")
          .slice(1)
          .filter((entry) => entry.includes(rotating.id)).length;
        if (failedStarts >= 2) break;
        await Bun.sleep(100);
      }
      const list = (await c.request("apps.list", {})) as ConnectedApp[];
      expect(failedStarts).toBeGreaterThanOrEqual(2);
      expect(daemonStderr).not.toContain(oldToken);
      expect(daemonStderr).not.toContain(newToken);
      expect(JSON.stringify(list)).not.toContain(oldToken);
      expect(JSON.stringify(list)).not.toContain(newToken);
    } finally {
      await c.request("apps.delete", { id: rotating.id });
    }
  });

  test("includes pending stderr on startup timeout and redacts its credential prefix", async () => {
    const timeoutDataDir = tmp("apps-timeout-data-");
    const timeoutAgentsRoot = tmp("apps-timeout-agents-");
    const timeoutStateDir = tmp("apps-timeout-state-");
    const timeoutToken = `apps-timeout-${crypto.randomUUID()}`;
    const timeoutDaemon = await startDaemon(
      timeoutDataDir,
      timeoutAgentsRoot,
      timeoutToken,
      {
        UPBOT_APP_START_TIMEOUT_MS: "1500",
        UPBOT_VAULT_KEY: "ef".repeat(32),
      },
    );
    const timeoutClient = await DaemonClient.connect(timeoutDaemon.port, timeoutToken);
    const stderrReader = (timeoutDaemon.proc.stderr as ReadableStream<Uint8Array>).getReader();
    let timeoutStderr = "";
    const stderrPump = (async () => {
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        timeoutStderr += decoder.decode(value, { stream: true });
      }
    })();
    const secret = `hangcred-${crypto.randomUUID().replaceAll("-", "")}`;
    const pidFile = join(timeoutStateDir, "pids.txt");
    let hungPid: number | undefined;
    let bad: ConnectedApp | undefined;
    try {
      bad = (await timeoutClient.request("apps.connect", {
        catalogId: "custom-stdio",
        name: "Hanging App",
        command: [
          "bun",
          "-e",
          `const {appendFileSync}=require("node:fs"); appendFileSync(${JSON.stringify(pidFile)},process.pid+"\\n"); process.stderr.write("hang-marker tok="+process.env.HANG_TOKEN.slice(0,12)); setInterval(()=>{},1000);`,
        ],
        secrets: { HANG_TOKEN: secret },
      })) as ConnectedApp;
      let failed: ConnectedApp | undefined;
      for (let i = 0; i < 100; i++) {
        const list = (await timeoutClient.request("apps.list", {})) as ConnectedApp[];
        failed = list.find((x) => x.id === bad!.id);
        if (failed?.status === "error") break;
        await Bun.sleep(100);
      }
      for (let i = 0; i < 20 && !timeoutStderr.includes("app start failed"); i++)
        await Bun.sleep(50);
      hungPid = Number(readFileSync(pidFile, "utf8").trim());
      const list = (await timeoutClient.request("apps.list", {})) as ConnectedApp[];
      expect(failed?.status).toBe("error");
      expect(timeoutStderr).toContain("app start failed");
      expect(failed?.error).toContain("hang-marker");
      expect(failed?.error).toContain("tok=[redacted]");
      const listed = JSON.stringify(list);
      for (let length = 4; length <= 12; length++) {
        expect(listed).not.toContain(secret.slice(0, length));
        expect(timeoutStderr).not.toContain(secret.slice(0, length));
      }
      await timeoutClient.request("apps.delete", { id: bad.id });
      for (let i = 0; i < 20 && pidAlive(hungPid); i++) await Bun.sleep(50);
      expect(pidAlive(hungPid)).toBe(false);
    } finally {
      if (bad) await timeoutClient.request("apps.delete", { id: bad.id }).catch(() => {});
      timeoutClient.close();
      try {
        timeoutDaemon.proc.kill("SIGKILL");
      } catch {}
      await timeoutDaemon.proc.exited;
      await stderrPump;
      await stopTestChildren(timeoutStateDir);
      for (const dir of [timeoutDataDir, timeoutAgentsRoot, timeoutStateDir])
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test("disable and delete", async () => {
    const off = (await c.request("apps.update", { id: app.id, enabled: false })) as ConnectedApp;
    expect(off.status).toBe("stopped");
    expect(await tool(a, "fake_app-echo", { text: "x" })).toContain("not available to you");
    await c.request("apps.delete", { id: app.id });
    expect(await c.request("apps.list", {})).toEqual([]);
  });
});
