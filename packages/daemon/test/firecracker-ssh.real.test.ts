import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import type { Agent, ChatItem, RemoteHost, Subagent, Turn } from "@upbot/protocol";
import {
  firecrackerRunDirs,
  makeFirecrackerHostRoot,
  REPO_ROOT,
  recordedFirecrackerPid,
  removeFirecrackerHostRoot,
} from "./firecracker-ssh.fixtures";
import { DaemonClient, type DaemonHandle, readPids, startDaemon, tmp } from "./helpers";

const enabled = process.env.UPBOT_REAL_FIRECRACKER === "1" && existsSync("/usr/sbin/sshd");
const providersRequested =
  process.env.UPBOT_REAL_FIRECRACKER === "1" && process.env.UPBOT_REAL_PROVIDERS === "1";
const artifacts = resolve(process.env.UPBOT_FC_ARTIFACTS ?? join(homedir(), ".upbot/firecracker"));
const missingProviderClis = providersRequested
  ? ["claude", "codex"].filter((cli) => {
      const rootfs = join(artifacts, "rootfs.ext4");
      if (!existsSync(rootfs)) return true;
      const result = spawnSync("debugfs", ["-R", `stat /usr/local/bin/${cli}`, rootfs], {
        encoding: "utf8",
      });
      return result.status !== 0 || !/Inode:\s+\d+/.test(result.stdout);
    })
  : [];
if (providersRequested && missingProviderClis.length)
  console.log(
    `Skipping real-provider Firecracker test: guest image is missing ${missingProviderClis.join(", ")}`,
  );
const realProvidersEnabled = enabled && providersRequested && missingProviderClis.length === 0;
const TOKEN = `firecracker-ssh-${crypto.randomUUID()}`;
const FAKE_AGENT = join(REPO_ROOT, "packages/daemon/test/fixtures/fake-acp-agent.ts");
const HOST_MAIN = join(REPO_ROOT, "packages/host/src/main.ts");
const SSH_RUN_SPEC_WRAPPER = join(
  REPO_ROOT,
  "packages/daemon/test/fixtures/ssh-run-spec-wrapper.ts",
);

function run(command: string, args: string[], cwd = REPO_ROOT) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function filesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesUnder(child) : entry.isFile() ? [child] : [];
  });
}

async function containsBytes(path: string, value: string): Promise<boolean> {
  const needle = Buffer.from(value);
  let carry = Buffer.alloc(0);
  for await (const chunk of createReadStream(path)) {
    const data = Buffer.concat([carry, chunk]);
    if (data.includes(needle)) return true;
    carry = data.subarray(Math.max(0, data.length - needle.length + 1));
  }
  return false;
}

async function assertNoPlaintext(paths: string[], values: string[]) {
  for (const path of paths)
    for (const value of values)
      if (await containsBytes(path, value))
        throw new Error(`plaintext fake credential found in ${path}`);
}

