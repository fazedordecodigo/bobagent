#!/usr/bin/env bun

// Fake `codex app-server` for daemon e2e tests: JSON-RPC lines over stdio.
// Logs every inbound message to $FAKE_CODEX_STATE_DIR/log.jsonl, its pid to pids.txt.
// FAKE_CODEX_NO_AUTH=1 makes account/read report a signed-out user.
//
// Prompt behaviors (text after any <conversation_history>/<agent_instructions> block):
//   echo:<t>  -> agentMessage deltas, turn completed
//   split:<t> -> agentMessage split inside a multi-byte UTF-8 character, turn completed
//   think:<t> -> reasoning delta then text <t>
//   tool      -> commandExecution + requestApproval -> "permission:<decision>"
//   whoami    -> "sandbox=<type> approval=<p> model=<m> effort=<e> thread=<id>"
//   slow      -> a delta every 100ms until turn/interrupt
//   fail      -> turn completed with status failed
//   crash     -> process.exit(1)

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATE_DIR = process.env.FAKE_CODEX_STATE_DIR ?? join(process.cwd(), ".fake-codex-state");
mkdirSync(STATE_DIR, { recursive: true });
const LOG = join(STATE_DIR, "log.jsonl");
const THREADS = join(STATE_DIR, "threads.json");
appendFileSync(join(STATE_DIR, "pids.txt"), `${process.pid}\n`);
const log = (method: string, params: unknown) =>
  appendFileSync(LOG, `${JSON.stringify({ ts: Date.now(), method, params })}\n`);
log("argv", process.argv.slice(2));

type J = Record<string, unknown>;
const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
const notify = (method: string, params: unknown) => send({ method, params });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function notifySplit(method: string, params: unknown) {
  const line = Buffer.from(`${JSON.stringify({ method, params })}\n`);
  const splitAt = line.findIndex((byte) => byte >= 0xc0) + 1;
  process.stdout.write(line.subarray(0, splitAt));
  await sleep(50);
  process.stdout.write(line.subarray(splitAt));
}
const threads = (): string[] => {
  try {
    return JSON.parse(readFileSync(THREADS, "utf8"));
  } catch {
    return [];
  }
};

let nextServerId = 1000;
const serverPending = new Map<number, (r: J) => void>();
const interrupted = new Set<string>();

function serverRequest(method: string, params: unknown): Promise<J> {
  const id = nextServerId++;
  return new Promise((resolve) => {
    serverPending.set(id, resolve);
    send({ id, method, params });
  });
}

const MODELS = [
  {
    id: "m-a",
    model: "gpt-a",
    displayName: "GPT A",
    description: "a",
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
  },
  {
    id: "m-b",
    model: "gpt-b",
    displayName: "GPT B",
    description: "b",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [{ reasoningEffort: "low" }],
  },
  {
    id: "m-h",
    model: "gpt-hidden",
    displayName: "Hidden",
    description: "h",
    hidden: true,
    isDefault: false,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [],
  },
];

function message(threadId: string, turnId: string, text: string) {
  const itemId = `msg-${crypto.randomUUID()}`;
  notify("item/started", {
    threadId,
    turnId,
    item: { type: "agentMessage", id: itemId, text: "" },
  });
  const half = Math.ceil(text.length / 2);
  for (const delta of [text.slice(0, half), text.slice(half)]) {
    if (delta) notify("item/agentMessage/delta", { threadId, turnId, itemId, delta });
  }
  notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: itemId, text } });
}

let usageTotals = 0;
function complete(threadId: string, turnId: string, status: string, error: J | null = null) {
  usageTotals += 1;
  notify("thread/tokenUsage/updated", {
    threadId,
    turnId,
    tokenUsage: {
      total: {
        totalTokens: usageTotals * 150,
        inputTokens: usageTotals * 100,
        outputTokens: usageTotals * 50,
      },
      last: { totalTokens: 150, inputTokens: 100, outputTokens: 50 },
      modelContextWindow: 258000,
    },
  });
  notify("turn/completed", { threadId, turn: { id: turnId, items: [], status, error } });
}

