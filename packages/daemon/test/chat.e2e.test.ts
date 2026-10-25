import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Agent, ChatItem, PendingPermission, Turn } from "@upbot/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  pidAlive,
  readLog,
  readPids,
  startDaemon,
  tmp,
  waitForExit,
  waitForPidDead,
} from "./helpers";

const TOKEN = `chat-test-${crypto.randomUUID()}`;

describe("chat e2e (fake acp agent)", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;

  async function newAgent(name: string, provider: string, instructions = ""): Promise<Agent> {
    return (await c.request("agents.create", { name, provider, instructions })) as Agent;
  }

  async function send(agentId: string, text: string): Promise<string> {
    const res = (await c.request("chat.send", { agentId, text })) as { queueId: string };
    (lastQueueId.get(agentId) ?? lastQueueId.set(agentId, []).get(agentId)!).push(res.queueId);
    return res.queueId;
  }

  const lastQueueId = new Map<string, string[]>();
  async function waitTurnEnd(agentId: string, timeout = 15000, queueId?: string): Promise<Turn> {
    const qid = queueId ?? lastQueueId.get(agentId)?.shift();
    return (await c.waitForEventWhere(
      "turn.ended",
      (d) => (d as Turn).agentId === agentId && (qid === undefined || (d as Turn).queueId === qid),
      timeout,
    )) as Turn;
  }

  async function history(agentId: string): Promise<{
    items: ChatItem[];
    turns: Turn[];
    hasMore: boolean;
  }> {
    return (await c.request("chat.history", { agentId })) as never;
  }

  beforeAll(async () => {
    dataDir = tmp("oa2-data-");
    agentsRoot = tmp("oa2-agents-");
    stateDir = tmp("oa2-fake-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      UPBOT_ACP_COMMAND_CURSOR: JSON.stringify(["bun", FAKE_AGENT]),
      UPBOT_ACP_COMMAND_GROK: JSON.stringify(["bun", FAKE_AGENT]),
      UPBOT_ACP_COMMAND_GEMINI: JSON.stringify(["definitely-not-a-binary-oa"]),
      UPBOT_CANCEL_GRACE_MS: "1000",
      FAKE_ACP_STATE_DIR: stateDir,
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
  });

  afterAll(() => {
    c?.close();
    try {
      daemon.proc.kill("SIGKILL");
    } catch {}
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(agentsRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("echo: streams chunks, ends completed, history + idle status", async () => {
    const agent = await newAgent("Echo", "devin");
    const base = c.events.length;
    await send(agent.id, "echo:hello world");
    const turn = await waitTurnEnd(agent.id);
    expect(turn.status).toBe("completed");
    expect(turn.stopReason).toBe("end_turn");

    const kinds = c.events.slice(base).map((e) => e.event);
    const iStarted = kinds.indexOf("turn.started");
    const iUser = kinds.indexOf("item.created");
    const iAgentMsg = kinds.indexOf("item.created", iUser + 1);
    const iDelta = kinds.indexOf("item.delta");
    const iEnded = kinds.indexOf("turn.ended");
    expect(iStarted).toBeGreaterThanOrEqual(0);
    expect(iUser).toBeGreaterThan(iStarted);
    expect(iAgentMsg).toBeGreaterThan(iUser);
    expect(iDelta).toBeGreaterThan(iAgentMsg);
    expect(iEnded).toBeGreaterThan(iDelta);
    expect(kinds.filter((k) => k === "item.delta").length).toBe(2);

    const h = await history(agent.id);
    expect(h.items.length).toBe(2);
    expect(h.items[0]).toMatchObject({ kind: "user_message", text: "echo:hello world" });
    expect(h.items[1]).toMatchObject({ kind: "agent_message", text: "hello world" });
    expect(h.turns[0]?.status).toBe("completed");

    const statuses = (await c.request("agents.statuses", {})) as Record<string, { status: string }>;
    expect(statuses[agent.id]?.status).toBe("idle");

    // env leak check: the provider child saw no UPBOT_* var and no token
    const envDump = JSON.parse(readFileSync(join(stateDir, "env.json"), "utf8")) as {
      keys: string[];
      env: Record<string, string>;
    };
    expect(envDump.keys.some((k) => k.startsWith("UPBOT_"))).toBe(false);
    expect(JSON.stringify(envDump.env)).not.toContain(TOKEN);
  });

  test("instructions prefix on first prompt of a new session only", async () => {
    const agent = await newAgent("Instructed", "devin", "Always answer in lowercase.");
    await send(agent.id, "echo:hi");
    await waitTurnEnd(agent.id);

    const log = readLog(stateDir);
    const prompts = log
      .filter((l) => l.method === "session/prompt")
      .map((l) => (l.params as { prompt: { text: string }[] }).prompt[0]?.text ?? "");
    expect(prompts[prompts.length - 1]).toMatch(/^<upbot_context>\n/);
    expect(prompts[prompts.length - 1]).toMatch(/Shared workspace for all bots: .*Workspace/);
    expect(prompts[prompts.length - 1]).toContain("<agent_instructions>\n");
    expect(prompts[prompts.length - 1]).toContain("Always answer in lowercase.");

    const h = await history(agent.id);
    const userItem = h.items.find((i) => i.kind === "user_message");
    expect(userItem).toMatchObject({ text: "echo:hi" });

    await send(agent.id, "echo:yo");
    await waitTurnEnd(agent.id);
    const prompts2 = readLog(stateDir)
      .filter((l) => l.method === "session/prompt")
      .map((l) => (l.params as { prompt: { text: string }[] }).prompt[0]?.text ?? "");
    expect(prompts2[prompts2.length - 1]).not.toContain("<agent_instructions>");
  });

  test("permission flow: requested, listed, respond, resolved", async () => {
    const agent = await newAgent("Perm", "devin");
    await send(agent.id, "tool");
    const pending = (await c.waitForEventWhere(
      "permission.requested",
      (d) => (d as PendingPermission).agentId === agent.id,
    )) as PendingPermission;
    expect(pending.options.length).toBe(4);

    const list = (await c.request("permissions.list", {})) as PendingPermission[];
    expect(list.some((p) => p.requestId === pending.requestId)).toBe(true);

    // status while awaiting
    const st = (await c.request("agents.statuses", {})) as Record<string, { status: string }>;
    expect(st[agent.id]?.status).toBe("awaiting_permission");

    // bad optionId -> bad_request, still pending
    await expect(
      c.request("permissions.respond", { requestId: pending.requestId, optionId: "nope" }),
    ).rejects.toMatchObject({ code: "bad_request" });

    await c.request("permissions.respond", {
      requestId: pending.requestId,
      optionId: "allow_once",
    });
    const resolved = (await c.waitForEventWhere(
      "permission.resolved",
      (d) => (d as { requestId: string }).requestId === pending.requestId,
    )) as { optionId: string };
    expect(resolved.optionId).toBe("allow_once");

    const turn = await waitTurnEnd(agent.id);
    expect(turn.status).toBe("completed");

    const h = await history(agent.id);
    const permItem = h.items.find((i) => i.kind === "permission");
    expect(permItem).toMatchObject({ resolution: { optionId: "allow_once" } });
    const toolItem = h.items.find((i) => i.kind === "tool_call");
    expect(toolItem).toMatchObject({ status: "completed" });
    const lastMsg = h.items[h.items.length - 1];
    expect(lastMsg).toMatchObject({ kind: "agent_message", text: "permission:allow_once" });

    // respond again -> not_found
    await expect(
      c.request("permissions.respond", { requestId: pending.requestId, optionId: "allow_once" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("cancel: during slow, during permission, ignorecancel kills after grace", async () => {
    // cancel during slow
    const agent = await newAgent("CancelSlow", "devin");
    await send(agent.id, "slow");
    await c.waitForEventWhere("item.delta", (d) => (d as { agentId: string }).agentId === agent.id);
    await c.request("chat.cancel", { agentId: agent.id });
    const t1 = await waitTurnEnd(agent.id);
    expect(t1.status).toBe("cancelled");

    // cancel while a permission is pending
    await send(agent.id, "tool");
    const pending = (await c.waitForEventWhere(
      "permission.requested",
      (d) => (d as PendingPermission).agentId === agent.id,
    )) as PendingPermission;
    await c.request("chat.cancel", { agentId: agent.id });
    const resolved = (await c.waitForEventWhere(
      "permission.resolved",
      (d) => (d as { requestId: string }).requestId === pending.requestId,
    )) as { optionId: string | null };
    expect(resolved.optionId).toBe(null);
    const t2 = await waitTurnEnd(agent.id);
    expect(t2.status).toBe("cancelled");

    // ignorecancel: grace timer kills the process (session is reused from
    // the tool turn, so no new pid is spawned)
    const pid = readPids(stateDir)[readPids(stateDir).length - 1]!;
    await send(agent.id, "ignorecancel");
    await c.waitForEventWhere("turn.started", (d) => (d as Turn).agentId === agent.id);
    await c.request("chat.cancel", { agentId: agent.id });
    const t3 = await waitTurnEnd(agent.id, 10000);
    expect(t3.status).toBe("cancelled");
    await waitForPidDead(pid);
  });

  test("send during a running turn enqueues instead of busy", async () => {
    const agent = await newAgent("Busy", "devin");
    await send(agent.id, "slow");
    await c.waitForEventWhere("turn.started", (d) => (d as Turn).agentId === agent.id);
    const res = (await c.request("chat.send", { agentId: agent.id, text: "echo:x" })) as {
      queueId: string;
    };
    expect(res.queueId).toBeTruthy();
    await c.request("chat.cancel", { agentId: agent.id });
    await waitTurnEnd(agent.id);
    // user cancel pauses the queue while items remain
    const q = (await c.request("queue.get", { agentId: agent.id })) as {
      paused: boolean;
      items: { id: string }[];
    };
    expect(q.paused).toBe(true);
    expect(q.items.length).toBe(1);
    // resume drains it
    await c.request("queue.resume", { agentId: agent.id });
    await waitTurnEnd(agent.id);
  });

  test("queue: order, remove, pause-on-stop, resume", async () => {
    const agent = await newAgent("Queue", "devin");
    await send(agent.id, "slow");
    await c.waitForEventWhere("turn.started", (d) => (d as Turn).agentId === agent.id);
    const ids: string[] = [];
    for (const t of ["echo:a", "echo:b", "echo:c"]) {
      const r = (await c.request("chat.send", { agentId: agent.id, text: t })) as {
        queueId: string;
      };
      ids.push(r.queueId);
      (lastQueueId.get(agent.id) ?? lastQueueId.set(agent.id, []).get(agent.id)!).push(r.queueId);
    }
    let q = (await c.request("queue.get", { agentId: agent.id })) as {
      paused: boolean;
      items: { id: string; text: string }[];
    };
    expect(q.items.length).toBe(3);
    await c.request("queue.remove", { queueId: ids[1]! });
    await c.request("chat.cancel", { agentId: agent.id });
    await waitTurnEnd(agent.id);
    q = (await c.request("queue.get", { agentId: agent.id })) as typeof q;
    expect(q.paused).toBe(true);
    expect(q.items.map((i) => i.text)).toEqual(["echo:a", "echo:c"]);
    await c.request("queue.resume", { agentId: agent.id });
    await waitTurnEnd(agent.id, 15000, ids[0]!); // a
    await waitTurnEnd(agent.id, 15000, ids[2]!); // c
    const prompts = readLog(stateDir)
      .filter((l) => l.method === "session/prompt")
      .map((l) => (l.params as { prompt: { text: string }[] }).prompt[0]?.text ?? "");
    // first prompt of the new session may carry a handoff/instructions prefix
    const seen = prompts.map((p) => p.match(/echo:[abc]$/)?.[0]).filter((p): p is string => !!p);
    expect(seen).toEqual(["echo:a", "echo:c"]);
  });

  test("queue: pause while idle then resume", async () => {
    const agent = await newAgent("Paused", "devin");
    await c.request("queue.pause", { agentId: agent.id });
    await send(agent.id, "echo:p");
    await expect(
      c.waitForEventWhere("turn.started", (d) => (d as Turn).agentId === agent.id, 500),
    ).rejects.toThrow();
    await c.request("queue.resume", { agentId: agent.id });
    const t = await waitTurnEnd(agent.id);
    expect(t.status).toBe("completed");
  });

  test("queue: failed turn auto-pauses with items kept", async () => {
    const agent = await newAgent("Crasher", "devin");
    await send(agent.id, "crash");
    await send(agent.id, "echo:q");
    const t = await waitTurnEnd(agent.id);
    expect(t.status).toBe("failed");
    const q = (await c.request("queue.get", { agentId: agent.id })) as {
      paused: boolean;
      items: { text: string }[];
    };
    expect(q.paused).toBe(true);
    expect(q.items.map((i) => i.text)).toEqual(["echo:q"]);
  });

  test("queue: kill -9 leaves started item alone, queued item runs after restart", async () => {
    const agent = await newAgent("K9", "devin");
    await send(agent.id, "slow");
    await c.waitForEventWhere("turn.started", (d) => (d as Turn).agentId === agent.id);
    const qx = await send(agent.id, "echo:x");
    daemon.proc.kill("SIGKILL");
    await daemon.proc.exited;
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      UPBOT_ACP_COMMAND_CURSOR: JSON.stringify(["bun", FAKE_AGENT]),
      UPBOT_ACP_COMMAND_GROK: JSON.stringify(["bun", FAKE_AGENT]),
      UPBOT_ACP_COMMAND_GEMINI: JSON.stringify(["definitely-not-a-binary-oa"]),
      UPBOT_CANCEL_GRACE_MS: "1000",
      FAKE_ACP_STATE_DIR: stateDir,
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
    const h = (await c.request("chat.history", { agentId: agent.id })) as {
      turns: Turn[];
      items: ChatItem[];
    };
    expect(h.turns.some((t) => t.status === "interrupted")).toBe(true);
    // queued echo:x drains automatically; slow's started item never re-runs
    const t2 = await waitTurnEnd(agent.id, 15000, qx);
    expect(t2.status).toBe("completed");
    const prompts = readLog(stateDir)
      .filter((l) => l.method === "session/prompt")
      .map((l) => (l.params as { prompt: { text: string }[] }).prompt[0]?.text ?? "");
    // slow's started queue item must not re-run; echo:x drains (possibly prefixed)
    expect(prompts.filter((p) => p.endsWith("slow")).length).toBeLessThanOrEqual(1);
    expect(prompts.some((p) => p.endsWith("echo:x"))).toBe(true);
  });

  test("config: configOptions, setConfig persistence, busy, invalid, defaults", async () => {
    const agent = await newAgent("Cfg", "devin");
    const opts = (await c.request("agents.configOptions", { agentId: agent.id })) as {
      configOptions: { id: string; category: string | null; options: { value: string }[] }[];
    };
    const ids = opts.configOptions.map((o) => o.id);
    expect(ids).toEqual(expect.arrayContaining(["mode", "model"]));

    const updatedP = c.waitForEventWhere("agent.updated", () => true, 5000);
    const r = (await c.request("agents.setConfig", {
      agentId: agent.id,
      configId: "model",
      value: "m2",
    })) as { configOptions: { id: string; currentValue: string }[] };
    await updatedP;
    expect(r.configOptions.find((o) => o.id === "model")?.currentValue).toBe("m2");
    const list = (await c.request("agents.list", {})) as Agent[];
    expect(list.find((a) => a.id === agent.id)?.config.model).toBe("m2");
    await expect(
      c.request("agents.setConfig", { agentId: agent.id, configId: "model", value: "zzz" }),
    ).rejects.toMatchObject({ code: "bad_request" });

    await send(agent.id, "slow");
    await c.waitForEventWhere("turn.started", (d) => (d as Turn).agentId === agent.id);
    await expect(
      c.request("agents.setConfig", { agentId: agent.id, configId: "model", value: "m1" }),
    ).rejects.toMatchObject({ code: "busy" });
    await c.request("chat.cancel", { agentId: agent.id });
    await waitTurnEnd(agent.id);

    // DEFAULT_MODE applied to devin since user never set mode: fake got mode=accept-edits
    const sets = readLog(stateDir)
      .filter((l) => l.method === "session/set_config_option")
      .map((l) => l.params as { configId: string; value: string });
    expect(sets.some((s) => s.configId === "model" && s.value === "m2")).toBe(true);
    expect(sets.some((s) => s.configId === "mode" && s.value === "accept-edits")).toBe(true);

    // switchmodel: agent-side config_option_update is broadcast
    const cfgP = c.waitForEventWhere(
      "agent.config",
      (d) =>
        (d as { agentId: string }).agentId === agent.id &&
        (d as { configOptions: { id: string; currentValue: string }[] }).configOptions.find(
          (o) => o.id === "model",
        )?.currentValue === "m2",
      10000,
    );
    await send(agent.id, "switchmodel");
    await waitTurnEnd(agent.id);
    await cfgP;
  });

  test("queue: send while session is starting outside a turn still drains", async () => {
    const dir2 = tmp("oa2-stall-data-");
    const root2 = tmp("oa2-stall-agents-");
    const state2 = tmp("oa2-stall-fake-");
    const d = await startDaemon(dir2, root2, TOKEN, {
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: state2,
      FAKE_ACP_NEW_DELAY_MS: "600",
    });
    const c2 = await DaemonClient.connect(d.port, TOKEN);
    try {
      const agent = (await c2.request("agents.create", {
        name: "Stall",
        provider: "devin",
      })) as Agent;
      const cfg = c2.request("agents.configOptions", { agentId: agent.id }); // slow session/new
      await c2.request("chat.send", { agentId: agent.id, text: "echo:x" });
      const ended = (await c2.waitForEventWhere(
        "turn.ended",
        (t) => (t as Turn).agentId === agent.id,
        15000,
      )) as Turn;
      expect(ended.status).toBe("completed");
      await cfg;
    } finally {
      d.proc.kill("SIGKILL");
      await d.proc.exited;
      c2.close();
    }
  });

  test("handoff: new session gets history block, resumed and later prompts do not", async () => {
    const agent = await newAgent("Handoff", "devin");
    await send(agent.id, "echo:first");
    await waitTurnEnd(agent.id);
    // switch provider to cursor (also the fake)
    await c.request("agents.update", { id: agent.id, provider: "cursor" });
    await send(agent.id, "history");
    await waitTurnEnd(agent.id);
    const h = (await c.request("chat.history", { agentId: agent.id })) as { items: ChatItem[] };
    const reply = [...h.items].reverse().find((i) => i.kind === "agent_message") as
      | { text: string }
      | undefined;
    expect(reply?.text).toContain("<conversation_history>");
    expect(reply?.text).toContain("[user]");
    expect(reply?.text).toContain("[assistant]");
    // second prompt in the same session: no block
    await send(agent.id, "history");
    await waitTurnEnd(agent.id);
    const h2 = (await c.request("chat.history", { agentId: agent.id })) as {
      items: ChatItem[];
    };
    const replies = h2.items.filter((i) => i.kind === "agent_message") as { text: string }[];
    expect(replies[replies.length - 1]?.text).not.toContain("<conversation_history>");
  });

  test("provider change during a running turn cancels it, queue keeps items", async () => {
    const agent = await newAgent("Switch", "devin");
    await send(agent.id, "slow");
    await c.waitForEventWhere("turn.started", (d) => (d as Turn).agentId === agent.id);
    const qa1 = await send(agent.id, "echo:after1");
    const qa2 = await send(agent.id, "echo:after2");
    await c.request("agents.update", { id: agent.id, provider: "cursor" });
    const cancelled = (await c.waitForEventWhere(
      "turn.ended",
      (d) => (d as Turn).agentId === agent.id && (d as Turn).status === "cancelled",
      10000,
    )) as Turn;
    expect(cancelled.status).toBe("cancelled");
    // queued items are kept and drain on the new provider's session
    const t1 = await waitTurnEnd(agent.id, 15000, qa1);
    const t2 = await waitTurnEnd(agent.id, 15000, qa2);
    expect([t1.status, t2.status]).toEqual(["completed", "completed"]);
    const prompts = readLog(stateDir)
      .filter((l) => l.method === "session/prompt")
      .map((l) => (l.params as { prompt: { text: string }[] }).prompt[0]?.text ?? "");
    expect(prompts.some((p) => p.endsWith("echo:after1"))).toBe(true);
    expect(prompts.some((p) => p.endsWith("echo:after2"))).toBe(true);
  });

  test("buildHandoff: truncation and budget", async () => {
    const { buildHandoff } = await import("../src/runtime/handoff");
    const big = "x".repeat(5000);
    const out = buildHandoff([
      { kind: "user_message", text: big },
      { kind: "agent_message", text: "ok" },
    ]);
    expect(out).toContain("<conversation_history>");
    expect(out).toContain("[…]");
    expect(out?.length).toBeLessThan(21000);
    expect(
      buildHandoff(
        Array.from({ length: 60 }, (_, i) => ({
          kind: "agent_message" as const,
          text: "y".repeat(900) + i,
        })),
      )?.length,
    ).toBeLessThanOrEqual(21000);
    expect(buildHandoff([])).toBeNull();
  });

  test("v2 database migrates to v3 preserving agent model into config", async () => {
    const dir = tmp("oa2-v2-data-");
    const root = tmp("oa2-v2-agents-");
    const db = new Database(join(dir, "upbot.db"));
    const { migrations: MIGRATIONS } = await import("../src/db/migrations");
    db.exec("BEGIN");
    db.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
    for (let i = 0; i < 2; i++) {
      db.exec(MIGRATIONS[i]!);
      db.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        i + 1,
        Date.now(),
      );
    }
    db.exec("COMMIT");
    db.query(
      "INSERT INTO agents (id, name, instructions, provider, model, workspace_path, created_at, updated_at) VALUES (?, ?, '', 'devin', 'x', ?, ?, ?)",
    ).run("agent-v2", "Two", join(root, "agent-v2"), Date.now(), Date.now());
    db.close();
    const d = await startDaemon(dir, root, TOKEN, {
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      UPBOT_ACP_COMMAND_CURSOR: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
    });
    try {
      const c2 = await DaemonClient.connect(d.port, TOKEN);
      const list = (await c2.request("agents.list", {})) as Agent[];
      const a = list.find((a) => a.id === "agent-v2");
      expect(a?.config).toEqual({ model: "x" });
      c2.close();
    } finally {
      d.proc.kill("SIGKILL");
      await d.proc.exited;
    }
    const db2 = new Database(join(dir, "upbot.db"), { readonly: true });
    expect(
      (db2.query("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n,
    ).toBe(15);
    db2.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  test("crash: turn fails with error item + error status; next send resumes via session/load", async () => {
    const agent = await newAgent("Crash", "devin");
    await send(agent.id, "echo:first");
    await waitTurnEnd(agent.id);

    await send(agent.id, "crash");
    const turn = await waitTurnEnd(agent.id);
    expect(turn.status).toBe("failed");
    expect(turn.error).toBeTruthy();

    const h = await history(agent.id);
    const errItem = h.items.find((i) => i.kind === "error");
    expect(errItem).toBeTruthy();

    const st = (await c.request("agents.statuses", {})) as Record<
      string,
      { status: string; error: string | null }
    >;
    expect(st[agent.id]?.status).toBe("error");
    expect(st[agent.id]?.error).toBeTruthy();

    // next send: new process, session/load with the same sessionId
    const logBefore = readLog(stateDir).filter((l) => l.method === "session/load").length;
    await send(agent.id, "echo:ok");
    const turn2 = await waitTurnEnd(agent.id);
    expect(turn2.status).toBe("completed");
    const loads = readLog(stateDir).filter((l) => l.method === "session/load");
    expect(loads.length).toBe(logBefore + 1);
    const lastLoad = loads[loads.length - 1];
    expect(lastLoad).toBeTruthy();
    expect(
      ((lastLoad as NonNullable<typeof lastLoad>).params as { sessionId: string }).sessionId,
    ).toBeTruthy();

    const st2 = (await c.request("agents.statuses", {})) as Record<string, { status: string }>;
    expect(st2[agent.id]?.status).toBe("idle");
  });

  test("SIGTERM restart: history persists, next send uses session/load, no orphan pids", async () => {
    const agent = await newAgent("Restart", "devin");
    await send(agent.id, "echo:persisted");
    await waitTurnEnd(agent.id);
    const pidsBefore = readPids(stateDir);

    daemon.proc.kill("SIGTERM");
    await waitForExit(daemon.proc, 8000);
    for (const pid of pidsBefore) await waitForPidDead(pid);

    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      UPBOT_ACP_COMMAND_CURSOR: JSON.stringify(["bun", FAKE_AGENT]),
      UPBOT_ACP_COMMAND_GROK: JSON.stringify(["bun", FAKE_AGENT]),
      UPBOT_ACP_COMMAND_GEMINI: JSON.stringify(["definitely-not-a-binary-oa"]),
      UPBOT_CANCEL_GRACE_MS: "1000",
      FAKE_ACP_STATE_DIR: stateDir,
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);

    const h = await history(agent.id);
    expect(h.items.some((i) => i.kind === "agent_message" && i.text === "persisted")).toBe(true);

    const loadsBefore = readLog(stateDir).filter((l) => l.method === "session/load").length;
    const newsBefore = readLog(stateDir).filter((l) => l.method === "session/new").length;
    await send(agent.id, "echo:again");
    const turn = await waitTurnEnd(agent.id);
    expect(turn.status).toBe("completed");
    const log = readLog(stateDir);
    expect(log.filter((l) => l.method === "session/load").length).toBe(loadsBefore + 1);
    expect(log.filter((l) => l.method === "session/new").length).toBe(newsBefore);
  });

  test("kill -9 during a turn: turn becomes interrupted after restart, orphan exits on stdin EOF", async () => {
    const agent = await newAgent("Killed", "devin");
    await send(agent.id, "slow");
    await c.waitForEventWhere("item.delta", (d) => (d as { agentId: string }).agentId === agent.id);
    const orphanPid = readPids(stateDir)[readPids(stateDir).length - 1]!;

    daemon.proc.kill("SIGKILL");
    await waitForExit(daemon.proc, 8000);
    await waitForPidDead(orphanPid);

    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      UPBOT_ACP_COMMAND_CURSOR: JSON.stringify(["bun", FAKE_AGENT]),
      UPBOT_ACP_COMMAND_GROK: JSON.stringify(["bun", FAKE_AGENT]),
      UPBOT_ACP_COMMAND_GEMINI: JSON.stringify(["definitely-not-a-binary-oa"]),
      UPBOT_CANCEL_GRACE_MS: "1000",
      FAKE_ACP_STATE_DIR: stateDir,
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);

    const h = await history(agent.id);
    const interrupted = h.turns.find((t) => t.status === "interrupted");
    expect(interrupted).toBeTruthy();
  });

  test("provider_unavailable: openai-compatible unsupported, missing CLI binary", async () => {
    const oai = await newAgent("OAI", "openai-compatible");
    await expect(c.request("chat.send", { agentId: oai.id, text: "echo:x" })).rejects.toMatchObject(
      { code: "provider_unavailable" },
    );

    const gemini = await newAgent("Gemini", "gemini");
    await expect(
      c.request("chat.send", { agentId: gemini.id, text: "echo:x" }),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  async function lastFakePidAfter(before: number): Promise<number> {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const pids = readPids(stateDir);
      if (pids.length > before) return pids[pids.length - 1]!;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("no new fake agent pid");
  }

  test("changing provider and deleting an agent each kill its provider process", async () => {
    const agent = await newAgent("Switch", "devin");
    const before1 = readPids(stateDir).length;
    await send(agent.id, "slow");
    const pid1 = await lastFakePidAfter(before1);
    expect(pidAlive(pid1)).toBe(true);
    await c.request("agents.update", { id: agent.id, provider: "grok" });
    await waitForPidDead(pid1);
    // leftover turn from the killed runtime ends cancelled
    const t = await waitTurnEnd(agent.id).catch(() => null);
    if (t) expect(t.status).toBe("cancelled");

    const agent2 = await newAgent("Delete", "devin");
    const before2 = readPids(stateDir).length;
    await send(agent2.id, "slow");
    const pid2 = await lastFakePidAfter(before2);
    await c.request("agents.delete", { id: agent2.id });
    await waitForPidDead(pid2);
  });

  test("v1 database migrates to v2 preserving agents", async () => {
    const dir = tmp("oa2-mig-");
    const root = tmp("oa2-mig-agents-");
    const db = new Database(join(dir, "upbot.db"));
    db.exec(`CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL, model TEXT, workspace_path TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER)`);
    db.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
    db.query("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(Date.now());
    db.query(
      "INSERT INTO agents (id, name, instructions, provider, model, workspace_path, created_at, updated_at) VALUES (?, ?, '', 'devin', NULL, ?, ?, ?)",
    ).run("agent-v1", "Old Agent", join(root, "agent-v1"), Date.now(), Date.now());
    db.close();

    const d = await startDaemon(dir, root, TOKEN, {
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      UPBOT_ACP_COMMAND_CURSOR: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
    });
    try {
      const c2 = await DaemonClient.connect(d.port, TOKEN);
      const list = (await c2.request("agents.list", {})) as Agent[];
      expect(list.some((a) => a.id === "agent-v1" && a.name === "Old Agent")).toBe(true);
      c2.close();
    } finally {
      d.proc.kill("SIGKILL");
      await d.proc.exited;
    }

    const db2 = new Database(join(dir, "upbot.db"), { readonly: true });
    const n = (db2.query("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n;
    expect(n).toBe(15);
    db2.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
});
