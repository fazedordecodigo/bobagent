// Remote execution hosts (Linux VPS over SSH). The daemon stays on the Mac; provider
// processes run on the host through `upbot-host run` (packages/host), optionally inside a
// Firecracker microVM per agent. The MCP bridge reaches back over an `ssh -R` unix socket.

import type { Database } from "bun:sqlite";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import type { AgentPlacement, HostPreflight, Isolation, RemoteHost } from "@upbot/protocol";
// @ts-expect-error -- Bun text import of the helper source (uploaded verbatim to hosts)
import helperSource from "../../../host/src/main.ts" with { type: "text" };
import { spawnEnv } from "../env/login-path";
import { spawnChild } from "../env/spawn";
import type { McpServerSpec, RemoteLaunch } from "../providers/types";
import { ProviderError } from "../providers/types";

type HostRow = {
  id: string;
  name: string;
  target: string;
  port: number;
  identity_file: string | null;
  root: string | null;
  preflight_json: string | null;
  created_at: number;
};

const HELPER = "bin/upbot-host.ts";
const BUN_PATH = 'PATH="$HOME/.bun/bin:$PATH"';

/** POSIX single-quote escaping. */
export const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

const expandHome = (p: string) => (p.startsWith("~/") ? `${homedir()}${p.slice(1)}` : p);

export function sshArgs(host: RemoteHost, extra: string[], remoteCmd: string): [string, string[]] {
  let base = ["ssh"];
  const override = process.env.UPBOT_SSH_COMMAND;
  if (override) {
    const parsed = JSON.parse(override);
    if (Array.isArray(parsed) && parsed.length) base = parsed.map(String);
  }
  const [bin, ...pre] = base as [string, ...string[]];
  return [
    bin,
    [
      ...pre,
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "StreamLocalBindUnlink=yes",
      // 22 is left to ~/.ssh/config so a Host alias with its own Port keeps working
      ...(host.port !== 22 ? ["-p", String(host.port)] : []),
      ...(host.identityFile ? ["-i", expandHome(host.identityFile)] : []),
      ...extra,
      "--",
      host.target,
      `sh -c ${shq(remoteCmd)}`,
    ],
  ];
}

