import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Agent, ChatAttachment, ChatItem, Gateway, Turn } from "@upbot/protocol";
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

const TOKEN = `queue-meta-${crypto.randomUUID()}`;
type Json = Record<string, unknown>;

async function until<T>(fn: () => Promise<T | undefined>, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value !== undefined) return value;
    await Bun.sleep(50);
  }
  throw new Error("timed out");
}

describe("queue metadata e2e", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  let agent: Agent;
  let gateway: Gateway;
  let fake: ReturnType<typeof Bun.serve>;
  const sent: Json[] = [];
  let queueTime = Date.now();

  async function insertQueue(text: string, metaJson: string): Promise<string> {
    const id = crypto.randomUUID();
    const db = openDatabase(dataDir);
    try {
      db.query(
        "INSERT INTO queue (id, agent_id, text, status, created_at, hops, meta_json) VALUES (?, ?, ?, 'queued', ?, 0, ?)",
      ).run(id, agent.id, text, queueTime++, metaJson);
    } finally {
      db.close();
    }
    return id;
  }

  async function turnFor(queueId: string): Promise<Turn> {
    return (await c.waitForEventWhere(
      "turn.ended",
      (data) => (data as Turn).queueId === queueId,
      20000,
    )) as Turn;
  }

  async function userItem(turnId: string): Promise<Extract<ChatItem, { kind: "user_message" }>> {
    const { items } = (await c.request("chat.history", { agentId: agent.id })) as {
      items: ChatItem[];
    };
    return items.find((item) => item.turnId === turnId && item.kind === "user_message") as Extract<
      ChatItem,
      { kind: "user_message" }
    >;
  }

  beforeAll(async () => {
    fake = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const method = new URL(req.url).pathname.split("/").pop();
        if (method === "getMe") return Response.json({ ok: true, result: { id: 1, is_bot: true } });
        if (method === "getUpdates") {
          await Bun.sleep(100);
          return Response.json({ ok: true, result: [] });
        }
        if (method === "sendMessage") {
          sent.push((await req.json()) as Json);
          return Response.json({ ok: true, result: {} });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const base = `http://127.0.0.1:${fake.port}`;
    dataDir = tmp("queue-meta-data-");
    agentsRoot = tmp("queue-meta-agents-");
    stateDir = tmp("queue-meta-fake-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      UPBOT_VAULT_KEY: "cd".repeat(32),
      UPBOT_TELEGRAM_API: base,
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
    agent = (await c.request("agents.create", {
      name: "Queue Meta",
      provider: "devin",
      instructions: "",
    })) as Agent;
    gateway = (await c.request("gateways.create", {
      kind: "telegram",
      name: "Queue Meta Telegram",
      agentId: agent.id,
      tokens: { botToken: "TG-TOKEN" },
    })) as Gateway;
    await until(async () => {
      const list = (await c.request("gateways.list", {})) as Gateway[];
      return list.find((item) => item.id === gateway.id && item.status === "connected");
    });
  });

  afterAll(async () => {
    if (c) c.close();
    fake?.stop(true);
    if (daemon) {
      try {
        daemon.proc.kill("SIGKILL");
      } catch {}
      await daemon.proc.exited;
    }
    await stopTestChildren(stateDir);
    for (const dir of [dataDir, agentsRoot, stateDir])
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("keeps a valid gateway and attachment when another attachment is malformed", async () => {
    const attachment: ChatAttachment = {
      name: "valid.txt",
      mime: "text/plain",
      size: 3,
      path: "/tmp/valid.txt",
    };
    await c.request("queue.pause", { agentId: agent.id });
    const queueId = await insertQueue(
      "echo:still delivered",
      JSON.stringify({
        gateway: {
          id: gateway.id,
          kind: "telegram",
          name: gateway.name,
          chatId: "5001",
          userId: "9",
          userName: "u9",
        },
        attachments: [attachment, { name: "bad" }],
      }),
    );
    const ended = turnFor(queueId);
    await c.request("queue.resume", { agentId: agent.id });
    const turn = await ended;
    expect(turn.status).toBe("completed");
    const reply = await until(async () => sent.find((item) => item.chat_id === "5001"));
    expect(reply.text).toBe("still delivered");
    const item = await userItem(turn.id);
    expect(item.gateway?.chatId).toBe("5001");
    expect(item.attachments).toEqual([attachment]);
  });

  test("drops invalid gateway routing while preserving other queue metadata", async () => {
    await c.request("queue.pause", { agentId: agent.id });
    const queueId = await insertQueue(
      "echo:no destination",
      JSON.stringify({
        gateway: {
          id: gateway.id,
          kind: "telegram",
          name: gateway.name,
          userId: "9",
          userName: "u9",
        },
        routine: { id: "r1", name: "Nightly", trigger: "manual" },
      }),
    );
    const ended = turnFor(queueId);
    await c.request("queue.resume", { agentId: agent.id });
    const turn = await ended;
    expect(turn.status).toBe("completed");
    const item = await userItem(turn.id);
    expect(item.routine).toEqual({ id: "r1", name: "Nightly", trigger: "manual" });
    expect(item).not.toHaveProperty("gateway");
    await Bun.sleep(500);
    expect(sent.some((message) => message.text === "no destination")).toBe(false);
  });

  test("keeps corrupt-meta MCP approvals in the background and continues the queue", async () => {
    await c.request("approvals.setRules", {
      rules: [{ id: "queue-meta-ask", pattern: "list_agents", action: "ask", agentId: null }],
    });
    await c.request("queue.pause", { agentId: agent.id });
    const corruptId = await insertQueue("mcp:list_agents {}", "{not json");
    const nextId = await insertQueue("echo:after approval", "{}");
    const corruptEnded = turnFor(corruptId);
    const nextEnded = turnFor(nextId);
    await c.request("queue.resume", { agentId: agent.id });
    const approval = (await c.waitForEventWhere(
      "approval.updated",
      (data) =>
        (data as { status?: string; tool?: string }).status === "pending" &&
        (data as { tool?: string }).tool === "list_agents",
      20000,
    )) as { id: string; background: boolean; status: string };
    const approvals = (await c.request("approvals.list", {})) as {
      id: string;
      background: boolean;
      status: string;
    }[];
    expect(approvals.find((item) => item.id === approval.id)).toMatchObject({
      status: "pending",
      background: true,
    });
    await c.request("approvals.respond", { id: approval.id, decision: "deny" });
    expect((await corruptEnded).status).toBe("completed");
    const nextTurn = await nextEnded;
    expect(nextTurn.status).toBe("completed");
    expect((await userItem(nextTurn.id)).text).toBe("echo:after approval");
  });
});
