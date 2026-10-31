import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@boto/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  lastAgentText,
  readLog,
  readPids,
  sendAndWait,
  startDaemon,
  stopDaemon,
  stopTestChildren,
  tmp,
  waitForPidDead,
} from "./helpers";

const FIXTURES = join(import.meta.dir, "fixtures");
const TOKEN = `native-test-${crypto.randomUUID()}`;

type Case = {
  provider: "claude" | "codex";
  stateEnv: string;
  allow: string;
  allowAlways: string;
  deny: string;
  allowReply: string;
  denyReply: string;
  alwaysReply: string;
  model: { from: string; to: string };
};

const CASES: Case[] = [
  {
    provider: "claude",
    stateEnv: "FAKE_CLAUDE_STATE_DIR",
    allow: "allow",
    allowAlways: "allow_always",
    deny: "deny",
    allowReply: "permission:allow",
    denyReply: "permission:deny",
    alwaysReply: "permission:allow+always",
    model: { from: "default", to: "sonnet" },
  },
  {
    provider: "codex",
    stateEnv: "FAKE_CODEX_STATE_DIR",
    allow: "accept",
    allowAlways: "acceptForSession",
    deny: "decline",
    allowReply: "permission:accept",
    denyReply: "permission:decline",
    alwaysReply: "permission:acceptForSession",
    model: { from: "gpt-a", to: "gpt-b" },
  },
];

