// bobagent-host: helper installed on a remote Linux host (VPS). The desktop daemon reaches it
// over SSH. It is a single self-contained file (node builtins + Bun only) so the daemon can
// upload its source verbatim.
//
//   bobagent-host preflight      JSON report: OS, KVM, Firecracker, kernel/rootfs, CLIs
//   bobagent-host run            first stdin line = RunSpec JSON; then stdio is the provider's
//   bobagent-host bridge         stdio MCP server forwarding to the daemon over a unix socket
//   bobagent-host guest-exec     (inside a microVM) first stdin line = exec spec JSON
//
// Isolation "firecracker" boots one microVM per agent session (`firecracker --no-api
// --config-file`), talks to the guest over vsock (CONNECT 1024 = provider stdio), and serves
// guest-initiated vsock ports: 5000 = bobagent bridge, 3128 = HTTPS CONNECT proxy (the guest
// has no network device; outbound traffic goes through this proxy).

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  accessSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer, isIP, type Server, type Socket } from "node:net";
import { arch, homedir, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

export type RunSpec = {
  agentId: string;
  isolation: "none" | "firecracker";
  cmd: string[];
  env?: Record<string, string>;
  bridgeSocket?: string;
  vcpus?: number;
  memMib?: number;
};

const ROOT = resolve(process.env.BOBAGENT_HOST_ROOT || join(homedir(), ".bobagent"));
const VSOCK_EXEC_PORT = 1024;
const VSOCK_BRIDGE_PORT = 5000;
const VSOCK_PROXY_PORT = 3128;
const PROVIDER_CLIS = ["claude", "codex", "devin", "agent", "grok", "opencode", "gemini"];

const die = (msg: string, code = 1): never => {
  process.stderr.write(`bobagent-host: ${msg}\n`);
  process.exit(code);
};

/** Resolves the first newline-terminated line of a stream; the remainder is returned as `rest`. */
export function readFirstLine(
  stream: NodeJS.ReadableStream,
  maxBytes = 1 << 20,
): Promise<{ line: string; rest: Buffer }> {
  return new Promise((ok, fail) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(10);
      if (nl >= 0) {
        cleanup();
        stream.pause();
        ok({ line: buf.subarray(0, nl).toString("utf8"), rest: buf.subarray(nl + 1) });
      } else if (buf.length > maxBytes) {
        cleanup();
        fail(new Error("first line too long"));
      }
    };
    const onEnd = () => {
      cleanup();
      fail(new Error("stream ended before the first line"));
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.resume();
  });
}

const safeId = (id: string) => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) die(`invalid agent id`);
  return id;
};

function which(cmd: string): string | null {
  return Bun.which(cmd) ?? null;
}

export function firecrackerBin(): string | null {
  const local = join(ROOT, "firecracker", "firecracker");
  return process.env.BOBAGENT_FIRECRACKER_BIN || (existsSync(local) ? local : which("firecracker"));
}

