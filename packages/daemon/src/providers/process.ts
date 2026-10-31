import type { ChildProcess } from "node:child_process";
import type { ProviderId } from "@boto/protocol";
import { resolveCommand, spawnEnv } from "../env/login-path";
import { spawnChild, waitForChildSpawn } from "../env/spawn";
import { envOverride } from "../env/vars";
import { ProviderError, type RemoteLaunch } from "./types";

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

const VM_CREDENTIAL_REJECTION_RE =
  /\b(?:401\b|(?:invalid|incorrect|rejected|expired|revoked)\s+(?:(?:x-)?api\s+)?key\b|(?:api|x-api)[ _-]?key.{0,32}(?:invalid|incorrect|rejected|expired|not valid)|(?:not valid|not a valid)\s+(?:(?:google|gemini)\s+)?(?:api\s+)?key\b|(?:invalid|incorrect|rejected|expired)\s+(?:authentication|credential|token)\b|authentication[ _-]?(?:error|failed|rejected)\b)/i;

export function authMessage(provider: ProviderId, detail = ""): string {
  const loginCmd = LOGIN_COMMANDS[provider] ?? "its login command";
  return `${provider} requires sign-in. Run \`${loginCmd}\` in a terminal.${detail ? ` (${detail})` : ""}`;
}

export function redactSecrets(s: string): string {
  return s
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1<redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<jwt-redacted>")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "<redacted>")
    .replace(
      /\b(sk-[A-Za-z0-9_*-]{8,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
      "<redacted>",
    );
}

export function redactCredential(detail: string, credential: string | null): string {
  return redactSecrets(credential ? detail.replaceAll(credential, "<redacted>") : detail);
}

/** Logs a failed resume fallback; callers fire onResumeFailed only after the replacement session started. */
export function logResumeFailed(
  provider: ProviderId,
  resumeSessionId: string,
  error: unknown,
  credential: string | null,
): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.error("[botod] provider.resume_failed", {
    provider,
    resumeSessionId,
    error: truncate(redactCredential(detail, credential), 500),
  });
}

export function isVmCredentialRejection(detail: string): boolean {
  return AUTH_RE.test(detail) || VM_CREDENTIAL_REJECTION_RE.test(detail);
}

export function vmCredentialRejectedMessage(
  provider: ProviderId,
  detail: string,
  credential: string,
): string {
  const safeDetail = redactCredential(detail, credential).replace(/\s+/g, " ").trim().slice(0, 180);
  return `${provider}: the saved microVM credential was rejected${safeDetail ? ` (${safeDetail})` : ""}. Update it in Settings → Hosts.`;
}

/** Lines of the stderr tail kept in a startup failure message. */
const STARTUP_ERROR_TAIL_LINES = 5;

/** Maps one startup evidence source (the error detail or the stderr tail) to an
 * auth ProviderError, or null when it shows neither a rejected microVM
 * credential nor a sign-in hint. */
export function startupAuthError(
  provider: ProviderId,
  detail: string,
  credential: string | null,
): ProviderError | null {
  if (credential && isVmCredentialRejection(detail)) {
    return new ProviderError(
      "auth_required",
      vmCredentialRejectedMessage(provider, detail, credential),
    );
  }
  if (AUTH_RE.test(detail)) {
    return new ProviderError(
      "auth_required",
      authMessage(provider, redactCredential(detail, credential)),
    );
  }
  return null;
}

/** Translates a provider startup failure into a ProviderError the same way for
 * every driver: a rejected microVM credential or a sign-in hint in the detail
 * or the stderr tail becomes `auth_required`; anything else becomes
 * `fallbackCode` with the detail plus a truncated tail, always redacted. */
export function classifyStartupError(
  provider: ProviderId,
  detail: string,
  tail: string,
  credential: string | null,
  fallbackCode: "provider_unavailable" | "internal" = "provider_unavailable",
): ProviderError {
  const auth =
    startupAuthError(provider, detail, credential) ?? startupAuthError(provider, tail, credential);
  if (auth) return auth;
  const safeDetail = redactCredential(detail, credential).trim();
  const safeTail = redactCredential(tail, credential)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-STARTUP_ERROR_TAIL_LINES)
    .join("\n");
  const reason = [safeDetail, safeTail].filter(Boolean).join("\n");
  return new ProviderError(
    fallbackCode,
    `${provider} failed to start${reason ? `: ${reason}` : ""}`,
  );
}

/** Spawn command for a provider; `BOTO_PROVIDER_COMMAND_<P>` (or the older
 * `BOTO_ACP_COMMAND_<P>`) holds a JSON array that replaces the default. */