async function runGuest(
  root: string,
  agentId: string,
  cmd: string[],
  env: Record<string, string>,
  input: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const guestHostEnv = { ...process.env };
  for (const name of [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
  ])
    delete guestHostEnv[name];
  const proc = Bun.spawn(["bun", HOST_MAIN, "run"], {
    cwd: REPO_ROOT,
    env: {
      ...guestHostEnv,
      UPBOT_HOST_ROOT: root,
      UPBOT_VM_WORKSPACE_MIB: "32",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  proc.stdin.write(
    `${JSON.stringify({ agentId, isolation: "firecracker", cmd, cwd: "/workspace", env })}\n`,
  );
  if (input) {
    await Bun.sleep(2500);
    proc.stdin.write(input);
    await Bun.sleep(3000);
  }
  proc.stdin.end();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([
      proc.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          proc.kill("SIGKILL");
          reject(new Error(`guest command ${cmd[0]} did not exit within 30000 ms`));
        }, 30000);
      }),
    ]);
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    return { code, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  timeoutMs = 60000,
): Promise<Turn> {
  return (await client.waitForEventWhere(
    "turn.ended",
    (data) => {
      const turn = data as Turn;
      return turn.agentId === agentId && (!queueId || turn.queueId === queueId);
    },
    timeoutMs,
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
  let daemonStderrText = "";
  let daemonStderrDone: Promise<void> = Promise.resolve();
  let knownHosts: string;
  let username: string;
  let port: number;
  let providerRunSpecEnvLog: string | null = null;

  beforeAll(async () => {
    sshDir = tmp("fc-sshd-");
    const bundle = join(sshDir, "fake-acp-agent.js");
    run("bun", ["build", FAKE_AGENT, "--target=bun", "--outfile", bundle]);
    root = makeFirecrackerHostRoot([
      { source: bundle, destination: "/opt/upbot/fake-acp-agent.js" },
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
        `SetEnv UPBOT_HOST_ROOT=${root}`,
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
    providerRunSpecEnvLog = providersRequested ? join(sshDir, "provider-run-spec-env.jsonl") : null;
    const sshCommand =
      providersRequested && providerRunSpecEnvLog
        ? [process.execPath, SSH_RUN_SPEC_WRAPPER, providerRunSpecEnvLog]
        : ["ssh", "-o", `UserKnownHostsFile=${knownHosts}`];
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      FAKE_ACP_STATE_DIR: stateDir,
      UPBOT_PROVIDER_COMMAND_DEVIN: JSON.stringify(["bun", "/opt/upbot/fake-acp-agent.js"]),
      UPBOT_SSH_COMMAND: JSON.stringify(sshCommand),
      ...(providersRequested
        ? {
            UPBOT_SENTINEL_TEST: "leak",
            ANTHROPIC_API_KEY: "sk-sentinel-leak",
            OPENAI_API_KEY: "sk-sentinel-leak",
            UPBOT_PROVIDER_COMMAND_CLAUDE: "",
            UPBOT_PROVIDER_COMMAND_CODEX: "",
            UPBOT_ACP_COMMAND_CLAUDE: "",
            UPBOT_ACP_COMMAND_CODEX: "",
          }
        : {}),
    });
    const daemonStderr = daemon.proc.stderr;
    if (!daemonStderr || typeof daemonStderr === "number")
      throw new Error("daemon stderr is unavailable");
    daemonStderrDone = (async () => {
      const reader = daemonStderr.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        daemonStderrText += decoder.decode(value, { stream: true });
      }
      daemonStderrText += decoder.decode();
    })();
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
    await daemonStderrDone;
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

  describe.skipIf(!realProvidersEnabled)("real Claude and Codex providers", () => {
    test("probes real Codex account/read with API-key environment alone", async () => {
      const version = await runGuest(root, "codex-version", ["codex", "--version"], {}, "");
      console.log(`Codex guest version command (${version.code}): ${version.stdout.trim()}`);
      expect(version.stdout).toContain("codex-cli");
      const rpc = [
        {
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "upbot-probe", title: "UpBot", version: "0.1.0" },
            capabilities: null,
          },
        },
        { method: "initialized" },
        { id: 2, method: "account/read", params: { refreshToken: false } },
      ]
        .map((message) => JSON.stringify(message))
        .join("\n");
      const observations = [];
      for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY"] as const) {
        const key = `sk-proj-fake-${crypto.randomUUID()}`;
        const result = await runGuest(
          root,
          `codex-env-${name.toLowerCase().replaceAll("_", "-")}`,
          ["codex", "app-server", "--listen", "stdio://"],
          { [name]: key },
          `${rpc}\n`,
        );
        console.log(
          `Codex ${name} probe process (${result.code}): stdout=${result.stdout.replaceAll(key, "<redacted>")} stderr=${result.stderr.replaceAll(key, "<redacted>")}`,
        );
        const messages = result.stdout.split(/\r?\n/).flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>];
          } catch {
            return [];
          }
        });
        const initialized = messages.find((message) => message.id === 1)?.result as
          | Record<string, unknown>
          | undefined;
        const account = messages.find((message) => message.id === 2)?.result as
          | Record<string, unknown>
          | undefined;
        expect(initialized).toBeDefined();
        expect(account).toBeDefined();
        expect(result.stdout.includes(key)).toBe(false);
        expect(result.stderr.includes(key)).toBe(false);
        observations.push({
          env: name,
          codexHome: initialized?.codexHome,
          account: account?.account ?? null,
          requiresOpenaiAuth: account?.requiresOpenaiAuth,
        });
      }
      console.log(`Codex app-server environment probe: ${JSON.stringify(observations)}`);
    }, 90000);

    test("honors Codex CODEX_HOME in guest tmpfs", async () => {
      const key = `sk-proj-fake-${crypto.randomUUID()}`;
      const rpc = [
        {
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "upbot-probe", title: "UpBot", version: "0.1.0" },
            capabilities: null,
          },
        },
        { method: "initialized" },
        { id: 2, method: "account/read", params: { refreshToken: false } },
      ]
        .map((message) => JSON.stringify(message))
        .join("\n");
      const result = await runGuest(
        root,
        "codex-tmpfs-home",
        ["sh", "-c", 'mkdir -p "$CODEX_HOME" && exec codex app-server --listen stdio://'],
        { OPENAI_API_KEY: key, CODEX_HOME: "/run/upbot/codex-home" },
        `${rpc}\n`,
      );
      const messages = result.stdout.split(/\r?\n/).flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
      const initialized = messages.find((message) => message.id === 1)?.result as
        | Record<string, unknown>
        | undefined;
      const account = messages.find((message) => message.id === 2)?.result as
        | Record<string, unknown>
        | undefined;
      expect(initialized?.codexHome).toBe("/run/upbot/codex-home");
      expect(account?.account).toBeNull();
      expect(account?.requiresOpenaiAuth).toBe(true);
      expect(result.stdout.includes(key)).toBe(false);
      expect(result.stderr.includes(key)).toBe(false);
      console.log(
        `Codex tmpfs home probe: ${JSON.stringify({ codexHome: initialized?.codexHome, account: account?.account ?? null, requiresOpenaiAuth: account?.requiresOpenaiAuth })}`,
      );
    }, 90000);

    test("surfaces sign-in errors, keeps daemon sentinels out of RunSpec env, and cleans up VMs", async () => {
      host = (await client.request("hosts.install", { id: host.id })) as RemoteHost;
      host = (await client.request("hosts.check", { id: host.id })) as RemoteHost;
      expect(host.preflight?.firecrackerReady).toBe(true);
      const runSpecEnvLogPath = providerRunSpecEnvLog;
      if (runSpecEnvLogPath === null) throw new Error("RunSpec env log path is unavailable");

      const providerAgentIds: Record<string, string> = {};
      for (const provider of ["claude", "codex"] as const) {
        const agent = (await client.request("agents.create", {
          name: `real-${provider}`,
          provider,
          instructions: "",
        })) as Agent;
        providerAgentIds[provider] = agent.id;
        await client.request("placements.set", {
          agentId: agent.id,
          hostId: host.id,
          isolation: "firecracker",
          vcpus: 1,
          memMib: 512,
        });

        const observedPids = new Set<number>();
        const collectPids = () => {
          for (const runDir of firecrackerRunDirs(root, agent.id)) {
            const pidFile = join(runDir, "firecracker.pid");
            if (existsSync(pidFile)) observedPids.add(recordedFirecrackerPid(runDir));
          }
        };
        const pidPoll = setInterval(collectPids, 10);
        collectPids();
        const startedAt = Date.now();
        let turn: Turn;
        try {
          const queue = (await client.request("chat.send", {
            agentId: agent.id,
            text: "Reply with READY.",
          })) as { queueId: string };
          turn = await waitForEvent(client, agent.id, queue.queueId);
        } finally {
          clearInterval(pidPoll);
          collectPids();
        }

        const durationMs = Date.now() - startedAt;
        const loginCommand = provider === "claude" ? "claude auth login" : "codex login";
        const errorText = turn.error ?? "";
        expect(turn.status).toBe("failed");
        expect(turn.error).not.toBeNull();
        expect(errorText).toContain(loginCommand);
        const history = (await client.request("chat.history", {
          agentId: agent.id,
        })) as { items: ChatItem[] };
        const errorItem = history.items.filter((item) => item.kind === "error").at(-1);
        expect(errorItem?.kind).toBe("error");
        if (errorItem?.kind === "error") expect(errorItem.message).toBe(errorText);
        console.log(`${provider} auth error (${durationMs} ms): ${errorText}`);

        expect(observedPids.size).toBeGreaterThan(0);
        for (const pid of observedPids) await waitForPidExit(pid);
        await waitForRunDirsRemoved(root, agent.id);
        expect(firecrackerRunDirs(root, agent.id)).toHaveLength(0);

        const proxyLogPath = join(root, "vms", agent.id, "proxy.log");
        const proxyLog = existsSync(proxyLogPath) ? readFileSync(proxyLogPath, "utf8").trim() : "";
        console.log(`${provider} proxy activity:\n${proxyLog || "(no CONNECT requests)"}`);
      }

      const runSpecs = readFileSync(runSpecEnvLogPath, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              agentId: string;
              command: string;
              envKeys: string[];
              upbotKeys: string[];
              apiKeyKeys: string[];
              hasSentinelValue: boolean;
            },
        );
      for (const provider of ["claude", "codex"] as const) {
        const specEnvs = runSpecs.filter((entry) => entry.agentId === providerAgentIds[provider]);
        expect(specEnvs.length).toBeGreaterThan(0);
        for (const entry of specEnvs) {
          expect(entry.command).toBe(provider);
          expect(entry.upbotKeys).toEqual([]);
          expect(entry.apiKeyKeys).toEqual([]);
          expect(entry.hasSentinelValue).toBe(false);
          console.log(`${provider} RunSpec env evidence: ${JSON.stringify(entry)}`);
        }
      }
    }, 240000);

    test("rejects fake VM credentials without persisting or leaking them", async () => {
      host = (await client.request("hosts.install", { id: host.id })) as RemoteHost;
      host = (await client.request("hosts.check", { id: host.id })) as RemoteHost;
      const runSpecEnvLogPath = providerRunSpecEnvLog;
      if (runSpecEnvLogPath === null) throw new Error("RunSpec env log path is unavailable");
      const fakeCredentials: string[] = [];
      const processSamples: string[] = [];
      const runSpecs = () =>
        readFileSync(runSpecEnvLogPath, "utf8")
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .map(
            (line) =>
              JSON.parse(line) as {
                agentId: string;
                command: string;
                isolation: string;
                envKeys: string[];
                credentialKeys: string[];
                hasFakeCredential: boolean;
                upbotKeys: string[];
                hasSentinelValue: boolean;
              },
          );

      const runCredentialed = async (
        provider: "claude" | "codex",
        kind: "api_key" | "oauth_token",
        key: string,
        envKeys: string[],
      ) => {
        fakeCredentials.push(key);
        await client.request("vmCredentials.set", { provider, kind, value: key });
        const agent = (await client.request("agents.create", {
          name: `credential-${provider}-${kind}`,
          provider,
          instructions: "",
        })) as Agent;
        await client.request("placements.set", {
          agentId: agent.id,
          hostId: host.id,
          isolation: "firecracker",
          vcpus: 1,
          memMib: 512,
        });
        const observedPids = new Set<number>();
        const collectPids = () => {
          for (const runDir of firecrackerRunDirs(root, agent.id)) {
            const pidFile = join(runDir, "firecracker.pid");
            if (existsSync(pidFile)) observedPids.add(recordedFirecrackerPid(runDir));
          }
        };
        const pidPoll = setInterval(collectPids, 10);
        let artifactLeak = false;
        const scanRunArtifacts = () => {
          const files = filesUnder(join(root, "vms", agent.id)).filter(
            (path) => !path.endsWith(".ext4"),
          );
          for (const path of files) {
            try {
              if (readFileSync(path).includes(Buffer.from(key))) artifactLeak = true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
        };
        const artifactPoll = setInterval(scanRunArtifacts, 50);
        const psPoll = setInterval(() => {
          const result = spawnSync("ps", ["-eo", "args"], { encoding: "utf8" });
          if (result.status === 0) processSamples.push(result.stdout);
        }, 20);
        collectPids();
        const startedAt = Date.now();
        let turn: Turn;
        try {
          const queue = (await client.request("chat.send", {
            agentId: agent.id,
            text: "Reply with READY.",
          })) as { queueId: string };
          turn = await waitForEvent(client, agent.id, queue.queueId, 30000);
        } finally {
          clearInterval(pidPoll);
          clearInterval(artifactPoll);
          clearInterval(psPoll);
          collectPids();
          scanRunArtifacts();
        }
        const durationMs = Date.now() - startedAt;
        const message = turn.error ?? "";
        expect(turn.status).toBe("failed");
        if (!message.includes("the saved microVM credential was rejected"))
          throw new Error(`${provider} did not report a rejected saved microVM credential`);
        if (!message.includes("Update it in Settings → Hosts."))
          throw new Error(`${provider} credential rejection did not direct the user to Settings`);
        if (message.includes(key)) throw new Error(`${provider} chat exposed the fake credential`);
        if (/requires sign-in|not logged in/i.test(message))
          throw new Error(`${provider} returned a signed-out message for a saved credential`);
        const history = (await client.request("chat.history", {
          agentId: agent.id,
        })) as { items: ChatItem[] };
        const errorItem = history.items.filter((item) => item.kind === "error").at(-1);
        if (errorItem?.kind !== "error" || errorItem.message !== message)
          throw new Error(`${provider} chat history did not contain the credential rejection`);
        if (JSON.stringify(history).includes(key))
          throw new Error(`${provider} chat history exposed the fake credential`);
        console.log(`${provider} ${kind} rejection (${durationMs} ms): ${message}`);

        expect(observedPids.size).toBeGreaterThan(0);
        if (artifactLeak) throw new Error(`${provider} VM artifact contained the fake credential`);
        for (const pid of observedPids) await waitForPidExit(pid);
        await client.request("agents.delete", { id: agent.id });
        await waitForRunDirsRemoved(root, agent.id);
        expect(firecrackerRunDirs(root, agent.id)).toHaveLength(0);
        expect(existsSync(join(root, "vms", agent.id, "workspace.ext4"))).toBe(true);
        await assertNoPlaintext(filesUnder(join(root, "vms", agent.id)), [key]);
        for (const sample of processSamples)
          if (sample.includes(key))
            throw new Error(`${provider} fake credential appeared in ps args`);
        expect(processSamples.length).toBeGreaterThan(0);

        const specEnvs = runSpecs().filter((entry) => entry.agentId === agent.id);
        expect(specEnvs.length).toBeGreaterThan(0);
        for (const entry of specEnvs) {
          expect(entry.isolation).toBe("firecracker");
          expect(entry.command).toBe(provider);
          expect(entry.credentialKeys).toEqual(envKeys);
          expect(entry.hasFakeCredential).toBe(true);
          expect(entry.upbotKeys).toEqual([]);
          expect(entry.hasSentinelValue).toBe(false);
        }
        if (provider === "codex") {
          const workspace = join(root, "vms", agent.id, "workspace.ext4");
          const authStat = spawnSync("debugfs", ["-R", "stat /root/.codex/auth.json", workspace], {
            encoding: "utf8",
          });
          const auth = spawnSync("debugfs", ["-R", "cat /root/.codex/auth.json", workspace], {
            encoding: "utf8",
          });
          if (auth.stdout.includes(key) || auth.stderr.includes(key))
            throw new Error("Codex auth.json on the persistent workspace contains the fake key");
          expect(specEnvs.some((entry) => entry.envKeys.includes("CODEX_HOME"))).toBe(true);
          console.log(
            `Codex persistent workspace scan: clean; auth.json=${/Inode:\s+\d+/.test(authStat.stdout) ? "present without fake key" : "absent"}`,
          );
        }
        const proxyLogPath = join(root, "vms", agent.id, "proxy.log");
        const proxyLog = existsSync(proxyLogPath) ? readFileSync(proxyLogPath, "utf8").trim() : "";
        console.log(
          `${provider} credential proxy activity:\n${proxyLog || "(no CONNECT requests)"}`,
        );
        return agent.id;
      };

      const claudeApiKey = `sk-ant-api03-fake-${crypto.randomUUID()}`;
      await runCredentialed("claude", "api_key", claudeApiKey, ["ANTHROPIC_API_KEY"]);

      const noneAgent = (await client.request("agents.create", {
        name: "credential-none",
        provider: "claude",
        instructions: "",
      })) as Agent;
      await client.request("placements.set", {
        agentId: noneAgent.id,
        hostId: host.id,
        isolation: "none",
      });
      const noneQueue = (await client.request("chat.send", {
        agentId: noneAgent.id,
        text: "Reply with READY.",
      })) as { queueId: string };
      await waitForEvent(client, noneAgent.id, noneQueue.queueId, 30000);
      await client.request("agents.delete", { id: noneAgent.id });
      const noneEnvs = runSpecs().filter((entry) => entry.agentId === noneAgent.id);
      expect(noneEnvs.length).toBeGreaterThan(0);
      for (const entry of noneEnvs) {
        expect(entry.isolation).toBe("none");
        expect(entry.credentialKeys).toEqual([]);
        expect(entry.hasFakeCredential).toBe(false);
        expect(entry.upbotKeys).toEqual([]);
        expect(entry.hasSentinelValue).toBe(false);
      }
      expect(firecrackerRunDirs(root, noneAgent.id)).toHaveLength(0);
      await assertNoPlaintext(filesUnder(join(root, "vms", noneAgent.id)), [claudeApiKey]);
      console.log(`isolation:none RunSpec env evidence: ${JSON.stringify(noneEnvs[0])}`);

      const claudeOauth = `sk-ant-oat01-fake-${crypto.randomUUID()}`;
      await runCredentialed("claude", "oauth_token", claudeOauth, ["CLAUDE_CODE_OAUTH_TOKEN"]);
      const codexKey = `sk-proj-fake-${crypto.randomUUID()}`;
      await runCredentialed("codex", "api_key", codexKey, ["CODEX_API_KEY", "OPENAI_API_KEY"]);

      await Bun.sleep(100);
      expect(daemonStderrText.includes(claudeApiKey)).toBe(false);
      expect(daemonStderrText.includes(claudeOauth)).toBe(false);
      expect(daemonStderrText.includes(codexKey)).toBe(false);
      await assertNoPlaintext(
        daemonDirs.flatMap((dir) => filesUnder(dir)),
        fakeCredentials,
      );
      await assertNoPlaintext([runSpecEnvLogPath], fakeCredentials);
      for (const key of fakeCredentials)
        for (const sample of processSamples)
          if (sample.includes(key)) throw new Error("fake credential appeared in host ps args");
      console.log(
        "fake credential leak scans: clean in vms, daemon stderr/data, RunSpec logs, and ps args",
      );
    }, 300000);
  });
});
