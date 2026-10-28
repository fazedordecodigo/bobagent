import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";
import { resolveCommandIn } from "./login-path";

export function resolveWindowsCommandInEnv(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  const pathext = Object.entries(env).find(([key]) => key.toLowerCase() === "pathext")?.[1];
  const hasPath = command.includes("/") || command.includes("\\") || win32.isAbsolute(command);
  const resolvedCommand =
    hasPath && !win32.isAbsolute(command) ? win32.resolve(cwd, command) : command;
  return resolveCommandIn(resolvedCommand, pathValue ? pathValue.split(";") : [], {
    platform: "win32",
    ...(pathext ? { pathext } : {}),
    exists,
  });
}

export function spawnChild(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcess {
  if (process.platform === "win32") {
    const env = options.env ?? process.env;
    const cwd =
      options.cwd instanceof URL
        ? fileURLToPath(options.cwd)
        : typeof options.cwd === "string"
          ? options.cwd
          : process.cwd();
    const resolved = resolveWindowsCommandInEnv(command, env, cwd);
    if (!resolved) throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
    return crossSpawn(resolved, args, { ...options, windowsHide: true });
  }
  return nodeSpawn(command, args, options);
}

export function waitForChildSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}
