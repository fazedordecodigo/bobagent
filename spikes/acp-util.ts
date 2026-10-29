// Shared ACP probe helpers: spawn an agent CLI over stdio with bounded stderr
// and first-stdout capture, expose the ndjson stream, and format errors.

import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const STDERR_TAIL_LINES = 200;
const FIRST_STDOUT_BYTES = 4096;

export type AcpProcess = {
  child: ChildProcess;
  stderrLines: string[];
  firstStdoutBytes: string;
  stream: acp.Stream;
  kill(): void;
};

export function spawnAcp(cmd: string[], cwd: string): AcpProcess {
  const child = spawn(cmd[0]!, cmd.slice(1), {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
  const stderrLines: string[] = [];
  child.stderr?.on("data", (d: Buffer) => {
    for (const line of d.toString("utf8").split("\n")) stderrLines.push(line);
    if (stderrLines.length > STDERR_TAIL_LINES) {
      stderrLines.splice(0, stderrLines.length - STDERR_TAIL_LINES);
    }
  });
  let firstStdoutBytes = "";
  let captured = 0;
  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (captured < FIRST_STDOUT_BYTES) {
        firstStdoutBytes += Buffer.from(chunk).toString("utf8");
        captured += chunk.length;
      }
      controller.enqueue(chunk);
    },
  });
  const webOut = (Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>).pipeThrough(tap);
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    webOut,
  );
  return {
    child,
    stderrLines,
    get firstStdoutBytes() {
      return firstStdoutBytes;
    },
    stream,
    kill() {
      try {
        child.kill("SIGKILL");
      } catch {}
    },
  };
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
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

export function fmtErr(e: unknown): string {
  if (e instanceof Error) {
    const anyE = e as { code?: unknown; data?: unknown };
    return `${e.name}: ${e.message}${anyE.code !== undefined ? ` (code ${String(anyE.code)})` : ""}${anyE.data !== undefined ? ` data=${JSON.stringify(anyE.data)}` : ""}`;
  }
  return String(e);
}