describe.each(CASES)("native $provider driver e2e", (cs) => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  const env = () => ({
    BOTO_PROVIDER_COMMAND_CLAUDE: JSON.stringify(["bun", join(FIXTURES, "fake-claude.ts")]),
    BOTO_PROVIDER_COMMAND_CODEX: JSON.stringify(["bun", join(FIXTURES, "fake-codex.ts")]),
    BOTO_CANCEL_GRACE_MS: "3000",
    [cs.stateEnv]: stateDir,
  });

  const newAgent = async (name: string) =>
    c.request("agents.create", { name, provider: cs.provider, instructions: "" });

  const turn = (agentId: string, text: string, timeout = 15000) =>
    sendAndWait(c, agentId, text, timeout);

  const agentText = (agentId: string) => lastAgentText(c, agentId);

  function persistedSessionId(agentId: string): string | null {
    const db = new Database(join(dataDir, "boto.db"), { readonly: true });
    try {
      const row = db
        .query("SELECT session_id FROM agent_sessions WHERE agent_id = ?")
        .get(agentId) as {
        session_id: string;
      } | null;
      return row?.session_id ?? null;
    } finally {
      db.close();
    }
  }

  function captureStderr(): string[] {
    const chunks: string[] = [];
    void (async () => {
      const reader = (daemon.proc.stderr as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(dec.decode(value));
      }
    })();
    return chunks;
  }

  async function restartDaemon(): Promise<string[]> {
    const before = readPids(stateDir);
    daemon.proc.kill("SIGKILL");
    await daemon.proc.exited;
    for (const pid of before) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
      await waitForPidDead(pid).catch(() => {});
    }
    c.close();
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, env());
    const stderrChunks = captureStderr();
    c = await DaemonClient.connect(daemon.port, TOKEN);
    return stderrChunks;
  }

  beforeAll(async () => {
    dataDir = tmp(`nat-${cs.provider}-data-`);
    agentsRoot = tmp(`nat-${cs.provider}-agents-`);
    stateDir = tmp(`nat-${cs.provider}-fake-`);
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, env());
    c = await DaemonClient.connect(daemon.port, TOKEN);
  });

  afterAll(async () => {
    await stopDaemon(daemon, c, stateDir);
    for (const d of [dataDir, agentsRoot, stateDir])
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("echo + thinking stream into items without duplication", async () => {
    const a = await newAgent("Echo");
    const t = await turn(a.id, "echo:hello native");
    expect(t.status).toBe("completed");
    expect(await agentText(a.id)).toBe("hello native");
    const t2 = await turn(a.id, "think:deep");
    expect(t2.status).toBe("completed");
    const h = await c.request("chat.history", { agentId: a.id });
    const thoughts = h.items.filter((i) => i.kind === "agent_thought" && i.turnId === t2.id);
    expect(thoughts.map((i) => ("text" in i ? i.text : ""))).toEqual(["pondering"]);
    expect(await agentText(a.id)).toBe("deep");
    const usage = await c.request("agents.usage", { agentId: a.id });
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.contextWindow).toBe(cs.provider === "claude" ? 200000 : 258000);
    const log = readLog(stateDir);
    if (cs.provider === "claude") {
      const argv = log.find((l) => l.method === "argv")!.params as string[];
      const cfg = JSON.parse(argv[argv.indexOf("--mcp-config") + 1]!);
      expect(cfg.mcpServers.boto.env.BOTO_BRIDGE_TOKEN).toBeTruthy();
    } else {
      const start = log.find((l) => l.method === "thread/start")!.params as {
        params: { config: Record<string, { env: Record<string, string> }> };
      };
      expect(start.params.config["mcp_servers.boto"]!.env.BOTO_BRIDGE_TOKEN).toBeTruthy();
    }
  });

  test("multi-byte UTF-8 split across stdout chunks is decoded intact", async () => {
    const a = await newAgent("UTF-8 split");
    const t = await turn(a.id, "split:olá 🎉 ünïcödé");
    const text = await agentText(a.id);
    expect(t.status).toBe("completed");
    expect(text).toBe("olá 🎉 ünïcödé");
    expect(text).not.toContain("\uFFFD");
  });

  for (const [label, pick, reply] of [
    ["allow", (x: Case) => x.allow, (x: Case) => x.allowReply],
    ["deny", (x: Case) => x.deny, (x: Case) => x.denyReply],
    ["allow always", (x: Case) => x.allowAlways, (x: Case) => x.alwaysReply],
  ] as const) {
    test(`tool permission: ${label}`, async () => {
      const a = await newAgent(`Tool ${label}`);
      const ended = turn(a.id, "tool");
      const pending = await c.waitForEventWhere("permission.requested", (d) => d.agentId === a.id);
      expect(pending.title).toContain("ls -la");
      expect(pending.toolKind).toBe("execute");
      expect(pending.options.map((o) => o.kind)).toEqual([
        "allow_once",
        "allow_always",
        "reject_once",
      ]);
      await c.request("permissions.respond", { requestId: pending.requestId, optionId: pick(cs) });
      const t = await ended;
      expect(t.status).toBe("completed");
      expect(await agentText(a.id)).toBe(reply(cs));
      const h = await c.request("chat.history", { agentId: a.id });
      const tool = h.items.find((i) => i.kind === "tool_call");
      expect(tool && "status" in tool ? tool.status : null).toBe(
        label === "deny" ? "failed" : "completed",
      );
    });
  }

  test("cancel interrupts a running turn", async () => {
    const a = await newAgent("Slow");
    const { queueId } = await c.request("chat.send", { agentId: a.id, text: "slow" });
    await c.waitForEventWhere("item.delta", (d) => d.agentId === a.id);
    await c.request("chat.cancel", { agentId: a.id });
    const t = await c.waitForEventWhere("turn.ended", (d) => d.queueId === queueId, 2500);
    expect(t.status).toBe("cancelled");
    expect((await turn(a.id, "echo:after")).status).toBe("completed");
  });

  test("config options: mode + model applied to the provider", async () => {
    const a = await newAgent("Config");
    const { configOptions: opts } = await c.request("agents.configOptions", {
      agentId: a.id,
    });
    const mode = opts.find((o) => o.id === "mode");
    const model = opts.find((o) => o.id === "model");
    expect(mode?.currentValue).toBe(cs.provider === "claude" ? "default" : "auto");
    expect(mode?.options.some((o) => /bypass|danger|full/i.test(o.value))).toBe(false);
    expect(model?.currentValue).toBe(cs.model.from);
    expect(model?.options.some((o) => o.value === "gpt-hidden")).toBe(false);
    await c.request("agents.setConfig", { agentId: a.id, configId: "model", value: cs.model.to });
    const altMode = cs.provider === "claude" ? "acceptEdits" : "read-only";
    await c.request("agents.setConfig", { agentId: a.id, configId: "mode", value: altMode });
    await turn(a.id, "whoami");
    const who = await agentText(a.id);
    expect(who).toContain(`model=${cs.model.to}`);
    expect(who).toContain(cs.provider === "claude" ? "mode=acceptEdits" : "sandbox=readOnly");
  });

  test("clearing a model config starts a fresh provider session", async () => {
    const a = await newAgent("Clear model");
    const { configOptions } = await c.request("agents.configOptions", {
      agentId: a.id,
    });
    const model = configOptions.find((option) => option.id === "model");
    expect(model?.options.some((option) => option.value === cs.model.to)).toBe(true);
    await c.request("agents.setConfig", {
      agentId: a.id,
      configId: "model",
      value: cs.model.to,
    });
    await turn(a.id, "echo:before clear");
    const beforeClear = readLog(stateDir);
    await c.request("agents.setConfig", {
      agentId: a.id,
      configId: "model",
      value: null,
    });
    const afterClear = readLog(stateDir);
    if (cs.provider === "claude") {
      const beforeCount = beforeClear.filter((item) => item.method === "argv").length;
      const argvs = afterClear
        .filter((item) => item.method === "argv")
        .map((item) => item.params as string[]);
      const nextArgs = argvs.slice(beforeCount);
      expect(nextArgs.length).toBeGreaterThan(0);
      expect(nextArgs.at(-1)).not.toContain("--resume");
    } else {
      const startsBefore = beforeClear.filter((item) => item.method === "thread/start").length;
      const resumesBefore = beforeClear.filter((item) => item.method === "thread/resume").length;
      expect(afterClear.filter((item) => item.method === "thread/start").length).toBeGreaterThan(
        startsBefore,
      );
      expect(afterClear.filter((item) => item.method === "thread/resume").length).toBe(
        resumesBefore,
      );
    }
    expect((await turn(a.id, "echo:after clear")).status).toBe("completed");
  });

  test("session resumes across a daemon restart", async () => {
    const a = await newAgent("Resume");
    await turn(a.id, "echo:first");
    await restartDaemon();
    await turn(a.id, "whoami");
    const who = await agentText(a.id);
    const log = readLog(stateDir);
    if (cs.provider === "claude") {
      const argvs = log.filter((l) => l.method === "argv").map((l) => l.params as string[]);
      const resumeArgs = argvs[argvs.length - 1]!;
      const id = resumeArgs[resumeArgs.indexOf("--resume") + 1];
      expect(resumeArgs).toContain("--resume");
      expect(who).toContain(`session=${id}`);
    } else {
      const resumes = log.filter((l) => l.method === "thread/resume");
      expect(resumes.length).toBeGreaterThan(0);
      const tid = (resumes[resumes.length - 1]!.params as { params: { threadId: string } }).params
        .threadId;
      expect(who).toContain(`thread=${tid}`);
    }
  });

  test("unknown saved session falls back to a fresh one and logs provider.resume_failed", async () => {
    const a = await newAgent("ResumeFail");
    await turn(a.id, "echo:first");
    const db = new Database(join(dataDir, "boto.db"), { readonly: true });
    const oldSessionId = (
      db.query("SELECT session_id FROM agent_sessions WHERE agent_id = ?").get(a.id) as {
        session_id: string;
      }
    ).session_id;
    db.close();
    // the fake CLI no longer knows the saved session/thread
    rmSync(join(stateDir, cs.provider === "claude" ? "sessions.json" : "threads.json"));
    const stderrChunks = await restartDaemon();
    const t = await turn(a.id, "whoami");
    expect(t.status).toBe("completed");
    const who = await agentText(a.id);
    expect(who).not.toContain(`=${oldSessionId}`);
    const log = readLog(stateDir);
    let freshSessionId: string;
    if (cs.provider === "claude") {
      const argvs = log.filter((l) => l.method === "argv").map((l) => l.params as string[]);
      const last = argvs[argvs.length - 1]!;
      expect(last).toContain("--session-id");
      expect(last).not.toContain("--resume");
      freshSessionId = last[last.indexOf("--session-id") + 1] ?? "";
    } else {
      const resumes = log
        .filter((l) => l.method === "thread/resume")
        .map((l) => (l.params as { params: { threadId: string } }).params.threadId);
      expect(resumes.filter((id) => id === oldSessionId)).toHaveLength(1);
      expect(log.filter((l) => l.method === "thread/start").length).toBeGreaterThan(0);
      freshSessionId = who.match(/thread=([^\s]+)/)?.[1] ?? "";
    }
    expect(freshSessionId).toBeTruthy();
    expect(persistedSessionId(a.id)).not.toBe(oldSessionId);
    expect(persistedSessionId(a.id)).toBe(freshSessionId);
    const deadline = Date.now() + 5000;
    let stderr = stderrChunks.join("");
    while (!stderr.includes("provider.resume_failed") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      stderr = stderrChunks.join("");
    }
    expect(stderr).toContain("provider.resume_failed");
    expect(stderr).toContain(oldSessionId);
  });

  test("transient resume failure keeps the saved session until a fresh launch succeeds", async () => {
    const a = await newAgent("TransientResumeFail");
    await turn(a.id, "echo:first");
    const oldSessionId = persistedSessionId(a.id);
    if (!oldSessionId) throw new Error("agent session was not persisted");
    writeFileSync(join(stateDir, "fail-start"), "");
    const stderrChunks = await restartDaemon();

    const failed = await turn(a.id, "whoami");
    expect(failed.status).toBe("failed");
    expect(persistedSessionId(a.id)).toBe(oldSessionId);
    const deadline = Date.now() + 5000;
    let stderr = stderrChunks.join("");
    while (!stderr.includes("provider.resume_failed") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      stderr = stderrChunks.join("");
    }
    expect(stderr).toContain("provider.resume_failed");

    rmSync(join(stateDir, "fail-start"));
    const { queueId } = await c.request("chat.send", { agentId: a.id, text: "whoami" });
    const retryTurn = c.waitForEventWhere("turn.ended", (d) => d.queueId === queueId);
    const queue = (await c.request("queue.get", { agentId: a.id })) as { paused: boolean };
    if (queue.paused) await c.request("queue.resume", { agentId: a.id });
    const completed = await retryTurn;
    expect(completed.status).toBe("completed");
    const who = await agentText(a.id);
    expect(who).toContain(
      cs.provider === "claude" ? `session=${oldSessionId}` : `thread=${oldSessionId}`,
    );
    expect(persistedSessionId(a.id)).toBe(oldSessionId);
  });

  test("provider crash fails the turn and the next turn respawns", async () => {
    const a = await newAgent("Crash");
    const t = await turn(a.id, "crash");
    expect(t.status).toBe("failed");
    expect((await turn(a.id, "echo:alive")).status).toBe("completed");
  });

  test("auth failure surfaces a sign-in hint", async () => {
    const a = await newAgent("Auth");
    if (cs.provider === "claude") {
      const t = await turn(a.id, "authfail");
      expect(t.status).toBe("failed");
      expect(t.error).toContain("claude auth login");
    } else {
      const t = await turn(a.id, "fail");
      expect(t.status).toBe("failed");
      expect(t.error).toContain("model exploded");
    }
  });
});

