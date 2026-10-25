#!/usr/bin/env bun
// Real-provider smoke test: runs the COMPILED daemon binary with a Finder-like
// PATH (/usr/bin:/bin:/usr/sbin:/sbin) to prove login-path resolution works,
// then drives each ACP provider through create -> send -> restart -> resume.
//
// Usage: bun scripts/smoke-acp-real.ts
// Writes spikes/out/phase2-real-smoke.json

import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent, ChatItem, PendingPermission, Turn } from "@openagent/protocol";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BINARY = join(ROOT, "apps/desktop/src-tauri/binaries/openagentd-aarch64-apple-darwin");
const TOKEN = `smoke-${crypto.randomUUID()}`;
const TURN_TIMEOUT_MS = 180_000;
const PROVIDERS = ["devin", "cursor", "grok", "opencode"] as const;
const DBG_DIR = mkdtempSync(join(tmpdir(), "oa-smoke-prompts-"));

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

class Ws {
  ws: WebSocket;
  private pending = new Map<string, Pending>();
  private waiters: {
    event: string;
    pred: (d: unknown) => boolean;
    resolve: (d: unknown) => void;
  }[] = [];
  events: { event: string; data: unknown }[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if ("event" in msg) {
        this.events.push(msg);
        const idx = this.waiters.findIndex((w) => w.event === msg.event && w.pred(msg.data));
        if (idx >= 0) this.waiters.splice(idx, 1)[0]?.resolve(msg.data);
      } else if ("id" in msg) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if ("error" in msg)
            p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
          else p.resolve(msg.result);
        }
      }
    });
  }

  static connect(port: number): Promise<Ws> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(TOKEN)}`);
      const t = setTimeout(() => reject(new Error("ws timeout")), 5000);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve(new Ws(ws));
      });
      ws.addEventListener("error", () => {
        clearTimeout(t);
        reject(new Error("ws error"));
      });
    });
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30000);
    });
  }

  waitEvent(event: string, pred: (d: unknown) => boolean, ms: number): Promise<unknown> {
    const existing = this.events.find((e) => e.event === event && pred(e.data));
    if (existing) return Promise.resolve(existing.data);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`event ${event} timeout`)), ms);
      this.waiters.push({
        event,
        pred,
        resolve: (d) => {
          clearTimeout(t);
          resolve(d);
        },
      });
    });
  }

  close() {
    this.ws.close();
  }
}

async function startDaemon(
  dataDir: string,
  agentsRoot: string,
): Promise<{ proc: ReturnType<typeof Bun.spawn>; port: number }> {
  const proc = Bun.spawn([BINARY, "--data-dir", dataDir, "--agents-root", agentsRoot], {
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: process.env.HOME ?? "",
      SHELL: process.env.SHELL ?? "/bin/zsh",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      OPENAGENT_DEBUG_PROMPTS_DIR: DBG_DIR,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const sink = proc.stdin as { write: (s: string) => void; flush: () => void };
  sink.write(`${TOKEN}\n`);
  sink.flush();
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  let buf = "";
  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no READY")), 20000);
    const pump = async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return reject(new Error("stdout closed"));
        buf += new TextDecoder().decode(value);
        const i = buf.indexOf("\n");
        if (i >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.startsWith("OPENAGENT_READY ")) {
            clearTimeout(t);
            resolve(JSON.parse(line.slice(16)).port);
            return;
          }
        }
      }
    };
    pump().catch(reject);
  });
  reader.releaseLock();
  return { proc, port };
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "oa-smoke-data-"));
  const agentsRoot = mkdtempSync(join(tmpdir(), "oa-smoke-agents-"));
  const results: Record<string, unknown>[] = [];

  let daemon = await startDaemon(dataDir, agentsRoot);
  let c = await Ws.connect(daemon.port);

  for (const provider of PROVIDERS) {
    const rec: Record<string, unknown> = { provider, t0: Date.now() };
    results.push(rec);
    try {
      const agent = (await c.request("agents.create", {
        name: `smoke-${provider}`,
        provider,
        instructions: "Always answer in lowercase.",
      })) as Agent;
      rec.agentId = agent.id;

      try {
        const co = (await c.request("agents.configOptions", { agentId: agent.id })) as {
          configOptions: { id: string; category: string | null; currentValue: string }[];
        };
        rec.configOptions = co.configOptions.map((o) => ({
          id: o.id,
          category: o.category,
          currentValue: o.currentValue,
        }));
      } catch (e) {
        rec.configOptionsError = String(e);
      }

      const permWatch = c
        .waitEvent(
          "permission.requested",
          (d) => (d as PendingPermission).agentId === agent.id,
          TURN_TIMEOUT_MS * 10,
        )
        .then(async (p) => {
          const perm = p as PendingPermission;
          rec.permissionRequest = { title: perm.title, answered: "reject_once" };
          await c.request("permissions.respond", {
            requestId: perm.requestId,
            optionId: "reject_once",
          });
        })
        .catch(() => {});
      void permWatch;

      // turn 1
      let t0 = Date.now();
      await c.request("chat.send", {
        agentId: agent.id,
        text: "Reply with exactly one word: pong",
      });
      const t1 = (await c.waitEvent(
        "turn.ended",
        (d) => (d as Turn).agentId === agent.id,
        TURN_TIMEOUT_MS,
      )) as Turn;
      rec.turn1 = {
        status: t1.status,
        stopReason: t1.stopReason,
        ms: Date.now() - t0,
        error: t1.error,
      };
      const h1 = (await c.request("chat.history", { agentId: agent.id })) as { items: ChatItem[] };
      rec.reply1 = h1.items
        .filter((i) => i.kind === "agent_message")
        .map((i) => (i as { text: string }).text)
        .join("");

      // restart the daemon (still Finder-like PATH)
      daemon.proc.kill("SIGTERM");
      await daemon.proc.exited;
      c.close();
      daemon = await startDaemon(dataDir, agentsRoot);
      c = await Ws.connect(daemon.port);

      const db = new Database(join(dataDir, "openagent.db"), { readonly: true });
      const sessBefore = db
        .query("SELECT session_id FROM agent_sessions WHERE agent_id = ?")
        .get(agent.id) as { session_id: string } | null;
      db.close();

      // turn 2: recall previous reply
      t0 = Date.now();
      const s2 = (await c.request("chat.send", {
        agentId: agent.id,
        text: "Which single word did you reply with in your previous message? Answer with that one word only.",
      })) as { queueId: string };
      const t2 = (await c.waitEvent(
        "turn.ended",
        (d) => (d as Turn).queueId === s2.queueId,
        TURN_TIMEOUT_MS,
      )) as Turn;
      rec.turn2 = {
        status: t2.status,
        stopReason: t2.stopReason,
        ms: Date.now() - t0,
        error: t2.error,
      };
      const h2 = (await c.request("chat.history", { agentId: agent.id })) as { items: ChatItem[] };
      const msgs = h2.items.filter((i) => i.kind === "agent_message") as { text: string }[];
      rec.reply2 = msgs[msgs.length - 1]?.text ?? null;

      const db2 = new Database(join(dataDir, "openagent.db"), { readonly: true });
      const sessAfter = db2
        .query("SELECT session_id, updated_at FROM agent_sessions WHERE agent_id = ?")
        .get(agent.id) as { session_id: string; updated_at: number } | null;
      db2.close();
      rec.sessionResumed = sessBefore !== null && sessAfter?.session_id === sessBefore.session_id;
      rec.sessionId = sessAfter?.session_id ?? null;

      // handoff: devin agent learns a secret, switch provider to grok, ask it back
      if (provider === "devin") {
        const s3 = (await c.request("chat.send", {
          agentId: agent.id,
          text: "My secret word is mango. Reply only: ok",
        })) as { queueId: string };
        const t3 = (await c.waitEvent(
          "turn.ended",
          (d) => (d as Turn).queueId === s3.queueId,
          TURN_TIMEOUT_MS,
        )) as Turn;
        rec.handoffTurn1 = { status: t3.status };
        if (t3.status !== "completed") throw new Error(`mango turn ended ${t3.status}`);
        await c.request("agents.update", { id: agent.id, provider: "grok" });
        const s4 = (await c.request("chat.send", {
          agentId: agent.id,
          text: "What is my secret word? Answer with one word.",
        })) as { queueId: string };
        const t4 = (await c.waitEvent(
          "turn.ended",
          (d) => (d as Turn).queueId === s4.queueId,
          TURN_TIMEOUT_MS,
        )) as Turn;
        rec.handoffTurn2 = { status: t4.status };
        const h3 = (await c.request("chat.history", { agentId: agent.id })) as {
          items: ChatItem[];
        };
        const msgs3 = h3.items.filter((i) => i.kind === "agent_message") as {
          text: string;
        }[];
        rec.handoffReply = msgs3[msgs3.length - 1]?.text?.trim() ?? null;
      }

      // grok setConfig: pick a different listed model, send pong, expect completed
      if (provider === "grok") {
        const co = (await c.request("agents.configOptions", { agentId: agent.id })) as {
          configOptions: { id: string; currentValue: string; options: { value: string }[] }[];
        };
        const model = co.configOptions.find((o) => o.id === "model" || o.category === "model");
        const other = model?.options.find((v) => v.value !== model.currentValue)?.value;
        if (other) {
          await c.request("agents.setConfig", {
            agentId: agent.id,
            configId: model?.id,
            value: other,
          });
          rec.setConfigApplied = other;
          const s5 = (await c.request("chat.send", {
            agentId: agent.id,
            text: "Reply with exactly one word: pong",
          })) as { queueId: string };
          const t5 = (await c.waitEvent(
            "turn.ended",
            (d) => (d as Turn).queueId === s5.queueId,
            TURN_TIMEOUT_MS,
          )) as Turn;
          rec.setConfigTurn = { status: t5.status, stopReason: t5.stopReason };
        }
      }
    } catch (e) {
      rec.error = e instanceof Error ? e.message : String(e);
    }
    rec.totalMs = Date.now() - (rec.t0 as number);
    delete rec.t0;
    console.log(`[smoke] ${provider}:`, JSON.stringify(rec));
  }

  daemon.proc.kill("SIGTERM");
  await Promise.race([daemon.proc.exited, new Promise((r) => setTimeout(r, 6000))]);
  try {
    daemon.proc.kill("SIGKILL");
  } catch {}
  c.close();

  mkdirSync(join(ROOT, "spikes/out"), { recursive: true });
  const outPath = join(ROOT, "spikes/out/phase2-real-smoke.json");
  writeFileSync(outPath, JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
  console.log(`wrote ${outPath} (prompts in ${DBG_DIR})`);
  process.exit(0);
}

main().catch((e) => {
  console.error("fatal", e);
  process.exit(1);
});
