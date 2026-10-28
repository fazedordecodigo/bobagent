export type DaemonTarget = {
  bunTarget: string;
  rustTriple: string;
};

const TARGETS: Record<string, DaemonTarget> = {
  "darwin/arm64": {
    bunTarget: "bun-darwin-arm64",
    rustTriple: "aarch64-apple-darwin",
  },
  "linux/x64": {
    bunTarget: "bun-linux-x64",
    rustTriple: "x86_64-unknown-linux-gnu",
  },
  "win32/x64": {
    bunTarget: "bun-windows-x64",
    rustTriple: "x86_64-pc-windows-msvc",
  },
};

export function daemonTarget(platform: string, arch: string): DaemonTarget {
  const target = TARGETS[`${platform}/${arch}`];
  if (!target) throw new Error(`Unsupported daemon build target: ${platform}/${arch}`);
  return target;
}

export function daemonTargetForTriple(triple: string): DaemonTarget {
  const target = Object.values(TARGETS).find((candidate) => candidate.rustTriple === triple);
  if (!target) throw new Error(`Unsupported Rust target triple: ${triple}`);
  return target;
}
