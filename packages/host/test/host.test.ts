import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  appendProxyLog,
  blockedHost,
  buildGuestProviderEnv,
  isFirecrackerReady,
  matchesGuestHelperStamp,
  proxyServer,
  proxyTarget,
  type RunSpec,
  readFirstLine,
  vmConfig,
} from "../src/main";

const MAIN = join(import.meta.dir, "../src/main.ts");

describe("upbot-host", () => {
  test("readFirstLine keeps the bytes after the spec", async () => {
    const s = new PassThrough();
    const p = readFirstLine(s);
    s.write('{"a":1}\nrest');
    const { line, rest } = await p;
    expect(line).toBe('{"a":1}');
    expect(rest.toString()).toBe("rest");
  });

  test("proxy blocks private, loopback, metadata and IPv6 destinations", () => {
    for (const h of [
      "localhost",
      "x.localhost",
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
      "100.64.0.1",
      "100.127.255.254",
      "192.0.0.1",
      "198.18.0.1",
      "198.19.255.254",
      "224.0.0.1",
      "::1",
      "[fd00::1]",
      "metadata.google.internal",
    ])
      expect(blockedHost(h)).toBe(true);
    for (const h of ["api.anthropic.com", "8.8.8.8", "172.32.0.1"])
      expect(blockedHost(h)).toBe(false);
  });

  test("proxyTarget rejects hostnames resolving to blocked addresses", async () => {
    expect(await proxyTarget("2130706433")).toBeNull();
    expect(await proxyTarget("localhost")).toBeNull();
    expect(await proxyTarget("8.8.8.8")).toBe("8.8.8.8");
  });

  test("guest provider env strips inherited internal UpBot values", () => {
    const env = buildGuestProviderEnv(
      {
        UPBOT_GUEST_PROXY: "http://127.0.0.1:3128",
        UPBOT_GUEST_BRIDGE_SOCKET: "/run/upbot/bridge.sock",
        UPBOT_SENTINEL_TEST: "leak",
        HOME: "/root",
        PATH: "/usr/bin",
      },
      { UPBOT_BRIDGE_TOKEN: "mcp-token", CUSTOM_VALUE: "kept" },
      "http://127.0.0.1:3128",
    );
    expect(env.UPBOT_GUEST_PROXY).toBeUndefined();
    expect(env.UPBOT_GUEST_BRIDGE_SOCKET).toBeUndefined();
    expect(env.UPBOT_SENTINEL_TEST).toBeUndefined();
    expect(env.UPBOT_BRIDGE_TOKEN).toBe("mcp-token");
    expect(env.CUSTOM_VALUE).toBe("kept");
    expect(env.HOME).toBe("/root");
    expect(env.NO_COLOR).toBe("1");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:3128");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1");
  });

  test("proxy audit log rotates above one MiB before appending", () => {
    const dir = mkdtempSync(join(tmpdir(), "proxy-log-test-"));
    const path = join(dir, "proxy.log");
    const large = Buffer.alloc(1024 * 1024 + 1, 0x61);
    writeFileSync(path, large);
    try {
      appendProxyLog(path, "api.example.com:443", "allowed 203.0.113.1");
      expect(readFileSync(`${path}.1`)).toEqual(large);
      const line = readFileSync(path, "utf8").trim();
      expect(line).toMatch(
        /^\d{4}-\d\d-\d\dT[\d:.]+Z api\.example\.com:443 allowed 203\.0\.113\.1$/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("proxy rejects a numeric hostname resolving to loopback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proxy-test-"));
    const socketPath = join(dir, "proxy.sock");
    const logPath = join(dir, "proxy.log");
    const target = createServer((conn) => conn.destroy());
    const proxy = proxyServer(logPath);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => proxy.listen(socketPath, resolve));
    try {
      const port = (target.address() as { port: number }).port;
      const response = await new Promise<string>((resolve, reject) => {
        const client = createConnection({ path: socketPath });
        let text = "";
        client.setTimeout(3000, () => client.destroy(new Error("proxy response timeout")));
        client.on("data", (data) => (text += data.toString()));
        client.on("end", () => resolve(text));
        client.on("error", reject);
        client.on("connect", () =>
          client.write(`CONNECT 2130706433:${port} HTTP/1.1\r\nHost: proxy\r\n\r\n`),
        );
      });
      expect(response).toStartWith("HTTP/1.1 403 Forbidden");
      expect(readFileSync(logPath, "utf8")).toContain(
        `2130706433:${port} denied blocked or unresolved destination`,
      );
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await new Promise<void>((resolve) => target.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("vm config clamps resources and wires vsock", () => {
    const spec: RunSpec = {
      agentId: "a",
      isolation: "firecracker",
      cmd: ["x"],
      vcpus: 999,
      memMib: 1,
    };
    const cfg = vmConfig(spec, "/root.ext4", "/v.sock", "/workspace.ext4");
    expect(cfg["machine-config"]).toEqual({ vcpu_count: 32, mem_size_mib: 256 });
    expect(cfg.vsock).toEqual({ guest_cid: 3, uds_path: "/v.sock" });
    expect(cfg.drives).toEqual([
      {
        drive_id: "rootfs",
        path_on_host: "/root.ext4",
        is_root_device: true,
        is_read_only: false,
      },
      {
        drive_id: "workspace",
        path_on_host: "/workspace.ext4",
        is_root_device: false,
        is_read_only: false,
      },
    ]);
  });

  test("preflight reports readiness without pretending", () => {
    const root = mkdtempSync(join(tmpdir(), "host-root-"));
    const r = spawnSync("bun", [MAIN, "preflight"], {
      env: { ...process.env, UPBOT_HOST_ROOT: root, UPBOT_FIRECRACKER_BIN: "/nonexistent" },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const pre = JSON.parse(r.stdout.trim());
    expect(pre.root).toBe(root);
    expect(pre.kernelImage).toBeNull();
    expect(pre.rootfs).toBeNull();
    expect(pre.guestHelperCurrent).toBeNull();
    expect(pre.firecrackerReady).toBe(false);
  });

  test("a stale guest helper stamp blocks Firecracker readiness", () => {
    const guestHelperCurrent = matchesGuestHelperStamp("stale", Buffer.from("current helper"));
    expect(guestHelperCurrent).toBe(false);
    expect(
      isFirecrackerReady({
        os: "linux",
        kvm: true,
        firecrackerVersion: "Firecracker v1.12.1",
        kernelImage: "/root/firecracker/vmlinux",
        rootfs: "/root/firecracker/rootfs.ext4",
        mkfsExt4: "/usr/sbin/mkfs.ext4",
        guestHelperCurrent,
      }),
    ).toBe(false);
    expect(
      isFirecrackerReady({
        os: "linux",
        kvm: true,
        firecrackerVersion: "Firecracker v1.12.1",
        kernelImage: "/root/firecracker/vmlinux",
        rootfs: "/root/firecracker/rootfs.ext4",
        mkfsExt4: "/usr/sbin/mkfs.ext4",
        guestHelperCurrent: null,
      }),
    ).toBe(true);
  });

  test("firecracker run fails clearly when prerequisites are missing", () => {
    const root = mkdtempSync(join(tmpdir(), "host-root-"));
    const r = spawnSync("bun", [MAIN, "run"], {
      input: `${JSON.stringify({ agentId: "a", isolation: "firecracker", cmd: ["true"] })}\n`,
      env: { ...process.env, UPBOT_HOST_ROOT: root, UPBOT_FIRECRACKER_BIN: "" },
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/firecracker|missing/);
  });

  test("local run executes the command in the agent workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "host-root-"));
    const r = spawnSync("bun", [MAIN, "run"], {
      input: `${JSON.stringify({
        agentId: "ag1",
        isolation: "none",
        cmd: [
          process.execPath,
          "-e",
          "console.log(process.cwd()); process.stdin.pipe(process.stdout)",
        ],
      })}\nhello`,
      env: { ...process.env, UPBOT_HOST_ROOT: root },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(join(root, "agents", "ag1"));
    expect(r.stdout).toContain("hello");
  });
});
