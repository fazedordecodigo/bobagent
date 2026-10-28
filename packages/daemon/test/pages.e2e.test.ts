import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, ChatItem, Page, Turn } from "@upbot/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  startDaemon,
  stopTestChildren,
  tmp,
} from "./helpers";

const TOKEN = `pages-test-${crypto.randomUUID()}`;

describe("pages e2e", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  let a: Agent;

  async function tool(agent: Agent, name: string, args: Record<string, unknown> = {}) {
    const { queueId } = (await c.request("chat.send", {
      agentId: agent.id,
      text: `mcp:${name} ${JSON.stringify(args)}`,
    })) as { queueId: string };
    const t = (await c.waitForEventWhere(
      "turn.ended",
      (d) => (d as Turn).queueId === queueId,
      20000,
    )) as Turn;
    const { items } = (await c.request("chat.history", { agentId: agent.id })) as {
      items: ChatItem[];
    };
    const msg = items.filter((i) => i.turnId === t.id && i.kind === "agent_message").pop();
    return msg && "text" in msg ? msg.text : "";
  }

  beforeAll(async () => {
    dataDir = tmp("pages-data-");
    agentsRoot = tmp("pages-root-");
    stateDir = tmp("pages-fake-");
    daemon = await startDaemon(dataDir, join(agentsRoot, "agents"), TOKEN, {
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
    a = (await c.request("agents.create", {
      name: "A",
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

  test("a bot publishes, revises and lists pages; the UI gets a token-protected URL", async () => {
    const out = await tool(a, "page_publish", {
      title: "Q3 report",
      description: "numbers",
      html: "<!doctype html><h1>Q3</h1>",
    });
    expect(out).toContain('published "Q3 report"');
    const [page] = (await c.request("pages.list", {})) as Page[];
    expect(page).toMatchObject({ title: "Q3 report", version: 1, agentId: a.id });
    expect(page!.path).toBe(join(agentsRoot, "Workspace", "Pages", page!.id, "index.html"));
    const res = await fetch(page!.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await res.text()).toContain("<h1>Q3</h1>");
    expect((await fetch(page!.url.replace(/token=\w+/, "token=nope"))).status).toBe(401);

    writeFileSync(join(a.workspacePath, "v2.html"), "<h1>Q3 v2</h1>");
    await tool(a, "page_publish", { id: page!.id, file: "v2.html" });
    const [v2] = (await c.request("pages.list", {})) as Page[];
    expect(v2!.version).toBe(2);
    expect(await (await fetch(v2!.url)).text()).toContain("v2");
    expect(
      existsSync(join(agentsRoot, "Workspace", "Pages", page!.id, ".history", "v1.html")),
    ).toBe(true);
    expect(await tool(a, "read_page", { id: page!.id })).toContain("Q3 v2");
    expect(JSON.parse((await tool(a, "list_pages")).replace(/^tool-ok:/, ""))[0]).toMatchObject({
      title: "Q3 report",
      by: "A",
    });
  });

  test("files outside the workspaces are rejected; delete removes the files", async () => {
    const outsideFile = join(dataDir, "outside.txt");
    writeFileSync(outsideFile, "outside");
    expect(await tool(a, "page_publish", { title: "x", file: outsideFile })).toContain(
      "must be inside your workspace",
    );
    const [page] = (await c.request("pages.list", {})) as Page[];
    await c.request("pages.delete", { id: page!.id });
    expect(existsSync(join(agentsRoot, "Workspace", "Pages", page!.id))).toBe(false);
    expect(await c.request("pages.list", {})).toEqual([]);
  });
});
