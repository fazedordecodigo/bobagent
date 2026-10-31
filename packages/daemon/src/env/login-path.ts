import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, win32 } from "node:path";

const MARKER = "__OA_PATH__";
const WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD";

let cached: string | null = null;

function loginShellPath(): string {
  const fallback = process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
  const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : fallback;
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
  const envPath =
    Object.entries(process.env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  const fixedDirs =
    process.platform === "win32"
      ? [
          process.env.APPDATA && win32.join(process.env.APPDATA, "npm"),
          process.env.USERPROFILE && win32.join(process.env.USERPROFILE, ".bun", "bin"),
          process.env.USERPROFILE && win32.join(process.env.USERPROFILE, ".local", "bin"),
          process.env.LOCALAPPDATA &&
            win32.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"),
        ]
      : [
          join(homedir(), ".local/bin"),
          join(homedir(), ".bun/bin"),
          join(homedir(), ".npm-global/bin"),
          "/opt/homebrew/bin",
          "/usr/local/bin",
        ];
  const sources =
    process.platform === "win32"
      ? [envPath.split(";"), fixedDirs]
      : [loginShellPath().split(delimiter), envPath.split(delimiter), fixedDirs];
  for (const dir of sources.flat()) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      parts.push(dir);
    }
  }
  cached = parts.join(process.platform === "win32" ? ";" : delimiter);
  return cached;
}

export function spawnEnv(
  extra?: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
  path = mergedPath(),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (platform === "win32" && k.toLowerCase() === "path") continue;
    if (!k.startsWith("BOTO_") && !k.startsWith("UPBOT_")) env[k] = v;
  }
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (platform === "win32" && k.toLowerCase() === "path") continue;
    env[k] = v;
  }
  env.PATH = path;
  return env;
}

export function resolveCommandIn(
  cmd: string,
  dirs: string[],
  options: {
    platform?: NodeJS.Platform;
    pathext?: string;
    exists?: (path: string) => boolean;
  } = {},
): string | null {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  if (platform !== "win32") {
    if (cmd.includes("/")) return exists(cmd) ? cmd : null;
    for (const dir of dirs) {
      const candidate = join(dir, cmd);
      if (exists(candidate)) return candidate;
    }
    return null;
  }

  const ext = win32.extname(cmd);
  const extensions = (options.pathext ?? WINDOWS_PATHEXT)
    .split(";")
    .map((value) => value.trim())
    .map((value) => (value.startsWith(".") ? value : `.${value}`))
    .filter((value) => value.length > 1);
  const hasPath = cmd.includes("/") || cmd.includes("\\") || win32.isAbsolute(cmd);
  const candidates =
    ext && extensions.some((value) => value.toLowerCase() === ext.toLowerCase())
      ? [cmd]
      : ext
        ? [cmd]
        : extensions.map((value) => `${cmd}${value}`);
  if (hasPath) {
    for (const candidate of candidates) {
      if (exists(candidate)) return candidate;
    }
    return null;
  }
  for (const dir of dirs) {
    for (const extension of candidates) {
      const candidate = win32.join(dir, extension);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

export function resolveCommand(cmd: string): string | null {
  const pathDelimiter = process.platform === "win32" ? ";" : delimiter;
  return resolveCommandIn(cmd, mergedPath().split(pathDelimiter), {
    pathext: process.env.PATHEXT || WINDOWS_PATHEXT,
    exists: existsSync,
  });
}

/** Test hook: drop the cached PATH so env changes take effect. */
export function resetPathCache(): void {
  cached = null;
}
