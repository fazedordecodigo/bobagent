import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { type Agent, type HostPreflight, RemoteHost } from "@upbot/protocol";
import { DaemonClient, type DaemonHandle, startDaemon, tmp } from "./helpers";

const FAKE_SSH = join(import.meta.dir, "fixtures/fake-preflight-ssh.ts");
const TOKEN = `host-preflight-${crypto.randomUUID()}`;

describe("host preflight RPC validation", () => {
  let root: string;
  let daemon: DaemonHandle | undefined;
  let c: DaemonClient | undefined;
  let preflight: HostPreflight;

  beforeEach(() => {
    root = tmp("host-preflight-");
    preflight = {
      root: join(root, "remote"),
      os: "linux",
      arch: "x64",
      kernelRelease: "test-kernel",
      bun: "test-bun",
      kvm: false,
      firecracker: null,
      kernelImage: null,
      rootfs: null,
      mkfsExt4: null,
      guestHelperCurrent: null,
      providers: { claude: null },
      firecrackerReady: false,
      futureField: "retained",
    };
    writeFileSync(join(root, "output"), `${JSON.stringify(preflight)}\n`);
  });

  afterEach(async () => {
    c?.close();
    if (daemon) {
      daemon.proc.kill("SIGKILL");
      await daemon.proc.exited;
    }
    daemon = undefined;
    c = undefined;
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function connect(env: Record<string, string> = {}) {
    daemon = await startDaemon(join(root, "data"), join(root, "agents"), TOKEN, {
      UPBOT_SSH_COMMAND: JSON.stringify([process.execPath, FAKE_SSH]),
      FAKE_PREFLIGHT_OUTPUT: join(root, "output"),
      FAKE_PREFLIGHT_SSH_LOG: join(root, "ssh.jsonl"),
      ...env,
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
    return c;
  }

  function stored(id: string) {
    const db = new Database(join(root, "data/upbot.db"), { readonly: true });
    try {
      return db.query("SELECT root, preflight_json FROM hosts WHERE id = ?").get(id);
    } finally {
      db.close();
    }
  }

  test("rejects invalid SSH preflight output without persisting or broadcasting it", async () => {
    const client = await connect();
    const host = RemoteHost.parse(
      await client.request("hosts.create", { name: "invalid", target: "fixture.invalid" }),
    );
    const changes = client.events.filter((e) => e.event === "hosts.changed").length;
    for (const output of [
      JSON.stringify({ root: preflight.root, firecrackerReady: true }),
      JSON.stringify({ ...preflight, root: 42 }),
      JSON.stringify({ ...preflight, firecrackerReady: "true" }),
      JSON.stringify({ ...preflight, providers: { claude: 42 } }),
      "not-json",
      "null",
    ]) {
      writeFileSync(join(root, "output"), `${output}\n`);
      await expect(client.request("hosts.check", { id: host.id })).rejects.toMatchObject({
        code: "bad_request",
        message: expect.stringContaining("unexpected preflight output"),
      });
      expect(await client.request("hosts.list")).toEqual([host]);
      expect(stored(host.id)).toEqual({ root: null, preflight_json: null });
      expect(client.events.filter((e) => e.event === "hosts.changed")).toHaveLength(changes);
    }
  });

  test("install persists valid preflight and failed rechecks retain the last valid state", async () => {
    const client = await connect();
    const host = RemoteHost.parse(
      await client.request("hosts.create", { name: "valid", target: "fixture.invalid" }),
    );
    const installed = RemoteHost.parse(await client.request("hosts.install", { id: host.id }));
    expect(installed).toEqual({ ...host, root: preflight.root, preflight });
    expect(stored(host.id)).toEqual({
      root: preflight.root,
      preflight_json: JSON.stringify(preflight),
    });
    const calls = readFileSync(join(root, "ssh.jsonl"), "utf8").trim().split("\n");
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(JSON.parse(call)).toContain(host.target);
    const changes = client.events.filter((e) => e.event === "hosts.changed").length;
    writeFileSync(
      join(root, "output"),
      JSON.stringify({ root: "untrusted", firecrackerReady: true }),
    );
    await expect(client.request("hosts.check", { id: host.id })).rejects.toThrow(
      /unexpected preflight output/,
    );
    expect(await client.request("hosts.list")).toEqual([installed]);
    expect(stored(host.id)).toEqual({
      root: preflight.root,
      preflight_json: JSON.stringify(preflight),
    });
    expect(client.events.filter((e) => e.event === "hosts.changed")).toHaveLength(changes);
  });

  test("invalid cached preflight is null over RPC and cannot authorize Firecracker placement", async () => {
    const client = await connect();
    const host = RemoteHost.parse(
      await client.request("hosts.create", { name: "cached", target: "fixture.invalid" }),
    );
    const agent = (await client.request("agents.create", {
      name: "bot",
      provider: "devin",
    })) as Agent;
    for (const cached of [
      JSON.stringify({ root: preflight.root, firecrackerReady: true }),
      "not-json",
    ]) {
      const db = new Database(join(root, "data/upbot.db"));
      try {
        db.query("UPDATE hosts SET root = ?, preflight_json = ? WHERE id = ?").run(
          preflight.root,
          cached,
          host.id,
        );
      } finally {
        db.close();
      }
      expect(await client.request("hosts.list")).toEqual([{ ...host, root: preflight.root }]);
      await expect(
        client.request("placements.set", {
          agentId: agent.id,
          hostId: host.id,
          isolation: "firecracker",
        }),
      ).rejects.toThrow(/not ready for Firecracker/);
    }
  });

  test.each(["not-json", '["ssh",42]', "[]", '{"command":"ssh"}'])(
    "invalid UPBOT_SSH_COMMAND %s falls back to ssh on PATH through RPC",
    async (override) => {
      const compiled = Bun.spawnSync([
        process.execPath,
        "build",
        FAKE_SSH,
        "--compile",
        "--outfile",
        join(root, process.platform === "win32" ? "ssh.exe" : "ssh"),
      ]);
      expect(compiled.exitCode).toBe(0);
      const shell = join(root, "login-shell");
      if (process.platform !== "win32") {
        writeFileSync(shell, '#!/bin/sh\nprintf "__OA_PATH__%s__OA_PATH__" "$PATH"\n', {
          mode: 0o700,
        });
      }
      const pathKey =
        Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
      const client = await connect({
        UPBOT_SSH_COMMAND: override,
        [pathKey]: `${root}${delimiter}${process.env[pathKey] ?? ""}`,
        ...(process.platform === "win32" ? {} : { SHELL: shell }),
      });
      const host = RemoteHost.parse(
        await client.request("hosts.create", { name: "fallback", target: "fixture.invalid" }),
      );
      const checked = RemoteHost.parse(await client.request("hosts.check", { id: host.id }));
      expect(checked.preflight).toEqual(preflight);
      expect(stored(host.id)).toEqual({
        root: preflight.root,
        preflight_json: JSON.stringify(preflight),
      });
      const calls = readFileSync(join(root, "ssh.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe("-T");
      expect(calls[0].slice(-2, -1)).toEqual([host.target]);
    },
  );
});
