import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Agent,
  DaemonEventMap,
  MethodName,
  MethodParams,
  MethodResult,
  Turn,
} from "@boto/protocol";
import { readReadyPort } from "../src/ready";

type DaemonEventName = keyof DaemonEventMap;

export const ROOT = join(import.meta.dir, "../../..");
export const DAEMON = join(ROOT, "packages/daemon/src/main.ts");
export const FAKE_AGENT = join(ROOT, "packages/daemon/test/fixtures/fake-acp-agent.ts");

export type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

export class DaemonClient {
  ws: WebSocket;
  private pending = new Map<string, Pending>();
  private eventWaiters: {
    event: string;
    pred: (d: unknown) => boolean;
    resolve: (d: unknown) => void;
  }[] = [];
  events: { event: string; data: unknown }[] = [];
  /** Events below this index are considered consumed and never matched again. */
  private cursor = 0;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if ("event" in msg) {
        this.events.push(msg);
        const idx = this.events.length - 1;
        for (let i = 0; i < this.eventWaiters.length; i++) {
          const w = this.eventWaiters[i]!;
          if (w.event === msg.event && w.pred(msg.data)) {
            this.eventWaiters.splice(i, 1);
            this.cursor = Math.max(this.cursor, idx + 1);
            w.resolve(msg.data);
            break;
          }
        }
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

  static connect(port: number, token: string): Promise<DaemonClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
      const timer = setTimeout(() => reject(new Error("ws connect timeout")), 5000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new DaemonClient(ws));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("ws connect failed"));
      });
    });
  }

  static connectExpectFail(port: number, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
      const timer = setTimeout(() => reject(new Error("ws unexpectedly hung")), 5000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        reject(new Error("ws connected but should have been rejected"));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  request<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
  request(method: string, params?: unknown): Promise<unknown>;
  request(method: string, params: unknown = {}): Promise<unknown> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`request ${method} timed out`));
      }, 10000);
    });
  }

  waitForEvent<E extends DaemonEventName>(event: E, timeoutMs = 10000): Promise<DaemonEventMap[E]> {
    return this.waitForEventWhere(event, () => true, timeoutMs);
  }

  /** Wait for the next event matching a predicate; already-consumed events are skipped. */
  waitForEventWhere<E extends DaemonEventName>(
    event: E,
    pred: (data: DaemonEventMap[E]) => boolean,
    timeoutMs = 10000,
  ): Promise<DaemonEventMap[E]> {
    const test = (d: unknown) => pred(d as DaemonEventMap[E]);
    const idx = this.events.findIndex(
      (e, i) => i >= this.cursor && e.event === event && test(e.data),
    );
    if (idx >= 0) {
      this.cursor = idx + 1;
      return Promise.resolve(this.events[idx]?.data as DaemonEventMap[E]);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`event ${event} timeout`)), timeoutMs);
      this.eventWaiters.push({
        event,
        pred: test,
        resolve: (d) => {
          clearTimeout(timer);
          resolve(d as DaemonEventMap[E]);
        },
      });
    });
  }

  eventKinds(): string[] {
    return this.events.map((e) => e.event);
  }

  close() {
    this.ws.close();
  }
}

export type DaemonHandle = {
  proc: ReturnType<typeof Bun.spawn>;
  port: number;
  stderrText?: Promise<string>;
};

export async function startDaemon(
  dataDir: string,
  agentsRoot: string,
  token: string,
  env: Record<string, string> = {},
  captureStderr = false,
): Promise<DaemonHandle> {
  const proc = Bun.spawn(["bun", DAEMON, "--data-dir", dataDir, "--agents-root", agentsRoot], {
    env: { ...process.env, BOTO_DEFAULT_BOT: "off", ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: ROOT,
  });
  const stderrText = captureStderr
    ? new Response(proc.stderr as ReadableStream<Uint8Array>).text()
    : undefined;
  // token is delivered on the first stdin line, never via env
  const port = await readReadyPort(proc, token, 15000).catch((error) => {
    proc.kill();
    throw error;
  });
  return stderrText ? { proc, port, stderrText } : { proc, port };
}

export function waitForExit(proc: ReturnType<typeof Bun.spawn>, ms: number): Promise<number> {
  return Promise.race([
    proc.exited,
    new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error("process did not exit")), ms),
    ),
  ]);
}

export function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function stopTestChildren(stateDirs: string | string[] | undefined): Promise<void> {
  const states = Array.isArray(stateDirs) ? stateDirs : stateDirs ? [stateDirs] : [];
  const pids = [...new Set(states.flatMap((stateDir) => readPids(stateDir)))];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  await Promise.all(pids.map((pid) => waitForPidDead(pid).catch(() => {})));
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readPids(stateDir: string): number[] {
  const f = join(stateDir, "pids.txt");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map(Number);
}

export function readLog(stateDir: string): { ts: number; method: string; params: unknown }[] {
  const f = join(stateDir, "log.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export async function waitForPidDead(pid: number, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`pid ${pid} still alive`);
}

/** Sends a chat message and resolves with its turn once `turn.ended` arrives. */
export async function sendAndWait(
  c: DaemonClient,
  agentId: string,
  text: string,
  timeoutMs = 30000,
): Promise<Turn> {
  const { queueId } = await c.request("chat.send", { agentId, text });
  return c.waitForEventWhere("turn.ended", (t) => t.queueId === queueId, timeoutMs);
}

/** Runs a bridge tool (`mcp:<name> <args>`) and returns the agent's reply text for that turn. */
export async function toolCall(
  c: DaemonClient,
  agent: Agent,
  name: string,
  args: Record<string, unknown> = {},
  timeoutMs = 30000,
): Promise<string> {
  const t = await sendAndWait(c, agent.id, `mcp:${name} ${JSON.stringify(args)}`, timeoutMs);
  const { items } = await c.request("chat.history", { agentId: agent.id });
  const msg = items.filter((i) => i.turnId === t.id && i.kind === "agent_message").pop();
  return msg && "text" in msg ? msg.text : "";
}

/** Text of the most recent agent_message in the agent's history ("" if none). */
export async function lastAgentText(c: DaemonClient, agentId: string): Promise<string> {
  const { items } = await c.request("chat.history", { agentId });
  const msg = items.filter((i) => i.kind === "agent_message").pop();
  return msg && "text" in msg ? msg.text : "";
}

/** Closes the client, kills the daemon and terminates leftover fake-agent children. */
export async function stopDaemon(
  handle: DaemonHandle,
  client: DaemonClient | undefined,
  stateDirs?: string | string[],
  signal: "SIGKILL" | "SIGTERM" = "SIGKILL",
): Promise<void> {
  client?.close();
  try {
    handle.proc.kill(signal);
  } catch {}
  await handle.proc.exited;
  await stopTestChildren(stateDirs);
}
