#!/usr/bin/env bun
// ACP probe: spawn an agent CLI over stdio, run initialize -> session/new ->
// session/prompt, collect session/update notifications, then optionally test
// session/load on a fresh process.
//
// Usage: bun spikes/acp-probe.ts <name> -- <cmd...>
// Writes spikes/out/acp-<name>.json

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";

const STEP_TIMEOUT_MS = 120_000;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type UpdateRecord = { kind: string; raw: unknown };
type PermissionRecord = { params: unknown; responded: string };

const report: Record<string, unknown> = {
  name: "",
  command: [],
  timings: {},
  initializeResponse: null,
  sessionId: null,
  sessionNewResponse: null,
  updateKinds: [] as string[],
  updateKindCounts: {} as Record<string, number>,
  updates: [] as UpdateRecord[],
  agentText: "",
  stopReason: null,
  permissionRequests: [] as PermissionRecord[],
  loadSession: null as null | {
    attempted: boolean;
    ok?: boolean;
    historyReplayed?: boolean;
    replayedUpdateKinds?: string[];
    error?: string;
  },
  notAcp: null as null | { firstStdoutBytes: string; note: string },
  stderrTail: "",
  errors: [] as string[],
};

function redactSecrets(s: string): string {
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1<redacted>")
    .replace(
      /\b(sk|pk|api|key|token|secret|auth|password|passwd)[-_]?(key|token|secret)?[-_]?[A-Za-z0-9]*["'=:\s]{1,4}[A-Za-z0-9._~+/=-]{16,}/gi,
      "$1$2<redacted>",
    )
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<jwt-redacted>")
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, (m) => (m.length >= 48 ? "<redacted>" : m));
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms in ${label}`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function fmtErr(e: unknown): string {
  if (e instanceof Error) {
    const anyE = e as { code?: unknown; data?: unknown };
    return `${e.name}: ${e.message}${anyE.code !== undefined ? ` (code ${String(anyE.code)})` : ""}${anyE.data !== undefined ? ` data=${JSON.stringify(anyE.data)}` : ""}`;
  }
  return String(e);
}

class ProcHandle {
  child: ChildProcess;
  stderrLines: string[] = [];
  firstStdoutBytes = "";
  stdout: ReadableStream<Uint8Array>;
  stdin: WritableStream<Uint8Array>;

  constructor(cmd: string[], cwd: string) {
    this.child = spawn(cmd[0]!, cmd.slice(1), {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    this.child.stderr?.on("data", (d: Buffer) => {
      const lines = d.toString("utf8").split("\n");
      for (const line of lines) this.stderrLines.push(line);
      if (this.stderrLines.length > 200) this.stderrLines = this.stderrLines.slice(-200);
    });
    const stdoutNode = this.child.stdout!;
    const self = this;
    let captured = 0;
    const tap = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (captured < 4096) {
          self.firstStdoutBytes += Buffer.from(chunk).toString("utf8");
          captured += chunk.length;
        }
        controller.enqueue(chunk);
      },
    });
    const webOut = Readable.toWeb(stdoutNode) as ReadableStream<Uint8Array>;
    this.stdout = webOut.pipeThrough(tap);
    this.stdin = Writable.toWeb(this.child.stdin!) as WritableStream<Uint8Array>;
  }

  kill() {
    try {
      this.child.kill("SIGKILL");
    } catch {}
  }
}

type Client = {
  conn: acp.ClientConnection;
  agent: acp.ClientContext;
};

async function connect(proc: ProcHandle): Promise<Client> {
  const stream = acp.ndJsonStream(proc.stdin, proc.stdout);
  const app = acp
    .client({ name: "acp-probe" })
    .onRequest("session/request_permission", async (ctx) => {
      (report.permissionRequests as PermissionRecord[]).push({
        params: ctx.params,
        responded: "cancelled",
      });
      return { outcome: { outcome: "cancelled" } } as never;
    })
    .onNotification("session/update", async (ctx) => {
      const update = (
        ctx.params as {
          update: { sessionUpdate: string; content?: { type: string; text?: string } };
        }
      ).update;
      const kind = update?.sessionUpdate ?? "unknown";
      (report.updateKinds as string[]).push(kind);
      const counts = report.updateKindCounts as Record<string, number>;
      counts[kind] = (counts[kind] ?? 0) + 1;
      (report.updates as UpdateRecord[]).push({ kind, raw: ctx.params });
      if (
        kind === "agent_message_chunk" &&
        update.content?.type === "text" &&
        update.content.text
      ) {
        report.agentText = (report.agentText as string) + update.content.text;
      }
    });
  const conn = app.connect(stream);
  return { conn, agent: conn.agent };
}

async function time<T>(label: string, p: Promise<T>): Promise<T> {
  const t0 = Date.now();
  const v = await withTimeout(p, STEP_TIMEOUT_MS, label);
  (report.timings as Record<string, number>)[label] = Date.now() - t0;
  return v;
}

async function initialize(agent: acp.ClientContext) {
  return time(
    "initialize",
    agent.request("initialize", {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "acp-probe", version: "0.0.0" },
    } as never),
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf("--");
  const name = sep === -1 ? argv[0] : argv[0];
  const cmd = sep === -1 ? argv.slice(1) : argv.slice(sep + 1);
  if (!name || cmd.length === 0) {
    console.error("usage: bun spikes/acp-probe.ts <name> -- <cmd...>");
    process.exit(2);
  }
  report.name = name;
  report.command = cmd;

  const cwd = mkdtempSync(join(tmpdir(), `acp-probe-${name}-`));
  report.cwd = cwd;

  let proc = new ProcHandle(cmd, cwd);
  let client: Client | null = null;
  let sessionId: string | null = null;

  const finish = async (code: number) => {
    proc.kill();
    report.stderrTail = redactSecrets(proc.stderrLines.slice(-40).join("\n"));
    mkdirSync(join(ROOT, "spikes/out"), { recursive: true });
    const outPath = join(ROOT, "spikes/out", `acp-${name}.json`);
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`wrote ${outPath}`);
    process.exit(code);
  };

  try {
    client = await connect(proc);
  } catch (e) {
    (report.errors as string[]).push(`connect: ${fmtErr(e)}`);
    await finish(1);
    return;
  }

  // Step 1: initialize
  let initRes: {
    protocolVersion?: number;
    agentCapabilities?: Record<string, unknown>;
    authMethods?: unknown[];
  };
  try {
    initRes = (await initialize(client.agent)) as typeof initRes;
    report.initializeResponse = initRes;
  } catch (e) {
    (report.errors as string[]).push(`initialize: ${fmtErr(e)}`);
    report.notAcp = {
      firstStdoutBytes: proc.firstStdoutBytes.slice(0, 2000),
      note: "initialize failed; child may not speak ACP ndjson",
    };
    await finish(1);
    return;
  }

  // Step 2: session/new
  try {
    const res = (await time(
      "session/new",
      client.agent.request("session/new", {
        cwd,
        mcpServers: [],
      } as never),
    )) as { sessionId: string };
    sessionId = res.sessionId;
    report.sessionId = sessionId;
    report.sessionNewResponse = res;
  } catch (e) {
    (report.errors as string[]).push(`session/new: ${fmtErr(e)}`);
    await finish(1);
    return;
  }

  // Step 3: session/prompt
  try {
    const res = (await time(
      "session/prompt",
      client.agent.request("session/prompt", {
        sessionId,
        prompt: [
          { type: "text", text: "Reply with exactly the word: pong. Do not use any tools." },
        ],
      } as never),
    )) as { stopReason?: string };
    report.stopReason = res.stopReason ?? null;
  } catch (e) {
    (report.errors as string[]).push(`session/prompt: ${fmtErr(e)}`);
  }

  // Step 4: session/load on a fresh process if supported
  const loadSessionCap =
    (initRes.agentCapabilities as { loadSession?: boolean } | undefined)?.loadSession === true;
  if (loadSessionCap && sessionId) {
    const loadReport: NonNullable<typeof report.loadSession> = { attempted: true };
    report.loadSession = loadReport;
    try {
      try {
        client.conn.close();
      } catch {}
      proc.kill();
      // wait briefly for process exit
      await new Promise((r) => setTimeout(r, 500));
      proc = new ProcHandle(cmd, cwd);
      const replayKinds: string[] = [];
      const stream = acp.ndJsonStream(proc.stdin, proc.stdout);
      const app2 = acp
        .client({ name: "acp-probe-load" })
        .onRequest(
          "session/request_permission",
          async () => ({ outcome: { outcome: "cancelled" } }) as never,
        )
        .onNotification("session/update", async (ctx) => {
          const update = (ctx.params as { update: { sessionUpdate: string } }).update;
          replayKinds.push(update?.sessionUpdate ?? "unknown");
        });
      const conn2 = app2.connect(stream);
      await initialize(conn2.agent);
      const t0 = Date.now();
      await withTimeout(
        conn2.agent.request("session/load", { sessionId, cwd, mcpServers: [] } as never),
        STEP_TIMEOUT_MS,
        "session/load",
      );
      (report.timings as Record<string, number>)["session/load"] = Date.now() - t0;
      loadReport.ok = true;
      loadReport.replayedUpdateKinds = replayKinds;
      loadReport.historyReplayed = replayKinds.length > 0;
      conn2.close();
    } catch (e) {
      loadReport.ok = false;
      loadReport.error = fmtErr(e);
      loadReport.replayedUpdateKinds = loadReport.replayedUpdateKinds ?? [];
    }
  } else {
    report.loadSession = { attempted: false };
  }

  await finish((report.errors as string[]).length ? 1 : 0);
}

main().catch(async (e) => {
  (report.errors as string[]).push(`fatal: ${fmtErr(e)}`);
  try {
    mkdirSync(join(ROOT, "spikes/out"), { recursive: true });
    writeFileSync(
      join(ROOT, "spikes/out", `acp-${report.name || "unknown"}.json`),
      JSON.stringify(report, null, 2),
    );
  } catch {}
  process.exit(1);
});
