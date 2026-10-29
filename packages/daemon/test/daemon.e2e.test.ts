import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@upbot/protocol";
import { DAEMON, DaemonClient, type DaemonHandle, ROOT, startDaemon, waitForExit } from "./helpers";

const TOKEN = `test-token-${crypto.randomUUID()}`;

describe("daemon e2e", () => {
  let dataDir: string;
  let agentsRoot: string;
  let daemon: DaemonHandle;
  let createdAgentId = "";

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "upbotd-data-"));
    agentsRoot = mkdtempSync(join(tmpdir(), "upbotd-agents-"));
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN);
  });

  afterAll(async () => {
    try {
      daemon.proc.kill("SIGKILL");
    } catch {}
    await daemon.proc.exited;
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
    const created = (await c1.request("agents.create", {
      name: "Test Agent",
      provider: "devin",
      instructions: "do stuff",
    })) as Agent;
    expect(created.id).toBeTruthy();
    expect(created.provider).toBe("devin");
    createdAgentId = created.id;
    expect(existsSync(created.workspacePath)).toBe(true);
    expect(created.workspacePath.startsWith(agentsRoot)).toBe(true);

    // second socket receives agent.created
    const ev = (await c2.waitForEvent("agent.created")) as Agent;
    expect(ev.id).toBe(created.id);

    // list contains it
    const list = (await c1.request("agents.list", {})) as Agent[];
    expect(list.some((a) => a.id === created.id)).toBe(true);

    // update name -> agent.updated
    const updated = (await c1.request("agents.update", {
      id: created.id,
      name: "Renamed",
    })) as Agent;
    expect(updated.name).toBe("Renamed");
    const updEv = (await c2.waitForEvent("agent.updated")) as Agent;
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
    const del = (await c1.request("agents.delete", { id: created.id })) as { ok: boolean };
    expect(del.ok).toBe(true);
    const delEv = (await c2.waitForEvent("agent.deleted")) as { id: string };
    expect(delEv.id).toBe(created.id);
    const list2 = (await c1.request("agents.list", {})) as Agent[];
    expect(list2.some((a) => a.id === created.id)).toBe(false);
    expect(existsSync(created.workspacePath)).toBe(true);

    c1.close();
    c2.close();
  });

  test("restart persists agents and does not re-apply migrations", async () => {
    const c = await DaemonClient.connect(daemon.port, TOKEN);
    const keep = (await c.request("agents.create", {
      name: "Survivor",
      provider: "opencode",
    })) as Agent;
    c.close();

    daemon.proc.kill("SIGTERM");
    await waitForExit(daemon.proc, 5000);

    const daemon2 = await startDaemon(dataDir, agentsRoot, TOKEN);
    try {
      const c2 = await DaemonClient.connect(daemon2.port, TOKEN);
      const list = (await c2.request("agents.list", {})) as Agent[];
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
    const d = mkdtempSync(join(tmpdir(), "upbotd-notok-"));
    const proc = Bun.spawn(
      ["bun", DAEMON, "--data-dir", d, "--agents-root", mkdtempSync(join(tmpdir(), "oa-nt-"))],
      { env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: ROOT },
    );
    (proc.stdin as { end: () => void }).end(); // EOF before any token line
    const code = await waitForExit(proc, 8000);
    expect(code).not.toBe(0);
  });

  test("closing stdin makes the daemon exit", async () => {
    const d = await startDaemon(
      mkdtempSync(join(tmpdir(), "upbotd-data2-")),
      mkdtempSync(join(tmpdir(), "upbotd-agents2-")),
      TOKEN,
    );
    (d.proc.stdin as { end: () => void }).end();
    await waitForExit(d.proc, 5000);
  });
});
