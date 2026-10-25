import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Agent, ChatItem, Memory, Skill, Turn } from "@upbot/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  readLog,
  readPids,
  startDaemon,
  tmp,
} from "./helpers";

const TOKEN = `p8-test-${crypto.randomUUID()}`;

describe("avatars, memories, skills, agent creation e2e", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let sharedRoot: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  let a: Agent;

  const newAgent = async (name: string) =>
    (await c.request("agents.create", { name, provider: "devin", instructions: "" })) as Agent;

  async function turn(agentId: string, text: string): Promise<string> {
    const { queueId } = (await c.request("chat.send", { agentId, text })) as { queueId: string };
    await c.waitForEventWhere("turn.ended", (d) => (d as Turn).queueId === queueId, 20000);
    const { items } = (await c.request("chat.history", { agentId })) as { items: ChatItem[] };
    const last = items.filter((i) => i.kind === "agent_message").pop();
    return last && "text" in last ? last.text : "";
  }

  const lastPrompt = () => {
    const prompts = readLog(stateDir).filter((l) => l.method === "session/prompt");
    return JSON.stringify(prompts[prompts.length - 1]!.params);
  };

  beforeAll(async () => {
    dataDir = tmp("p8-data-");
    agentsRoot = tmp("p8-agents-");
    stateDir = tmp("p8-fake-");
    sharedRoot = tmp("p8-shared-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      UPBOT_SHARED_ROOT: sharedRoot,
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
    a = await newAgent("Mem");
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
    for (const d of [dataDir, agentsRoot, stateDir, sharedRoot])
      rmSync(d, { recursive: true, force: true });
  });

  test("draft turns a description into name, instructions and avatar", async () => {
    const d = (await c.request("agents.draft", {
      prompt: "an agent named Sentinel that audits our code for security issues",
    })) as { name: string; instructions: string; avatar: { emoji: string; color: string } };
    expect(d.name).toBe("Sentinel");
    expect(d.instructions).toContain("audits our code");
    expect(d.avatar.emoji).toBe("🛡️");
    const plain = (await c.request("agents.draft", { prompt: "write release notes" })) as {
      name: string;
    };
    expect(plain.name).toBe("Write Release");
  });

  test("avatar is stored on create and update", async () => {
    const x = (await c.request("agents.create", {
      name: "Av",
      provider: "devin",
      avatar: { emoji: "🦊", color: "#ff8800" },
    })) as Agent;
    expect(x.avatar).toEqual({ emoji: "🦊", color: "#ff8800" });
    const y = (await c.request("agents.update", { id: x.id, avatar: null })) as Agent;
    expect(y.avatar).toBeNull();
    await expect(
      c.request("agents.update", { id: x.id, avatar: { emoji: "x", color: "red" } }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  test("memories via RPC are injected into the first prompt of a session", async () => {
    const m = (await c.request("memories.add", {
      agentId: a.id,
      text: "User prefers tabs",
    })) as Memory;
    await turn(a.id, "echo:hi");
    expect(lastPrompt()).toContain("agent_memories");
    expect(lastPrompt()).toContain(`[${m.id}] User prefers tabs`);
    await turn(a.id, "echo:again");
    expect(lastPrompt()).not.toContain("agent_memories");
  });

  test("agents remember and forget through the bridge", async () => {
    const out = await turn(a.id, 'mcp:remember {"text":"Deploys happen on Fridays"}');
    expect(out).toMatch(/^tool-ok:remembered \[/);
    const list = (await c.request("memories.list", { agentId: a.id })) as Memory[];
    const fri = list.find((m) => m.text === "Deploys happen on Fridays")!;
    expect(fri).toBeTruthy();
    expect(await turn(a.id, `mcp:forget {"id":"${fri.id}"}`)).toContain("tool-ok:forgot");
    expect(await turn(a.id, 'mcp:forget {"id":"nope"}')).toContain("tool-error:");
    const after = (await c.request("memories.list", { agentId: a.id })) as Memory[];
    expect(after.map((m) => m.text)).toEqual(["User prefers tabs"]);
  });

  test("skills library: create, read, revise with history, prompt index", async () => {
    const body = "1. Run the tests\\n2. Ship it";
    expect(
      await turn(
        a.id,
        `mcp:create_skill {"name":"Release Checklist","description":"Use before releases","body":"${body}"}`,
      ),
    ).toBe("tool-ok:created skill release-checklist");
    expect(
      await turn(
        a.id,
        'mcp:create_skill {"name":"release-checklist","description":"x","body":"y"}',
      ),
    ).toContain("tool-error:");
    expect(await turn(a.id, 'mcp:read_skill {"name":"release-checklist"}')).toContain(
      "Run the tests",
    );
    expect(
      await turn(a.id, 'mcp:revise_skill {"name":"release-checklist","body":"1. Tag first"}'),
    ).toBe("tool-ok:revised skill release-checklist");
    const s = (await c.request("skills.get", { name: "release-checklist" })) as Skill;
    expect(s).toMatchObject({
      description: "Use before releases",
      author: "Mem",
      body: "1. Tag first\n",
    });
    expect(readdirSync(join(sharedRoot, "Skills", "release-checklist", ".history")).length).toBe(1);
    await c.request("skills.save", { name: "triage", description: "Bug triage", body: "Label it" });
    expect(((await c.request("skills.list", {})) as Skill[]).map((x) => x.name)).toEqual([
      "release-checklist",
      "triage",
    ]);
    const fresh = await newAgent("Fresh");
    await turn(fresh.id, "echo:x");
    expect(lastPrompt()).toContain("skills_library");
    expect(lastPrompt()).toContain("release-checklist: Use before releases");
    await c.request("skills.delete", { name: "triage" });
    expect(existsSync(join(sharedRoot, "Skills", "triage"))).toBe(false);
  });

  test("agents can create agents", async () => {
    const created = c.waitForEventWhere(
      "agent.created",
      (d) => (d as Agent).name === "Scribe",
      20000,
    );
    const out = await turn(
      a.id,
      'mcp:create_agent {"name":"Scribe","instructions":"Write docs","emoji":"✍️"}',
    );
    expect(out).toContain("tool-ok:created agent Scribe");
    const ag = (await created) as Agent;
    expect(ag.provider).toBe("devin");
    expect(ag.avatar?.emoji).toBe("✍️");
    expect(
      await turn(a.id, 'mcp:create_agent {"name":"X","instructions":"y","provider":"nope"}'),
    ).toContain("tool-error:unknown provider");
  });
});