async function sshExec(
  host: RemoteHost,
  remoteCmd: string,
  input?: string,
  timeoutMs = 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const [bin, args] = sshArgs(host, [], remoteCmd);
  const proc = spawnChild(bin, args, {
    cwd: homedir(),
    env: spawnEnv(),
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (input !== undefined) proc.stdin?.on("error", () => {});
  const stdoutPromise = new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    proc.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stdout?.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    if (!proc.stdout) resolve("");
  });
  const stderrPromise = new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    proc.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr?.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    if (!proc.stderr) resolve("");
  });
  const codePromise = new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (exitCode) => resolve(exitCode ?? 1));
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  try {
    if (input !== undefined) proc.stdin?.end(input);
    const [stdout, stderr, code] = await Promise.all([stdoutPromise, stderrPromise, codePromise]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

export class HostStore {
  /** Provider login env for microVM sessions (wired to VmCredentials in main.ts). */
  credentialEnv: (provider: string) => Record<string, string> = () => ({});

  constructor(private db: Database) {}

  private toHost(r: HostRow): RemoteHost {
    return {
      id: r.id,
      name: r.name,
      target: r.target,
      port: r.port,
      identityFile: r.identity_file,
      root: r.root,
      preflight: r.preflight_json ? (JSON.parse(r.preflight_json) as HostPreflight) : null,
      createdAt: r.created_at,
    };
  }

  list(): RemoteHost[] {
    return (this.db.query("SELECT * FROM hosts ORDER BY created_at").all() as HostRow[]).map((r) =>
      this.toHost(r),
    );
  }

  get(id: string): RemoteHost | null {
    const r = this.db.query("SELECT * FROM hosts WHERE id = ?").get(id) as HostRow | null;
    return r ? this.toHost(r) : null;
  }

  create(p: { name: string; target: string; port?: number; identityFile?: string | null }) {
    const id = crypto.randomUUID();
    this.db
      .query(
        "INSERT INTO hosts (id, name, target, port, identity_file, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, p.name, p.target, p.port ?? 22, p.identityFile ?? null, Date.now());
    return this.get(id)!;
  }

  update(p: {
    id: string;
    name?: string;
    target?: string;
    port?: number;
    identityFile?: string | null;
  }): RemoteHost | null {
    const h = this.get(p.id);
    if (!h) return null;
    const changedConn = p.target !== undefined || p.port !== undefined;
    this.db
      .query(
        "UPDATE hosts SET name = ?, target = ?, port = ?, identity_file = ?, root = ?, preflight_json = ? WHERE id = ?",
      )
      .run(
        p.name ?? h.name,
        p.target ?? h.target,
        p.port ?? h.port,
        p.identityFile !== undefined ? p.identityFile : h.identityFile,
        changedConn ? null : h.root,
        changedConn ? null : h.preflight ? JSON.stringify(h.preflight) : null,
        p.id,
      );
    return this.get(p.id);
  }

  delete(id: string): boolean {
    const n = this.db.query("DELETE FROM hosts WHERE id = ?").run(id).changes;
    this.db
      .query("UPDATE agent_placement SET host_id = NULL, isolation = 'none' WHERE host_id = ?")
      .run(id);
    return n > 0;
  }

  /** Uploads the helper to the host root and runs preflight. */
  async install(id: string): Promise<RemoteHost> {
    const h = this.mustGet(id);
    const r = await sshExec(
      h,
      `ROOT="\${UPBOT_HOST_ROOT:-$HOME/.upbot}" && umask 077 && mkdir -p "$ROOT/bin" && cat > "$ROOT/${HELPER}.tmp" && mv "$ROOT/${HELPER}.tmp" "$ROOT/${HELPER}"`,
      helperSource as string,
    );
    if (r.code !== 0) throw new Error(`install failed: ${sshError(r)}`);
    return this.check(id);
  }

  async check(id: string): Promise<RemoteHost> {
    const h = this.mustGet(id);
    const r = await sshExec(
      h,
      `ROOT="\${UPBOT_HOST_ROOT:-$HOME/.upbot}"; ${BUN_PATH}; command -v bun >/dev/null 2>&1 || { echo "bun is not installed on the host (curl -fsSL https://bun.sh/install | bash)" >&2; exit 127; }; test -f "$ROOT/${HELPER}" || { echo "helper not installed; use Install" >&2; exit 3; }; exec bun "$ROOT/${HELPER}" preflight`,
    );
    if (r.code !== 0) throw new Error(sshError(r));
    const line = r.stdout.trim().split("\n").pop() ?? "";
    let pre: HostPreflight;
    try {
      pre = JSON.parse(line);
    } catch {
      throw new Error(`unexpected preflight output: ${line.slice(0, 200)}`);
    }
    this.db
      .query("UPDATE hosts SET root = ?, preflight_json = ? WHERE id = ?")
      .run(pre.root, JSON.stringify(pre), id);
    return this.get(id)!;
  }

  private mustGet(id: string): RemoteHost {
    const h = this.get(id);
    if (!h) throw new Error("host not found");
    return h;
  }

  // ---- placement ----

  placement(agentId: string): AgentPlacement {
    const r = this.db
      .query("SELECT host_id, isolation, vcpus, mem_mib FROM agent_placement WHERE agent_id = ?")
      .get(agentId) as {
      host_id: string | null;
      isolation: Isolation;
      vcpus: number;
      mem_mib: number;
    } | null;
    return {
      agentId,
      hostId: r?.host_id ?? null,
      isolation: r?.isolation ?? "none",
      vcpus: r?.vcpus ?? 2,
      memMib: r?.mem_mib ?? 2048,
    };
  }

  placements(): AgentPlacement[] {
    const ids = this.db.query("SELECT agent_id FROM agent_placement").all() as {
      agent_id: string;
    }[];
    return ids.map((r) => this.placement(r.agent_id));
  }

  setPlacement(p: {
    agentId: string;
    hostId: string | null;
    isolation: Isolation;
    vcpus?: number;
    memMib?: number;
  }): AgentPlacement {
    if (p.hostId) {
      const h = this.mustGet(p.hostId);
      if (!h.root) throw new Error(`host ${h.name} is not installed yet (Install first)`);
      if (p.isolation === "firecracker" && !h.preflight?.firecrackerReady) {
        throw new Error(
          `host ${h.name} is not ready for Firecracker (needs Linux, /dev/kvm, firecracker, vmlinux and rootfs.ext4 — see Check)`,
        );
      }
    } else if (p.isolation === "firecracker") {
      throw new Error("Firecracker microVMs need a remote Linux host with KVM");
    }
    const cur = this.placement(p.agentId);
    this.db
      .query(
        `INSERT INTO agent_placement (agent_id, host_id, isolation, vcpus, mem_mib) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET host_id = excluded.host_id, isolation = excluded.isolation,
           vcpus = excluded.vcpus, mem_mib = excluded.mem_mib`,
      )
      .run(p.agentId, p.hostId, p.isolation, p.vcpus ?? cur.vcpus, p.memMib ?? cur.memMib);
    return this.placement(p.agentId);
  }

  copyPlacement(fromAgentId: string, toAgentId: string): void {
    const p = this.placement(fromAgentId);
    if (!p.hostId) return;
    this.db
      .query(
        "INSERT OR REPLACE INTO agent_placement (agent_id, host_id, isolation, vcpus, mem_mib) VALUES (?, ?, ?, ?, ?)",
      )
      .run(toAgentId, p.hostId, p.isolation, p.vcpus, p.memMib);
  }

  /** Launch plan for an agent's next provider session, or null to run locally. */
  launchFor(agentId: string, bridgePort: number): RemoteLaunch | null {
    const p = this.placement(agentId);
    if (!p.hostId) return null;
    const h = this.get(p.hostId);
    if (!h?.root) {
      throw new ProviderError(
        "provider_unavailable",
        "the agent's remote host is missing or not installed (Settings → Hosts)",
      );
    }
    const agent = this.db.query("SELECT provider FROM agents WHERE id = ?").get(agentId) as {
      provider: string;
    } | null;
    const credentials =
      p.isolation === "firecracker" && agent ? this.credentialEnv(agent.provider) : {};
    return remoteLaunch(h, p, bridgePort, credentials);
  }
}

function sshError(r: { code: number; stderr: string; stdout: string }): string {
  const msg = (r.stderr || r.stdout).trim().split("\n").slice(-5).join("\n");
  return msg || `ssh exited with code ${r.code}`;
}

export function remoteLaunch(
  host: RemoteHost,
  placement: AgentPlacement,
  bridgePort: number,
  credentials: Record<string, string> = {},
): RemoteLaunch {
  const root = host.root!;
  const helper = `${root}/${HELPER}`;
  const vm = placement.isolation === "firecracker";
  const socket = `/tmp/upbot-${randomBytes(8).toString("hex")}.sock`;
  return {
    cwd: vm ? "/workspace" : `${root}/agents/${placement.agentId}`,
    describe: `${host.name}${vm ? " (microVM)" : ""}`,
    credentials: vm ? credentials : {},
    mcp(spec: McpServerSpec): McpServerSpec {
      if (spec.name !== "upbot") return spec;
      const token = spec.env.UPBOT_BRIDGE_TOKEN ?? "";
      return vm
        ? {
            name: spec.name,
            command: "upbot-bridge",
            args: [],
            env: { UPBOT_BRIDGE_TOKEN: token },
          }
        : {
            name: spec.name,
            command: "sh",
            args: ["-c", `${BUN_PATH} exec bun ${shq(helper)} bridge`],
            env: { UPBOT_BRIDGE_SOCKET: socket, UPBOT_BRIDGE_TOKEN: token },
          };
    },
    spawn(cmd: string[], env: Record<string, string>): ChildProcess {
      const forward = bridgePort ? ["-R", `${socket}:127.0.0.1:${bridgePort}`] : [];
      const [bin, args] = sshArgs(host, forward, `${BUN_PATH} exec bun ${shq(helper)} run`);
      const child = spawnChild(bin, args, {
        cwd: homedir(),
        stdio: ["pipe", "pipe", "pipe"],
        env: spawnEnv(),
      });
      child.on("error", () => {});
      child.stdin?.on("error", () => {});
      child.stdin?.write(
        `${JSON.stringify({
          agentId: placement.agentId,
          isolation: placement.isolation,
          cmd,
          env: vm ? { ...env, ...credentials } : env,
          bridgeSocket: bridgePort ? socket : undefined,
          vcpus: placement.vcpus,
          memMib: placement.memMib,
        })}\n`,
      );
      return child;
    },
  };
}
