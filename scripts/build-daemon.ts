import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  type DaemonTarget,
  daemonTarget,
  daemonTargetForTriple,
} from "../packages/daemon/src/target";

function targetFromArgs(args: string[]): DaemonTarget {
  const index = args.indexOf("--target");
  const inline = args.find((arg) => arg.startsWith("--target="));
  if (index >= 0 && !args[index + 1]) throw new Error("--target requires a Rust target triple");
  if (inline !== undefined && inline.length === "--target=".length) {
    throw new Error("--target requires a Rust target triple");
  }
  const triple = index >= 0 ? args[index + 1] : inline?.slice("--target=".length);
  return triple ? daemonTargetForTriple(triple) : daemonTarget(process.platform, process.arch);
}

function build(): void {
  let target: DaemonTarget;
  try {
    target = targetFromArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  const outfile = resolve("apps/desktop/src-tauri/binaries", `botod-${target.rustTriple}`);
  mkdirSync(dirname(outfile), { recursive: true });
  const result = spawnSync(
    "bun",
    [
      "build",
      "--compile",
      "--minify",
      `--target=${target.bunTarget}`,
      "packages/daemon/src/main.ts",
      "--outfile",
      outfile,
    ],
    { stdio: "inherit" },
  );
  if (result.error) {
    console.error(result.error.message);
    process.exitCode = 1;
  } else if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
}

if (import.meta.main) build();
