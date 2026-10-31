import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertGuestInitExecutable,
  firecrackerPids,
  firecrackerRunDirs,
  HOST_MAIN,
  makeFirecrackerHostRoot,
  REPO_ROOT,
  recordedFirecrackerPid,
  removeFirecrackerHostRoot,
} from "./firecracker-fixtures";

const enabled = process.env.BOTO_REAL_FIRECRACKER === "1";
const hostProcesses: ReturnType<typeof Bun.spawn>[] = [];

type HostRun = {
  proc: ReturnType<typeof Bun.spawn>;
  output: Promise<string>;
  errors: Promise<string>;
  firstLine: Promise<{ line: string; ms: number } | null>;
};

function hostRun(
  root: string,
  spec: Record<string, unknown>,
  input = "",
  closeInput = true,
): HostRun {
  const started = Date.now();
  const proc = Bun.spawn(["bun", HOST_MAIN, "run"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      BOTO_HOST_ROOT: root,
      BOTO_VM_WORKSPACE_MIB: "32",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  hostProcesses.push(proc);
  proc.stdin.write(`${JSON.stringify(spec)}\n${input}`);
  if (closeInput) proc.stdin.end();

  let resolveFirstLine!: (value: { line: string; ms: number } | null) => void;
  const firstLine = new Promise<{ line: string; ms: number } | null>((resolve) => {
    resolveFirstLine = resolve;
  });
  const output = (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let captured = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (!captured) {
        const newline = text.indexOf("\n");
        if (newline >= 0) {
          captured = true;
          resolveFirstLine({ line: text.slice(0, newline), ms: Date.now() - started });
        }
      }
    }
    text += decoder.decode();
    if (!captured) resolveFirstLine(null);
    return text;
  })();
  return { proc, output, errors: new Response(proc.stderr).text(), firstLine };
}

async function waitForExit(run: HostRun, timeoutMs = 60000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([
      run.proc.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          run.proc.kill("SIGKILL");
          reject(new Error(`boto-host did not exit within ${timeoutMs} ms`));
        }, timeoutMs);
      }),
    ]);
    const [stdout, stderr] = await Promise.all([run.output, run.errors]);
    return { code, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function spec(agentId: string, cmd: string[], extra: Record<string, unknown> = {}) {
  return { agentId, isolation: "firecracker", cmd, ...extra };
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function waitForPidExit(pid: number) {
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return;
      throw e;
    }
    if (Date.now() >= deadline) throw new Error(`firecracker pid ${pid} is still alive`);
    await Bun.sleep(50);
  }
}

async function waitForRunDir(root: string, agentId: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const runDir = firecrackerRunDirs(root, agentId).find((dir) =>
      existsSync(join(dir, "firecracker.pid")),
    );
    if (runDir) return runDir;
    await Bun.sleep(20);
  }
  throw new Error(`Firecracker run directory for ${agentId} was not created`);
}

