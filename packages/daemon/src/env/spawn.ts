import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import crossSpawn from "cross-spawn";

export function spawnChild(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcess {
  if (process.platform === "win32") {
    return crossSpawn(command, args, { ...options, windowsHide: true });
  }
  return nodeSpawn(command, args, options);
}
