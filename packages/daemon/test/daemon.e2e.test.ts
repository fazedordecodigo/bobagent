import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@bobagent/protocol";

const ROOT = join(import.meta.dir, "../../..");
const DAEMON = join(ROOT, "packages/daemon/src/main.ts");
const TOKEN = `test-token-${crypto.randomUUID()}`;

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

class DaemonClient {
  ws: WebSocket;
  private pending = new Map<string, Pending>();
  private eventWaiters: { event: string; resolve: (d: unknown) => void }[] = [];
  events: { event: string; data: unknown }[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if ("event" in msg) {
        this.events.push(msg);
        const idx = this.eventWaiters.findIndex((w) => w.event === msg.event);
        if (idx >= 0) this.eventWaiters.splice(idx, 1)[0]?.resolve(msg.data);
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

  request(method: string, params: unknown = {}): Promise<unknown> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`request ${method} timed out`));
      }, 5000);
    });
  }

  waitForEvent(event: string, timeoutMs = 5000): Promise<unknown> {
    const existing = this.events.find((e) => e.event === event);
    if (existing) return Promise.resolve(existing.data);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`event ${event} timeout`)), timeoutMs);
      this.eventWaiters.push({
        event,
        resolve: (d) => {
          clearTimeout(timer);
          resolve(d);
        },
      });
    });
  }

  close() {
    this.ws.close();
  }
}

type DaemonHandle = {
  proc: ReturnType<typeof Bun.spawn>;
  port: number;
};

async function startDaemon(dataDir: string, agentsRoot: string): Promise<DaemonHandle> {
  const proc = Bun.spawn(["bun", DAEMON, "--data-dir", dataDir, "--agents-root", agentsRoot], {
    env: { ...process.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: ROOT,
  });
  (proc.stdin as { write: (s: string) => void; flush: () => void }).write(`${TOKEN}\n`);
  (proc.stdin as { flush: () => void }).flush();
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("daemon did not print READY")), 15000);
    const pump = async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          reject(new Error("daemon stdout closed before READY"));
          return;
        }
        buf += decoder.decode(value);
        const idx = buf.indexOf("\n");
        if (idx >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.startsWith("BOBAGENT_READY ")) {
            clearTimeout(timer);
            resolve(JSON.parse(line.slice("BOBAGENT_READY ".length)).port);
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

function waitForExit(proc: ReturnType<typeof Bun.spawn>, ms: number): Promise<number> {
  return Promise.race([
    proc.exited,
    new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error("process did not exit")), ms),
    ),
  ]);
}