function preflight() {
  let kvm = false;
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
    kvm = true;
  } catch {}
  const fc = firecrackerBin();
  let fcVersion: string | null = null;
  if (fc) {
    const r = spawnSync(fc, ["--version"], { encoding: "utf8", timeout: 5000 });
    fcVersion = r.status === 0 ? (r.stdout.split("\n")[0] ?? "").trim() : null;
  }
  const kernel = join(ROOT, "firecracker", "vmlinux");
  const rootfs = join(ROOT, "firecracker", "rootfs.ext4");
  const providers: Record<string, string | null> = {};
  for (const c of PROVIDER_CLIS) providers[c] = which(c);
  const report = {
    root: ROOT,
    os: platform(),
    arch: arch(),
    kernelRelease: release(),
    bun: Bun.version,
    kvm,
    firecracker: fc ? { path: fc, version: fcVersion } : null,
    kernelImage: existsSync(kernel) ? kernel : null,
    rootfs: existsSync(rootfs) ? rootfs : null,
    mkfsExt4: which("mkfs.ext4"),
    providers,
    firecrackerReady:
      platform() === "linux" &&
      kvm &&
      !!fcVersion &&
      existsSync(kernel) &&
      existsSync(rootfs) &&
      !!which("mkfs.ext4"),
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

/** Pipes the rest of our stdin (after the spec line) into `sink`; ends it on EOF. */
function pumpStdin(rest: Buffer, sink: NodeJS.WritableStream) {
  if (rest.length) sink.write(rest);
  process.stdin.pipe(sink);
}

async function pumpFramedStdin(rest: Buffer, sink: NodeJS.WritableStream) {
  const writeFrame = async (data: Buffer) => {
    const frame = Buffer.allocUnsafe(data.length + 4);
    frame.writeUInt32BE(data.length);
    data.copy(frame, 4);
    if (!sink.write(frame)) await new Promise<void>((resolve) => sink.once("drain", resolve));
  };
  if (rest.length) await writeFrame(rest);
  for await (const chunk of process.stdin) await writeFrame(Buffer.from(chunk));
  await writeFrame(Buffer.alloc(0));
}

function pumpGuestStdin(rest: Buffer, source: NodeJS.ReadableStream, sink: NodeJS.WritableStream) {
  let buffer = rest;
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    sink.end();
  };
  const onData = (chunk: Buffer) => {
    if (ended) return;
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (length === 0) {
        buffer = buffer.subarray(4);
        finish();
        return;
      }
      if (buffer.length < length + 4) return;
      sink.write(buffer.subarray(4, length + 4));
      buffer = buffer.subarray(length + 4);
    }
  };
  source.on("data", onData);
  source.once("end", finish);
  if (rest.length) onData(Buffer.alloc(0));
  source.resume();
}

function finish(code: number) {
  process.stdin.destroy();
  process.exitCode = code;
}

function runLocal(spec: RunSpec, rest: Buffer) {
  const cwd = join(ROOT, "agents", safeId(spec.agentId));
  mkdirSync(cwd, { recursive: true });
  const [bin, ...args] = spec.cmd;
  if (!bin) die("empty command");
  const child = spawn(bin as string, args, {
    cwd,
    env: { ...process.env, ...spec.env, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.on("error", (e) => die(`cannot start ${bin}: ${e.message}`, 127));
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.stdin.on("error", () => {});
  pumpStdin(rest, child.stdin);
  process.stdin.on("end", () => setTimeout(() => child.kill("SIGKILL"), 5000).unref());
  child.on("close", (code, signal) => finish(code ?? (signal ? 1 : 0)));
}

export function blockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "metadata.google.internal")
    return true;
  if (isIP(h) === 4) {
    const [a, b] = h.split(".").map(Number) as [number, number];
    return (
      a === 127 ||
      a === 0 ||
      a === 10 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(h.replace(/^\[|\]$/g, "")) === 6) return true;
  return false;
}

export async function proxyTarget(host: string): Promise<string | null> {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (blockedHost(normalized)) return null;
  if (isIP(normalized) === 4) return normalized;
  if (isIP(normalized) === 6) return null;
  try {
    const addresses = await lookup(normalized, { all: true, family: 4 });
    if (!addresses.length || addresses.some(({ address }) => blockedHost(address))) return null;
    return addresses[0]!.address;
  } catch {
    return null;
  }
}

/** Minimal HTTP CONNECT proxy for the guest (public destinations only). */
export function proxyServer(): Server {
  return createServer((conn) => {
    let head = Buffer.alloc(0);
    const onData = async (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > 16384) conn.destroy();
        return;
      }
      conn.off("data", onData);
      const m = /^CONNECT ([^\s:]+|\[[^\]]+\]):(\d{1,5}) HTTP\/1\.[01]\r\n/.exec(
        head.toString("latin1"),
      );
      if (!m) {
        conn.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const target = await proxyTarget(m[1]!);
      if (!target) {
        conn.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const upstream = createConnection({
        host: target,
        port: Number(m[2]),
      });
      upstream.once("connect", () => {
        conn.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const extra = head.subarray(end + 4);
        if (extra.length) upstream.write(extra);
        conn.pipe(upstream).pipe(conn);
      });
      upstream.on("error", () => conn.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
      conn.on("error", () => upstream.destroy());
    };
    conn.on("data", onData);
    conn.on("error", () => {});
  });
}

function relayServer(targetPath: string): Server {
  return createServer((conn) => {
    const up = createConnection({ path: targetPath });
    conn.pipe(up).pipe(conn);
    up.on("error", () => conn.destroy());
    conn.on("error", () => up.destroy());
  });
}

function listenUnix(server: Server, path: string): Promise<void> {
  rmSync(path, { force: true });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(path, () => ok());
  });
}

