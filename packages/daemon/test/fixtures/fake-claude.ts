#!/usr/bin/env bun

// Fake Claude Code CLI for daemon e2e tests: speaks the stream-json stdio protocol
// (control_request/control_response + user/assistant/result lines). Logs argv and
// every stdin message to $FAKE_CLAUDE_STATE_DIR/log.jsonl, its pid to pids.txt.
// A $FAKE_CLAUDE_STATE_DIR/fail-start file makes every launch exit transiently.
//
// Prompt behaviors (by text prefix, after any <conversation_history>/<agent_instructions>):
//   echo:<t>    -> streamed text deltas + full assistant message, result success
//   split:<t>   -> assistant message split inside a multi-byte UTF-8 character, result success
//   think:<t>   -> thinking delta, then text <t>
//   tool        -> tool_use Bash + can_use_tool -> tool_result -> "permission:<behavior>"
//   whoami      -> "mode=<m> model=<m> session=<id>"
//   slow        -> a delta every 100ms until an interrupt control request
//   authfail    -> synthetic "Not logged in" error result
//   crash       -> process.exit(1)

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATE_DIR = process.env.FAKE_CLAUDE_STATE_DIR ?? join(process.cwd(), ".fake-claude-state");
mkdirSync(STATE_DIR, { recursive: true });
const LOG = join(STATE_DIR, "log.jsonl");
const SESSIONS = join(STATE_DIR, "sessions.json");
appendFileSync(join(STATE_DIR, "pids.txt"), `${process.pid}\n`);

function log(method: string, params: unknown) {
  appendFileSync(LOG, `${JSON.stringify({ ts: Date.now(), method, params })}\n`);
}
log("argv", process.argv.slice(2));
if (existsSync(join(STATE_DIR, "fail-start"))) {
  process.stderr.write("transient start failure\n");
  process.exit(1);
}

const argv = process.argv.slice(2);
const argOf = (flag: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

function sessions(): string[] {
  try {
    return JSON.parse(readFileSync(SESSIONS, "utf8"));
  } catch {
    return [];
  }
}

const resume = argOf("--resume");
if (resume && !sessions().includes(resume)) {
  process.stderr.write(`No conversation found with session ID: ${resume}\n`);
  process.exit(1);
}
const sessionId = resume ?? argOf("--session-id") ?? crypto.randomUUID();
let mode = argOf("--permission-mode") ?? "default";
let model = "default";
let interrupted = false;
let pendingPermission: ((r: Record<string, unknown>) => void) | null = null;

const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendSplit(m: unknown) {
  const line = Buffer.from(`${JSON.stringify(m)}\n`);
  const splitAt = line.findIndex((byte) => byte >= 0xc0) + 1;
  process.stdout.write(line.subarray(0, splitAt));
  await sleep(50);
  process.stdout.write(line.subarray(splitAt));
}

function streamText(msgId: string, text: string, kind: "text" | "thinking" = "text") {
  send({ type: "stream_event", event: { type: "message_start", message: { id: msgId } } });
  const parts = [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))];
  for (const p of parts) {
    if (!p) continue;
    send({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta:
          kind === "text"
            ? { type: "text_delta", text: p }
            : { type: "thinking_delta", thinking: p },
      },
    });
  }
  send({
    type: "assistant",
    session_id: sessionId,
    message: {
      id: msgId,
      model: "fake",
      role: "assistant",
      content: [kind === "text" ? { type: "text", text } : { type: "thinking", thinking: text }],
    },
  });
}

let totalCost = 0;
function result(extra: Record<string, unknown> = {}) {
  totalCost += 0.01;
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    result: "",
    usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 },
    total_cost_usd: totalCost,
    modelUsage: { fake: { contextWindow: 200000 } },
    ...extra,
  });
}

