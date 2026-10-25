import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  Agent,
  AgentPlacement,
  ChatItem,
  RemoteHost,
  Subagent,
  Turn,
} from "@bobagent/protocol";
import { DaemonClient, type DaemonHandle, FAKE_AGENT, readPids, startDaemon, tmp } from "./helpers";

const TOKEN = `remote-test-${crypto.randomUUID()}`;
const FAKE_SSH = join(import.meta.dir, "fixtures/fake-ssh.ts");

describe("remote hosts + subagents e2e", () => {
  let dataDir: string;
  let stateDir: string;
  let sshHome: string;
  let sshLog: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  let host: RemoteHost;
  let boss: Agent;

  async function turn(agentId: string, text: string): Promise<Turn> {
    const { queueId } = (await c.request("chat.send", { agentId, text })) as { queueId: string };
    return (await c.waitForEventWhere(
      "turn.ended",
      (d) => (d as Turn).queueId === queueId,
      30000,
    )) as Turn;
  }
  const items = async (agentId: string) =>
    ((await c.request("chat.history", { agentId })) as { items: ChatItem[] }).items;
  async function lastText(agentId: string): Promise<string> {
    const msgs = (await items(agentId)).filter((i) => i.kind === "agent_message");
    const last = msgs[msgs.length - 1];
    return last && "text" in last ? last.text : "";
  }
  const sshCalls = () =>
    readFileSync(sshLog, "utf8")
      .trim()
      .split("\n")
      .map(
        (l) =>
          JSON.parse(l) as {
            opts: string[];
            target: string;
            remoteCmd: string;
            leakedEnv: string[];
          },
      );

  beforeAll(async () => {
    dataDir = tmp("rh-data-");
    stateDir = tmp("rh-fake-");
    sshHome = tmp("rh-home-");
    sshLog = join(tmp("rh-log-"), "ssh.jsonl");
    daemon = await startDaemon(dataDir, tmp("rh-agents-"), TOKEN, {
      BOBAGENT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      BOBAGENT_SSH_COMMAND: JSON.stringify(["bun", FAKE_SSH]),
      FAKE_ACP_STATE_DIR: stateDir,
      FAKE_SSH_HOME: sshHome,
      FAKE_SSH_LOG: sshLog,
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
    boss = (await c.request("agents.create", {
      name: "Boss",
      provider: "devin",
      instructions: "",
    })) as Agent;
  });

  afterAll(() => {
    c?.close();
    try {
      daemon.proc.kill("SIGKILL");
    } catch {}
    for (const pid of readPids(stateDir)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    rmSync(sshHome, { recursive: true, force: true });
  });

  test("rejects ssh targets that look like options", async () => {
    for (const target of ["-oProxyCommand=sh", "user@-host", "a b", "host;rm"]) {
      await expect(c.request("hosts.create", { name: "x", target })).rejects.toThrow();
    }
  });

  test("create + install uploads the helper and runs preflight", async () => {
    host = (await c.request("hosts.create", {
      name: "vps",
      target: "bob@vps.example.com",
      port: 2222,
    })) as RemoteHost;
    expect(host.root).toBeNull();
    await expect(
      c.request("placements.set", { agentId: boss.id, hostId: host.id, isolation: "none" }),
    ).rejects.toThrow(/not installed/);
    host = (await c.request("hosts.install", { id: host.id })) as RemoteHost;
    expect(existsSync(join(sshHome, ".bobagent/bin/bobagent-host.ts"))).toBe(true);
    expect(host.root).toBe(join(sshHome, ".bobagent"));
    const pre = host.preflight;
    expect(pre?.firecrackerReady).toBe(
      process.platform === "linux" &&
        !!pre?.kvm &&
        !!pre.firecracker?.version &&
        !!pre.kernelImage &&
        !!pre.rootfs &&
        pre.guestHelperCurrent !== false,
    );
    const call = sshCalls().at(-1)!;
    expect(call.target).toBe("bob@vps.example.com");
    expect(call.opts).toContain("BatchMode=yes");
    expect(call.opts.join(" ")).toContain("-p 2222");
  });

  test("firecracker placement is refused when preflight is not ready", async () => {
    if (host.preflight?.firecrackerReady) return;
    await expect(
      c.request("placements.set", { agentId: boss.id, hostId: host.id, isolation: "firecracker" }),
    ).rejects.toThrow(/Firecracker/);
    await expect(
      c.request("placements.set", { agentId: boss.id, hostId: null, isolation: "firecracker" }),
    ).rejects.toThrow(/remote Linux host/);
  });

  test("agent turns run on the host over ssh, bridge included", async () => {
    const p = (await c.request("placements.set", {
      agentId: boss.id,
      hostId: host.id,
      isolation: "none",
    })) as AgentPlacement;
    expect(p.hostId).toBe(host.id);
    expect((await turn(boss.id, "echo:hello-vps")).status).toBe("completed");
    expect(await lastText(boss.id)).toBe("hello-vps");
    expect(existsSync(join(sshHome, ".bobagent/agents", boss.id))).toBe(true);
    const run = sshCalls().find((l) => l.remoteCmd.includes(" run"))!;
    expect(run.opts).toContain("-R");
    for (const l of sshCalls()) expect(l.leakedEnv).toEqual([]);
    expect(readFileSync(sshLog, "utf8")).not.toContain(TOKEN);

    expect((await turn(boss.id, "mcp:list_agents {}")).status).toBe("completed");
    expect(await lastText(boss.id)).toContain('"Boss"');
  }, 30000);

  test("spawn_subagents runs children in parallel and reports one result", async () => {
    let bossTurns = 0;
    const results = c.waitForEventWhere(
      "turn.ended",
      (d) => (d as Turn).agentId === boss.id && ++bossTurns === 2,
      60000,
    );
    const t = await turn(
      boss.id,
      `mcp:spawn_subagents ${JSON.stringify({
        tasks: [
          { task: "echo:alpha-result", name: "a" },
          { task: "echo:beta-result", name: "b" },
          { task: "echo:gamma-result", name: "c" },
        ],
      })}`,
    );
    expect(t.status).toBe("completed");
    expect(await lastText(boss.id)).toContain("launched 3 subagent(s)");
    await results;
    const msgs = (await items(boss.id)).filter((i) => i.kind === "user_message");
    const last = msgs.at(-1) as { text: string };
    expect(last.text).toContain("<subagent_results");
    for (const r of ["alpha-result", "beta-result", "gamma-result"]) expect(last.text).toContain(r);
    const subs = (await c.request("subagents.list", { parentId: boss.id })) as Subagent[];
    expect(subs).toHaveLength(3);
    expect(subs.every((s) => s.status === "done")).toBe(true);
    // non-kept subagents are removed, and they ran on the parent's host
    const agents = (await c.request("agents.list", {})) as Agent[];
    for (const s of subs) {
      expect(agents.some((a) => a.id === s.agentId)).toBe(false);
      expect(existsSync(join(sshHome, ".bobagent/agents", s.agentId))).toBe(true);
    }
    // turns overlapped: children started before the last one finished
    const starts = subs.map((s) => s.createdAt);
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(5000);
  }, 90000);

  test("subagent limits", async () => {
    const tasks = Array.from({ length: 9 }, (_, i) => ({ task: `echo:${i}` }));
    await turn(boss.id, `mcp:spawn_subagents ${JSON.stringify({ tasks })}`);
    expect(await lastText(boss.id)).toMatch(/at most 8/);
  }, 30000);

  test("unreachable host surfaces the ssh error", async () => {
    const bad = (await c.request("hosts.create", {
      name: "down",
      target: "unreachable.example",
    })) as RemoteHost;
    await expect(c.request("hosts.check", { id: bad.id })).rejects.toThrow(/Connection refused/);
    await c.request("hosts.delete", { id: bad.id });
  });
});
