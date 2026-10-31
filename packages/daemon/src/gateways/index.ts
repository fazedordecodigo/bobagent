import type { Database } from "bun:sqlite";
import type { Gateway, GatewayKind, GatewayStatus, Turn } from "@boto/protocol";
import type { AgentStore } from "../agents";
import { type ChatStore, parseQueueMeta } from "../chat-store";
import type { Broadcast } from "../rpc";
import { RpcError } from "../runtime/agent-runtime";
import type { RuntimeManager } from "../runtime/runtime-manager";
import { GATEWAY_PREFIX, type Vault } from "../vault";
import type { Inbound, Transport, TransportHooks } from "./common";
import { DiscordTransport } from "./discord";
import { SlackTransport } from "./slack";
import { TelegramTransport } from "./telegram";

// Messaging gateways: Telegram (Bot API long polling), Slack (Socket Mode) and Discord
// (Gateway WebSocket) deliver messages from allowlisted users to an agent and post the
// agent's reply back. Tokens live in the vault as gateway.<id>.<field> (never shared with agents).

export const TOKEN_FIELDS: Record<GatewayKind, string[]> = {
  telegram: ["botToken"],
  slack: ["botToken", "appToken"],
  discord: ["botToken"],
};
const MAX_REPLY = 20_000;
const errorName = (e: unknown) =>
  e instanceof Error && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "unknown";

const tokenName = (id: string, field: string) => `${GATEWAY_PREFIX}${id}.${field}`;

export function safeGatewayError(message: string, secrets: readonly string[]): string {
  let safe = message;
  for (const secret of secrets) if (secret) safe = safe.replaceAll(secret, "[redacted]");
  safe = safe
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted]")
    .replace(/\bx(?:ox[a-z]|app)-[A-Za-z0-9-]+/g, "[redacted]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/g, (url) => {
      try {
        return `${new URL(url).origin}/[redacted]`;
      } catch {
        return "<url>";
      }
    })
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ");
  return safe.length > 300 ? `${safe.slice(0, 300)}…` : safe;
}

// Emit bounded, redacted operational telemetry as one JSON line on stderr.
function logGateway(event: string, ctx: Record<string, unknown>) {
  console.error("[botod]", event, JSON.stringify(ctx));
}

type Row = {
  id: string;
  kind: GatewayKind;
  name: string;
  agent_id: string;
  allowed_users: string;
  enabled: number;
  created_at: number;
  updated_at: number;
};

function defaultTransport(
  kind: GatewayKind,
  tokens: Record<string, string>,
  hooks: TransportHooks,
): Transport {
  return kind === "telegram"
    ? new TelegramTransport(tokens.botToken!, hooks)
    : kind === "slack"
      ? new SlackTransport(tokens.botToken!, tokens.appToken!, hooks)
      : new DiscordTransport(tokens.botToken!, hooks);
}

export class GatewayService {
  private transports = new Map<string, Transport>();
  private transportInfo = new WeakMap<Transport, { kind: GatewayKind; secrets: string[] }>();
  private status = new Map<
    string,
    { status: GatewayStatus; error: string | null; sendError: string | null }
  >();
  private downSince = new Map<string, number>();
  private errorAttempts = new Map<string, number>();

  constructor(
    private db: Database,
    private agents: AgentStore,
    private chat: ChatStore,
    private runtimes: () => RuntimeManager,
    private vault: Vault,
    private broadcast: Broadcast,
    private createTransport: (
      kind: GatewayKind,
      tokens: Record<string, string>,
      hooks: TransportHooks,
    ) => Transport = defaultTransport,
  ) {}

  private row(id: string): Row | null {
    return this.db
      .query("SELECT * FROM gateways WHERE id = ? AND deleted_at IS NULL")
      .get(id) as Row | null;
  }