describe("codex signed out", () => {
  test("start fails with codex login hint", async () => {
    const dataDir = tmp("nat-auth-data-");
    const agentsRoot = tmp("nat-auth-agents-");
    const stateDir = tmp("nat-auth-fake-");
    const d = await startDaemon(dataDir, agentsRoot, TOKEN, {
      BOTO_PROVIDER_COMMAND_CODEX: JSON.stringify(["bun", join(FIXTURES, "fake-codex.ts")]),
      FAKE_CODEX_STATE_DIR: stateDir,
      FAKE_CODEX_NO_AUTH: "1",
      OPENAI_API_KEY: "",
    });
    const c = await DaemonClient.connect(d.port, TOKEN);
    try {
      const a = await c.request("agents.create", {
        name: "x",
        provider: "codex",
        instructions: "",
      });
      const { queueId } = await c.request("chat.send", { agentId: a.id, text: "echo:x" });
      const t = await c.waitForEventWhere("turn.ended", (e) => e.queueId === queueId);
      expect(t.status).toBe("failed");
      expect(t.error).toContain("codex login");
    } finally {
      c.close();
      d.proc.kill("SIGKILL");
      await d.proc.exited;
      await stopTestChildren(stateDir);
      for (const p of [dataDir, agentsRoot, stateDir])
        rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
