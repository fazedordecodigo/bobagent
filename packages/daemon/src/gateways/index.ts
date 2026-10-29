import type { Database } from "bun:sqlite";
import type { Gateway, GatewayKind, GatewayStatus, Turn } from "@upbot/protocol";
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
    this.transports.get(id)?.stop();
    this.transports.delete(id);
    this.status.delete(id);
  }

  private sanitizeError(t: Transport, message: string, fallbackSecrets: string[] = []) {
    for (const secret of this.transportInfo.get(t)?.secrets ?? fallbackSecrets) {
      message = message.split(secret).join("[redacted]");
    }
    return message.slice(0, 500);
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
        this.status.set(id, {
          status,
          error: error === null ? null : this.sanitizeError(t, error, secrets),
          sendError: this.status.get(id)?.sendError ?? null,
        });
        this.emit(id);
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
  ) {
    if (!t) return;
    try {
      await t.send(chatId, text, replyTo);
    } catch (e) {
      const info = this.transportInfo.get(t);
      const message = this.sanitizeError(t, e instanceof Error ? e.message : "send failed");
      console.error(
        `[upbotd] gateway ${id} (${info?.kind ?? "unknown"}) send failed (${errorName(e)})`,
      );
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
    }
  }

  private onInbound(id: string, sourceTransport: Transport, m: Inbound) {
    const r = this.row(id);
    if (!r || !this.transports.has(id) || r.enabled !== 1) return;
    const allowed = JSON.parse(r.allowed_users) as string[];
    if (!allowed.includes(m.userId)) {
      void this.deliver(
        id,
        sourceTransport,
        m.chatId,
        `This UpBot gateway doesn't know you yet. Ask its owner to allow user id ${m.userId}.`,
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
      void this.deliver(
        id,
        sourceTransport,
        m.chatId,
        `UpBot could not deliver this: ${(e as Error).message}`,
        m.replyTo,
      );
    }
  }

  /** Posts the agent's final reply back to the chat the message came from. */
  onTurnEnded(turn: Turn, queueRow: { meta_json: string | null } | null) {
    const meta = parseQueueMeta(queueRow);
    if (!meta.gateway) return;
    const reply = this.chat.turnReplyText(turn);
    void this.deliver(
      meta.gateway.id,
      this.transports.get(meta.gateway.id),
      meta.gateway.chatId,
      reply.slice(0, MAX_REPLY),
      meta.gateway.replyTo,
    );
  }

  private emit(id: string): Gateway {
    const g = this.get(id);
    this.broadcast("gateway.updated", g);
    return g;
  }
}
