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
//   slow           -> a chunk every 100ms; responds to session/cancel
//   ignorecancel   -> streams forever, ignores session/cancel
//   crash          -> one chunk then process.exit(1)

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
  const text = prompt?.[0]?.text ?? "";
  const sessions = loadSessions();
  sessions[sessionId] ??= { prompts: [] };
  sessions[sessionId].prompts.push(text);
  saveSessions(sessions);
  // cancel is per-turn: a new prompt clears it
  cancelledSessions.delete(sessionId);

  const say = async (kind: string, t: string) => {
    await ctx.client.notify("session/update", chunk(sessionId, kind, t));
  };

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

  if (text === "slow") {
    while (!cancelledSessions.has(sessionId)) {
      await say("agent_message_chunk", ".");
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
    const sessions = loadSessions();
    const sessionId = `fake-${Date.now()}-${sessionCounter++}`;
    sessions[sessionId] = { prompts: [] };
    saveSessions(sessions);
    return { sessionId } as never;
  })
  .onRequest("session/load", async (ctx) => {
    const params = ctx.params as { sessionId: string; cwd?: string };
    logRequest("session/load", params);
    const sessions = loadSessions();
    if (!sessions[params.sessionId]) {
      throw new Error(`unknown session ${params.sessionId}`);
    }
    // replay one chunk like a real agent; the daemon drops these
    await ctx.client.notify(
      "session/update",
      chunk(params.sessionId, "agent_message_chunk", "[replayed history]"),
    );
    return {} as never;
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