export function commandFor(provider: ProviderId): string[] | null {
  const key = provider.toUpperCase().replace(/-/g, "_");
  return (
    envOverride(`BOTO_PROVIDER_COMMAND_${key}`) ??
    envOverride(`BOTO_ACP_COMMAND_${key}`) ??
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
  waitForSpawn(): Promise<void>;
  /** Called once on exit unless `markClosed()` ran first. */
  onUnexpectedExit(cb: (message: string) => void): void;
  markClosed(): void;
  kill(): void;
};

/** Local command or, with `remote`, the raw command (resolved on the host's PATH). */
export function providerCommand(
  provider: ProviderId,
  remote?: RemoteLaunch,
): { bin: string; args: string[] } {
  if (!remote) return resolveProviderCommand(provider);
  const cmd = commandFor(provider);
  if (!cmd) throw new ProviderError("provider_unavailable", `${provider} is not supported yet`);
  return { bin: cmd[0]!, args: cmd.slice(1) };
}

export function spawnProvider(
  bin: string,
  args: string[],
  cwd: string,
  extraEnv?: Record<string, string>,
  remote?: RemoteLaunch,
): ProviderProcess {
  // Reject unsanitizable env upfront: the runtime's own env validation error
  // quotes the offending value verbatim, which would leak an injected credential.
  for (const [key, value] of Object.entries(extraEnv ?? {})) {
    if (key.includes("\0") || value.includes("\0")) {
      throw new ProviderError(
        "provider_unavailable",
        `${bin} failed to start: env ${key.replaceAll("\0", "\\0")} contains a NUL byte`,
      );
    }
  }
  const stderrLines: string[] = [];
  let child: ChildProcess;
  try {
    child = remote
      ? remote.spawn([bin, ...args], { NO_COLOR: "1", ...extraEnv })
      : spawnChild(bin, args, {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: spawnEnv({ NO_COLOR: "1", ...extraEnv }),
        });
  } catch (error) {
    let detail = error instanceof Error ? error.message : String(error);
    detail = redactSecrets(detail);
    for (const value of Object.values(extraEnv ?? {})) {
      if (value) detail = detail.replaceAll(value, "<redacted>");
    }
    throw new ProviderError("provider_unavailable", `${bin} failed to start: ${detail}`);
  }
  const spawnReady = waitForChildSpawn(child);
  void spawnReady.catch(() => {});
  let hasSpawned = false;
  let spawnError: Error | null = null;
  child.on("spawn", () => {
    hasSpawned = true;
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
  child.on("error", (error) => {
    hasExited = true;
    spawnError = error;
    if (hasSpawned && !closedByUs && exitCb)
      exitCb(`process error: ${error.message}${tail() ? `: ${tail()}` : ""}`);
  });
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
    waitForSpawn: () => spawnReady,
    onUnexpectedExit: (cb) => {
      exitCb = cb;
      if (hasSpawned && spawnError && !closedByUs)
        cb(`process error: ${spawnError.message}${tail() ? `: ${tail()}` : ""}`);
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

/** Ends stdin and kills the process; `kill()` already marks it closed by us. */
export function closeProviderProcess(proc: ProviderProcess): void {
  try {
    proc.child.stdin?.end();
  } catch {}
  proc.kill();
}

/** Calls `onLine` with each parsed JSON object read from a newline-delimited stream. */
export function readJsonLines(
  stream: NodeJS.ReadableStream,
  onLine: (msg: Record<string, unknown>) => void,
): void {
  // Only the current chunk is scanned for '\n'; the incomplete tail is kept
  // as Buffer slices and concatenated into a line exactly once, so a large
  // line spread over many chunks costs O(L) instead of O(L^2/chunk).
  const pending: Buffer[] = [];
  stream.on("data", (d: Buffer) => {
    const chunk = Buffer.isBuffer(d) ? d : Buffer.from(d);
    let start = 0;
    let idx = chunk.indexOf("\n", start);
    while (idx >= 0) {
      const piece = chunk.subarray(start, idx);
      const line = (pending.length === 0 ? piece : Buffer.concat([...pending, piece]))
        .toString("utf8")
        .trim();
      pending.length = 0;
      if (line) {
        try {
          const msg = JSON.parse(line);
          if (msg && typeof msg === "object") onLine(msg as Record<string, unknown>);
        } catch {}
      }
      start = idx + 1;
      idx = chunk.indexOf("\n", start);
    }
    if (start < chunk.length) pending.push(chunk.subarray(start));
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

export function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}
