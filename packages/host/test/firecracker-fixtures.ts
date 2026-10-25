import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "../../..");
export const HOST_MAIN = join(REPO_ROOT, "packages/host/src/main.ts");
export const HOST_INIT = join(REPO_ROOT, "packages/host/rootfs/upbot-init");

const ARTIFACTS = resolve(process.env.UPBOT_FC_ARTIFACTS ?? join(homedir(), ".upbot/firecracker"));

function debugfs(rootfs: string, command: string) {
  const result = spawnSync("debugfs", ["-w", "-R", command, rootfs], { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`debugfs ${command} failed: ${result.stderr || result.stdout}`);
}

export function injectGuestFile(
  rootfs: string,
  source: string,
  destination: string,
  mode?: string,
) {
  debugfs(rootfs, `rm ${destination}`);
  debugfs(rootfs, `write ${resolve(source)} ${destination}`);
  if (mode) debugfs(rootfs, `set_inode_field ${destination} mode ${mode}`);
}

export function makeFirecrackerHostRoot(
  extraFiles: {
    source: string;
    destination: string;
    mode?: string;
  }[] = [],
): string {
  const root = mkdtempSync(join(tmpdir(), "upbot-fc-test-"));
  try {
    const firecracker = join(root, "firecracker");
    mkdirSync(firecracker, { recursive: true });
    for (const name of ["firecracker", "vmlinux"]) {
      const artifact = join(ARTIFACTS, name);
      if (!existsSync(artifact)) throw new Error(`missing Firecracker test artifact: ${artifact}`);
      symlinkSync(artifact, join(firecracker, name));
    }
    const baseRootfs = join(ARTIFACTS, "rootfs.ext4");
    if (!existsSync(baseRootfs))
      throw new Error(`missing Firecracker test artifact: ${baseRootfs}`);
    const rootfs = join(firecracker, "rootfs.ext4");
    const cp = spawnSync("cp", ["--reflink=auto", "--sparse=always", baseRootfs, rootfs]);
    if (cp.status !== 0) copyFileSync(baseRootfs, rootfs);
    injectGuestFile(rootfs, HOST_MAIN, "/opt/upbot/upbot-host.ts");
    injectGuestFile(rootfs, HOST_INIT, "/usr/sbin/upbot-init", "0100755");
    const helperHash = createHash("sha256").update(readFileSync(HOST_MAIN)).digest("hex");
    writeFileSync(join(firecracker, "guest-helper.sha256"), `${helperHash}\n`);
    for (const file of extraFiles)
      injectGuestFile(rootfs, file.source, file.destination, file.mode);
    return root;
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
}

function recordedPids(path: string): number[] {
  if (!existsSync(path)) return [];
  const pids: number[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) pids.push(...recordedPids(child));
    else if (entry.name === "firecracker.pid") {
      const pid = Number(readFileSync(child, "utf8"));
      if (Number.isInteger(pid) && pid > 1) pids.push(pid);
    }
  }
  return pids;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function removeFirecrackerHostRoot(root: string): Promise<void> {
  const pids = recordedPids(join(root, "vms"));
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  const deadline = Date.now() + 3000;
  while (pids.some(pidAlive) && Date.now() < deadline) await Bun.sleep(50);
  rmSync(root, { recursive: true, force: true });
}

export function firecrackerPids(root: string): number[] {
  return recordedPids(join(root, "vms"));
}

export function firecrackerRunDirs(root: string, agentId: string): string[] {
  const agentDir = join(root, "vms", agentId);
  if (!existsSync(agentDir)) return [];
  return readdirSync(agentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^r[0-9a-f]{8}$/.test(entry.name))
    .map((entry) => join(agentDir, entry.name));
}

export function recordedFirecrackerPid(runDir: string): number {
  return Number(readFileSync(join(runDir, "firecracker.pid"), "utf8"));
}

export function recordedFirecrackerAlive(runDir: string): boolean {
  const pid = recordedFirecrackerPid(runDir);
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function assertGuestInitExecutable(rootfs: string): void {
  const r = spawnSync("debugfs", ["-R", "stat /usr/sbin/upbot-init", rootfs], {
    encoding: "utf8",
  });
  if (r.status !== 0 || !/Mode:\s+0755/.test(r.stdout))
    throw new Error(`guest init is not executable: ${r.stderr || r.stdout}`);
}
