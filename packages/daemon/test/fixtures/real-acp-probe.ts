import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const provider = process.argv[2] as "gemini" | "opencode" | "cursor";
const commands = {
  gemini: ["gemini", "--experimental-acp"],
  opencode: ["opencode", "acp"],
  cursor: ["agent", "acp"],
} as const;
const command = commands[provider];
if (!command) throw new Error(`unsupported ACP probe provider: ${provider}`);

const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
const stderr: string[] = [];
child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
child.on("error", (error) => stderr.push(error.message));
const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
const stream = acp.ndJsonStream(
  Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
  Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
);
const conn = acp.client({ name: "upbot-acp-probe" }).connect(stream);
conn.closed.catch(() => {});

async function bounded<T>(name: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} timed out`)), 8000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let stage: "initialize" | "session/new" | "session/prompt" | null = null;
let error: string | null = null;
let initialized: Record<string, unknown> | null = null;
let session: Record<string, unknown> | null = null;
let prompt: Record<string, unknown> | null = null;

try {
  stage = "initialize";
  initialized = (await bounded(
    stage,
    conn.agent.request("initialize", {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "upbot-acp-probe", version: "0.3.0" },
    } as never),
  )) as Record<string, unknown>;
  await conn.agent.notify("initialized");
  stage = "session/new";
  session = (await bounded(
    stage,
    conn.agent.request("session/new", { cwd: "/workspace", mcpServers: [] } as never),
  )) as Record<string, unknown>;
  stage = "session/prompt";
  prompt = (await bounded(
    stage,
    conn.agent.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Reply with READY." }],
    } as never),
  )) as Record<string, unknown>;
  stage = null;
} catch (cause) {
  error = cause instanceof Error ? cause.message : String(cause);
}

process.stdout.write(
  `${JSON.stringify({
    provider,
    initialize: initialized ? { authMethods: initialized.authMethods ?? null } : null,
    sessionNew: session,
    prompt,
    failedAt: stage,
    error,
    exitCode: child.exitCode,
    stderr: stderr.join("").slice(-4000),
  })}\n`,
);
try {
  conn.close();
} catch {}
if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
