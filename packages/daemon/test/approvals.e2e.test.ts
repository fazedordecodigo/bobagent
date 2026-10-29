import { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Agent, Approval, ChatItem, ConnectedApp, Turn, VaultEntry } from "@upbot/protocol";
import { defaultAppPermissions } from "@upbot/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  ROOT,
  startDaemon,
  stopTestChildren,
  tmp,
} from "./helpers";

const TOKEN = `approvals-test-${crypto.randomUUID()}`;
const FAKE_MCP = join(ROOT, "packages/daemon/test/fixtures/fake-mcp-server.ts");

describe("approvals e2e", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  let a: Agent;
  let app: ConnectedApp;

  async function tool(agent: Agent, name: string, args: Record<string, unknown> = {}) {
    const { queueId } = (await c.request("chat.send", {
      agentId: agent.id,
      text: `mcp:${name} ${JSON.stringify(args)}`,
    })) as { queueId: string };
    const t = (await c.waitForEventWhere(
      "turn.ended",
      (d) => (d as Turn).queueId === queueId,
      30000,
    )) as Turn;
    const { items } = (await c.request("chat.history", { agentId: agent.id })) as {
      items: ChatItem[];
    };
    const msg = items.filter((i) => i.turnId === t.id && i.kind === "agent_message").pop();
    return msg && "text" in msg ? msg.text : "";
  }

  /** Runs a tool call that should raise an approval; answers it with `decide`. */
  async function withApproval(
    name: string,
    args: Record<string, unknown>,
    decide: (ap: Approval) => Promise<unknown>,
  ): Promise<{ text: string; approval: Approval }> {
    const pending = c.waitForEventWhere(
      "approval.updated",
      (d) => (d as Approval).status === "pending",
      20000,
    ) as Promise<Approval>;
    const result = tool(a, name, args);
    const approval = await pending;
    await decide(approval);
    return { text: await result, approval };
  }

  beforeAll(async () => {
    dataDir = tmp("appr-data-");
    agentsRoot = tmp("appr-agents-");
    stateDir = tmp("appr-fake-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      UPBOT_VAULT_KEY: "12".repeat(32),
      UPBOT_APPROVAL_TTL_MS: "2000",
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
    a = (await c.request("agents.create", {
      name: "A",
      provider: "devin",
      instructions: "",
    })) as Agent;
    app = (await c.request("apps.connect", {
      catalogId: "custom-stdio",
      name: "Notes",
      command: ["bun", FAKE_MCP],
      secrets: { FAKE_APP_PERMISSIONS: "1" },
    })) as ConnectedApp;
  });

  beforeEach(async () => {
    await c.request("apps.update", { id: app.id, permissions: defaultAppPermissions });
    await c.request("approvals.setRules", { rules: [] });
  });

  afterAll(async () => {
    c?.close();
    try {
      daemon.proc.kill("SIGKILL");
    } catch {}
    await daemon.proc.exited;
    await stopTestChildren(stateDir);
    for (const d of [dataDir, agentsRoot, stateDir])
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("reads run without asking; app writes ask first and can be approved or declined", async () => {
    expect(await tool(a, "notes-get_note", { text: "x" })).toBe("tool-ok:echo:x");
    const unknown = await withApproval("notes-echo", { text: "unknown" }, (ap) =>
      c.request("approvals.respond", { id: ap.id, decision: "approve" }),
    );
    expect(unknown.approval.permission).toBe("write");
    expect(unknown.text).toBe("tool-ok:echo:unknown");
    const ok = await withApproval("notes-create_note", { title: "t" }, (ap) =>
      c.request("approvals.respond", { id: ap.id, decision: "approve" }),
    );
    expect(ok.approval).toMatchObject({
      kind: "tool",
      tool: "notes-create_note",
      background: false,
    });
    expect(ok.approval.detail).toContain('"title": "t"');
    expect(ok.text).toBe("tool-ok:note-created");
    const no = await withApproval("notes-create_note", {}, (ap) =>
      c.request("approvals.respond", { id: ap.id, decision: "deny" }),
    );
    expect(no.text).toContain("declined");
  });

  test("always allows the app kind without adding a rule; explicit ask still wins", async () => {
    await withApproval("notes-create_note", {}, (ap) =>
      c.request("approvals.respond", { id: ap.id, decision: "always" }),
    );
    expect(await tool(a, "notes-create_note")).toBe("tool-ok:note-created");
    const rules = (await c.request("approvals.rules", {})) as { pattern: string }[];
    expect(rules).toEqual([]);
    expect(((await c.request("apps.list", {})) as ConnectedApp[])[0]?.permissions.write).toBe(
      "allow",
    );
    await c.request("approvals.setRules", {
      rules: [
        ...rules,
        { id: "r-ask", pattern: "notes-*", action: "ask", agentId: null },
        { id: "r-allow", pattern: "list_agents", action: "allow", agentId: null },
      ],
    });
    const asked = await withApproval("notes-create_note", {}, (ap) =>
      c.request("approvals.respond", { id: ap.id, decision: "approve" }),
    );
    expect(asked.text).toBe("tool-ok:note-created");
    await c.request("approvals.setRules", { rules: [] });
  });

  test("legacy double-underscore app approval rules still match", async () => {
    await c.request("approvals.setRules", {
      rules: [{ id: "legacy-ask", pattern: "notes__*", action: "ask", agentId: null }],
    });
    const asked = await withApproval("notes-echo", { text: "legacy" }, (ap) =>
      c.request("approvals.respond", { id: ap.id, decision: "approve" }),
    );
    expect(asked.approval.tool).toBe("notes-echo");
    expect(asked.text).toBe("tool-ok:echo:legacy");
    await c.request("approvals.setRules", { rules: [] });
  });

  test("wildcard allow keeps sensitive app writes gated", async () => {
    await c.request("approvals.setRules", {
      rules: [{ id: "wildcard-allow", pattern: "*", action: "allow", agentId: null }],
    });
    const write = await withApproval("notes-create_note", {}, (ap) =>
      c.request("approvals.respond", { id: ap.id, decision: "approve" }),
    );
    expect(write.approval.tool).toBe("notes-create_note");
    expect(write.text).toBe("tool-ok:note-created");
    expect(await tool(a, "notes-get_note", { text: "read" })).toBe("tool-ok:echo:read");
    expect(await tool(a, "list_agents")).toContain("A");

    await c.request("approvals.setRules", {
      rules: [
        {
          id: "explicit-write-allow",
          pattern: "notes-create_note",
          action: "allow",
          agentId: null,
        },
      ],
    });
    const specific = await withApproval("notes-create_note", {}, (ap) =>
      c.request("approvals.respond", { id: ap.id, decision: "approve" }),
    );
    expect(specific.text).toBe("tool-ok:note-created");
    await c.request("approvals.setRules", { rules: [] });
  });

  test("unanswered approvals expire and tell the bot not to retry", async () => {
    const pending = c.waitForEventWhere(
      "approval.updated",
      (d) => (d as Approval).status === "expired",
      20000,
    );
    const text = await tool(a, "notes-create_note");
    await pending;
    expect(text).toContain("did not approve");
  });

  test("permission defaults and sensitive allow validation through RPC", async () => {
    expect(app.permissions).toEqual(defaultAppPermissions);
    for (const kind of ["send", "pay", "book", "del"]) {
      await expect(
        c.request("apps.update", { id: app.id, permissions: { [kind]: "allow" } }),
      ).rejects.toThrow();
      await expect(
        c.request("apps.connect", {
          catalogId: "custom-stdio",
          name: `Invalid ${kind}`,
          command: ["bun", FAKE_MCP],
          secrets: {},
          permissions: { [kind]: "allow" },
        }),
      ).rejects.toThrow();
    }
    expect(((await c.request("apps.list", {})) as ConnectedApp[]).length).toBe(1);
  });

  test("off auto-denies without approval; allow passes; ask creates labeled approval", async () => {
    await c.request("apps.update", { id: app.id, permissions: { write: "off" } });
    const before = (await c.request("approvals.list", {})) as Approval[];
    expect(await tool(a, "notes-create_note")).toContain("Notes não permite write");
    expect(((await c.request("approvals.list", {})) as Approval[]).map((x) => x.id)).toEqual(
      before.map((x) => x.id),
    );
    await c.request("apps.update", { id: app.id, permissions: { write: "allow" } });
    expect(await tool(a, "notes-create_note")).toBe("tool-ok:note-created");
    await c.request("apps.update", { id: app.id, permissions: { write: "ask" } });
    const asked = await withApproval("notes-create_note", {}, (ap) =>
      c.request("approvals.respond", { id: ap.id, decision: "deny" }),
    );
    expect(asked.approval).toMatchObject({
      appId: app.id,
      appName: "Notes",
      permission: "write",
      agentId: a.id,
    });
  });

  test("sensitive calls cannot be bypassed by rules, always or task decisions", async () => {
    await c.request("approvals.setRules", {
      rules: [
        { id: "all", pattern: "*", action: "allow", agentId: null },
        { id: "send", pattern: "notes-send_message", action: "allow", agentId: a.id },
      ],
    });
    const before = await c.request("approvals.rules", {});
    for (const decision of ["always", "task", "approve"] as const) {
      const called = await withApproval("notes-send_message", {}, (ap) =>
        c.request("approvals.respond", { id: ap.id, decision }),
      );
      expect(called.approval.permission).toBe("send");
      expect(called.text).toBe("tool-ok:message-sent");
      expect(((await c.request("apps.list", {})) as ConnectedApp[])[0]?.permissions.send).toBe(
        "ask",
      );
      expect(await c.request("approvals.rules", {})).toEqual(before);
    }
  });

  test("task grant passes another call in the same turn but not the next turn", async () => {
    const waiting = c.waitForEventWhere(
      "approval.updated",
      (d) => (d as Approval).status === "pending",
    ) as Promise<Approval>;
    const sent = (await c.request("chat.send", {
      agentId: a.id,
      text: `mcp-sequence:${JSON.stringify([
        { tool: "notes-create_note", args: {} },
        { tool: "notes-create_note", args: {} },
        { tool: "notes-echo", args: { text: "done" } },
      ])}`,
    })) as { queueId: string };
    const ap = await waiting;
    await c.request("approvals.respond", { id: ap.id, decision: "task" });
    await c.waitForEventWhere("turn.ended", (d) => (d as Turn).queueId === sent.queueId);
    const approvals = (await c.request("approvals.list", {})) as Approval[];
    expect(approvals.filter((x) => x.turnId === ap.turnId)).toHaveLength(1);
    const { items } = (await c.request("chat.history", { agentId: a.id })) as { items: ChatItem[] };
    expect(
      items
        .filter((x) => x.turnId === ap.turnId && x.kind === "agent_message")
        .map((x) => ("text" in x ? x.text : ""))
        .join(""),
    ).toContain("tool-ok:note-createdtool-ok:note-createdtool-ok:echo:done");
    expect(((await c.request("apps.list", {})) as ConnectedApp[])[0]?.permissions.write).toBe(
      "ask",
    );
    const next = await withApproval("notes-create_note", {}, (approval) =>
      c.request("approvals.respond", { id: approval.id, decision: "deny" }),
    );
    expect(next.approval.turnId).not.toBe(ap.turnId);
    expect(next.text).toContain("declined");
  });

  test("always reports the previous level for honest app-level undo", async () => {
    let result: Approval | undefined;
    await withApproval("notes-create_note", {}, async (ap) => {
      result = (await c.request("approvals.respond", {
        id: ap.id,
        decision: "always",
      })) as Approval;
    });
    expect(result).toMatchObject({
      previousLevel: "ask",
      permission: "write",
      appId: app.id,
      status: "approved",
    });
    expect(await c.request("approvals.rules", {})).toEqual([]);
    await c.request("apps.update", { id: app.id, permissions: { write: result!.previousLevel } });
    const asked = await withApproval("notes-create_note", {}, (ap) =>
      c.request("approvals.respond", { id: ap.id, decision: "deny" }),
    );
    expect(asked.text).toContain("declined");
  });

  test("persists the approval audit trail through daemon RPC", async () => {
    const dbPath = join(dataDir, "upbot.db");
    let db: Database;
    try {
      db = new Database(dbPath, { readonly: true });
    } catch {
      db = new Database(dbPath);
    }
    try {
      const startSeq =
        (db.query("SELECT MAX(seq) AS seq FROM approval_audit").get() as { seq: number | null })
          .seq ?? 0;

      const approved = await withApproval(
        "notes-create_note",
        { title: "audit-arg-marker" },
        (ap) => c.request("approvals.respond", { id: ap.id, decision: "approve" }),
      );
      await withApproval("notes-create_note", {}, (ap) =>
        c.request("approvals.respond", { id: ap.id, decision: "always" }),
      );

      await c.request("apps.update", { id: app.id, permissions: { write: "off" } });
      await tool(a, "notes-create_note");

      await c.request("approvals.setRules", {
        rules: [{ id: "e2e-r", pattern: "list_agents", action: "ask", agentId: null }],
      });
      await c.request("approvals.setRules", {
        rules: [{ id: "e2e-r", pattern: "list_agents", action: "allow", agentId: null }],
      });

      const secretName = "audit.secret";
      await withApproval(
        "request_secret",
        { name: secretName, label: "Audit secret", reason: "audit" },
        (ap) =>
          c.request("approvals.respond", {
            id: ap.id,
            decision: "approve",
            value: "sk_audit_marker_77",
          }),
      );

      const rows = db
        .query(
          "SELECT seq, event, agent_id, data_json FROM approval_audit WHERE seq > ? ORDER BY seq",
        )
        .all(startSeq) as {
        seq: number;
        event: string;
        agent_id: string | null;
        data_json: string;
      }[];
      const entries = rows.map((row) => ({
        ...row,
        data: JSON.parse(row.data_json) as Record<string, unknown>,
      }));
      const decided = entries.find(
        (row) => row.event === "approval.decided" && row.data.approvalId === approved.approval.id,
      )!;
      expect(decided.data).toMatchObject({
        kind: "tool",
        tool: "notes-create_note",
        appId: app.id,
        permission: "write",
        status: "approved",
        decision: "approve",
      });
      expect(decided.agent_id).toBe(a.id);

      expect(
        entries.find((row) => row.event === "approval.permission_escalated")?.data,
      ).toMatchObject({
        appId: app.id,
        permission: "write",
        previousLevel: "ask",
      });
      expect(
        entries.find(
          (row) =>
            row.event === "approval.app_permissions_changed" &&
            row.data.source === "update" &&
            JSON.stringify(row.data.changes).includes('"to":"allow"'),
        )?.data,
      ).toMatchObject({
        appId: app.id,
        source: "update",
        changes: [{ permission: "write", from: "ask", to: "allow" }],
      });
      expect(
        entries.find(
          (row) =>
            row.event === "approval.app_permissions_changed" &&
            row.data.source === "update" &&
            JSON.stringify(row.data.changes).includes('"to":"off"'),
        )?.data,
      ).toMatchObject({
        appId: app.id,
        source: "update",
        changes: [{ permission: "write", from: "allow", to: "off" }],
      });
      expect(entries.find((row) => row.event === "approval.auto_denied")?.data).toMatchObject({
        tool: "notes-create_note",
        permission: "write",
        reason: "permission_off",
      });
      expect(
        entries.filter((row) => row.event === "approval.rules_changed").at(-1)?.data,
      ).toMatchObject({ changedRuleIds: ["e2e-r"] });
      expect(
        entries.find(
          (row) =>
            row.event === "approval.decided" &&
            row.data.kind === "secret" &&
            row.data.secretName === secretName,
        )?.data,
      ).toMatchObject({ kind: "secret", secretName, status: "approved" });

      const serialized = entries.map((row) => row.data_json).join("\n");
      expect(serialized).not.toContain("audit-arg-marker");
      expect(serialized).not.toContain("sk_audit_marker_77");
    } finally {
      db.close();
    }
  }, 30000);

  test("secure secret request stores the value in the vault for that bot only", async () => {
    const r = await withApproval(
      "request_secret",
      { name: "stripe.key", label: "Stripe key", reason: "check invoices" },
      (ap) =>
        c.request("approvals.respond", { id: ap.id, decision: "approve", value: "sk_test_42" }),
    );
    expect(r.approval).toMatchObject({
      kind: "secret",
      secretName: "stripe.key",
      title: "Stripe key",
    });
    expect(r.text).toContain('vault as "stripe.key"');
    expect(r.text).not.toContain("sk_test_42");
    const v = (await c.request("vault.list", {})) as VaultEntry[];
    expect(v.find((e) => e.name === "stripe.key")?.agentIds).toEqual([a.id]);
    expect(await tool(a, "vault_get", { name: "stripe.key" })).toBe("tool-ok:sk_test_42");
  });

  test("take-over waits for the user to finish", async () => {
    const r = await withApproval("request_takeover", { reason: "2FA code needed" }, (ap) =>
      c.request("approvals.respond", { id: ap.id, decision: "done" }),
    );
    expect(r.approval.kind).toBe("takeover");
    expect(r.text).toContain("the user finished");
    const list = (await c.request("approvals.list", { agentId: a.id })) as Approval[];
    expect(list[0]).toMatchObject({ kind: "takeover", status: "done" });
  });
});