async function runTurn(threadId: string, turnId: string, params: J) {
  const input = (params.input as J[])[0] as J;
  const text = String(input.text)
    .replace(/^[\s\S]*<\/(conversation_history|agent_instructions|upbot_context)>\s*/, "")
    .trim();
  notify("turn/started", {
    threadId,
    turn: { id: turnId, items: [], status: "inProgress", error: null },
  });
  if (text.startsWith("echo:")) {
    message(threadId, turnId, text.slice(5));
    complete(threadId, turnId, "completed");
  } else if (text.startsWith("split:")) {
    const itemId = `msg-${crypto.randomUUID()}`;
    notify("item/started", {
      threadId,
      turnId,
      item: { type: "agentMessage", id: itemId, text: "" },
    });
    await notifySplit("item/completed", {
      threadId,
      turnId,
      item: { type: "agentMessage", id: itemId, text: text.slice(6) },
    });
    complete(threadId, turnId, "completed");
  } else if (text.startsWith("think:")) {
    notify("item/reasoning/summaryTextDelta", {
      threadId,
      turnId,
      itemId: "r1",
      delta: "pondering",
      summaryIndex: 0,
    });
    message(threadId, turnId, text.slice(6));
    complete(threadId, turnId, "completed");
  } else if (text === "tool") {
    const itemId = `cmd-${crypto.randomUUID()}`;
    notify("item/started", {
      threadId,
      turnId,
      item: {
        type: "commandExecution",
        id: itemId,
        command: "ls -la",
        cwd: "/tmp",
        status: "inProgress",
      },
    });
    const res = await serverRequest("item/commandExecution/requestApproval", {
      threadId,
      turnId,
      itemId,
      command: "ls -la",
      cwd: "/tmp",
      startedAtMs: Date.now(),
    });
    const ok = res.decision === "accept" || res.decision === "acceptForSession";
    notify("item/completed", {
      threadId,
      turnId,
      item: {
        type: "commandExecution",
        id: itemId,
        command: "ls -la",
        status: ok ? "completed" : "declined",
        exitCode: ok ? 0 : null,
        aggregatedOutput: ok ? "file-a\nfile-b" : null,
      },
    });
    if (res.decision === "cancel") return complete(threadId, turnId, "interrupted");
    message(threadId, turnId, `permission:${String(res.decision)}`);
    complete(threadId, turnId, "completed");
  } else if (text === "whoami") {
    const sp = params.sandboxPolicy as J | undefined;
    message(
      threadId,
      turnId,
      `sandbox=${sp?.type} approval=${params.approvalPolicy} model=${params.model} effort=${params.effort} thread=${threadId}`,
    );
    complete(threadId, turnId, "completed");
  } else if (text === "slow") {
    for (let i = 0; i < 600 && !interrupted.has(turnId); i++) {
      notify("item/agentMessage/delta", { threadId, turnId, itemId: "slow", delta: `tick${i} ` });
      await sleep(100);
    }
    complete(threadId, turnId, "interrupted");
  } else if (text === "fail") {
    complete(threadId, turnId, "failed", { message: "model exploded" });
  } else if (text === "crash") {
    process.exit(1);
  } else {
    message(threadId, turnId, `unknown:${text}`);
    complete(threadId, turnId, "completed");
  }
}

function thread(id: string) {
  return {
    thread: { id, cwd: "/tmp", status: { type: "idle" }, turns: [] },
    model: "gpt-a",
    reasoningEffort: null,
  };
}

function handle(m: J) {
  const id = m.id as number;
  const p = (m.params ?? {}) as J;
  const ok = (result: unknown) => send({ id, result });
  switch (m.method) {
    case "initialize":
      return ok({
        userAgent: "fake-codex/0.0.0",
        codexHome: STATE_DIR,
        platformFamily: "unix",
        platformOs: "macos",
      });
    case "account/read":
      return ok(
        process.env.FAKE_CODEX_NO_AUTH
          ? { account: null, requiresOpenaiAuth: true }
          : { account: { type: "chatgpt", email: "x@y.z" }, requiresOpenaiAuth: true },
      );
    case "thread/start": {
      const tid = crypto.randomUUID();
      writeFileSync(THREADS, JSON.stringify([...threads(), tid]));
      ok(thread(tid));
      return notify("thread/started", thread(tid));
    }
    case "thread/resume":
      if (!threads().includes(String(p.threadId))) {
        return send({
          id,
          error: { code: -32600, message: `no rollout found for thread id ${p.threadId}` },
        });
      }
      return ok(thread(String(p.threadId)));
    case "model/list":
      return ok({ data: MODELS, nextCursor: null });
    case "turn/start": {
      const turnId = crypto.randomUUID();
      ok({ turn: { id: turnId, items: [], status: "inProgress", error: null } });
      void runTurn(String(p.threadId), turnId, p);
      return;
    }
    case "turn/interrupt":
      interrupted.add(String(p.turnId));
      return ok({});
    default:
      return send({ id, error: { code: -32601, message: `unknown method ${m.method}` } });
  }
}

let buf = "";
process.stdin.on("data", (d: Buffer) => {
  buf += d.toString("utf8");
  let i = buf.indexOf("\n");
  while (i >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    i = buf.indexOf("\n");
    if (!line.trim()) continue;
    const m = JSON.parse(line) as J;
    log(String(m.method ?? "response"), m);
    if (m.method === undefined && typeof m.id === "number") {
      const cb = serverPending.get(m.id);
      serverPending.delete(m.id);
      cb?.((m.result ?? {}) as J);
    } else if (m.id !== undefined) {
      handle(m);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