/** Opens the host-initiated vsock stream: CONNECT <port>\n -> OK <n>\n. */
function vsockConnect(uds: string, port: number): Promise<Socket> {
  return new Promise((ok, fail) => {
    const s = createConnection({ path: uds });
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      s.destroy();
      finishFail(new Error("vsock connection timed out"));
    }, 3000);
    const finishFail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fail(error);
    };
    const onData = (d: Buffer) => {
      buf += d.toString("latin1");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      s.off("data", onData);
      if (!buf.startsWith("OK")) {
        s.destroy();
        finishFail(new Error(`vsock refused: ${buf.slice(0, nl)}`));
        return;
      }
      settled = true;
      clearTimeout(timer);
      const extra = buf.slice(nl + 1);
      s.pause();
      if (extra) s.unshift(Buffer.from(extra, "latin1"));
      ok(s);
    };
    s.on("data", onData);
    s.once("error", finishFail);
    s.once("close", () => finishFail(new Error("vsock closed before OK")));
    s.once("connect", () => s.write(`CONNECT ${port}\n`));
  });
}

async function connectGuest(uds: string, timeoutMs: number, alive: () => boolean): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await vsockConnect(uds, VSOCK_EXEC_PORT);
    } catch (e) {
      if (!alive()) throw new Error("microVM exited during boot");
      if (Date.now() > deadline) throw e;
      await Bun.sleep(200);
    }
  }
}

export function vmConfig(spec: RunSpec, rootDisk: string, uds: string, workspaceDisk: string) {
  return {
    "boot-source": {
      kernel_image_path: join(ROOT, "firecracker", "vmlinux"),
      boot_args: "console=ttyS0 reboot=k panic=1 pci=off init=/sbin/bobagent-init",
    },
    drives: [
      { drive_id: "rootfs", path_on_host: rootDisk, is_root_device: true, is_read_only: false },
      {
        drive_id: "workspace",
        path_on_host: workspaceDisk,
        is_root_device: false,
        is_read_only: false,
      },
    ],
    "machine-config": {
      vcpu_count: Math.min(Math.max(spec.vcpus ?? 2, 1), 32),
      mem_size_mib: Math.min(Math.max(spec.memMib ?? 2048, 256), 65536),
    },
    vsock: { guest_cid: 3, uds_path: uds },
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function removeStaleRuns(agentDir: string): Promise<void> {
  for (const entry of readdirSync(agentDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^r[0-9a-f]{8}$/.test(entry.name)) continue;
    const runDir = join(agentDir, entry.name);
    const pidFile = join(runDir, "firecracker.pid");
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (Number.isInteger(pid) && pid > 1) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
        const deadline = Date.now() + 3000;
        while (pidAlive(pid) && Date.now() < deadline) await Bun.sleep(50);
      }
    }
    rmSync(runDir, { recursive: true, force: true });
  }
}

function ensureWorkspaceDisk(path: string): void {
  if (existsSync(path)) return;
  const size = Number(process.env.BOBAGENT_VM_WORKSPACE_MIB ?? 8192);
  if (!Number.isInteger(size) || size < 1)
    die("BOBAGENT_VM_WORKSPACE_MIB must be a positive integer");
  const mkfs = which("mkfs.ext4") ?? die("mkfs.ext4 not found; install e2fsprogs on the host");
  const truncate = spawnSync("truncate", ["-s", `${size}M`, path]);
  if (truncate.status !== 0)
    die(`cannot create workspace disk: ${truncate.stderr.toString().trim()}`);
  const format = spawnSync(mkfs, ["-q", "-F", path]);
  if (format.status !== 0) {
    rmSync(path, { force: true });
    die(`cannot format workspace disk: ${format.stderr.toString().trim()}`);
  }
}

