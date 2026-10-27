import type { Database } from "bun:sqlite";
import type { Approval, ApprovalDecision, ApprovalRule } from "@upbot/protocol";
import { RpcError } from "./runtime/agent-runtime";
import type { RuntimeManager } from "./runtime/runtime-manager";
import type { Vault } from "./vault";

// Approvals gate bot tool calls on the bridge. Rules match tool names (glob, `*`), per bot or
// for every bot; "ask" wins over "allow". Without a rule, connected-app tools that look like
// writes (create/update/delete/send/...) ask first unless a specific rule allows them.
// A lone wildcard allow never bypasses that connected-app write default. A pending approval blocks the tool call
// until the user decides; approvals raised by background work (routines, other bots,
// gateways, group chats) expire after UPBOT_APPROVAL_BACKGROUND_TTL_MS (default 10 min),
// others after UPBOT_APPROVAL_TTL_MS (default 60 min). The same queue carries secure secret
// requests (value goes straight to the vault) and browser take-over requests.

type Broadcast = (event: string, data: unknown) => void;
type Waiter = {
  resolve: (a: Approval, value?: string) => void;
  timer: ReturnType<typeof setTimeout>;
};

const WRITE_VERB =
  /(^|[_-])(create|update|delete|remove|send|post|publish|pay|charge|refund|transfer|merge|write|edit|archive|invite|cancel|move|rename|upload|patch|put|set|add|insert|close)/i;

function globRe(pattern: string): RegExp {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${esc}$`, "i");
}

export function legacyPattern(pattern: string): string {
  return pattern.includes("__") ? pattern.replace("__", "-").replace(/_{2,}/g, "_") : pattern;
}

const ms = (env: string | undefined, d: number) => (env && Number(env) > 0 ? Number(env) : d);

export class ApprovalService {
  private pending = new Map<string, Approval>();
  private waiters = new Map<string, Waiter>();
  private recent: Approval[] = [];

  constructor(
    private db: Database,
    private vault: Vault,
    private runtimes: () => RuntimeManager,
    private broadcast: Broadcast,
  ) {}

  rules(): ApprovalRule[] {
    const r = this.db.query("SELECT value FROM settings WHERE key = 'approval_rules'").get() as {
      value: string;
    } | null;
    return r ? (JSON.parse(r.value) as ApprovalRule[]) : [];
  }

  setRules(rules: ApprovalRule[]): ApprovalRule[] {
    this.db
      .query("INSERT OR REPLACE INTO settings (key, value) VALUES ('approval_rules', ?)")
      .run(JSON.stringify(rules));
    this.broadcast("approvals.rulesChanged", {});
    return rules;
  }

  /** "ask" | "allow" for a tool call, after rules and defaults. */
  decide(agentId: string, tool: string, isAppTool: boolean): "ask" | "allow" {
    const hits = this.rules().filter(
      (r) =>
        (r.agentId === null || r.agentId === agentId) &&
        (globRe(r.pattern).test(tool) || globRe(legacyPattern(r.pattern)).test(tool)),
    );
    if (hits.some((r) => r.action === "ask")) return "ask";
    if (hits.some((r) => r.action === "allow" && r.pattern !== "*")) return "allow";
    const op = isAppTool ? tool.slice(tool.indexOf("-") + 1) : "";
    return isAppTool && WRITE_VERB.test(op) ? "ask" : "allow";
  }

  list(agentId?: string): Approval[] {
    const all = [...this.pending.values(), ...this.recent];
    return all
      .filter((a) => !agentId || a.agentId === agentId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  private open(
    agentId: string,
    p: Pick<Approval, "kind" | "title" | "detail" | "tool" | "secretName">,
  ): Promise<{ approval: Approval; value?: string }> {
    const cur = this.runtimes().currentTurn(agentId);
    const background = cur?.background ?? true;
    const ttl = background
      ? ms(process.env.UPBOT_APPROVAL_BACKGROUND_TTL_MS, 10 * 60_000)
      : ms(process.env.UPBOT_APPROVAL_TTL_MS, 60 * 60_000);
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

  private finish(id: string, status: Approval["status"], value?: string): Approval | null {
    const a = this.pending.get(id);
    if (!a) return null;
    this.pending.delete(id);
    const done = { ...a, status };
    this.recent = [done, ...this.recent].slice(0, 50);
    const w = this.waiters.get(id);
    this.waiters.delete(id);
    if (w) {
      clearTimeout(w.timer);
      w.resolve(done, value);
    }
    this.broadcast("approval.updated", done);
    return done;
  }

  respond(p: { id: string; decision: ApprovalDecision; value?: string }): Approval {
    const a = this.pending.get(p.id);
    if (!a) throw new RpcError("not_found", "approval not found or no longer pending");
    if (a.kind === "secret") {
      if (p.decision === "deny") return this.finish(a.id, "denied")!;
      if (!p.value) throw new RpcError("bad_request", "enter the secret value");
      const name = a.secretName!;
      let agentIds = [a.agentId];
      try {
        const existing = this.vault.list().find((v) => v.name === name);
        if (existing) agentIds = [...new Set([...existing.agentIds, a.agentId])];
      } catch {}
      this.vault.set(name, p.value, agentIds);
      return this.finish(a.id, "approved")!;
    }
    if (a.kind === "takeover") return this.finish(a.id, p.decision === "deny" ? "denied" : "done")!;
    if (p.decision === "always" && a.tool) {
      this.setRules([
        ...this.rules(),
        { id: crypto.randomUUID(), pattern: a.tool, action: "allow", agentId: a.agentId },
      ]);
    }
    return this.finish(a.id, p.decision === "deny" ? "denied" : "approved")!;
  }

  /** Ends approvals left by a finished turn. */
  onTurnEnded(agentId: string, turnId: string): void {
    for (const a of this.pending.values())
      if (a.agentId === agentId && a.turnId === turnId) this.finish(a.id, "expired");
  }

  /** Blocks until a tool call is allowed; throws when denied or expired. */
  async gate(agentId: string, tool: string, args: unknown, isAppTool: boolean): Promise<void> {
    if (this.decide(agentId, tool, isAppTool) === "allow") return;
    const detail = JSON.stringify(args ?? {}, null, 2).slice(0, 4000);
    const { approval } = await this.open(agentId, {
      kind: "tool",
      title: `Run ${tool}`,
      detail,
      tool,
      secretName: null,
    });
    if (approval.status === "approved") return;
    throw new Error(
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
