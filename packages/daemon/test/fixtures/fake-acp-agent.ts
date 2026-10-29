#!/usr/bin/env bun

// Fake ACP agent for daemon e2e tests. Speaks ACP over stdio, supports
// loadSession, logs every inbound request to $FAKE_ACP_STATE_DIR/log.jsonl,
// persists session ids in sessions.json, appends its pid to pids.txt.
//
// Prompt behaviors (by text prefix):
//   echo:<t>       -> 3 message chunks concatenating to <t>
//   think:<t>      -> thought chunk then message chunk <t>
//   tool           -> tool_call pending -> request_permission (4 options)
//                     -> tool_call_update -> message "permission:<optionId|cancelled>"
//   tools          -> tool_call tc-a + tc-b, interleaved tool_call_updates (incl. an
//                     orphan update for tc-orphan) -> message "tools:done"
//   slow           -> a chunk every 100ms; responds to session/cancel
//   slowseq        -> sequenced chunks every 100ms; responds to session/cancel
//   ignorecancel   -> streams forever, ignores session/cancel
//   crash          -> one chunk then process.exit(1)

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const STATE_DIR = process.env.FAKE_ACP_STATE_DIR ?? join(process.cwd(), ".fake-acp-state");
mkdirSync(STATE_DIR, { recursive: true });
const LOG = join(STATE_DIR, "log.jsonl");
const SESSIONS_FILE = join(STATE_DIR, "sessions.json");
appendFileSync(join(STATE_DIR, "pids.txt"), `${process.pid}\n`);
// record the env the daemon gave us so tests can assert no secrets leak
writeFileSync(
  join(STATE_DIR, "env.json"),
  JSON.stringify({ keys: Object.keys(process.env), env: process.env }),
);

function logRequest(method: string, params: unknown) {
  try {
    appendFileSync(LOG, `${JSON.stringify({ ts: Date.now(), method, params })}\n`);
  } catch {}
}

const MODE_VALUES = ["ask-all", "default", "bypass", "accept-edits"];
const MODEL_VALUES =
  process.env.FAKE_ACP_EFFORT === "1" ? ["grok-4.7-fast", "grok-4.7"] : ["m1", "m2"];
const MODEL_NAMES =
  process.env.FAKE_ACP_EFFORT === "1" ? ["Grok 4.7 Fast", "Grok 4.7"] : MODEL_VALUES;

function configOptions() {
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: state.config.mode ?? "default",
      options: MODE_VALUES.map((v) => ({ value: v, name: v })),
    },
    ...(process.env.FAKE_ACP_EFFORT === "1"
      ? [
          {
            id: "effort",
            name: "Effort",
            category: "thought_level",
            type: "select",
            currentValue: state.config.effort ?? "medium",
            options: ["low", "medium", "high"].map((value) => ({ value, name: value })),
          },
        ]
      : []),
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: state.config.model ?? MODEL_VALUES[0],
      options: MODEL_VALUES.map((value, index) => ({
        value,
        name: MODEL_NAMES[index] ?? value,
      })),
    },
  ];
}

const state = {
  config: {
    mode: undefined as string | undefined,
    model: undefined as string | undefined,
    effort: undefined as string | undefined,
  },
};
try {
  Object.assign(state, JSON.parse(readFileSync(join(STATE_DIR, "state.json"), "utf8")));
} catch {}
function saveState() {
  writeFileSync(join(STATE_DIR, "state.json"), JSON.stringify(state));
}