async function runFirecracker(spec: RunSpec, rest: Buffer) {
  const id = safeId(spec.agentId);
  const fc =
    firecrackerBin() ?? die("firecracker binary not found (run `bobagent-host preflight`)");
  const base = join(ROOT, "firecracker", "rootfs.ext4");
  if (!existsSync(base)) die(`missing ${base}`);
  if (!existsSync(join(ROOT, "firecracker", "vmlinux"))) die("missing firecracker/vmlinux");
  const agentDir = join(ROOT, "vms", id);
  mkdirSync(agentDir, { recursive: true });
  await removeStaleRuns(agentDir);
  const workspaceDisk = join(agentDir, "workspace.ext4");
  ensureWorkspaceDisk(workspaceDisk);
  const vmDir = join(agentDir, `r${randomBytes(4).toString("hex")}`);
  mkdirSync(vmDir);
  const disk = join(vmDir, "root.ext4");
  const cp = spawnSync("cp", ["--reflink=auto", "--sparse=always", base, disk]);
  if (cp.status !== 0) copyFileSync(base, disk);
  const pidFile = join(vmDir, "firecracker.pid");
  const uds = join(vmDir, "v.sock");
  if (Buffer.byteLength(`${uds}_${VSOCK_PROXY_PORT}`) > 107) {
    rmSync(vmDir, { recursive: true, force: true });
    return die(
      `Firecracker socket path exceeds Linux's 107-byte limit: ${uds}; use a shorter BOBAGENT_HOST_ROOT`,
    );
  }
  const servers: Server[] = [];
  const proxy = proxyServer();
  servers.push(proxy);
  try {
    await listenUnix(proxy, `${uds}_${VSOCK_PROXY_PORT}`);
    if (spec.bridgeSocket) {
      const bridge = relayServer(spec.bridgeSocket);
      servers.push(bridge);
      await listenUnix(bridge, `${uds}_${VSOCK_BRIDGE_PORT}`);
    }
  } catch (e) {
    for (const server of servers) {
      try {
        server.close();
      } catch {}
    }
    rmSync(vmDir, { recursive: true, force: true });
    return die(`cannot start Firecracker socket server: ${(e as Error).message}`);
  }
  const configPath = join(vmDir, "vm.json");
  writeFileSync(configPath, JSON.stringify(vmConfig(spec, disk, uds, workspaceDisk), null, 2));
  const logPath = join(vmDir, "console.log");
  const log = openSync(logPath, "w");
  const vmArgs = ["--no-api", "--config-file", configPath, "--id", id];
  const setpriv = which("setpriv");
  const vm: ChildProcess = spawn(
    setpriv ?? (fc as string),
    setpriv ? ["--pdeathsig", "KILL", "--", fc, ...vmArgs] : vmArgs,
    {
      stdio: ["ignore", log, log],
      cwd: vmDir,
    },
  );
  closeSync(log);
  writeFileSync(pidFile, String(vm.pid ?? ""));
  let vmAlive = true;
  let cleaned = false;
  let cleanup = () => {};
  const onSignal = () => {
    cleanup();
    process.exit(0);
  };
  const onHostDisconnect = () => {
    cleanup();
    finish(0);
  };
  const onVmExit = (code: number | null, signal: NodeJS.Signals | null) => {
    vmAlive = false;
    const tail = existsSync(logPath) ? readFileSync(logPath, "utf8").slice(-1500) : "";
    cleanup();
    die(
      `microVM exited (code ${code}${signal ? `, signal ${signal}` : ""})${tail ? `\n${tail}` : ""}`,
    );
  };
  cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    vmAlive = false;
    vm.removeListener("exit", onVmExit);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    process.off("SIGHUP", onSignal);
    process.stdout.off("close", onHostDisconnect);
    process.stdout.off("error", onHostDisconnect);
    for (const server of servers) {
      try {
        server.close();
      } catch {}
    }
    try {
      vm.kill("SIGKILL");
    } catch {}
    rmSync(vmDir, { recursive: true, force: true });
  };
  vm.on("exit", onVmExit);
  vm.on("error", (e) => {
    cleanup();
    die(`cannot start firecracker: ${e.message}`);
  });
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  process.once("SIGHUP", onSignal);
  process.stdout.once("close", onHostDisconnect);
  process.stdout.once("error", onHostDisconnect);
  let guest: Socket;
  try {
    guest = await connectGuest(
      uds,
      Number(process.env.BOBAGENT_VM_BOOT_TIMEOUT_MS || 60000),
      () => vmAlive,
    );
  } catch (e) {
    cleanup();
    return die(`cannot reach the guest: ${(e as Error).message}`);
  }
  guest.write(`${JSON.stringify({ cmd: spec.cmd, env: spec.env ?? {}, cwd: "/workspace" })}\n`);
  guest.pipe(process.stdout);
  guest.resume();
  guest.on("error", () => {});
  void pumpFramedStdin(rest, guest).catch(() => {});
  guest.on("close", () => {
    cleanup();
    finish(0);
  });
}

