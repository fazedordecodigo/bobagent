import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Agent, ChatItem, ConfigOption, PendingPermission, Turn } from "@bobagent/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  readLog,
  readPids,
  startDaemon,
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
    BOBAGENT_PROVIDER_COMMAND_CLAUDE: JSON.stringify(["bun", join(FIXTURES, "fake-claude.ts")]),
    BOBAGENT_PROVIDER_COMMAND_CODEX: JSON.stringify(["bun", join(FIXTURES, "fake-codex.ts")]),
    BOBAGENT_CANCEL_GRACE_MS: "3000",
    [cs.stateEnv]: stateDir,
  });

  const newAgent = async (name: string) =>
    (await c.request("agents.create", { name, provider: cs.provider, instructions: "" })) as Agent;

  async function turn(agentId: string, text: string, timeout = 15000): Promise<Turn> {
    const { queueId } = (await c.request("chat.send", { agentId, text })) as { queueId: string };
    return (await c.waitForEventWhere(
      "turn.ended",
      (d) => (d as Turn).queueId === queueId,
      timeout,
    )) as Turn;
  }

  async function lastAgentText(agentId: string): Promise<string> {
    const h = (await c.request("chat.history", { agentId })) as { items: ChatItem[] };
    const msgs = h.items.filter((i) => i.kind === "agent_message");
    const last = msgs[msgs.length - 1];
    return last && "text" in last ? last.text : "";
  }

  beforeAll(async () => {
    dataDir = tmp(`nat-${cs.provider}-data-`);
    agentsRoot = tmp(`nat-${cs.provider}-agents-`);
    stateDir = tmp(`nat-${cs.provider}-fake-`);
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, env());
    c = await DaemonClient.connect(daemon.port, TOKEN);
  });

  afterAll(() => {
    c?.close();
    try {
      daemon.proc.kill("SIGKILL");
    } catch {}
    for (const pid of readPids(stateDir)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    for (const d of [dataDir, agentsRoot, stateDir]) rmSync(d, { recursive: true, force: true });
  });

  test("echo + thinking stream into items without duplication", async () => {
    const a = await newAgent("Echo");
    const t = await turn(a.id, "echo:hello native");
    expect(t.status).toBe("completed");
    expect(await lastAgentText(a.id)).toBe("hello native");
    const t2 = await turn(a.id, "think:deep");
    expect(t2.status).toBe("completed");
    const h = (await c.request("chat.history", { agentId: a.id })) as { items: ChatItem[] };
    const thoughts = h.items.filter((i) => i.kind === "agent_thought" && i.turnId === t2.id);
    expect(thoughts.map((i) => ("text" in i ? i.text : ""))).toEqual(["pondering"]);
    expect(await lastAgentText(a.id)).toBe("deep");
    const usage = (await c.request("agents.usage", { agentId: a.id })) as {
      inputTokens: number;
      contextWindow: number | null;
    };
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.contextWindow).toBe(cs.provider === "claude" ? 200000 : 258000);
    const log = readLog(stateDir);
    if (cs.provider === "claude") {
      const argv = log.find((l) => l.method === "argv")!.params as string[];
      const cfg = JSON.parse(argv[argv.indexOf("--mcp-config") + 1]!);
      expect(cfg.mcpServers.bobagent.env.BOBAGENT_BRIDGE_TOKEN).toBeTruthy();
    } else {
      const start = log.find((l) => l.method === "thread/start")!.params as {
        params: { config: Record<string, { env: Record<string, string> }> };
      };
      expect(start.params.config["mcp_servers.bobagent"]!.env.BOBAGENT_BRIDGE_TOKEN).toBeTruthy();
    }
  });

  for (const [label, pick, reply] of [
    ["allow", (x: Case) => x.allow, (x: Case) => x.allowReply],
    ["deny", (x: Case) => x.deny, (x: Case) => x.denyReply],
    ["allow always", (x: Case) => x.allowAlways, (x: Case) => x.alwaysReply],
  ] as const) {
    test(`tool permission: ${label}`, async () => {
      const a = await newAgent(`Tool ${label}`);
      const ended = turn(a.id, "tool");
      const pending = (await c.waitForEventWhere(
        "permission.requested",
        (d) => (d as PendingPermission).agentId === a.id,
      )) as PendingPermission;
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
      expect(await lastAgentText(a.id)).toBe(reply(cs));
      const h = (await c.request("chat.history", { agentId: a.id })) as { items: ChatItem[] };
      const tool = h.items.find((i) => i.kind === "tool_call");
      expect(tool && "status" in tool ? tool.status : null).toBe(
        label === "deny" ? "failed" : "completed",
      );
    });
  }

  test("cancel interrupts a running turn", async () => {
    const a = await newAgent("Slow");
    const { queueId } = (await c.request("chat.send", { agentId: a.id, text: "slow" })) as {
      queueId: string;
    };
    await c.waitForEventWhere("item.delta", (d) => (d as { agentId: string }).agentId === a.id);
    await c.request("chat.cancel", { agentId: a.id });
    const t = (await c.waitForEventWhere(
      "turn.ended",
      (d) => (d as Turn).queueId === queueId,
      2500,
    )) as Turn;
    expect(t.status).toBe("cancelled");
    expect((await turn(a.id, "echo:after")).status).toBe("completed");
  });

  test("config options: mode + model applied to the provider", async () => {
    const a = await newAgent("Config");
    const { configOptions: opts } = (await c.request("agents.configOptions", {
      agentId: a.id,
    })) as { configOptions: ConfigOption[] };
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
    const who = await lastAgentText(a.id);
    expect(who).toContain(`model=${cs.model.to}`);
    expect(who).toContain(cs.provider === "claude" ? "mode=acceptEdits" : "sandbox=readOnly");
  });

  test("session resumes across a daemon restart", async () => {
    const a = await newAgent("Resume");
    await turn(a.id, "echo:first");
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
    c = await DaemonClient.connect(daemon.port, TOKEN);
    await turn(a.id, "whoami");
    const who = await lastAgentText(a.id);
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
      BOBAGENT_PROVIDER_COMMAND_CODEX: JSON.stringify(["bun", join(FIXTURES, "fake-codex.ts")]),
      FAKE_CODEX_STATE_DIR: stateDir,
      FAKE_CODEX_NO_AUTH: "1",
      OPENAI_API_KEY: "",
    });
    const c = await DaemonClient.connect(d.port, TOKEN);
    try {
      const a = (await c.request("agents.create", {
        name: "x",
        provider: "codex",
        instructions: "",
      })) as Agent;
      const { queueId } = (await c.request("chat.send", { agentId: a.id, text: "echo:x" })) as {
        queueId: string;
      };
      const t = (await c.waitForEventWhere(
        "turn.ended",
        (e) => (e as Turn).queueId === queueId,
      )) as Turn;
      expect(t.status).toBe("failed");
      expect(t.error).toContain("codex login");
    } finally {
      c.close();
      d.proc.kill("SIGKILL");
      for (const p of [dataDir, agentsRoot, stateDir]) rmSync(p, { recursive: true, force: true });
    }
  });
});
