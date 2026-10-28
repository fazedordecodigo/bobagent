import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, ChatItem, Routine, RoutineRun, Turn } from "@upbot/protocol";
import { parseSchedule } from "../src/routines";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  readLog,
  readPids,
  startDaemon,
  tmp,
} from "./helpers";

const TOKEN = `p9-test-${crypto.randomUUID()}`;

describe("schedule parser", () => {
  test("intervals, daily and weekly", () => {
    const base = new Date(2026, 0, 5, 10, 30).getTime(); // Monday 10:30 local
    expect(parseSchedule("every 15m")(base) - base).toBe(15 * 60_000);
    expect(parseSchedule("every 2h")(base) - base).toBe(2 * 3_600_000);
    expect(new Date(parseSchedule("daily 09:00")(base)).getDate()).toBe(6);
    expect(new Date(parseSchedule("daily 11:00")(base)).getHours()).toBe(11);
    const w = new Date(parseSchedule("weekly fri 08:15")(base));
    expect([w.getDay(), w.getHours(), w.getMinutes()]).toEqual([5, 8, 15]);
    expect(() => parseSchedule("every 0m")).toThrow();
    expect(() => parseSchedule("daily 25:00")).toThrow();
    expect(() => parseSchedule("sometimes")).toThrow();
  });
});

