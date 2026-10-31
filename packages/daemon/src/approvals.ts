import type { Database } from "bun:sqlite";
import type { Approval, ApprovalDecision, ApprovalRule } from "@boto/protocol";
import { classifyAppTool, isSensitivePermission } from "@boto/protocol";
import { z } from "zod";
import type { AppsService } from "./apps";
import { getSetting, InvalidSettingError, setSetting } from "./db/settings";
import { envPositiveNumber } from "./env/vars";
import { RpcError } from "./runtime/agent-runtime";
import type { RuntimeManager } from "./runtime/runtime-manager";
import type { Vault } from "./vault";

// Approvals gate bot tool calls on the bridge. App permissions cannot be bypassed by
// allow rules; explicit ask rules still require review. A pending approval blocks the tool call
// until the user decides; approvals raised by background work (routines, other bots,
// gateways, group chats) expire after BOTO_APPROVAL_BACKGROUND_TTL_MS (default 10 min),
// others after BOTO_APPROVAL_TTL_MS (default 60 min). The same queue carries secure secret
// requests (value goes straight to the vault) and browser take-over requests.

type Broadcast = (event: string, data: unknown) => void;
type Waiter = {
  resolve: (a: Approval, value?: string) => void;
  timer: ReturnType<typeof setTimeout>;
};

