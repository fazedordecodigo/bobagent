import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BOT_NAME } from "../src/persona";
import {
  DAEMON,
  DaemonClient,
  type DaemonHandle,
  ROOT,
  startDaemon,
  stopDaemon,
  tmp,
  waitForExit,
} from "./helpers";

const TOKEN = `test-token-${crypto.randomUUID()}`;

describe("daemon e2e", () => {
  let dataDir: string;
  let agentsRoot: string;
  let daemon: DaemonHandle;
  let createdAgentId = "";

  beforeAll(async () => {
    dataDir = tmp("upbotd-data-");
    agentsRoot = tmp("upbotd-agents-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN);
  });

  afterAll(async () => {
    await stopDaemon(daemon, undefined);
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(agentsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("health: token -> 200, no token -> 401, bad origin -> 403", async () => {
    const ok = await fetch(`http://127.0.0.1:${daemon.port}/health`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");

    const noToken = await fetch(`http://127.0.0.1:${daemon.port}/health`);
    expect(noToken.status).toBe(401);

    const badOrigin = await fetch(`http://127.0.0.1:${daemon.port}/health`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: "https://evil.example" },
    });
    expect(badOrigin.status).toBe(403);
  });

  test("ws: bad/missing token rejected, valid token connects", async () => {
    await DaemonClient.connectExpectFail(daemon.port, "");
    await DaemonClient.connectExpectFail(daemon.port, "wrong-token");
    const c = await DaemonClient.connect(daemon.port, TOKEN);
    c.close();
  });

  test("agent lifecycle: create, list, broadcast, update, errors, delete", async () => {
    const c1 = await DaemonClient.connect(daemon.port, TOKEN);
    const c2 = await DaemonClient.connect(daemon.port, TOKEN);

    // create
    const created = await c1.request("agents.create", {
      name: "Test Agent",
      provider: "devin",
      instructions: "do stuff",
    });
    expect(created.id).toBeTruthy();
    expect(created.provider).toBe("devin");
    createdAgentId = created.id;
    expect(existsSync(created.workspacePath)).toBe(true);
    expect(created.workspacePath.startsWith(agentsRoot)).toBe(true);

    // second socket receives agent.created
    const ev = await c2.waitForEvent("agent.created");
    expect(ev.id).toBe(created.id);

    // list contains it
    const list = await c1.request("agents.list", {});
    expect(list.some((a) => a.id === created.id)).toBe(true);

    // update name -> agent.updated
    const updated = await c1.request("agents.update", {
      id: created.id,
      name: "Renamed",
    });
    expect(updated.name).toBe("Renamed");
    const updEv = await c2.waitForEvent("agent.updated");
    expect(updEv.id).toBe(created.id);
    expect(updEv.name).toBe("Renamed");

    // invalid params -> bad_request
    await expect(
      c1.request("agents.create", { name: "", provider: "devin" }),
    ).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(
      c1.request("agents.create", { name: "X", provider: "not-a-provider" }),
    ).rejects.toMatchObject({ code: "bad_request" });

    // unknown ids -> not_found
    await expect(
      c1.request("agents.update", { id: "nonexistent", name: "Y" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(c1.request("agents.delete", { id: "nonexistent" })).rejects.toMatchObject({
      code: "not_found",
    });

    // unknown method -> bad_request
    await expect(c1.request("bogus.method", {})).rejects.toMatchObject({ code: "bad_request" });

    // delete -> agent.deleted, excluded from list, workspace dir kept
    const del = await c1.request("agents.delete", { id: created.id });
    expect(del.ok).toBe(true);
    const delEv = await c2.waitForEvent("agent.deleted");
    expect(delEv.id).toBe(created.id);
    const list2 = await c1.request("agents.list", {});
    expect(list2.some((a) => a.id === created.id)).toBe(false);
    expect(existsSync(created.workspacePath)).toBe(true);

    c1.close();
    c2.close();
  });

  test("restart persists agents and does not re-apply migrations", async () => {
    const c = await DaemonClient.connect(daemon.port, TOKEN);
    const keep = await c.request("agents.create", {
      name: "Survivor",
      provider: "opencode",
    });
    c.close();

    daemon.proc.kill("SIGTERM");
    await waitForExit(daemon.proc, 5000);

    const daemon2 = await startDaemon(dataDir, agentsRoot, TOKEN);
    try {
      const c2 = await DaemonClient.connect(daemon2.port, TOKEN);
      const list = await c2.request("agents.list", {});
      expect(list.some((a) => a.id === keep.id)).toBe(true);
      expect(list.some((a) => a.id === createdAgentId)).toBe(false);
      c2.close();
    } finally {
      daemon2.proc.kill("SIGKILL");
      await daemon2.proc.exited;
    }

    const db = new Database(join(dataDir, "upbot.db"), { readonly: true });
    const rows = db.query("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number };
    expect(rows.n).toBe(21);
    db.close();
  });

  test("daemon without a stdin token exits non-zero", async () => {
    const d = tmp("upbotd-notok-");
    const proc = Bun.spawn(["bun", DAEMON, "--data-dir", d, "--agents-root", tmp("oa-nt-")], {
      env: { ...process.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: ROOT,
    });
    (proc.stdin as { end: () => void }).end(); // EOF before any token line
    const code = await waitForExit(proc, 8000);
    expect(code).not.toBe(0);
  });

  test("closing stdin makes the daemon exit", async () => {
    const d = await startDaemon(tmp("upbotd-data2-"), tmp("upbotd-agents2-"), TOKEN);
    (d.proc.stdin as { end: () => void }).end();
    await waitForExit(d.proc, 5000);
  });

  test("logs auth rejections and the shutdown reason to stderr", async () => {
    const d = await startDaemon(
      mkdtempSync(join(tmpdir(), "upbotd-data3-")),
      mkdtempSync(join(tmpdir(), "upbotd-agents3-")),
      TOKEN,
      {},
      true,
    );
    const stderrText = d.stderrText;
    if (!stderrText) throw new Error("stderr capture was not enabled");

    const rejected = await fetch(`http://127.0.0.1:${d.port}/health`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(rejected.status).toBe(401);

    // stdin EOF (not SIGTERM): Windows can't deliver signals to the child handler
    (d.proc.stdin as { end: () => void }).end();
    await waitForExit(d.proc, 5000);

    const stderr = await stderrText;
    expect(stderr).toContain("auth.rejected");
    expect(stderr).toContain("/health");
    expect(stderr).toContain("shutting down");
    expect(stderr).toContain("stdin EOF");
    expect(stderr).not.toContain("wrong-token");
  });

  test("fresh install seeds the default UpBot bot once, not again after delete + restart", async () => {
    const freshDataDir = tmp("upbotd-default-bot-data-");
    const freshAgentsRoot = tmp("upbotd-default-bot-agents-");
    let freshDaemon: DaemonHandle | undefined;
    let freshClient: DaemonClient | undefined;

    try {
      freshDaemon = await startDaemon(freshDataDir, freshAgentsRoot, TOKEN, {
        UPBOT_DEFAULT_BOT: "on",
      });
      freshClient = await DaemonClient.connect(freshDaemon.port, TOKEN);
      const agents = await freshClient.request("agents.list", {});
      expect(agents).toHaveLength(1);
      const defaultBot = agents[0];
      if (!defaultBot) throw new Error("expected default bot");
      expect(defaultBot.name).toBe(DEFAULT_BOT_NAME);
      expect(defaultBot.provider).toBe("claude");
      expect(defaultBot.workspacePath.startsWith(freshAgentsRoot)).toBe(true);

      await freshClient.request("agents.delete", { id: defaultBot.id });
      await stopDaemon(freshDaemon, freshClient, undefined, "SIGTERM");
      freshDaemon = undefined;
      freshClient = undefined;

      freshDaemon = await startDaemon(freshDataDir, freshAgentsRoot, TOKEN, {
        UPBOT_DEFAULT_BOT: "on",
      });
      freshClient = await DaemonClient.connect(freshDaemon.port, TOKEN);
      expect(await freshClient.request("agents.list", {})).toEqual([]);
    } finally {
      try {
        if (freshDaemon) await stopDaemon(freshDaemon, freshClient);
      } finally {
        rmSync(freshDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        rmSync(freshAgentsRoot, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      }
    }
  }, 30000);
});
