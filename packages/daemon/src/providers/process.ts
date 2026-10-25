import { type ChildProcess, spawn } from "node:child_process";
import type { ProviderId } from "@bobagent/protocol";
import { resolveCommand, spawnEnv } from "../env/login-path";
import { ProviderError } from "./types";

export const STDERR_TAIL_LINES = 50;

export const DEFAULT_COMMANDS: Record<ProviderId, string[] | null> = {
  devin: ["devin", "acp"],
  cursor: ["agent", "acp"],
  grok: ["grok", "agent", "stdio"],
  opencode: ["opencode", "acp"],
  gemini: ["gemini", "--experimental-acp"],
  claude: ["claude"],
  codex: ["codex", "app-server", "--listen", "stdio://"],
  "openai-compatible": null,
};

export const LOGIN_COMMANDS: Partial<Record<ProviderId, string>> = {
  devin: "devin auth login",
  cursor: "agent login",
  grok: "grok login",
  opencode: "opencode auth login",
  gemini: "gemini",
  claude: "claude auth login",
  codex: "codex login",
};

export const AUTH_RE =
  /\b(auth(entication)?[ _-]?(required|failed)|unauthori[sz]ed|not (logged|signed) in|log ?in required|sign ?in required|please run \/login)\b/i;

export function authMessage(provider: ProviderId, detail = ""): string {
  const loginCmd = LOGIN_COMMANDS[provider] ?? "its login command";
  return `${provider} requires sign-in. Run \`${loginCmd}\` in a terminal.${detail ? ` (${detail})` : ""}`;
}

export function redactSecrets(s: string): string {
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1<redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<jwt-redacted>")
    .replace(
      /\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
      "<redacted>",
    );
}

function envOverride(name: string): string[] | null {
  const raw = process.env[name];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((s) => typeof s === "string")) {
      return parsed;
    }
  } catch {}
  return null;
}

/** Spawn command for a provider; `BOBAGENT_PROVIDER_COMMAND_<P>` (or the older
 * `BOBAGENT_ACP_COMMAND_<P>`) holds a JSON array that replaces the default. */
export function commandFor(provider: ProviderId): string[] | null {
  const key = provider.toUpperCase().replace(/-/g, "_");
  return (
    envOverride(`BOBAGENT_PROVIDER_COMMAND_${key}`) ??
    envOverride(`BOBAGENT_ACP_COMMAND_${key}`) ??
    DEFAULT_COMMANDS[provider]
  );
}

export function resolveProviderCommand(provider: ProviderId): { bin: string; args: string[] } {
  const cmd = commandFor(provider);
  if (!cmd) throw new ProviderError("provider_unavailable", `${provider} is not supported yet`);
  const bin = resolveCommand(cmd[0]!);
  if (!bin) {
    throw new ProviderError(
      "provider_unavailable",
      `\`${cmd[0]}\` not found in PATH (provider: ${provider})`,
    );
  }
  return { bin, args: cmd.slice(1) };
}

export type ProviderProcess = {
  child: ChildProcess;
  stderrTail(): string;
  /** True once the process has exited. */
  exited(): boolean;
  /** Called once on exit unless `markClosed()` ran first. */
  onUnexpectedExit(cb: (message: string) => void): void;
  markClosed(): void;
  kill(): void;
};

export function spawnProvider(
  bin: string,
  args: string[],
  cwd: string,
  extraEnv?: Record<string, string>,
): ProviderProcess {
  const stderrLines: string[] = [];
  const child = spawn(bin, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: spawnEnv({ NO_COLOR: "1", ...extraEnv }),
  });
  child.stderr?.on("data", (d: Buffer) => {
    for (const line of d.toString("utf8").split("\n")) stderrLines.push(line);
    if (stderrLines.length > STDERR_TAIL_LINES * 2) {
      stderrLines.splice(0, stderrLines.length - STDERR_TAIL_LINES);
    }
  });
  child.stdin?.on("error", () => {});
  let hasExited = false;
  let closedByUs = false;
  let exitCb: ((m: string) => void) | null = null;
  const tail = () => redactSecrets(stderrLines.slice(-STDERR_TAIL_LINES).join("\n")).trim();
  child.on("error", () => {});
  child.on("exit", (code, signal) => {
    hasExited = true;
    if (!closedByUs && exitCb) {
      const t = tail();
      exitCb(
        `process exited (code ${code ?? "null"}, signal ${signal ?? "null"})${t ? `: ${t}` : ""}`,
      );
    }
  });
  return {
    child,
    stderrTail: tail,
    exited: () => hasExited,
    onUnexpectedExit: (cb) => {
      exitCb = cb;
    },
    markClosed: () => {
      closedByUs = true;
    },
    kill: () => {
      closedByUs = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    },
  };
}

/** Calls `onLine` with each parsed JSON object read from a newline-delimited stream. */
export function readJsonLines(
  stream: NodeJS.ReadableStream,
  onLine: (msg: Record<string, unknown>) => void,
): void {
  let buf = "";
  stream.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) {
        try {
          const msg = JSON.parse(line);
          if (msg && typeof msg === "object") onLine(msg as Record<string, unknown>);
        } catch {}
      }
      idx = buf.indexOf("\n");
    }
  });
}

export function writeJsonLine(child: ChildProcess, msg: unknown): void {
  if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) return;
  child.stdin.write(`${JSON.stringify(msg)}\n`);
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
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

export function truncate(s: string, n = 2000): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
