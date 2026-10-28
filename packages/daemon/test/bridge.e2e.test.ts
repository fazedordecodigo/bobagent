import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, ChatItem, Turn } from "@upbot/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  readLog,
  readPids,
  startDaemon,
  tmp,
} from "./helpers";

const TOKEN = `bridge-test-${crypto.randomUUID()}`;

describe("agent-to-agent bridge e2e", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let sharedRoot: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  let alice: Agent;
  let bob: Agent;

  const newAgent = async (name: string) =>
    (await c.request("agents.create", { name, provider: "devin", instructions: "" })) as Agent;

  async function turn(agentId: string, text: string): Promise<Turn> {
    const { queueId } = (await c.request("chat.send", { agentId, text })) as { queueId: string };
    return (await c.waitForEventWhere(
      "turn.ended",
      (d) => (d as Turn).queueId === queueId,
      20000,
    )) as Turn;
  }

  const items = async (agentId: string) =>
    ((await c.request("chat.history", { agentId })) as { items: ChatItem[] }).items;

  async function lastText(agentId: string): Promise<string> {
    const msgs = (await items(agentId)).filter((i) => i.kind === "agent_message");
    const last = msgs[msgs.length - 1];
    return last && "text" in last ? last.text : "";
  }

  /** Waits for a turn on `agentId` that started from a message by another agent. */
  function nextIncoming(agentId: string): Promise<Turn> {
    return c.waitForEventWhere(
      "turn.ended",
      (d) => (d as Turn).agentId === agentId,
      20000,
    ) as Promise<Turn>;
  }

  beforeAll(async () => {
    dataDir = tmp("br-data-");
    agentsRoot = tmp("br-agents-");
    stateDir = tmp("br-fake-");
    sharedRoot = tmp("br-shared-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      UPBOT_SHARED_ROOT: sharedRoot,
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
    alice = await newAgent("Alice");
    bob = await newAgent("Bob");
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
    for (const d of [dataDir, agentsRoot, stateDir, sharedRoot]) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("sessions get a upbot MCP server with a per-agent token", async () => {
    await turn(alice.id, "echo:hi");
    const news = readLog(stateDir).filter((l) => l.method === "session/new");
    const spec = (
      news[news.length - 1]!.params as {
        mcpServers: { name: string; env: { name: string; value: string }[] }[];
      }
    ).mcpServers[0]!;
    expect(spec.name).toBe("upbot");
    const tokenVar = spec.env.find((e) => e.name === "UPBOT_BRIDGE_TOKEN")!;
    expect(tokenVar.value.length).toBeGreaterThan(20);
    expect(tokenVar.value).not.toBe(TOKEN);
  });

  test("list_agents shows peers and marks self", async () => {
    await turn(alice.id, "mcp:list_agents {}");
    const text = await lastText(alice.id);
    expect(text.startsWith("tool-ok:")).toBe(true);
    const list = JSON.parse(text.slice(8)) as { name: string; you: boolean }[];
    expect(list.find((a) => a.name === "Bob")?.you).toBe(false);
    expect(list.find((a) => a.name === "Alice")?.you).toBe(true);
  });

  test("send_message queues a turn on the recipient, marked with the sender", async () => {
    const incoming = nextIncoming(bob.id);
    await turn(alice.id, 'mcp:send_message {"to":"bob","text":"echo:hello from alice"}');
    expect(await lastText(alice.id)).toContain("queued for Bob");
    expect((await incoming).status).toBe("completed");
    const bobItems = await items(bob.id);
    const user = bobItems.filter((i) => i.kind === "user_message").pop();
    expect(user && "from" in user ? user.from : null).toEqual({ agentId: alice.id, name: "Alice" });
    expect(await lastText(bob.id)).toBe("hello from alice");
    const prompts = readLog(stateDir).filter((l) => l.method === "session/prompt");
    const raw = JSON.stringify(prompts[prompts.length - 1]!.params);
    expect(raw).toContain("agent_message_context");
  });

  test("replies chain back to the sender", async () => {
    const back = c.waitForEventWhere(
      "item.created",
      (d) => {
        const i = d as ChatItem;
        return (
          i.agentId === alice.id &&
          i.kind === "user_message" &&
          "from" in i &&
          i.from?.name === "Bob"
        );
      },
      20000,
    );
    const inner = JSON.stringify({ to: "Alice", text: "echo:pong" });
    await turn(
      alice.id,
      `mcp:send_message ${JSON.stringify({ to: "Bob", text: `mcp:send_message ${inner}` })}`,
    );
    await back;
    await c.waitForEventWhere("turn.ended", (d) => (d as Turn).agentId === alice.id, 20000);
    expect(await lastText(alice.id)).toBe("pong");
  });

  test("unknown recipient and empty text are tool errors", async () => {
    await turn(alice.id, 'mcp:send_message {"to":"Nobody","text":"x"}');
    expect(await lastText(alice.id)).toContain("tool-error:no agent named");
    await turn(alice.id, 'mcp:send_message {"to":"Alice","text":"x"}');
    expect(await lastText(alice.id)).toContain("tool-error:");
  });

  test("share_file copies into the recipient workspace with a sha256 manifest", async () => {
    const content = `report ${crypto.randomUUID()}\n`;
    writeFileSync(join(alice.workspacePath, "report.txt"), content);
    const incoming = nextIncoming(bob.id);
    await turn(alice.id, 'mcp:share_file {"to":"Bob","path":"report.txt","note":"please review"}');
    const text = await lastText(alice.id);
    expect(text.startsWith("tool-ok:")).toBe(true);
    const r = JSON.parse(text.slice(8)) as { transferId: string; sha256: string; path: string };
    const sha = createHash("sha256").update(content).digest("hex");
    expect(r.sha256).toBe(sha);
    expect(readFileSync(join(bob.workspacePath, r.path), "utf8")).toBe(content);
    const manifest = JSON.parse(
      readFileSync(join(sharedRoot, "Transfers", r.transferId, "manifest.json"), "utf8"),
    );
    expect(manifest.file.sha256).toBe(sha);
    expect(manifest.note).toBe("please review");
    expect(existsSync(join(sharedRoot, "Transfers", r.transferId, "report.txt"))).toBe(true);
    await incoming;
    const user = (await items(bob.id)).filter((i) => i.kind === "user_message").pop();
    expect(user && "text" in user ? user.text : "").toContain(r.path);
  });

  test("share_file refuses paths outside the workspace", async () => {
    const before = existsSync(join(sharedRoot, "Transfers"))
      ? readdirSync(join(sharedRoot, "Transfers")).length
      : 0;
    const outsideFile = join(dataDir, "outside.txt");
    writeFileSync(outsideFile, "outside");
    await turn(alice.id, `mcp:share_file ${JSON.stringify({ to: "Bob", path: outsideFile })}`);
    expect(await lastText(alice.id)).toContain("tool-error:only files inside your workspace");
    expect(readdirSync(join(sharedRoot, "Transfers")).length).toBe(before);
  });

  test("bridge endpoint rejects bad tokens and browser origins", async () => {
    const url = `http://127.0.0.1:${daemon.port}/bridge`;
    const body = JSON.stringify({ method: "tools/list" });
    expect(
      (await fetch(url, { method: "POST", body, headers: { authorization: "Bearer nope" } }))
        .status,
    ).toBe(401);
    expect(
      (await fetch(url, { method: "POST", body, headers: { authorization: `Bearer ${TOKEN}` } }))
        .status,
    ).toBe(401);
    expect(
      (await fetch(url, { method: "POST", body, headers: { origin: "http://evil.test" } })).status,
    ).toBe(403);
  });
});
