import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { Agent, ChatItem, RemoteHost, Subagent, Turn } from "@bobagent/protocol";
import {
  firecrackerRunDirs,
  makeFirecrackerHostRoot,
  REPO_ROOT,
  recordedFirecrackerPid,
  removeFirecrackerHostRoot,
} from "./firecracker-ssh.fixtures";
import { DaemonClient, type DaemonHandle, readPids, startDaemon, tmp } from "./helpers";

const enabled = process.env.BOBAGENT_REAL_FIRECRACKER === "1" && existsSync("/usr/sbin/sshd");
const TOKEN = `firecracker-ssh-${crypto.randomUUID()}`;
const FAKE_AGENT = join(REPO_ROOT, "packages/daemon/test/fixtures/fake-acp-agent.ts");

function run(command: string, args: string[], cwd = REPO_ROOT) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForSsh(port: number) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
      });
      return;
    } catch {
      await Bun.sleep(50);
    }
  }
  throw new Error("private sshd did not accept connections");
}

async function waitForPidExit(pid: number) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2).trimStart()[0];
      if (state === "Z") return;
      process.kill(pid, 0);
    } catch (e) {
      if (["ENOENT", "ESRCH"].includes((e as NodeJS.ErrnoException).code ?? "")) return;
      throw e;
    }
    await Bun.sleep(50);
  }
  const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
  throw new Error(`firecracker pid ${pid} is still alive: ${command}`);
}

async function waitForRunDirsRemoved(root: string, agentId: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!firecrackerRunDirs(root, agentId).length) return;
    await Bun.sleep(50);
  }
  throw new Error(`Firecracker run directory for ${agentId} was not removed`);
}

async function waitForEvent(
  client: DaemonClient,
  agentId: string,
  queueId?: string,
): Promise<Turn> {
  return (await client.waitForEventWhere(
    "turn.ended",
    (data) => {
      const turn = data as Turn;
      return turn.agentId === agentId && (!queueId || turn.queueId === queueId);
    },
    60000,
  )) as Turn;
}