describe("routines + attachments e2e", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  let a: Agent;

  const lastPrompt = () => {
    const prompts = readLog(stateDir).filter((l) => l.method === "session/prompt");
    return JSON.stringify(prompts[prompts.length - 1]!.params);
  };
  const userItem = async (queueId: string) => {
    const t = (await c.waitForEventWhere(
      "turn.ended",
      (d) => (d as Turn).queueId === queueId,
      20000,
    )) as Turn;
    const { items } = (await c.request("chat.history", { agentId: a.id })) as { items: ChatItem[] };
    return items.find((i) => i.turnId === t.id && i.kind === "user_message") as Extract<
      ChatItem,
      { kind: "user_message" }
    >;
  };

  beforeAll(async () => {
    dataDir = tmp("p9-data-");
    agentsRoot = tmp("p9-agents-");
    stateDir = tmp("p9-fake-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      UPBOT_ROUTINE_TICK_MS: "150",
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
    a = (await c.request("agents.create", {
      name: "R",
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
    for (const d of [dataDir, agentsRoot, stateDir]) rmSync(d, { recursive: true, force: true });
  });

  test("create validates the schedule", async () => {
    await expect(
      c.request("routines.create", { agentId: a.id, name: "x", prompt: "y", schedule: "whenever" }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  test("manual run sends the routine prompt and records the run", async () => {
    const r = (await c.request("routines.create", {
      agentId: a.id,
      name: "Standup",
      prompt: "echo:standup",
      schedule: "daily 09:00",
    })) as Routine;
    expect(r.nextRunAt).toBeGreaterThan(Date.now());
    expect(r.webhook).toBe(false);
    const run = (await c.request("routines.run", { id: r.id })) as RoutineRun;
    expect(run.trigger).toBe("manual");
    const u = await userItem(run.queueId!);
    expect(u.text).toBe("echo:standup");
    expect(u.routine).toEqual({ id: r.id, name: "Standup", trigger: "manual" });
    expect(lastPrompt()).toContain('<routine name=\\"Standup\\" trigger=\\"manual\\">');
    const runs = (await c.request("routines.runs", { id: r.id })) as RoutineRun[];
    expect(runs.length).toBe(1);
  });

  test("scheduler fires due routines and computes the next run", async () => {
    const r = (await c.request("routines.create", {
      agentId: a.id,
      name: "Tick",
      prompt: "echo:tick",
      schedule: "every 5m",
    })) as Routine;
    const db = new Database(join(dataDir, "upbot.db"));
    db.query("UPDATE routines SET next_run_at = 1 WHERE id = ?").run(r.id);
    db.close();
    const ev = (await c.waitForEventWhere(
      "routine.updated",
      (d) => (d as Routine).id === r.id && (d as Routine).lastRunAt !== null,
      10000,
    )) as Routine;
    expect(ev.nextRunAt! - Date.now()).toBeGreaterThan(4 * 60_000);
    const [run] = (await c.request("routines.runs", { id: r.id })) as RoutineRun[];
    expect(run!.trigger).toBe("schedule");
    expect((await userItem(run!.queueId!)).routine?.trigger).toBe("schedule");
  });

  test("webhook trigger requires its token and passes the payload", async () => {
    const r = (await c.request("routines.create", {
      agentId: a.id,
      name: "Hook",
      prompt: "echo:hooked",
      webhook: true,
    })) as Routine;
    expect(r.webhookUrl).toBe(`http://127.0.0.1:${daemon.port}/hooks/${r.id}`);
    expect(r.nextRunAt).toBeNull();
    const post = (headers: Record<string, string>) =>
      fetch(r.webhookUrl!, { method: "POST", headers, body: '{"event":"push"}' });
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: "Bearer wrong" })).status).toBe(401);
    expect(
      (await post({ authorization: `Bearer ${r.webhookToken}`, origin: "https://evil.example" }))
        .status,
    ).toBe(403);
    const res = await post({ authorization: `Bearer ${r.webhookToken}` });
    expect(res.status).toBe(202);
    const run = (await res.json()) as RoutineRun;
    expect((await userItem(run.queueId!)).routine?.trigger).toBe("webhook");
    expect(lastPrompt()).toContain("webhook_payload");
    expect(lastPrompt()).toContain('\\"event\\":\\"push\\"');
    await c.request("routines.update", { id: r.id, enabled: false });
    expect((await post({ authorization: `Bearer ${r.webhookToken}` })).status).toBe(401);
    await c.request("routines.delete", { id: r.id });
    expect(
      ((await c.request("routines.list", { agentId: a.id })) as Routine[]).map((x) => x.name),
    ).toEqual(["Standup", "Tick"]);
  });

  test("attachments are saved in the workspace, zips extracted, paths given to the agent", async () => {
    const work = tmp("p9-zip-");
    writeFileSync(join(work, "notes.txt"), "zipped content");
    const zipCommand =
      process.platform === "win32"
        ? ["tar", "-a", "-cf", "bundle.zip", "notes.txt"]
        : ["zip", "-q", "bundle.zip", "notes.txt"];
    expect(Bun.spawnSync(zipCommand, { cwd: work }).exitCode).toBe(0);
    const zip = readFileSync(join(work, "bundle.zip")).toString("base64");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const { queueId } = (await c.request("chat.send", {
      agentId: a.id,
      text: "echo:look",
      attachments: [
        { name: "shot.png", mime: "image/png", dataBase64: png },
        { name: "bundle.zip", mime: "application/zip", dataBase64: zip },
        {
          name: "../../escape.txt",
          mime: "text/plain",
          dataBase64: Buffer.from("x").toString("base64"),
        },
      ],
    })) as { queueId: string };
    const u = await userItem(queueId);
    expect(u.text).toBe("echo:look");
    const [img, z, esc] = u.attachments!;
    expect(img).toMatchObject({ name: "shot.png", mime: "image/png", size: 4 });
    expect(img!.path.startsWith(join(a.workspacePath, "attachments"))).toBe(true);
    expect(existsSync(img!.path)).toBe(true);
    expect(readFileSync(join(z!.extractedTo!, "notes.txt"), "utf8")).toBe("zipped content");
    expect(esc!.name).toBe("escape.txt");
    expect(esc!.path.startsWith(join(a.workspacePath, "attachments"))).toBe(true);
    const p = lastPrompt();
    expect(p).toContain("<attachments>");
    expect(p).toContain("shot.png (image, image/png, 4 bytes)");
    expect(p).toContain("extracted to");
    rmSync(work, { recursive: true, force: true });
  });
});