function loadSessions(): Record<string, { prompts: string[] }> {
  try {
    return JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveSessions(s: Record<string, { prompts: string[] }>) {
  writeFileSync(SESSIONS_FILE, JSON.stringify(s));
}

const cancelledSessions = new Set<string>();
type McpSpec = {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
};
const sessionMcp = new Map<string, McpSpec[]>();

/** Minimal MCP stdio client: initialize + one tools/call, returns the text content. */
async function callMcp(spec: McpSpec, tool: string, args: unknown): Promise<string> {
  const env = { ...process.env };
  for (const e of spec.env) env[e.name] = e.value;
  const child = spawn(spec.command, spec.args, { env, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const waiters = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>();
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
      waiters.get(m.id)?.(m);
    }
  });
  const req = (id: number, method: string, params: unknown) =>
    new Promise<{ result?: unknown; error?: { message: string } }>((resolve) => {
      waiters.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  try {
    await req(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fake", version: "0" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const r = await req(2, "tools/call", { name: tool, arguments: args });
    if (r.error) return `mcp-error:${r.error.message}`;
    const res = r.result as { content: { text: string }[]; isError?: boolean };
    return `${res.isError ? "tool-error:" : "tool-ok:"}${res.content.map((c) => c.text).join("")}`;
  } finally {
    child.kill();
  }
}
let sessionCounter = 0;

process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Ctx = {
  params: Record<string, unknown>;
  client: {
    request: (m: string, p: unknown) => Promise<unknown>;
    notify: (m: string, p: unknown) => Promise<void>;
  };
};

function chunk(sessionId: string, kind: string, text: string) {
  return {
    sessionId,
    update: { sessionUpdate: kind, content: { type: "text", text } },
  };
}

async function handlePrompt(ctx: Ctx): Promise<{ stopReason: string }> {
  const { sessionId, prompt } = ctx.params as {
    sessionId: string;
    prompt: { type: string; text?: string }[];
  };
  const full = (prompt?.[0]?.text ?? "")
    .replace(/^[\s\S]*<\/agent_message_context>\n/, "")
    .replace(/^[\s\S]*<\/channel_context>\n[^\n]*\n/, "")
    // group-chat quotes and leading @mentions are addressing, not part of the command
    .replace(/^<in_reply_to[^>]*>[\s\S]*?<\/in_reply_to>\n/, "")
    .replace(/^(?:@[\w-]+\s+)+/, "");
  // session context blocks prepended by the daemon are not part of the command
  const stripped = full.replace(
    /^(?:<(upbot_context|agent_instructions|agent_memories|skills_library|conversation_summary|conversation_history|attachments)>[\s\S]*?<\/\1>\s*)+/,
    "",
  );
  const external = /^<(external_message|team_message)[^>]*>\n([\s\S]*?)\n<\/\1>/.exec(stripped);
  const text = external ? external[2]! : stripped;
  const sessions = loadSessions();
  sessions[sessionId] ??= { prompts: [] };
  sessions[sessionId].prompts.push(text);
  saveSessions(sessions);
  // cancel is per-turn: a new prompt clears it
  cancelledSessions.delete(sessionId);

  const say = async (kind: string, t: string) => {
    await ctx.client.notify("session/update", chunk(sessionId, kind, t));
  };

  if (text.startsWith("watchdog-delay:")) {
    await sleep(Number.parseInt(text.slice("watchdog-delay:".length), 10) || 0);
    return { stopReason: "end_turn" };
  }

  if (text === "watchdog-idle") {
    while (!cancelledSessions.has(sessionId)) await sleep(10);
    return { stopReason: "cancelled" };
  }

  if (text === "watchdog-metadata-idle") {
    await ctx.client.notify("session/update", {
      sessionId,
      update: { sessionUpdate: "available_commands_update", availableCommands: [] },
    } as never);
    while (!cancelledSessions.has(sessionId)) await sleep(10);
    return { stopReason: "cancelled" };
  }

  const watchdogActivity = /^watchdog-activity:(\d+):(\d+)$/.exec(text);
  if (watchdogActivity) {
    const activityDelay = Number(watchdogActivity[1]);
    const totalDelay = Number(watchdogActivity[2]);
    await sleep(activityDelay);
    await say("agent_thought_chunk", "activity");
    await sleep(Math.max(0, totalDelay - activityDelay));
    return { stopReason: "end_turn" };
  }

  if (text.startsWith("mcp-sequence:")) {
    const calls = JSON.parse(text.slice("mcp-sequence:".length)) as {
      tool: string;
      args: Record<string, unknown>;
    }[];
    const spec = sessionMcp.get(sessionId)?.find((x) => x.name === "upbot");
    if (!spec) throw new Error("no-upbot-mcp");
    for (const call of calls)
      await say("agent_message_chunk", await callMcp(spec, call.tool, call.args));
    return { stopReason: "end_turn" };
  }
  if (text.startsWith("mcp:")) {
    const m = /^mcp:([A-Za-z0-9_-]+)\s*([\s\S]*)$/.exec(text);
    const spec = sessionMcp.get(sessionId)?.find((x) => x.name === "upbot");
    if (!m || !spec) {
      await say("agent_message_chunk", "no-upbot-mcp");
      return { stopReason: "end_turn" };
    }
    await say("agent_message_chunk", await callMcp(spec, m[1]!, JSON.parse(m[2] || "{}")));
    return { stopReason: "end_turn" };
  }

  if (text.includes("<compaction_request>")) {
    if (process.env.FAKE_ACP_COMPACT_ERROR) {
      throw new acp.RequestError(-32603, process.env.FAKE_ACP_COMPACT_ERROR);
    }
    await say(
      "agent_message_chunk",
      `SUMMARY: ${sessions[sessionId].prompts.length - 1} earlier prompts`,
    );
    return { stopReason: "end_turn" };
  }

  const usageCmd = /^usage:(\d+)\/(\d+)$/.exec(text);
  if (usageCmd) {
    await ctx.client.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "usage_update",
        used: Number(usageCmd[1]),
        size: Number(usageCmd[2]),
      },
    });
    await say("agent_message_chunk", "ok");
    return {
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    } as { stopReason: string };
  }

  if (text.startsWith("echo:")) {
    const t = text.slice(5);
    const n = Math.max(1, Math.ceil(t.length / 3));
    for (let i = 0; i < 3; i++) {
      const part = t.slice(i * n, (i + 1) * n);
      if (part) await say("agent_message_chunk", part);
    }
    return { stopReason: "end_turn" };
  }

  if (text.startsWith("think:")) {
    const t = text.slice(6);
    await say("agent_thought_chunk", "thinking...");
    await say("agent_message_chunk", t);
    return { stopReason: "end_turn" };
  }

  if (text === "tool") {
    const toolCallId = "tc-1";
    await ctx.client.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Fake tool",
        kind: "execute",
        status: "pending",
        content: [],
        locations: [],
      },
    });
    const permRes = (await ctx.client.request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId, title: "Fake tool", kind: "execute" },
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
        { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
        { optionId: "reject_always", name: "Reject always", kind: "reject_always" },
      ],
    })) as { outcome?: { outcome?: string; optionId?: string } };
    const outcome = permRes?.outcome;
    const selected = outcome?.outcome === "selected" ? (outcome.optionId ?? null) : null;
    const allowed = selected?.startsWith("allow");
    await ctx.client.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: allowed ? "completed" : "failed",
      },
    });
    await say("agent_message_chunk", `permission:${selected ?? "cancelled"}`);
    return { stopReason: "end_turn" };
  }

  if (text === "tools") {
    const toolCall = (toolCallId: string, title: string) =>
      ctx.client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title,
          kind: "execute",
          status: "pending",
        },
      });
    const toolUpdate = (toolCallId: string, status: string, title?: string) =>
      ctx.client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status,
          ...(title === undefined ? {} : { title }),
        },
      });
    await toolCall("tc-a", "Tool A");
    await toolCall("tc-b", "Tool B");
    await toolUpdate("tc-a", "in_progress");
    await toolUpdate("tc-b", "completed");
    // update for a toolCallId the daemon never saw: must be ignored
    await toolUpdate("tc-orphan", "completed");
    await toolUpdate("tc-a", "completed", "Tool A renamed");
    await say("agent_message_chunk", "tools:done");
    return { stopReason: "end_turn" };
  }

  if (text === "slow") {
    while (!cancelledSessions.has(sessionId)) {
      await say("agent_message_chunk", ".");
      await sleep(100);
    }
    return { stopReason: "cancelled" };
  }

  if (text === "slowseq") {
    let i = 0;
    while (!cancelledSessions.has(sessionId)) {
      await say("agent_message_chunk", `${i}|`);
      i += 1;
      await sleep(100);
    }
    return { stopReason: "cancelled" };
  }

  if (text === "ignorecancel") {
    for (;;) {
      await say("agent_message_chunk", ".");
      await sleep(100);
    }
  }

  if (text === "switchmodel") {
    state.config.model = MODEL_VALUES[1];
    saveState();
    await ctx.client.notify("session/update", {
      sessionId,
      update: { sessionUpdate: "config_option_update", configOptions: configOptions() },
    });
    return { stopReason: "end_turn" };
  }

  if (text === "history") {
    await say("agent_message_chunk", full);
    return { stopReason: "end_turn" };
  }

  if (text === "crash") {
    await say("agent_message_chunk", "before crash");
    process.exit(1);
  }

  await say("agent_message_chunk", `unhandled:${text}`);
  return { stopReason: "end_turn" };
}

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
);