  private toGateway(r: Row): Gateway {
    const s = this.status.get(r.id);
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      agentId: r.agent_id,
      allowedUsers: JSON.parse(r.allowed_users) as string[],
      enabled: r.enabled === 1,
      status: r.enabled === 1 ? (s?.status ?? "connecting") : "stopped",
      error: r.enabled === 1 ? (s?.error ?? s?.sendError ?? null) : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  list(): Gateway[] {
    const rows = this.db
      .query("SELECT * FROM gateways WHERE deleted_at IS NULL ORDER BY created_at ASC")
      .all() as Row[];
    return rows.map((r) => this.toGateway(r));
  }

  get(id: string): Gateway {
    const r = this.row(id);
    if (!r) throw new RpcError("not_found", "gateway not found");
    return this.toGateway(r);
  }

  private saveTokens(
    id: string,
    kind: GatewayKind,
    tokens: Record<string, string>,
    required: boolean,
  ) {
    for (const f of TOKEN_FIELDS[kind]) {
      const v = tokens[f]?.trim();
      if (v) this.vault.set(tokenName(id, f), v, []);
      else if (required)
        throw new RpcError("bad_request", `${kind} needs ${TOKEN_FIELDS[kind].join(" and ")}`);
    }
  }

  private tokens(id: string, kind: GatewayKind): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of TOKEN_FIELDS[kind]) out[f] = this.vault.revealInternal(tokenName(id, f));
    return out;
  }

  create(p: {
    kind: GatewayKind;
    name: string;
    agentId: string;
    tokens: Record<string, string>;
    allowedUsers?: string[] | undefined;
    enabled?: boolean | undefined;
  }): Gateway {
    if (!this.agents.get(p.agentId)) throw new RpcError("not_found", "agent not found");
    const id = crypto.randomUUID().slice(0, 12);
    this.saveTokens(id, p.kind, p.tokens, true);
    const now = Date.now();
    this.db
      .query(
        "INSERT INTO gateways (id, kind, name, agent_id, allowed_users, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        p.kind,
        p.name,
        p.agentId,
        JSON.stringify(p.allowedUsers ?? []),
        p.enabled === false ? 0 : 1,
        now,
        now,
      );
    this.restart(id);
    return this.emit(id);
  }

  update(p: {
    id: string;
    name?: string | undefined;
    agentId?: string | undefined;
    tokens?: Record<string, string> | undefined;
    allowedUsers?: string[] | undefined;
    enabled?: boolean | undefined;
  }): Gateway {
    const r = this.row(p.id);
    if (!r) throw new RpcError("not_found", "gateway not found");
    if (p.agentId && !this.agents.get(p.agentId))
      throw new RpcError("not_found", "agent not found");
    if (p.tokens) this.saveTokens(p.id, r.kind, p.tokens, false);
    this.db
      .query(
        "UPDATE gateways SET name = ?, agent_id = ?, allowed_users = ?, enabled = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        p.name ?? r.name,
        p.agentId ?? r.agent_id,
        p.allowedUsers ? JSON.stringify([...new Set(p.allowedUsers.map(String))]) : r.allowed_users,
        p.enabled === undefined ? r.enabled : p.enabled ? 1 : 0,
        Date.now(),
        p.id,
      );
    if (p.tokens || p.enabled !== undefined) this.restart(p.id);
    return this.emit(p.id);
  }

  delete(id: string): void {
    const r = this.row(id);
    if (!r) throw new RpcError("not_found", "gateway not found");
    this.stopTransport(id);
    this.db.query("UPDATE gateways SET deleted_at = ? WHERE id = ?").run(Date.now(), id);
    for (const f of TOKEN_FIELDS[r.kind]) this.vault.delete(tokenName(r.id, f));
    this.broadcast("gateway.deleted", { id });
  }

  startAll(): void {
    for (const g of this.list()) if (g.enabled) this.restart(g.id);
  }

  stopAll(): void {
    for (const id of [...this.transports.keys()]) this.stopTransport(id);
  }

  private stopTransport(id: string) {
    const t = this.transports.get(id);
    t?.stop();
    this.transports.delete(id);
    this.status.delete(id);
    this.downSince.delete(id);
    this.errorAttempts.delete(id);
  }

  // Status transitions go through here so flapping transports don't spam stderr:
  // an error is logged once per distinct message, every retry is still counted
  // and the reconnect log carries downtime and attempt count.
  private logStatus(
    id: string,
    kind: GatewayKind,
    prev: { status: GatewayStatus; error: string | null } | undefined,
    status: GatewayStatus,
    error: string | null,
  ) {
    if (prev?.status === "connected" && (status === "error" || status === "connecting")) {
      if (!this.downSince.has(id)) this.downSince.set(id, Date.now());
      logGateway("gateway.disconnected", { gatewayId: id, kind });
    }
    if (status === "error") {
      if (!this.downSince.has(id)) this.downSince.set(id, Date.now());
      this.errorAttempts.set(id, (this.errorAttempts.get(id) ?? 0) + 1);
      if (prev?.status === "error" && prev.error === error) return;
      logGateway("gateway.error", { gatewayId: id, kind, error });
    } else if (status === "connected") {
      const since = this.downSince.get(id);
      const attempts = this.errorAttempts.get(id) ?? 0;
      this.downSince.delete(id);
      this.errorAttempts.delete(id);
      if (since === undefined) {
        logGateway("gateway.connected", { gatewayId: id, kind });
      } else {
        logGateway("gateway.connected", {
          gatewayId: id,
          kind,
          downtimeMs: Date.now() - since,
          errorAttempts: attempts,
        });
      }
    }
  }

  private sanitizeError(t: Transport, message: string, fallbackSecrets: string[] = []) {
    return safeGatewayError(message, this.transportInfo.get(t)?.secrets ?? fallbackSecrets);
  }

  private restart(id: string) {
    this.stopTransport(id);
    const r = this.row(id);
    if (!r || r.enabled !== 1) return;
    const tokens = this.tokens(id, r.kind);
    const secrets = Object.values(tokens).filter((value) => value.length > 0);
    const hooks: TransportHooks = {
      onMessage: (m) => this.onInbound(id, t, m),
      onStatus: (status, error = null) => {
        if (this.transports.get(id) !== t) return;
        const safeError = error === null ? null : this.sanitizeError(t, error, secrets);
        const prev = this.status.get(id);
        this.status.set(id, {
          status,
          error: safeError,
          sendError: prev?.sendError ?? null,
        });
        this.emit(id);
        this.logStatus(id, r.kind, prev, status, safeError);
      },
    };
    const t = this.createTransport(r.kind, tokens, hooks);
    this.transports.set(id, t);
    this.transportInfo.set(t, {
      kind: r.kind,
      secrets,
    });
    this.status.set(id, { status: "connecting", error: null, sendError: null });
    t.start();
  }

  /**
   * Posts through the gateway transport and reports redacted send errors separately.
   */
  private async deliver(
    id: string,
    t: Transport | undefined,
    chatId: string,
    text: string,
    replyTo?: string,
    ctx: Record<string, unknown> = {},
  ) {
    if (!t) return;
    const kind = this.transportInfo.get(t)?.kind ?? this.row(id)?.kind ?? null;
    try {
      await t.send(chatId, text, replyTo);
    } catch (e) {
      const message = this.sanitizeError(t, e instanceof Error ? e.message : "send failed");
      logGateway("gateway.send_failed", {
        gatewayId: id,
        kind,
        ...ctx,
        error: message,
        name: errorName(e),
      });
      if (this.transports.get(id) !== t) return;
      const status = this.status.get(id) ?? {
        status: "error" as GatewayStatus,
        error: null,
        sendError: null,
      };
      this.status.set(id, { ...status, sendError: message });
      this.emit(id);
      return;
    }
    if (this.transports.get(id) !== t) return;
    const s = this.status.get(id);
    if (s?.sendError) {
      this.status.set(id, { ...s, sendError: null });
      this.emit(id);
      logGateway("gateway.send_recovered", { gatewayId: id, kind });
    }
  }

  private onInbound(id: string, sourceTransport: Transport, m: Inbound) {
    const r = this.row(id);
    if (!r || !this.transports.has(id) || r.enabled !== 1) return;
    const allowed = JSON.parse(r.allowed_users) as string[];
    if (!allowed.includes(m.userId)) {
      const validUserId = /^[A-Za-z0-9_.:@-]{1,128}$/.test(m.userId);
      logGateway("gateway.unauthorized_user", {
        gatewayId: id,
        kind: r.kind,
        userId: validUserId ? m.userId : null,
        ...(!validUserId ? { userIdInvalid: true } : {}),
      });
      void this.deliver(
        id,
        sourceTransport,
        m.chatId,
        `This Boto gateway doesn't know you yet. Ask its owner to allow user id ${m.userId}.`,
        m.replyTo,
      );
      return;
    }
    // "@AgentName message" routes to another agent; otherwise the gateway's default agent
    let agentId = r.agent_id;
    let text = m.text.trim();
    const at = /^@(\S+)\s+([\s\S]+)$/.exec(text);
    if (at) {
      const target = this.agents
        .list()
        .find((a) => a.name.toLowerCase().replace(/\s+/g, "") === at[1]!.toLowerCase());
      if (target) {
        agentId = target.id;
        text = at[2]!;
      }
    }
    if (!text) return;
    const source = {
      id,
      kind: r.kind,
      name: r.name,
      chatId: m.chatId,
      userId: m.userId,
      userName: m.userName,
    };
    const prompt = `<external_message source="${r.kind}" gateway="${r.name.replace(/[<>"&]/g, "")}" from="${m.userName.replace(/[<>"&]/g, "")}">\n${text}\n</external_message>\nYour final reply is sent back to them in ${r.kind}; keep it concise.`;
    try {
      this.runtimes().sendFrom(agentId, text, {
        agentId: null,
        hops: 0,
        prompt,
        meta: { gateway: { ...source, ...(m.replyTo ? { replyTo: m.replyTo } : {}) } },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logGateway("gateway.deliver_failed", {
        gatewayId: id,
        kind: r.kind,
        agentId,
        error: this.sanitizeError(sourceTransport, message),
      });
      void this.deliver(
        id,
        sourceTransport,
        m.chatId,
        `Boto could not deliver this: ${message}`,
        m.replyTo,
        { agentId },
      );
    }
  }

  /** Posts the agent's final reply back to the chat the message came from. */
  onTurnEnded(turn: Turn, queueRow: { meta_json: string | null } | null) {
    const meta = parseQueueMeta(queueRow);
    if (!meta.gateway) return;
    const gw = meta.gateway;
    const reply = this.chat.turnReplyText(turn);
    void this.deliver(
      gw.id,
      this.transports.get(gw.id),
      gw.chatId,
      reply.slice(0, MAX_REPLY),
      gw.replyTo,
      { agentId: turn.agentId, turnId: turn.id },
    );
  }

  private emit(id: string): Gateway {
    const g = this.get(id);
    this.broadcast("gateway.updated", g);
    return g;
  }
}