describe.skipIf(!enabled)("real Firecracker host", () => {
  let root = "";

  beforeEach(() => {
    root = makeFirecrackerHostRoot();
    assertGuestInitExecutable(join(root, "firecracker/rootfs.ext4"));
  });

  afterEach(async () => {
    for (const proc of hostProcesses) {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
    await Promise.allSettled(hostProcesses.map((proc) => proc.exited));
    hostProcesses.length = 0;
    if (root) await removeFirecrackerHostRoot(root);
  });

  test("boots, round-trips stdin after EOF, and reports boot time", async () => {
    const run = hostRun(
      root,
      spec("roundtrip", ["sh", "-c", "printf 'boot-ready\\n'; cat"]),
      "from-host\n",
    );
    const runDir = await waitForRunDir(root, "roundtrip");
    const pid = recordedFirecrackerPid(runDir);
    const first = await run.firstLine;
    expect(first?.line).toBe("boot-ready");
    console.log("boot_ms=", first?.ms);
    expect(first!.ms).toBeLessThan(15000);
    const result = await waitForExit(run);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("from-host");
    await waitForPidExit(pid);
    expect(existsSync(runDir)).toBe(false);
    expect(existsSync(join(root, "vms", "roundtrip", "workspace.ext4"))).toBe(true);

    const eofRun = hostRun(root, spec("eof", ["sh", "-c", "printf 'eof-output\\n'; cat"]));
    const eofDir = await waitForRunDir(root, "eof");
    const eofPid = recordedFirecrackerPid(eofDir);
    const eof = await waitForExit(eofRun);
    expect(eof.code).toBe(0);
    expect(eof.stdout).toContain("eof-output");
    await waitForPidExit(eofPid);
    expect(existsSync(eofDir)).toBe(false);
  }, 90000);

  test("bounds the run when the guest command ignores stdin EOF", async () => {
    const run = hostRun(root, spec("ignored-eof", ["sleep", "600"]));
    const runDir = await waitForRunDir(root, "ignored-eof");
    const pid = recordedFirecrackerPid(runDir);
    const started = Date.now();
    const result = await waitForExit(run, 25000);
    expect(result.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(25000);
    await waitForPidExit(pid);
    expect(existsSync(runDir)).toBe(false);
  }, 45000);

  test("applies the requested vCPU and memory limits", async () => {
    const run = hostRun(
      root,
      spec("resources", ["sh", "-c", "nproc; awk '/MemTotal/ {print $2}' /proc/meminfo"], {
        vcpus: 3,
        memMib: 700,
      }),
    );
    const runDir = await waitForRunDir(root, "resources");
    const pid = recordedFirecrackerPid(runDir);
    const result = await waitForExit(run);
    expect(result.code).toBe(0);
    const [cpus, memKiB] = result.stdout.trim().split("\n").map(Number);
    expect(cpus).toBe(3);
    const memMib = memKiB! / 1024;
    expect(memMib).toBeGreaterThan(600);
    expect(memMib).toBeLessThanOrEqual(700);
    await waitForPidExit(pid);
  }, 90000);

  test("forwards the guest bridge to the host unix socket", async () => {
    const socketPath = join(root, "bridge.sock");
    const requests: { method: string; authorization: string | null }[] = [];
    const bridge = Bun.serve({
      unix: socketPath,
      async fetch(request) {
        const body = (await request.json()) as { method: string };
        requests.push({ method: body.method, authorization: request.headers.get("authorization") });
        if (request.headers.get("authorization") !== "Bearer bridge-test-token")
          return new Response("unauthorized", { status: 401 });
        if (body.method === "tools/list")
          return Response.json({
            tools: [
              {
                name: "integration_tool",
                description: "test tool",
                inputSchema: { type: "object" },
              },
            ],
          });
        return Response.json({});
      },
    });
    try {
      const requestsFromGuest = [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18" },
        }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      ];
      const script = `printf '%s\\n' ${requestsFromGuest.map(shellQuote).join(" ")} | boto-bridge`;
      const result = await waitForExit(
        hostRun(
          root,
          spec("bridge", ["sh", "-c", script], {
            bridgeSocket: socketPath,
            env: { BOTO_BRIDGE_TOKEN: "bridge-test-token" },
          }),
        ),
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("integration_tool");
      expect(requests).toEqual([
        { method: "tools/list", authorization: "Bearer bridge-test-token" },
      ]);
    } finally {
      bridge.stop(true);
    }
  }, 90000);

  test("does not expose internal Boto variables to guest commands", async () => {
    const result = await waitForExit(hostRun(root, spec("guest-env", ["env"])));
    expect(result.code).toBe(0);
    expect(result.stdout).not.toMatch(/^BOTO_/m);
    expect(result.stdout).toContain("HTTPS_PROXY=http://127.0.0.1:3128");
    expect(result.stdout).toContain("NO_COLOR=1");
  }, 90000);

  test("allows public HTTPS and denies private destinations through the CONNECT proxy", async () => {
    const blocked = [
      "https://127.0.0.1:443",
      "http://169.254.169.254/",
      "https://10.0.0.1/",
      "https://2130706433/",
    ];
    const checks = blocked
      .map(
        (url) =>
          `response="$(curl --noproxy '' --proxytunnel -sv --connect-timeout 5 --max-time 10 -x http://127.0.0.1:3128 ${shellQuote(url)} 2>&1)" && { echo "unexpectedly allowed ${url}"; exit 2; }; printf '%s' "$response" | grep -q 'HTTP/1.1 403 Forbidden' || { printf '%s\\n' "$response"; exit 3; }`,
      )
      .join("; ");
    const run = hostRun(
      root,
      spec("proxy", [
        "sh",
        "-c",
        `set -e; status="$(curl -sS -o /dev/null -w '%{http_code}' https://example.com)"; echo "public:$status"; test "$status" = 200; for host in api.anthropic.com api.openai.com; do status="$(curl -sS --connect-timeout 10 --max-time 30 -o /dev/null -w '%{http_code}' "https://$host/")"; test "$status" != 000; echo "$host:$status"; done; ${checks}; echo proxy-blocked`,
      ]),
    );
    const runDir = await waitForRunDir(root, "proxy");
    const pid = recordedFirecrackerPid(runDir);
    const result = await waitForExit(run, 90000);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("public:200");
    expect(result.stdout).toContain("api.anthropic.com:");
    expect(result.stdout).toContain("api.openai.com:");
    expect(result.stdout).toContain("proxy-blocked");
    const proxyLog = readFileSync(join(root, "vms", "proxy", "proxy.log"), "utf8");
    expect(proxyLog).toMatch(/api\.anthropic\.com:443 allowed \d+\.\d+\.\d+\.\d+/);
    expect(proxyLog).toMatch(/api\.openai\.com:443 allowed \d+\.\d+\.\d+\.\d+/);
    expect(
      proxyLog.match(/127\.0\.0\.1:443 denied blocked or unresolved destination/g),
    ).toHaveLength(2);
    expect(proxyLog).toMatch(/127\.0\.0\.1:443 denied blocked or unresolved destination/);
    console.log(
      result.stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith("api."))
        .join("\n"),
    );
    console.log(`proxy audit log:\n${proxyLog.trim()}`);
    await waitForPidExit(pid);
  }, 120000);

  test("cleans per-run disks, preserves workspace, handles signals, and removes stale runs", async () => {
    const agentId = "lifecycle";
    const firstRun = hostRun(
      root,
      spec(agentId, ["sh", "-c", "printf 'persisted-data' > /workspace/persisted; echo first"]),
    );
    const firstRunDir = await waitForRunDir(root, agentId);
    const firstPid = recordedFirecrackerPid(firstRunDir);
    const first = await waitForExit(firstRun);
    expect(first.code).toBe(0);
    await waitForPidExit(firstPid);
    const agentDir = join(root, "vms", agentId);
    const workspace = join(agentDir, "workspace.ext4");
    expect(existsSync(workspace)).toBe(true);
    expect(firecrackerRunDirs(root, agentId)).toHaveLength(0);

    const secondRun = hostRun(root, spec(agentId, ["cat", "/workspace/persisted"]));
    const secondRunDir = await waitForRunDir(root, agentId);
    const secondPid = recordedFirecrackerPid(secondRunDir);
    const second = await waitForExit(secondRun);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("persisted-data");
    await waitForPidExit(secondPid);
    expect(existsSync(workspace)).toBe(true);

    const term = hostRun(
      root,
      spec(agentId, ["sh", "-c", "echo term-ready; exec sleep 60"]),
      "",
      false,
    );
    expect((await term.firstLine)?.line).toBe("term-ready");
    const termRunDir = await waitForRunDir(root, agentId);
    const termPid = recordedFirecrackerPid(termRunDir);
    term.proc.kill("SIGTERM");
    const termResult = await waitForExit(term);
    expect(termResult.code).toBe(0);
    await waitForPidExit(termPid);
    expect(existsSync(termRunDir)).toBe(false);
    expect(existsSync(workspace)).toBe(true);

    const killId = "kill-case";
    const killed = hostRun(
      root,
      spec(killId, ["sh", "-c", "echo kill-ready; exec sleep 60"]),
      "",
      false,
    );
    expect((await killed.firstLine)?.line).toBe("kill-ready");
    const staleRunDir = await waitForRunDir(root, killId);
    const killedVmPid = recordedFirecrackerPid(staleRunDir);
    killed.proc.kill("SIGKILL");
    await killed.proc.exited;
    await waitForPidExit(killedVmPid);
    expect(existsSync(staleRunDir)).toBe(true);

    const recovered = await waitForExit(hostRun(root, spec(killId, ["echo", "recovered"])));
    expect(recovered.code).toBe(0);
    expect(recovered.stdout).toContain("recovered");
    expect(existsSync(staleRunDir)).toBe(false);
    expect(firecrackerRunDirs(root, killId)).toHaveLength(0);
    expect(existsSync(join(root, "vms", killId, "workspace.ext4"))).toBe(true);
    expect(firecrackerPids(root)).toHaveLength(0);
  }, 150000);
});
