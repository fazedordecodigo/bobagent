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
