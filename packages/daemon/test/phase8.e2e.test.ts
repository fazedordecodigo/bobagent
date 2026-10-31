import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@boto/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  lastAgentText,
  readLog,
  sendAndWait,
  startDaemon,
  stopDaemon,
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
    c.request("agents.create", { name, provider: "devin", instructions: "" });

  const turn = async (agentId: string, text: string) => {
    await sendAndWait(c, agentId, text, 20000);
    return lastAgentText(c, agentId);
  };

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
      BOTO_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      BOTO_SHARED_ROOT: sharedRoot,
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
    a = await newAgent("Mem");
  });

  afterAll(async () => {
    await stopDaemon(daemon, c, stateDir);
    for (const d of [dataDir, agentsRoot, stateDir, sharedRoot])
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("draft turns a description into name, instructions and avatar", async () => {
    const d = await c.request("agents.draft", {
      prompt: "an agent named Sentinel that audits our code for security issues",
    });
    expect(d.name).toBe("Sentinel");
    expect(d.instructions).toContain("audits our code");
    expect(d.avatar).toMatchObject({ emoji: "🛡️" });
    const plain = await c.request("agents.draft", { prompt: "write release notes" });
    expect(plain.name).toBe("Write Release");
  });

  test("avatar is stored on create and update", async () => {
    const x = await c.request("agents.create", {
      name: "Av",
      provider: "devin",
      avatar: { emoji: "🦊", color: "#ff8800" },
    });
    expect(x.avatar).toEqual({ emoji: "🦊", color: "#ff8800" });
    const y = await c.request("agents.update", { id: x.id, avatar: null });
    expect(y.avatar).toBeNull();
    const icon = await c.request("agents.update", {
      id: x.id,
      avatar: { icon: "sheet" },
    });
    expect(icon.avatar).toEqual({ icon: "sheet" });
    await expect(
      c.request("agents.update", { id: x.id, avatar: { emoji: "x", color: "red" } }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      c.request("agents.update", { id: x.id, avatar: { icon: "calendar" } }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  test("soft-deleted agents can be restored and icon avatars survive list round-trips", async () => {
    const deleted = await newAgent("Restaurar");
    await c.request("agents.update", { id: deleted.id, avatar: { icon: "chart" } });
    await c.request("agents.delete", { id: deleted.id });
    expect((await c.request("agents.list", {})).some((item) => item.id === deleted.id)).toBe(false);
    const created = c.waitForEventWhere("agent.created", (item) => item.id === deleted.id);
    const restored = await c.request("agents.restore", { id: deleted.id });
    expect(restored.avatar).toEqual({ icon: "chart" });
    await created;
    expect((await c.request("agents.list", {})).some((item) => item.id === deleted.id)).toBe(true);
    await expect(c.request("agents.restore", { id: deleted.id })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  test("memories enforce the configuration screen character limit", async () => {
    const accepted = await c.request("memories.add", {
      agentId: a.id,
      text: "x".repeat(2_000),
    });
    expect(accepted.text).toHaveLength(2_000);
    await c.request("memories.delete", { id: accepted.id });
    await expect(
      c.request("memories.add", { agentId: a.id, text: "x".repeat(2_001) }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  test("memories.update rewrites the text, emits memories.changed and rejects missing ids", async () => {
    const m = await c.request("memories.add", { agentId: a.id, text: "Old note" });
    const changed = c.waitForEventWhere("memories.changed", (d) => d.agentId === a.id);
    const updated = await c.request("memories.update", {
      id: m.id,
      text: "  New note  ",
    });
    await changed;
    expect(updated).toMatchObject({ id: m.id, agentId: a.id, text: "New note" });
    expect(updated.updatedAt).toBeGreaterThanOrEqual(m.updatedAt);
    const list = await c.request("memories.list", { agentId: a.id });
    expect(list.find((x) => x.id === m.id)?.text).toBe("New note");
    await expect(
      c.request("memories.update", { id: m.id, text: "x".repeat(2_001) }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(c.request("memories.update", { id: "missing", text: "x" })).rejects.toMatchObject({
      code: "not_found",
    });
    await c.request("memories.delete", { id: m.id });
    await expect(
      c.request("memories.update", { id: m.id, text: "after delete" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await c.request("memories.list", { agentId: a.id })).not.toContainEqual(
      expect.objectContaining({ id: m.id }),
    );
  });

  test("memories.update enforces edit limits without changing stored memory on invalid edits", async () => {
    const memory = await c.request("memories.add", {
      agentId: a.id,
      text: "Original memory",
    });
    for (const text of ["", "   ", "x".repeat(2_001)]) {
      await expect(c.request("memories.update", { id: memory.id, text })).rejects.toMatchObject({
        code: "bad_request",
      });
    }
    expect(await c.request("memories.list", { agentId: a.id })).toContainEqual(memory);
    const atLimit = await c.request("memories.update", {
      id: memory.id,
      text: "x".repeat(2_000),
    });
    expect(atLimit).toMatchObject({
      id: memory.id,
      agentId: memory.agentId,
      createdAt: memory.createdAt,
      text: "x".repeat(2_000),
    });
    expect(atLimit.updatedAt).toBeGreaterThanOrEqual(memory.updatedAt);
    expect(await c.request("memories.list", { agentId: a.id })).toContainEqual(atLimit);
    await c.request("memories.delete", { id: memory.id });
  });

  test("memories via RPC are injected into the first prompt of a session", async () => {
    const m = await c.request("memories.add", {
      agentId: a.id,
      text: "User prefers tabs",
    });
    await turn(a.id, "echo:hi");
    expect(lastPrompt()).toContain("agent_memories");
    expect(lastPrompt()).toContain(`[${m.id}] User prefers tabs`);
    await turn(a.id, "echo:again");
    expect(lastPrompt()).not.toContain("agent_memories");
  });

  test("agents remember and forget through the bridge", async () => {
    const out = await turn(a.id, 'mcp:remember {"text":"Deploys happen on Fridays"}');
    expect(out).toMatch(/^tool-ok:remembered \[/);
    const list = await c.request("memories.list", { agentId: a.id });
    const fri = list.find((m) => m.text === "Deploys happen on Fridays")!;
    expect(fri).toBeTruthy();
    expect(await turn(a.id, `mcp:forget {"id":"${fri.id}"}`)).toContain("tool-ok:forgot");
    expect(await turn(a.id, 'mcp:forget {"id":"nope"}')).toContain("tool-error:");
    const after = await c.request("memories.list", { agentId: a.id });
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
    const s = await c.request("skills.get", { name: "release-checklist" });
    expect(s).toMatchObject({
      description: "Use before releases",
      author: "Mem",
      body: "1. Tag first\n",
    });
    expect(readdirSync(join(sharedRoot, "Skills", "release-checklist", ".history")).length).toBe(1);
    await c.request("skills.save", { name: "triage", description: "Bug triage", body: "Label it" });
    expect((await c.request("skills.list", {})).map((x) => x.name)).toEqual([
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
    const created = c.waitForEventWhere("agent.created", (d) => d.name === "Scribe", 20000);
    const out = await turn(
      a.id,
      'mcp:create_agent {"name":"Scribe","instructions":"Write docs","emoji":"✍️"}',
    );
    expect(out).toContain("tool-ok:created agent Scribe");
    const ag = await created;
    expect(ag.provider).toBe("devin");
    expect(ag.avatar && "emoji" in ag.avatar ? ag.avatar.emoji : undefined).toBe("✍️");
    expect(
      await turn(a.id, 'mcp:create_agent {"name":"X","instructions":"y","provider":"nope"}'),
    ).toContain("tool-error:unknown provider");
  });
});
