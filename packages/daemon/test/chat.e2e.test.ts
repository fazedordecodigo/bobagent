import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Agent, ChatItem, PendingPermission, Turn } from "@openagent/protocol";
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
    const res = (await c.request("chat.send", { agentId, text })) as { turnId: string };
    return res.turnId;
  }

  async function waitTurnEnd(agentId: string, timeout = 15000): Promise<Turn> {
    return (await c.waitForEventWhere(
      "turn.ended",
      (d) => (d as Turn).agentId === agentId,
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
      OPENAGENT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      OPENAGENT_ACP_COMMAND_GROK: JSON.stringify(["bun", FAKE_AGENT]),
      OPENAGENT_ACP_COMMAND_GEMINI: JSON.stringify(["definitely-not-a-binary-oa"]),
      OPENAGENT_CANCEL_GRACE_MS: "1000",
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

    // env leak check: the provider child saw no OPENAGENT_* var and no token
    const envDump = JSON.parse(readFileSync(join(stateDir, "env.json"), "utf8")) as {
      keys: string[];
      env: Record<string, string>;
    };
    expect(envDump.keys.some((k) => k.startsWith("OPENAGENT_"))).toBe(false);
    expect(JSON.stringify(envDump.env)).not.toContain(TOKEN);
  });

  test("instructions prefix on first prompt of a new session only", async () => {
    const agent = await newAgent("Instructed", "devin", "Always answer in lowercase.");
    await send(agent.id, "echo:hi");
    await waitTurnEnd(agent.id);

    const log = readLog(stateDir);
    const prompts = log
      .filter((l) => l.method === "session/prompt")
      .map((l) => (l.params as { prompt: { text: string }[] }).prompt[0]?.text);
    expect(prompts[prompts.length - 1]).toMatch(/^<agent_instructions>\n/);
    expect(prompts[prompts.length - 1]).toContain("Always answer in lowercase.");

    const h = await history(agent.id);
    const userItem = h.items.find((i) => i.kind === "user_message");
    expect(userItem).toMatchObject({ text: "echo:hi" });

    await send(agent.id, "echo:yo");
    await waitTurnEnd(agent.id);
    const prompts2 = readLog(stateDir)
      .filter((l) => l.method === "session/prompt")
      .map((l) => (l.params as { prompt: { text: string }[] }).prompt[0]?.text);
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

  test("send during a running turn -> busy", async () => {
    const agent = await newAgent("Busy", "devin");
    await send(agent.id, "slow");
    await c.waitForEventWhere("turn.started", (d) => (d as Turn).agentId === agent.id);
    await expect(
      c.request("chat.send", { agentId: agent.id, text: "echo:x" }),
    ).rejects.toMatchObject({ code: "busy" });
    await c.request("chat.cancel", { agentId: agent.id });
    await waitTurnEnd(agent.id);
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
    expect((lastLoad!.params as { sessionId: string }).sessionId).toBeTruthy();

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
      OPENAGENT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      OPENAGENT_ACP_COMMAND_GROK: JSON.stringify(["bun", FAKE_AGENT]),
      OPENAGENT_ACP_COMMAND_GEMINI: JSON.stringify(["definitely-not-a-binary-oa"]),
      OPENAGENT_CANCEL_GRACE_MS: "1000",
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
      OPENAGENT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      OPENAGENT_ACP_COMMAND_GROK: JSON.stringify(["bun", FAKE_AGENT]),
      OPENAGENT_ACP_COMMAND_GEMINI: JSON.stringify(["definitely-not-a-binary-oa"]),
      OPENAGENT_CANCEL_GRACE_MS: "1000",
      FAKE_ACP_STATE_DIR: stateDir,
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);

    const h = await history(agent.id);
    const interrupted = h.turns.find((t) => t.status === "interrupted");
    expect(interrupted).toBeTruthy();
  });

  test("provider_unavailable: claude unsupported, missing CLI binary", async () => {
    const claude = await newAgent("Claude", "claude");
    await expect(
      c.request("chat.send", { agentId: claude.id, text: "echo:x" }),
    ).rejects.toMatchObject({ code: "provider_unavailable" });

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
    const db = new Database(join(dir, "openagent.db"));
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
      OPENAGENT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
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

    const db2 = new Database(join(dir, "openagent.db"), { readonly: true });
    const n = (db2.query("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n;
    expect(n).toBe(2);
    db2.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
});