describe.skipIf(!enabled)("real Firecracker SSH integration", () => {
  let root: string;
  let sshDir: string;
  let sshd: ReturnType<typeof Bun.spawn>;
  let sshdLog: Promise<string>;
  let daemon: DaemonHandle;
  let client: DaemonClient;
  let host: RemoteHost;
  let boss: Agent;
  let stateDir: string;
  let daemonDirs: string[] = [];
  let knownHosts: string;
  let username: string;
  let port: number;

  beforeAll(async () => {
    sshDir = tmp("fc-sshd-");
    const bundle = join(sshDir, "fake-acp-agent.js");
    run("bun", ["build", FAKE_AGENT, "--target=bun", "--outfile", bundle]);
    root = makeFirecrackerHostRoot([
      { source: bundle, destination: "/opt/bobagent/fake-acp-agent.js" },
    ]);
    username = userInfo().username;
    port = await freePort();
    const hostKey = join(sshDir, "host_key");
    const clientKey = join(sshDir, "client_key");
    run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey], sshDir);
    run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", clientKey], sshDir);
    const authorizedKeys = join(sshDir, "authorized_keys");
    writeFileSync(authorizedKeys, readFileSync(`${clientKey}.pub`), { mode: 0o600 });
    knownHosts = join(sshDir, "known_hosts");
    const config = join(sshDir, "sshd_config");
    writeFileSync(
      config,
      [
        "AddressFamily inet",
        "ListenAddress 127.0.0.1",
        `Port ${port}`,
        `HostKey ${hostKey}`,
        `PidFile ${join(sshDir, "sshd.pid")}`,
        `AuthorizedKeysFile ${authorizedKeys}`,
        "StrictModes no",
        "UsePAM no",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "PubkeyAuthentication yes",
        "AllowStreamLocalForwarding yes",
        "AllowTcpForwarding yes",
        "PermitRootLogin yes",
        `SetEnv BOBAGENT_HOST_ROOT=${root}`,
        "LogLevel VERBOSE",
      ].join("\n"),
    );
    sshd = Bun.spawn(["/usr/sbin/sshd", "-D", "-e", "-f", config], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = sshd.stderr;
    if (!stderr || typeof stderr === "number")
      throw new Error("private sshd stderr is unavailable");
    sshdLog = new Response(stderr).text();
    await waitForSsh(port);

    stateDir = tmp("fc-ssh-state-");
    const dataDir = tmp("fc-ssh-data-");
    const agentsRoot = tmp("fc-ssh-agents-");
    daemonDirs = [stateDir, dataDir, agentsRoot];
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      FAKE_ACP_STATE_DIR: stateDir,
      BOBAGENT_PROVIDER_COMMAND_DEVIN: JSON.stringify(["bun", "/opt/bobagent/fake-acp-agent.js"]),
      BOBAGENT_SSH_COMMAND: JSON.stringify(["ssh", "-o", `UserKnownHostsFile=${knownHosts}`]),
    });
    client = await DaemonClient.connect(daemon.port, TOKEN);
    boss = (await client.request("agents.create", {
      name: "Firecracker Boss",
      provider: "devin",
      instructions: "",
    })) as Agent;
    host = (await client.request("hosts.create", {
      name: "local test sshd",
      target: `${username}@127.0.0.1`,
      port,
      identityFile: clientKey,
    })) as RemoteHost;
  });

  afterAll(async () => {
    client?.close();
    try {
      daemon?.proc.kill("SIGKILL");
    } catch {}
    if (daemon) await daemon.proc.exited;
    try {
      sshd?.kill("SIGTERM");
    } catch {}
    if (stateDir) {
      for (const pid of readPids(stateDir)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    if (sshd) await sshd.exited;
    if (root) await removeFirecrackerHostRoot(root);
    if (sshDir) rmSync(sshDir, { recursive: true, force: true });
    for (const dir of daemonDirs) rmSync(dir, { recursive: true, force: true });
    await sshdLog?.catch(() => "");
  });

  test("installs the helper, runs agents and subagents inside isolated VMs", async () => {
    host = (await client.request("hosts.install", { id: host.id })) as RemoteHost;
    host = (await client.request("hosts.check", { id: host.id })) as RemoteHost;
    expect(host.root).toBe(root);
    expect(host.preflight?.firecrackerReady).toBe(true);

    await client.request("placements.set", {
      agentId: boss.id,
      hostId: host.id,
      isolation: "firecracker",
      vcpus: 1,
      memMib: 512,
    });
    const queue = (await client.request("chat.send", {
      agentId: boss.id,
      text: "echo:hello-vm",
    })) as { queueId: string };
    expect((await waitForEvent(client, boss.id, queue.queueId)).status).toBe("completed");
    let history = (await client.request("chat.history", { agentId: boss.id })) as {
      items: ChatItem[];
    };
    expect(
      history.items
        .filter((item) => item.kind === "agent_message")
        .map((item) => ("text" in item ? item.text : ""))
        .join("\n"),
    ).toContain("hello-vm");

    const bridgeQueue = (await client.request("chat.send", {
      agentId: boss.id,
      text: "mcp:list_agents {}",
    })) as { queueId: string };
    expect((await waitForEvent(client, boss.id, bridgeQueue.queueId)).status).toBe("completed");
    history = (await client.request("chat.history", { agentId: boss.id })) as {
      items: ChatItem[];
    };
    expect(
      history.items
        .filter((item) => item.kind === "agent_message")
        .map((item) => ("text" in item ? item.text : ""))
        .join("\n"),
    ).toContain("Firecracker Boss");

    let bossTurns = 0;
    const results = client.waitForEventWhere(
      "turn.ended",
      (data) => {
        const turn = data as Turn;
        return turn.agentId === boss.id && ++bossTurns === 2;
      },
      120000,
    );
    const observedPids = new Map<string, Set<number>>();
    const observePids = () => {
      const vmRoot = join(root, "vms");
      if (!existsSync(vmRoot)) return;
      for (const entry of readdirSync(vmRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pids = observedPids.get(entry.name) ?? new Set<number>();
        for (const runDir of firecrackerRunDirs(root, entry.name)) {
          const pidFile = join(runDir, "firecracker.pid");
          if (existsSync(pidFile)) pids.add(recordedFirecrackerPid(runDir));
        }
        if (pids.size) observedPids.set(entry.name, pids);
      }
    };
    const pidPoll = setInterval(observePids, 10);
    observePids();
    try {
      const subagentQueue = (await client.request("chat.send", {
        agentId: boss.id,
        text: `mcp:spawn_subagents ${JSON.stringify({
          tasks: [
            { task: "echo:alpha-result", name: "a" },
            { task: "echo:beta-result", name: "b" },
            { task: "echo:gamma-result", name: "c" },
          ],
        })}`,
      })) as { queueId: string };
      expect((await waitForEvent(client, boss.id, subagentQueue.queueId)).status).toBe("completed");
      await results;
    } finally {
      clearInterval(pidPoll);
      observePids();
    }
    history = (await client.request("chat.history", { agentId: boss.id })) as {
      items: ChatItem[];
    };
    const userMessages = history.items.filter((item) => item.kind === "user_message");
    const resultText = "text" in userMessages.at(-1)! ? userMessages.at(-1)!.text : "";
    expect(resultText).toContain("<subagent_results");
    for (const text of ["alpha-result", "beta-result", "gamma-result"])
      expect(resultText).toContain(text);

    const subagents = (await client.request("subagents.list", {
      parentId: boss.id,
    })) as Subagent[];
    expect(subagents).toHaveLength(3);
    expect(subagents.every((subagent) => subagent.status === "done")).toBe(true);
    for (const subagent of subagents) {
      const agentDir = join(root, "vms", subagent.agentId);
      expect(existsSync(join(agentDir, "workspace.ext4"))).toBe(true);
      const pids = observedPids.get(subagent.agentId);
      expect(pids?.size).toBeGreaterThan(0);
      for (const pid of pids ?? []) await waitForPidExit(pid);
      await waitForRunDirsRemoved(root, subagent.agentId);
      expect(firecrackerRunDirs(root, subagent.agentId)).toHaveLength(0);
    }
    const vms = readdirSync(join(root, "vms"), { withFileTypes: true });
    expect(vms.some((entry) => entry.isDirectory())).toBe(true);
  }, 240000);
});