async function runPrompt(raw: string) {
  const s = sessions();
  if (!s.includes(sessionId)) writeFileSync(SESSIONS, JSON.stringify([...s, sessionId]));
  const text = raw
    .replace(/^[\s\S]*<\/(conversation_history|agent_instructions|upbot_context)>\s*/, "")
    .trim();
  send({ type: "system", subtype: "init", session_id: sessionId, permissionMode: mode, model });
  interrupted = false;
  if (text.startsWith("echo:")) {
    streamText(`msg-${Date.now()}`, text.slice(5));
    result();
  } else if (text.startsWith("split:")) {
    await sendSplit({
      type: "assistant",
      session_id: sessionId,
      message: {
        id: `msg-${Date.now()}`,
        model: "fake",
        role: "assistant",
        content: [{ type: "text", text: text.slice(6) }],
      },
    });
    result();
  } else if (text.startsWith("think:")) {
    streamText(`th-${Date.now()}`, "pondering", "thinking");
    streamText(`msg-${Date.now()}`, text.slice(6));
    result();
  } else if (text === "tool") {
    const toolId = `toolu_${Date.now()}`;
    send({
      type: "assistant",
      session_id: sessionId,
      message: {
        id: `m-${toolId}`,
        model: "fake",
        content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command: "ls -la" } }],
      },
    });
    const res = await new Promise<Record<string, unknown>>((resolve) => {
      pendingPermission = resolve;
      send({
        type: "control_request",
        request_id: `perm-${toolId}`,
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "ls -la" },
          tool_use_id: toolId,
          permission_suggestions: [
            {
              type: "addRules",
              rules: [{ toolName: "Bash" }],
              behavior: "allow",
              destination: "session",
            },
          ],
        },
      });
    });
    const allowed = res.behavior === "allow";
    send({
      type: "user",
      session_id: sessionId,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolId,
            is_error: !allowed,
            content: allowed ? "file-a\nfile-b" : String(res.message),
          },
        ],
      },
    });
    if (res.interrupt === true) {
      result({ subtype: "error_during_execution", is_error: true });
      return;
    }
    const always = Array.isArray(res.updatedPermissions) ? "+always" : "";
    streamText(`msg-${Date.now()}`, `permission:${String(res.behavior)}${always}`);
    result();
  } else if (text === "whoami") {
    streamText(`msg-${Date.now()}`, `mode=${mode} model=${model} session=${sessionId}`);
    result();
  } else if (text === "slow") {
    for (let i = 0; i < 600 && !interrupted; i++) {
      streamText(`msg-${i}`, `tick${i} `);
      await sleep(100);
    }
    result({ subtype: "error_during_execution", is_error: true });
  } else if (text === "authfail") {
    send({
      type: "assistant",
      session_id: sessionId,
      error: "authentication_failed",
      message: {
        id: "synthetic",
        model: "<synthetic>",
        content: [{ type: "text", text: "Not logged in · Please run /login" }],
      },
    });
    result({ is_error: true, result: "Not logged in · Please run /login" });
  } else if (text === "crash") {
    process.exit(1);
  } else {
    streamText(`msg-${Date.now()}`, `unknown:${text}`);
    result();
  }
}

let buf = "";
let queue = Promise.resolve();
process.stdin.on("data", (d: Buffer) => {
  buf += d.toString("utf8");
  let i = buf.indexOf("\n");
  while (i >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    i = buf.indexOf("\n");
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    log(m.type === "control_request" ? `control:${m.request.subtype}` : m.type, m);
    if (m.type === "control_request") {
      const r = m.request;
      const ok = (response: unknown = {}) =>
        send({
          type: "control_response",
          response: { subtype: "success", request_id: m.request_id, response },
        });
      if (r.subtype === "initialize") {
        ok({
          commands: [],
          models: [
            { value: "default", displayName: "Default", description: "fake default" },
            { value: "sonnet", displayName: "Sonnet", description: "fake sonnet" },
          ],
          current_permission_mode: mode,
          account: {},
        });
      } else if (r.subtype === "interrupt") {
        interrupted = true;
        if (pendingPermission) {
          pendingPermission({ behavior: "deny", message: "interrupted", interrupt: true });
          pendingPermission = null;
        }
        ok({ still_queued: [] });
      } else if (r.subtype === "set_permission_mode") {
        mode = r.mode;
        ok();
      } else if (r.subtype === "set_model") {
        model = r.model;
        ok();
      } else {
        send({
          type: "control_response",
          response: { subtype: "error", request_id: m.request_id, error: "unsupported" },
        });
      }
    } else if (m.type === "control_response") {
      if (pendingPermission) {
        const cb = pendingPermission;
        pendingPermission = null;
        cb(m.response.response);
      }
    } else if (m.type === "user") {
      const content = m.message.content;
      const text = Array.isArray(content)
        ? content.map((c: { text?: string }) => c.text ?? "").join("")
        : String(content);
      queue = queue.then(() => runPrompt(text));
    }
  }
});
process.stdin.on("end", () => process.exit(0));