function globRe(pattern: string): RegExp {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${esc}$`, "i");
}

export function legacyPattern(pattern: string): string {
  return pattern.includes("__") ? pattern.replace("__", "-").replace(/_{2,}/g, "_") : pattern;
}

/** Expected tool-call rejection: the user denied, the approval expired or the app forbids it. */
export class GateRejection extends Error {
  constructor(
    readonly reason: "denied" | "expired",
    message: string,
  ) {
    super(message);
    this.name = "GateRejection";
  }
}

const rulesSchema = z.array(
  z.looseObject({
    id: z.string(),
    pattern: z.string(),
    action: z.enum(["ask", "allow"]),
    agentId: z.string().nullable(),
  }),
);

export class ApprovalService {
  private pending = new Map<string, Approval>();
  private waiters = new Map<string, Waiter>();
  private recent: Approval[] = [];
  private grants = new Map<string, Set<string>>();
  private responding = new Set<string>();

  constructor(
    private db: Database,
    private vault: Vault,
    private runtimes: () => RuntimeManager,
    private broadcast: Broadcast,
    private apps: AppsService,
  ) {
    apps.onPermissionsChanged = (e) =>
      this.audit("approval.app_permissions_changed", {
        appId: e.appId,
        source: e.source,
        changes: e.changes,
      });
  }

  rules(): ApprovalRule[] {
    return getSetting(this.db, "approval_rules", rulesSchema, []);
  }

  setRules(rules: ApprovalRule[]): ApprovalRule[] {
    let previous: ApprovalRule[];
    try {
      previous = this.rules();
    } catch (e) {
      // A corrupt stored value must not block repair: treat it as empty.
      if (!(e instanceof InvalidSettingError)) throw e;
      previous = [];
    }
    setSetting(this.db, "approval_rules", rules);
    const previousIds = new Set(previous.map((r) => r.id));
    const nextIds = new Set(rules.map((r) => r.id));
    const addedRuleIds = rules.filter((r) => !previousIds.has(r.id)).map((r) => r.id);
    const removedRuleIds = previous.filter((r) => !nextIds.has(r.id)).map((r) => r.id);
    const previousById = new Map(previous.map((r) => [r.id, r]));
    const changedRuleIds = rules
      .filter((r) => {
        const old = previousById.get(r.id);
        return (
          old !== undefined &&
          (old.pattern !== r.pattern || old.action !== r.action || old.agentId !== r.agentId)
        );
      })
      .map((r) => r.id);
    this.audit("approval.rules_changed", {
      addedCount: addedRuleIds.length,
      removedCount: removedRuleIds.length,
      changedCount: changedRuleIds.length,
      addedRuleIds,
      removedRuleIds,
      changedRuleIds,
    });
    this.broadcast("approvals.rulesChanged", {});
    return rules;
  }

  /** Persistent audit trail (approval_audit). Never stores args, details or secret values. */
  private audit(event: string, data: Record<string, unknown>, a?: Approval): void {
    try {
      this.db
        .query(
          "INSERT INTO approval_audit (event, approval_id, agent_id, turn_id, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          event,
          a?.id ?? (typeof data.approvalId === "string" ? data.approvalId : null),
          a?.agentId ?? (typeof data.agentId === "string" ? data.agentId : null),
          a?.turnId ?? null,
          JSON.stringify(data),
          Date.now(),
        );
    } catch (error) {
      console.error("[botod] approval.audit_write_failed", (error as Error).message);
    }
  }

  /** "ask" | "allow" for a tool call, after rules and defaults. */
  decide(agentId: string, tool: string, isAppTool: boolean): "ask" | "allow" {
    const hits = this.rules().filter(
      (r) =>
        (r.agentId === null || r.agentId === agentId) &&
        (globRe(r.pattern).test(tool) || globRe(legacyPattern(r.pattern)).test(tool)),
    );
    if (hits.some((r) => r.action === "ask")) return "ask";
    const app = isAppTool ? this.apps.appForTool(tool) : undefined;
    if (app) {
      const kind = classifyAppTool(tool);
      const turn = this.runtimes().currentTurn(agentId);
      if (
        !isSensitivePermission(kind) &&
        turn &&
        this.grants.get(`${agentId}:${turn.id}`)?.has(`${app.id}:${kind}`)
      )
        return "allow";
      return app.permissions[kind] === "allow" ? "allow" : "ask";
    }
    if (hits.some((r) => r.action === "allow" && r.pattern !== "*")) return "allow";
    return "allow";
  }

  list(agentId?: string): Approval[] {
    const all = [...this.pending.values(), ...this.recent];
    return all
      .filter((a) => !agentId || a.agentId === agentId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  private open(
    agentId: string,
    p: Pick<
      Approval,
      "kind" | "title" | "detail" | "tool" | "secretName" | "appId" | "appName" | "permission"
    >,
  ): Promise<{ approval: Approval; value?: string }> {
    const cur = this.runtimes().currentTurn(agentId);
    const background = cur?.background ?? true;
    const ttl = background
      ? envPositiveNumber("BOTO_APPROVAL_BACKGROUND_TTL_MS", 10 * 60_000)
      : envPositiveNumber("BOTO_APPROVAL_TTL_MS", 60 * 60_000);
    const now = Date.now();
    const approval: Approval = {
      id: crypto.randomUUID(),
      agentId,
      turnId: cur?.id ?? null,
      ...p,
      background,
      status: "pending",
      createdAt: now,
      expiresAt: now + ttl,
    };
    this.pending.set(approval.id, approval);
    this.broadcast("approval.updated", approval);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(approval.id, "expired"), ttl);
      this.waiters.set(approval.id, {
        timer,
        resolve: (a, value) => resolve({ approval: a, ...(value !== undefined ? { value } : {}) }),
      });
    });
  }

  private finish(
    id: string,
    status: Approval["status"],
    value?: string,
    outcome?: {
      decision?: ApprovalDecision;
      requestedDecision?: ApprovalDecision;
      reason?: string;
      failure?: string;
    },
  ): Approval | null {
    if (status === "expired" && this.responding.has(id)) return null;
    const a = this.pending.get(id);
    if (!a) return null;
    this.pending.delete(id);
    const done = { ...a, status };
    this.recent = [done, ...this.recent].slice(0, 50);
    this.audit(
      "approval.decided",
      {
        approvalId: done.id,
        turnId: done.turnId,
        kind: done.kind,
        tool: done.tool,
        appId: done.appId ?? null,
        permission: done.permission ?? null,
        secretName: done.kind === "secret" ? done.secretName : null,
        status,
        decision: outcome?.decision ?? null,
        requestedDecision: outcome?.requestedDecision ?? null,
        reason: outcome?.reason ?? null,
        failure: outcome?.failure ?? null,
        background: done.background,
        ageMs: Date.now() - done.createdAt,
      },
      done,
    );
    const w = this.waiters.get(id);
    this.waiters.delete(id);
    if (w) {
      clearTimeout(w.timer);
      w.resolve(done, value);
    }
    this.broadcast("approval.updated", done);
    return done;
  }

  async respond(p: {
    id: string;
    decision: ApprovalDecision;
    value?: string | undefined;
  }): Promise<Approval> {
    const a = this.pending.get(p.id);
    if (!a) throw new RpcError("not_found", "approval not found or no longer pending");
    if (this.responding.has(p.id))
      throw new RpcError("busy", "approval decision is already being saved");
    if (a.expiresAt <= Date.now()) {
      this.finish(a.id, "expired");
      throw new RpcError("not_found", "approval not found or no longer pending");
    }
    if (a.kind === "secret" && p.decision !== "deny" && !p.value)
      throw new RpcError("bad_request", "enter the secret value");
    this.responding.add(p.id);
    const waiter = this.waiters.get(p.id);
    if (waiter) clearTimeout(waiter.timer);
    try {
      if (a.kind === "secret") {
        if (p.decision === "deny")
          return this.finish(a.id, "denied", undefined, { decision: "deny" })!;
        if (!p.value) throw new RpcError("bad_request", "enter the secret value");
        const name = a.secretName!;
        let agentIds: string[];
        try {
          const existing = this.vault.get(name);
          agentIds = existing ? [...new Set([...existing.agentIds, a.agentId])] : [a.agentId];
        } catch (error) {
          const failure = error instanceof RpcError ? error.code : (error as Error).name;
          this.audit(
            "approval.secret_allowlist_read_failed",
            {
              approvalId: a.id,
              agentId: a.agentId,
              secretName: name,
              failure,
            },
            a,
          );
          console.error("[botod] approval.secret_allowlist_read_failed", {
            approvalId: a.id,
            agentId: a.agentId,
            secretName: name,
            failure,
          });
          throw error;
        }
        this.vault.set(name, p.value, agentIds);
        this.broadcast("vault.changed", {});
        return this.finish(a.id, "approved", undefined, { decision: p.decision })!;
      }
      if (a.kind === "takeover")
        return this.finish(a.id, p.decision === "deny" ? "denied" : "done", undefined, {
          decision: p.decision,
        })!;
      if (a.appId && a.permission) {
        if (p.decision === "deny")
          return this.finish(a.id, "denied", undefined, { decision: "deny" })!;
        if (this.apps.get(a.appId).permissions[a.permission] === "off")
          return this.finish(a.id, "denied", undefined, {
            decision: "deny",
            requestedDecision: p.decision,
            reason: "permission_off",
          })!;
        if (p.decision === "always" && !isSensitivePermission(a.permission)) {
          const app = this.apps.get(a.appId);
          a.previousLevel = app.permissions[a.permission];
          try {
            await this.apps.update({ id: a.appId, permissions: { [a.permission]: "allow" } });
          } catch (error) {
            this.apps.restorePermission(a.appId, a.permission, a.previousLevel);
            throw error;
          }
          this.audit(
            "approval.permission_escalated",
            {
              approvalId: a.id,
              agentId: a.agentId,
              appId: a.appId,
              permission: a.permission,
              previousLevel: a.previousLevel,
            },
            a,
          );
        }
        if (p.decision === "task" && a.turnId && !isSensitivePermission(a.permission)) {
          const key = `${a.agentId}:${a.turnId}`;
          const grants = this.grants.get(key) ?? new Set<string>();
          grants.add(`${a.appId}:${a.permission}`);
          this.grants.set(key, grants);
        }
      } else if (p.decision === "always" && a.tool) {
        const rule: ApprovalRule = {
          id: crypto.randomUUID(),
          pattern: a.tool,
          action: "allow",
          agentId: a.agentId,
        };
        this.setRules([...this.rules(), rule]);
        this.audit(
          "approval.permission_escalated",
          { approvalId: a.id, agentId: a.agentId, ruleId: rule.id, pattern: rule.pattern },
          a,
        );
      }
      return this.finish(a.id, p.decision === "deny" ? "denied" : "approved", undefined, {
        decision: p.decision,
      })!;
    } catch (error) {
      this.finish(a.id, "denied", undefined, {
        requestedDecision: p.decision,
        reason: "respond_failed",
        failure: error instanceof RpcError ? error.code : (error as Error).name,
      });
      throw error;
    } finally {
      this.responding.delete(p.id);
    }
  }

  /** Ends approvals left by a finished turn. */
  onTurnEnded(agentId: string, turnId: string): void {
    this.grants.delete(`${agentId}:${turnId}`);
    for (const a of this.pending.values())
      if (a.agentId === agentId && a.turnId === turnId) this.finish(a.id, "expired");
  }

  /** Blocks until a tool call is allowed; throws when denied or expired. */
  async gate(agentId: string, tool: string, args: unknown, isAppTool: boolean): Promise<void> {
    const app = isAppTool ? this.apps.appForTool(tool) : undefined;
    if (isAppTool && !app) throw new RpcError("not_found", "app not found");
    const permission = classifyAppTool(tool);
    if (app?.permissions[permission] === "off") {
      this.audit("approval.auto_denied", {
        agentId,
        tool,
        appId: app.id,
        permission,
        reason: "permission_off",
      });
      throw new GateRejection("denied", `${app.name} não permite ${permission}`);
    }
    if (this.decide(agentId, tool, isAppTool) === "allow") return;
    const detail = JSON.stringify(args ?? {}, null, 2);
    const { approval } = await this.open(agentId, {
      kind: "tool",
      title: `Run ${tool}`,
      detail,
      tool,
      secretName: null,
      ...(app ? { appId: app.id, appName: app.name, permission } : {}),
    });
    if (approval.status === "approved") return;
    throw new GateRejection(
      approval.status === "expired" ? "expired" : "denied",
      approval.status === "expired"
        ? `the user did not approve ${tool} in time; do not retry it, report back and wait for instructions`
        : `the user declined ${tool}; do not retry it`,
    );
  }

  async requestSecret(
    agentId: string,
    name: string,
    label: string,
    reason: string,
  ): Promise<string> {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name) || /^(gateway|team|vmcred|email|app)\./.test(name))
      throw new Error("`name` must be a vault name like stripe.key (letters, digits, . _ -)");
    const { approval } = await this.open(agentId, {
      kind: "secret",
      title: label || name,
      detail: reason,
      tool: null,
      secretName: name,
    });
    if (approval.status !== "approved")
      return `the user did not provide ${name} (${approval.status})`;
    return `the user stored the secret in the vault as "${name}" and gave you access; use vault_get only when a command needs it and never print it`;
  }

  async requestTakeover(agentId: string, reason: string): Promise<string> {
    const { approval } = await this.open(agentId, {
      kind: "takeover",
      title: "Take over the bot browser",
      detail: reason,
      tool: null,
      secretName: null,
    });
    return approval.status === "done"
      ? "the user finished in the browser; take a new browser_snapshot and continue"
      : `the user did not take over (${approval.status}); stop and report back`;
  }
}
