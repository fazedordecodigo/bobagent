import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { blockedHost, type RunSpec, readFirstLine, vmConfig } from "../src/main";

const MAIN = join(import.meta.dir, "../src/main.ts");

describe("bobagent-host", () => {
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
      "::1",
      "[fd00::1]",
      "metadata.google.internal",
    ])
      expect(blockedHost(h)).toBe(true);
    for (const h of ["api.anthropic.com", "8.8.8.8", "172.32.0.1"])
      expect(blockedHost(h)).toBe(false);
  });

  test("vm config clamps resources and wires vsock", () => {
    const spec: RunSpec = {
      agentId: "a",
      isolation: "firecracker",
      cmd: ["x"],
      vcpus: 999,
      memMib: 1,
    };
    const cfg = vmConfig(spec, "/d.ext4", "/v.sock");
    expect(cfg["machine-config"]).toEqual({ vcpu_count: 32, mem_size_mib: 256 });
    expect(cfg.vsock).toEqual({ guest_cid: 3, uds_path: "/v.sock" });
    expect(cfg.drives[0]?.path_on_host).toBe("/d.ext4");
  });

  test("preflight reports readiness without pretending", () => {
    const root = mkdtempSync(join(tmpdir(), "host-root-"));
    const r = spawnSync("bun", [MAIN, "preflight"], {
      env: { ...process.env, BOBAGENT_HOST_ROOT: root, BOBAGENT_FIRECRACKER_BIN: "/nonexistent" },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const pre = JSON.parse(r.stdout.trim());
    expect(pre.root).toBe(root);
    expect(pre.kernelImage).toBeNull();
    expect(pre.rootfs).toBeNull();
    expect(pre.firecrackerReady).toBe(false);
  });

  test("firecracker run fails clearly when prerequisites are missing", () => {
    const root = mkdtempSync(join(tmpdir(), "host-root-"));
    const r = spawnSync("bun", [MAIN, "run"], {
      input: `${JSON.stringify({ agentId: "a", isolation: "firecracker", cmd: ["true"] })}\n`,
      env: { ...process.env, BOBAGENT_HOST_ROOT: root, BOBAGENT_FIRECRACKER_BIN: "" },
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/firecracker|missing/);
  });

  test("local run executes the command in the agent workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "host-root-"));
    const r = spawnSync("bun", [MAIN, "run"], {
      input: `${JSON.stringify({ agentId: "ag1", isolation: "none", cmd: ["sh", "-c", "pwd; cat"] })}\nhello`,
      env: { ...process.env, BOBAGENT_HOST_ROOT: root },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(join(root, "agents", "ag1"));
    expect(r.stdout).toContain("hello");
  });
});