async function run() {
  const { line, rest } = await readFirstLine(process.stdin);
  let spec: RunSpec;
  try {
    spec = JSON.parse(line);
  } catch {
    return die("invalid run spec");
  }
  if (!Array.isArray(spec.cmd) || !spec.cmd.every((c) => typeof c === "string")) die("invalid cmd");
  if (spec.isolation === "firecracker") await runFirecracker(spec, rest);
  else runLocal(spec, rest);
}

async function guestExec() {
  const { line, rest } = await readFirstLine(process.stdin);
  const spec = JSON.parse(line) as { cmd: string[]; env: Record<string, string>; cwd: string };
  mkdirSync(spec.cwd, { recursive: true });
  const proxy = process.env.BOBAGENT_GUEST_PROXY;
  const env: Record<string, string | undefined> = { ...process.env, ...spec.env, NO_COLOR: "1" };
  if (proxy) {
    env.HTTPS_PROXY = env.https_proxy = env.HTTP_PROXY = env.http_proxy = proxy;
    env.NO_PROXY = env.no_proxy = "localhost,127.0.0.1";
  }
  const [bin, ...args] = spec.cmd;
  const child = spawn(bin as string, args, {
    cwd: spec.cwd,
    env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.on("error", (e) => die(`cannot start ${bin}: ${e.message}`, 127));
  child.stdout.pipe(process.stdout);
  child.stdin.on("error", () => {});
  pumpGuestStdin(rest, process.stdin, child.stdin);
  child.on("close", (code, signal) => {
    spawnSync("sync");
    finish(code ?? (signal ? 1 : 0));
  });
}

async function bridge() {
  const sock =
    process.env.BOBAGENT_BRIDGE_SOCKET ||
    process.env.BOBAGENT_GUEST_BRIDGE_SOCKET ||
    "/run/bobagent/bridge.sock";
  const token = process.env.BOBAGENT_BRIDGE_TOKEN;
  if (!token) die("BOBAGENT_BRIDGE_TOKEN missing", 2);
  const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
  type Msg = { id?: number | string; method?: string; params?: unknown };
  const forward = async (method: string, params: unknown) => {
    const res = await fetch("http://localhost/bridge", {
      unix: sock,
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
    } as RequestInit);
    if (!res.ok) throw new Error(`daemon returned ${res.status}: ${await res.text()}`);
    return res.json();
  };
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", async (raw) => {
    let m: Msg;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.id === undefined) return;
    try {
      if (m.method === "initialize") {
        const v = (m.params as { protocolVersion?: string } | undefined)?.protocolVersion;
        send({
          jsonrpc: "2.0",
          id: m.id,
          result: {
            protocolVersion: v ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "bobagent", version: "0.1.0" },
          },
        });
      } else if (m.method === "ping") send({ jsonrpc: "2.0", id: m.id, result: {} });
      else if (m.method === "tools/list" || m.method === "tools/call")
        send({ jsonrpc: "2.0", id: m.id, result: await forward(m.method, m.params ?? {}) });
      else
        send({
          jsonrpc: "2.0",
          id: m.id,
          error: { code: -32601, message: `method not found: ${m.method}` },
        });
    } catch (e) {
      if (m.method === "tools/call")
        send({
          jsonrpc: "2.0",
          id: m.id,
          result: { content: [{ type: "text", text: (e as Error).message }], isError: true },
        });
      else
        send({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: (e as Error).message } });
    }
  });
  await new Promise<void>((r) => rl.on("close", () => r()));
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === "preflight") preflight();
  else if (cmd === "run") await run();
  else if (cmd === "bridge") await bridge();
  else if (cmd === "guest-exec") await guestExec();
  else if (cmd === "version") process.stdout.write("bobagent-host 0.1.0\n");
  else die("usage: bobagent-host preflight|run|bridge|guest-exec|version", 2);
}
