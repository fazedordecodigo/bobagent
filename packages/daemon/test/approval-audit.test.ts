import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { ApprovalService } from "../src/approvals";
import { AppsService } from "../src/apps";
import { migrations } from "../src/db/migrations";
import { RpcError } from "../src/runtime/agent-runtime";
import type { RuntimeManager } from "../src/runtime/runtime-manager";
import { Vault } from "../src/vault";

type AuditRow = {
  seq: number;
  event: string;
  approval_id: string | null;
  agent_id: string | null;
  turn_id: string | null;
  data_json: string;
  created_at: number;
};

const rows = (db: Database, event: string): AuditRow[] =>
  db.query("SELECT * FROM approval_audit WHERE event = ? ORDER BY seq").all(event) as AuditRow[];

const json = (r: AuditRow) => JSON.parse(r.data_json) as Record<string, unknown>;

async function withApprovals(
  run: (ctx: {
    approvals: ApprovalService;
    apps: AppsService;
    vault: Vault;
    db: Database;
  }) => Promise<void>,
) {
  const savedTtl = process.env.UPBOT_APPROVAL_TTL_MS;
  const savedKey = process.env.UPBOT_VAULT_KEY;
  process.env.UPBOT_APPROVAL_TTL_MS = "50";
  process.env.UPBOT_VAULT_KEY = "12".repeat(32);
  const db = new Database(":memory:");
  try {
    for (const sql of migrations) db.exec(sql);
    db.query(
      "INSERT INTO connected_apps (id, catalog_id, config_json, enabled, created_at) VALUES (?, ?, ?, 0, 1)",
    ).run(
      "notes",
      "custom-stdio",
      JSON.stringify({
        name: "Notes",
        transport: "stdio",
        command: ["unused"],
        url: null,
        secretKeys: [],
        headers: {},
        agentIds: [],
      }),
    );
    const vault = new Vault(db, "unused");
    const apps = new AppsService(db, vault, () => {});
    const runtimes = {
      currentTurn: () => ({ id: "turn", background: false }),
    } as unknown as RuntimeManager;
    const approvals = new ApprovalService(
      db,
      vault,
      () => runtimes,
      () => {},
      apps,
    );
    await run({ approvals, apps, vault, db });
  } finally {
    if (savedTtl === undefined) delete process.env.UPBOT_APPROVAL_TTL_MS;
    else process.env.UPBOT_APPROVAL_TTL_MS = savedTtl;
    if (savedKey === undefined) delete process.env.UPBOT_VAULT_KEY;
    else process.env.UPBOT_VAULT_KEY = savedKey;
    db.close();
  }
}

test("approval.decided persists approve, deny and expiry with decision and context", async () => {
  await withApprovals(async ({ approvals, db }) => {
    const g1 = approvals.gate("bot", "notes-create_note", { title: "secret-title" }, true);
    const p1 = approvals.list()[0]!;
    await approvals.respond({ id: p1.id, decision: "approve" });
    await g1;

    const g2 = approvals.gate("bot", "notes-create_note", {}, true).catch((e) => e);
    const p2 = approvals.list()[0]!;
    await approvals.respond({ id: p2.id, decision: "deny" });
    expect(await g2).toBeInstanceOf(Error);

    const g3 = approvals.gate("bot", "notes-create_note", {}, true).catch((e) => e);
    const p3 = approvals.list()[0]!;
    await Bun.sleep(80);
    expect(await g3).toBeInstanceOf(Error);

    const decided = rows(db, "approval.decided").map(json);
    const approved = decided.find((r) => r.approvalId === p1.id)!;
    expect(approved).toMatchObject({
      turnId: "turn",
      kind: "tool",
      tool: "notes-create_note",
      appId: "notes",
      permission: "write",
      status: "approved",
      decision: "approve",
      background: false,
    });
    expect(approved.ageMs).toBeGreaterThanOrEqual(0);
    expect(decided.find((r) => r.approvalId === p2.id)).toMatchObject({
      status: "denied",
      decision: "deny",
    });
    expect(decided.find((r) => r.approvalId === p3.id)).toMatchObject({
      status: "expired",
      decision: null,
    });
    // tool args never reach the audit trail
    expect(JSON.stringify(decided)).not.toContain("secret-title");
  });
});