acp
  .agent({ name: "fake-acp-agent" })
  .onRequest("initialize", async (ctx) => {
    logRequest("initialize", ctx.params);
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
      },
      authMethods: [],
    } as never;
  })
  .onRequest("session/new", async (ctx) => {
    logRequest("session/new", ctx.params);
    if (process.env.FAKE_ACP_NEW_ERROR) {
      throw new acp.RequestError(-32603, process.env.FAKE_ACP_NEW_ERROR);
    }
    const delay = Number.parseInt(process.env.FAKE_ACP_NEW_DELAY_MS ?? "", 10) || 0;
    if (delay > 0) await sleep(delay);
    const sessions = loadSessions();
    const sessionId = `fake-${Date.now()}-${sessionCounter++}`;
    sessions[sessionId] = { prompts: [] };
    saveSessions(sessions);
    sessionMcp.set(sessionId, (ctx.params as { mcpServers?: McpSpec[] }).mcpServers ?? []);
    return { sessionId, configOptions: configOptions() } as never;
  })
  .onRequest("session/load", async (ctx) => {
    const params = ctx.params as { sessionId: string; cwd?: string; mcpServers?: McpSpec[] };
    logRequest("session/load", params);
    if (process.env.FAKE_ACP_LOAD_BEHAVIOR === "close") process.exit(1);
    if (process.env.FAKE_ACP_LOAD_BEHAVIOR === "error") throw new Error("session load failed");
    if (process.env.FAKE_ACP_LOAD_BEHAVIOR === "auth") throw acp.RequestError.authRequired();
    sessionMcp.set(params.sessionId, params.mcpServers ?? []);
    const sessions = loadSessions();
    if (!sessions[params.sessionId]) {
      throw new Error(`unknown session ${params.sessionId}`);
    }
    // replay one chunk like a real agent; the daemon drops these
    await ctx.client.notify(
      "session/update",
      chunk(params.sessionId, "agent_message_chunk", "[replayed history]"),
    );
    return { configOptions: configOptions() } as never;
  })
  .onRequest("session/set_config_option", async (ctx) => {
    const params = ctx.params as { configId: string; value: string };
    logRequest("session/set_config_option", params);
    if (params.configId === "mode" || params.configId === "model" || params.configId === "effort") {
      state.config[params.configId] = params.value;
      saveState();
    }
    return { configOptions: configOptions() } as never;
  })
  .onRequest("session/prompt", async (ctx) => {
    logRequest("session/prompt", ctx.params);
    return (await handlePrompt(ctx as unknown as Ctx)) as never;
  })
  .onNotification("session/cancel", async (ctx) => {
    const params = ctx.params as { sessionId?: string };
    logRequest("session/cancel", params);
    if (params.sessionId) cancelledSessions.add(params.sessionId);
  })
  .connect(stream);
