import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const MARKER = "__OA_PATH__";
const FIXED_DIRS = [
  join(homedir(), ".local/bin"),
  join(homedir(), ".bun/bin"),
  join(homedir(), ".npm-global/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

let cached: string | null = null;

function loginShellPath(): string {
  const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/zsh";
  try {
    const res = spawnSync(shell, ["-l", "-i", "-c", `printf "${MARKER}%s${MARKER}" "$PATH"`], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      encoding: "utf8",
    });
    const out = res.stdout ?? "";
    const start = out.indexOf(MARKER);
    const end = out.indexOf(MARKER, start + MARKER.length);
    if (start >= 0 && end > start) {
      return out.slice(start + MARKER.length, end);
    }
  } catch {}
  return "";
}

export function mergedPath(): string {
  if (cached !== null) return cached;
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const dir of [
    ...loginShellPath().split(delimiter),
    ...(process.env.PATH ?? "").split(delimiter),
    ...FIXED_DIRS,
  ]) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      parts.push(dir);
    }
  }
  cached = parts.join(delimiter);
  return cached;
}

export function spawnEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("BOBAGENT_")) env[k] = v;
  }
  return { ...env, ...extra, PATH: mergedPath() };
}

export function resolveCommand(cmd: string): string | null {
  if (cmd.includes("/")) return existsSync(cmd) ? cmd : null;
  for (const dir of mergedPath().split(delimiter)) {
    const candidate = join(dir, cmd);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Test hook: drop the cached PATH so env changes take effect. */
export function resetPathCache(): void {
  cached = null;
}
