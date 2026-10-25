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

import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
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
    providers,
    firecrackerReady:
      platform() === "linux" && kvm && !!fcVersion && existsSync(kernel) && existsSync(rootfs),
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

/** Pipes the rest of our stdin (after the spec line) into `sink`; ends it on EOF. */
function pumpStdin(rest: Buffer, sink: NodeJS.WritableStream) {
  if (rest.length) sink.write(rest);
  process.stdin.pipe(sink);
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
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
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
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (isIP(h.replace(/^\[|\]$/g, "")) === 6) return true;
  return false;
}

/** Minimal HTTP CONNECT proxy for the guest (public destinations only). */
export function proxyServer(): Server {
  return createServer((conn) => {
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
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
      if (!m || blockedHost(m[1]!)) {
        conn.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const upstream = createConnection({
        host: m[1]!.replace(/^\[|\]$/g, ""),
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
    const onData = (d: Buffer) => {
      buf += d.toString("latin1");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      s.off("data", onData);
      if (!buf.startsWith("OK")) {
        s.destroy();
        fail(new Error(`vsock refused: ${buf.slice(0, nl)}`));
        return;
      }
      const extra = buf.slice(nl + 1);
      s.pause();
      if (extra) s.unshift(Buffer.from(extra, "latin1"));
      ok(s);
    };
    s.on("data", onData);
    s.once("error", fail);
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

export function vmConfig(spec: RunSpec, disk: string, uds: string) {
  return {
    "boot-source": {
      kernel_image_path: join(ROOT, "firecracker", "vmlinux"),
      boot_args: "console=ttyS0 reboot=k panic=1 pci=off init=/sbin/bobagent-init",
    },
    drives: [{ drive_id: "rootfs", path_on_host: disk, is_root_device: true, is_read_only: false }],
    "machine-config": {
      vcpu_count: Math.min(Math.max(spec.vcpus ?? 2, 1), 32),
      mem_size_mib: Math.min(Math.max(spec.memMib ?? 2048, 256), 65536),
    },
    vsock: { guest_cid: 3, uds_path: uds },
  };
}

async function runFirecracker(spec: RunSpec, rest: Buffer) {
  const id = safeId(spec.agentId);
  const fc = firecrackerBin();
  if (!fc) die("firecracker binary not found (run `bobagent-host preflight`)");
  const base = join(ROOT, "firecracker", "rootfs.ext4");
  if (!existsSync(base)) die(`missing ${base}`);
  if (!existsSync(join(ROOT, "firecracker", "vmlinux"))) die("missing firecracker/vmlinux");
  const vmDir = join(ROOT, "vms", id);
  mkdirSync(vmDir, { recursive: true });
  const disk = join(vmDir, "disk.ext4");
  if (!existsSync(disk)) {
    const cp = spawnSync("cp", ["--reflink=auto", "--sparse=always", base, disk]);
    if (cp.status !== 0) copyFileSync(base, disk);
  }
  const pidFile = join(vmDir, "firecracker.pid");
  if (existsSync(pidFile)) {
    const old = Number(readFileSync(pidFile, "utf8"));
    if (old > 0) {
      try {
        process.kill(old, "SIGKILL");
      } catch {}
    }
  }
  const uds = join(vmDir, "v.sock");
  const servers: Server[] = [];
  const proxy = proxyServer();
  await listenUnix(proxy, `${uds}_${VSOCK_PROXY_PORT}`);
  servers.push(proxy);
  if (spec.bridgeSocket) {
    const bridge = relayServer(spec.bridgeSocket);
    await listenUnix(bridge, `${uds}_${VSOCK_BRIDGE_PORT}`);
    servers.push(bridge);
  }
  rmSync(uds, { force: true });
  const configPath = join(vmDir, "vm.json");
  writeFileSync(configPath, JSON.stringify(vmConfig(spec, disk, uds), null, 2));
  const logPath = join(vmDir, "console.log");
  const log = openSync(logPath, "w");
  const vm = spawn(fc as string, ["--no-api", "--config-file", configPath, "--id", id], {
    stdio: ["ignore", log, log],
    cwd: vmDir,
  });
  closeSync(log);
  writeFileSync(pidFile, String(vm.pid ?? ""));
  let vmAlive = true;
  const cleanup = () => {
    for (const s of servers) s.close();
    try {
      vm.kill("SIGKILL");
    } catch {}
    rmSync(pidFile, { force: true });
    for (const p of [uds, `${uds}_${VSOCK_PROXY_PORT}`, `${uds}_${VSOCK_BRIDGE_PORT}`])
      rmSync(p, { force: true });
  };
  vm.on("exit", (code) => {
    vmAlive = false;
    const tail = existsSync(logPath) ? readFileSync(logPath, "utf8").slice(-1500) : "";
    cleanup();
    die(`microVM exited (code ${code})${tail ? `\n${tail}` : ""}`);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
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
  pumpStdin(rest, guest);
  process.stdin.on("end", () => setTimeout(() => guest.destroy(), 5000).unref());
  guest.on("close", () => {
    vm.removeAllListeners("exit");
    cleanup();
    process.exit(0);
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
  pumpStdin(rest, child.stdin);
  child.on("exit", (code) => process.exit(code ?? 1));
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