describe("daemon e2e", () => {
  let dataDir: string;
  let agentsRoot: string;
  let daemon: DaemonHandle;
  let createdAgentId = "";

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "bobagentd-data-"));
    agentsRoot = mkdtempSync(join(tmpdir(), "bobagentd-agents-"));
    daemon = await startDaemon(dataDir, agentsRoot);
  });

  afterAll(() => {
    try {
      daemon.proc.kill("SIGKILL");
    } catch {}
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(agentsRoot, { recursive: true, force: true });
  });

  test("health: token -> 200, no token -> 401, bad origin -> 403", async () => {
    const ok = await fetch(`http://127.0.0.1:${daemon.port}/health`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");

    const noToken = await fetch(`http://127.0.0.1:${daemon.port}/health`);
    expect(noToken.status).toBe(401);

    const badOrigin = await fetch(`http://127.0.0.1:${daemon.port}/health`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: "https://evil.example" },
    });
    expect(badOrigin.status).toBe(403);
  });

  test("ws: bad/missing token rejected, valid token connects", async () => {
    await DaemonClient.connectExpectFail(daemon.port, "");
    await DaemonClient.connectExpectFail(daemon.port, "wrong-token");
    const c = await DaemonClient.connect(daemon.port, TOKEN);
    c.close();
  });

  test("agent lifecycle: create, list, broadcast, update, errors, delete", async () => {
    const c1 = await DaemonClient.connect(daemon.port, TOKEN);
    const c2 = await DaemonClient.connect(daemon.port, TOKEN);

    // create
    const created = (await c1.request("agents.create", {
      name: "Test Agent",
      provider: "devin",
      instructions: "do stuff",
    })) as Agent;
    expect(created.id).toBeTruthy();
    expect(created.provider).toBe("devin");
    createdAgentId = created.id;
    expect(existsSync(created.workspacePath)).toBe(true);
    expect(created.workspacePath.startsWith(agentsRoot)).toBe(true);

    // second socket receives agent.created
    const ev = (await c2.waitForEvent("agent.created")) as Agent;
    expect(ev.id).toBe(created.id);

    // list contains it
    const list = (await c1.request("agents.list", {})) as Agent[];
    expect(list.some((a) => a.id === created.id)).toBe(true);

    // update name -> agent.updated
    const updated = (await c1.request("agents.update", {
      id: created.id,
      name: "Renamed",
    })) as Agent;
    expect(updated.name).toBe("Renamed");
    const updEv = (await c2.waitForEvent("agent.updated")) as Agent;
    expect(updEv.id).toBe(created.id);
    expect(updEv.name).toBe("Renamed");

    // invalid params -> bad_request
    await expect(
      c1.request("agents.create", { name: "", provider: "devin" }),
    ).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(
      c1.request("agents.create", { name: "X", provider: "not-a-provider" }),
    ).rejects.toMatchObject({ code: "bad_request" });

    // unknown ids -> not_found
    await expect(
      c1.request("agents.update", { id: "nonexistent", name: "Y" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(c1.request("agents.delete", { id: "nonexistent" })).rejects.toMatchObject({
      code: "not_found",
    });

    // unknown method -> bad_request
    await expect(c1.request("bogus.method", {})).rejects.toMatchObject({ code: "bad_request" });

    // delete -> agent.deleted, excluded from list, workspace dir kept
    const del = (await c1.request("agents.delete", { id: created.id })) as { ok: boolean };
    expect(del.ok).toBe(true);
    const delEv = (await c2.waitForEvent("agent.deleted")) as { id: string };
    expect(delEv.id).toBe(created.id);
    const list2 = (await c1.request("agents.list", {})) as Agent[];
    expect(list2.some((a) => a.id === created.id)).toBe(false);
    expect(existsSync(created.workspacePath)).toBe(true);

    c1.close();
    c2.close();
  });

  test("restart persists agents and does not re-apply migrations", async () => {
    const c = await DaemonClient.connect(daemon.port, TOKEN);
    const keep = (await c.request("agents.create", {
      name: "Survivor",
      provider: "opencode",
    })) as Agent;
    c.close();

    daemon.proc.kill("SIGTERM");
    await waitForExit(daemon.proc, 5000);

    const daemon2 = await startDaemon(dataDir, agentsRoot);
    try {
      const c2 = await DaemonClient.connect(daemon2.port, TOKEN);
      const list = (await c2.request("agents.list", {})) as Agent[];
      expect(list.some((a) => a.id === keep.id)).toBe(true);
      expect(list.some((a) => a.id === createdAgentId)).toBe(false);
      c2.close();
    } finally {
      daemon2.proc.kill("SIGKILL");
      await daemon2.proc.exited;
    }

    const db = new Database(join(dataDir, "bobagent.db"), { readonly: true });
    const rows = db.query("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number };
    expect(rows.n).toBe(6);
    db.close();
  });

  test("daemon without a stdin token exits non-zero", async () => {
    const d = mkdtempSync(join(tmpdir(), "bobagentd-notok-"));
    const proc = Bun.spawn(
      ["bun", DAEMON, "--data-dir", d, "--agents-root", mkdtempSync(join(tmpdir(), "oa-nt-"))],
      { env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: ROOT },
    );
    (proc.stdin as { end: () => void }).end(); // EOF before any token line
    const code = await waitForExit(proc, 8000);
    expect(code).not.toBe(0);
  });

  test("closing stdin makes the daemon exit", async () => {
    const d = await startDaemon(
      mkdtempSync(join(tmpdir(), "bobagentd-data2-")),
      mkdtempSync(join(tmpdir(), "bobagentd-agents2-")),
    );
    (d.proc.stdin as { end: () => void }).end();
    await waitForExit(d.proc, 5000);
  });
});