test("approval.auto_denied records off-permission denials in gate", async () => {
  await withApprovals(async ({ approvals, apps, db }) => {
    await apps.update({ id: "notes", permissions: { write: "off" } });
    await expect(approvals.gate("bot", "notes-create_note", {}, true)).rejects.toThrow(
      "Notes não permite write",
    );
    const denied = rows(db, "approval.auto_denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]!.agent_id).toBe("bot");
    expect(denied[0]!.approval_id).toBeNull();
    expect(json(denied[0]!)).toMatchObject({
      agentId: "bot",
      tool: "notes-create_note",
      appId: "notes",
      permission: "write",
      reason: "permission_off",
    });
  });
});

test("app permission changes record stored diffs", async () => {
  await withApprovals(async ({ apps, db }) => {
    await apps.update({ id: "notes", permissions: { write: "off", read: "ask" } });
    expect(rows(db, "approval.app_permissions_changed").map(json)).toMatchObject([
      {
        appId: "notes",
        source: "update",
        changes: [
          { permission: "read", from: "allow", to: "ask" },
          { permission: "write", from: "ask", to: "off" },
        ],
      },
    ]);

    await apps.update({ id: "notes", permissions: { write: "off", read: "ask" } });
    expect(rows(db, "approval.app_permissions_changed")).toHaveLength(1);

    await apps.update({ id: "notes", permissions: { write: "allow" } });
    apps.restorePermission("notes", "write", "ask");
    expect(rows(db, "approval.app_permissions_changed").map(json).at(-1)).toMatchObject({
      appId: "notes",
      source: "restore",
      changes: [{ permission: "write", from: "allow", to: "ask" }],
    });
  });
});

test("approval.permission_escalated records always decisions for apps and tool rules", async () => {
  await withApprovals(async ({ approvals, apps, db }) => {
    const g1 = approvals.gate("bot", "notes-create_note", {}, true);
    const p1 = approvals.list()[0]!;
    await approvals.respond({ id: p1.id, decision: "always" });
    await g1;
    expect(
      rows(db, "approval.permission_escalated")
        .map(json)
        .find((r) => r.approvalId === p1.id),
    ).toMatchObject({ appId: "notes", permission: "write", previousLevel: "ask" });
    expect(apps.get("notes").permissions.write).toBe("allow");

    approvals.setRules([
      { id: "ask-backup", pattern: "list_agents", action: "ask", agentId: null },
    ]);
    const g2 = approvals.gate("bot", "list_agents", {}, false);
    const p2 = approvals.list()[0]!;
    await approvals.respond({ id: p2.id, decision: "always" });
    await g2;
    const rule = approvals
      .rules()
      .find((r) => r.pattern === "list_agents" && r.action === "allow")!;
    expect(
      rows(db, "approval.permission_escalated")
        .map(json)
        .find((r) => r.approvalId === p2.id),
    ).toMatchObject({ agentId: "bot", ruleId: rule.id, pattern: "list_agents" });
  });
});

test("failed always decisions record a safe failure outcome without escalation", async () => {
  await withApprovals(async ({ approvals, apps, db }) => {
    const gate = approvals.gate("bot", "notes-create_note", {}, true).catch((error) => error);
    const pending = approvals.list()[0]!;
    spyOn(apps, "update").mockImplementationOnce(async () => {
      throw new RpcError("busy", "x");
    });

    await expect(approvals.respond({ id: pending.id, decision: "always" })).rejects.toThrow("x");
    expect(await gate).toBeInstanceOf(Error);
    expect(apps.get("notes").permissions.write).toBe("ask");

    const decided = rows(db, "approval.decided")
      .map(json)
      .find((r) => r.approvalId === pending.id);
    expect(decided).toMatchObject({
      status: "denied",
      decision: null,
      requestedDecision: "always",
      reason: "respond_failed",
      failure: "busy",
    });
    expect(
      rows(db, "approval.permission_escalated")
        .map(json)
        .some((r) => r.approvalId === pending.id),
    ).toBe(false);
  });
});

test("approval.rules_changed records added and removed rule ids", async () => {
  await withApprovals(async ({ approvals, db }) => {
    approvals.setRules([
      { id: "r1", pattern: "a*", action: "ask", agentId: null },
      { id: "r2", pattern: "b*", action: "allow", agentId: "bot" },
    ]);
    approvals.setRules([
      { id: "r2", pattern: "b*", action: "allow", agentId: "bot" },
      { id: "r3", pattern: "c*", action: "ask", agentId: null },
    ]);
    const changes = rows(db, "approval.rules_changed").map(json);
    expect(changes[0]).toMatchObject({
      addedCount: 2,
      removedCount: 0,
      addedRuleIds: ["r1", "r2"],
      removedRuleIds: [],
    });
    expect(changes[1]).toMatchObject({
      addedCount: 1,
      removedCount: 1,
      changedCount: 0,
      addedRuleIds: ["r3"],
      removedRuleIds: ["r1"],
      changedRuleIds: [],
    });
    approvals.setRules([
      { id: "r2", pattern: "b*", action: "allow", agentId: "bot" },
      { id: "r3", pattern: "c*", action: "ask", agentId: null },
    ]);
    approvals.setRules([
      { id: "r2", pattern: "b-updated*", action: "ask", agentId: "bot" },
      { id: "r3", pattern: "c*", action: "ask", agentId: null },
    ]);
    const edited = rows(db, "approval.rules_changed").map(json)[3]!;
    expect(edited).toMatchObject({
      addedCount: 0,
      removedCount: 0,
      changedCount: 1,
      addedRuleIds: [],
      removedRuleIds: [],
      changedRuleIds: ["r2"],
    });
  });
});

test("secret approval logs and audits a vault read failure without the secret value", async () => {
  await withApprovals(async ({ approvals, vault, db }) => {
    const stderr = spyOn(console, "error").mockImplementation(() => {});
    spyOn(vault, "list").mockImplementationOnce(() => {
      throw new Error("decrypt failed sk_leak_marker_1");
    });
    const secret = approvals.requestSecret("bot", "stripe.key", "Stripe", "check invoices");
    const pending = approvals.list()[0]!;
    await approvals.respond({ id: pending.id, decision: "approve", value: "sk_live_9" });
    await secret;

    const logged = stderr.mock.calls.find(
      (c) => c[0] === "[upbotd] approval.secret_allowlist_read_failed",
    );
    expect(logged?.[1]).toMatchObject({
      approvalId: pending.id,
      agentId: "bot",
      secretName: "stripe.key",
      failure: "Error",
    });
    const stderrCalls = JSON.stringify(stderr.mock.calls);
    stderr.mockRestore();

    expect(stderrCalls).not.toContain("sk_leak_marker_1");
    expect(stderrCalls).not.toContain("decrypt failed");

    const failed = rows(db, "approval.secret_allowlist_read_failed");
    expect(failed).toHaveLength(1);
    expect(json(failed[0]!)).toMatchObject({
      approvalId: pending.id,
      agentId: "bot",
      secretName: "stripe.key",
      failure: "Error",
    });
    expect(failed[0]!.data_json).not.toContain("decrypt failed");
    expect(vault.list().find((v) => v.name === "stripe.key")?.agentIds).toEqual(["bot"]);

    const dump = JSON.stringify(
      db.query("SELECT data_json FROM approval_audit").all() as AuditRow[],
    );
    expect(dump).not.toContain("sk_live_9");
    expect(
      rows(db, "approval.decided")
        .map(json)
        .find((r) => r.approvalId === pending.id),
    ).toMatchObject({ kind: "secret", secretName: "stripe.key", status: "approved" });
  });
});
