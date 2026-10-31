import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import type { Agent } from "@upbot/protocol";
import { findBrowser } from "../src/browser";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  startDaemon,
  stopDaemon,
  tmp,
  toolCall,
} from "./helpers";

const TOKEN = `br-test-${crypto.randomUUID()}`;
const hasBrowser = findBrowser() !== null;

describe.skipIf(!hasBrowser)("agent browser e2e (headless Chromium over CDP)", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  let a: Agent;
  let site: ReturnType<typeof Bun.serve>;

  const tool = (name: string, args: Record<string, unknown> = {}) =>
    toolCall(c, a, name, args, 60000);

  beforeAll(async () => {
    site = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const u = new URL(req.url);
        const page =
          u.pathname === "/result"
            ? `<title>Result</title><p>Result: ${u.searchParams.get("q")}</p><a href="/">Home</a>`
            : `<title>Search</title><form action="/result"><input name="q" placeholder="Query"><button>Go</button></form>`;
        return new Response(`<!doctype html><html><body>${page}</body></html>`, {
          headers: { "content-type": "text/html" },
        });
      },
    });
    dataDir = tmp("br-data-");
    agentsRoot = tmp("br-agents-");
    stateDir = tmp("br-fake-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      UPBOT_BROWSER_HEADLESS: "1",
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
    a = await c.request("agents.create", {
      name: "Surfer",
      provider: "devin",
      instructions: "",
    });
  });

  afterAll(async () => {
    await c?.request("browser.close", {}).catch(() => {});
    site?.stop(true);
    await stopDaemon(daemon, c, stateDir, "SIGTERM");
    for (const d of [dataDir, agentsRoot, stateDir])
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }, 20000);

  test("open, snapshot, type+submit, click, back, screenshot, close", async () => {
    const base = `http://127.0.0.1:${site.port}`;
    expect(await tool("browser_open", { url: `${base}/` })).toContain(
      `tool-ok:opened ${base}/ — Search`,
    );
    const snap = await tool("browser_snapshot");
    expect(snap).toContain('[1] input[text] "Query"');
    expect(snap).toContain('[2] button "Go"');
    expect(await tool("browser_type", { ref: 1, text: "hello world", submit: true })).toContain(
      "/result?q=hello+world",
    );
    expect(await tool("browser_snapshot")).toContain("Result: hello world");
    const st = await c.request("browser.status", {});
    expect(st).toMatchObject({ available: true, running: true });
    expect(st.tabs).toEqual([
      { agentId: a.id, url: `${base}/result?q=hello+world`, title: "Result" },
    ]);
    await tool("browser_snapshot");
    expect(await tool("browser_click", { ref: 1 })).toContain(`now at ${base}/`);
    expect(await tool("browser_back")).toContain("/result?q=hello+world");
    expect(await tool("browser_click", { ref: 99 })).toContain("tool-error:element [99] not found");
    const shot = await tool("browser_screenshot");
    const screenshot = /to (.+\.png)$/.exec(shot)?.[1];
    expect(screenshot?.startsWith(a.workspacePath)).toBe(true);
    expect(existsSync(screenshot!)).toBe(true);
    expect(await tool("browser_open", { url: "file:///etc/hosts" })).toContain(
      "tool-error:only http(s)",
    );
    expect(await tool("browser_close")).toBe("tool-ok:closed your tab");
    expect((await c.request("browser.status", {})).tabs).toEqual([]);
  }, 120000);
});
