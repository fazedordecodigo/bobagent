import type { Database } from "bun:sqlite";
import type { TeamMember, TeamMessage, TeamStatus, Turn } from "@upbot/protocol";
import type { AgentStore } from "./agents";
import type { ChatStore } from "./chat-store";
import type { Broadcast } from "./rpc";
import { RpcError } from "./runtime/agent-runtime";
import type { RuntimeManager } from "./runtime/runtime-manager";
import type { Vault } from "./vault";

// Team client: connects this daemon to a UpBot relay (packages/relay) so teammates can
// message the agents you share, and you can message theirs. Replies are each agent's final
// answer for that turn. The member token lives in the vault as team.token.

type Config = { url: string; sharedAgentIds: string[] };
type MsgRow = {
  id: string;
  request_id: string;
  direction: "out" | "in";
  member_id: string;
  member_name: string;
  agent_id: string;
  agent_name: string;
  text: string;
  reply: string | null;
  status: "pending" | "completed" | "failed";
  created_at: number;
};

// Relay-provided ids are untrusted: log them only when they look like ids.
const logId = (v: unknown) =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : "invalid";

// The relay has no delivery ack, so an `out` request whose reply never comes (e.g. the relay
// dropped it because we were offline) fails after this TTL; a late reply still overwrites it.
const REPLY_TTL_MS = (() => {
  const v = Number(process.env.UPBOT_TEAM_REPLY_TTL_MS);
  return v > 0 ? v : 30 * 60_000;
})();
const EXPIRED_REPLY = "No reply from the teammate in time; the relay may have dropped it.";

const toMessage = (r: MsgRow): TeamMessage => ({
  id: r.id,
  requestId: r.request_id,
  direction: r.direction,
  memberId: r.member_id,
  memberName: r.member_name,
  agentId: r.agent_id,
  agentName: r.agent_name,
  text: r.text,
  reply: r.reply,
  status: r.status,
  createdAt: r.created_at,
});

export class TeamClient {
  private ws: WebSocket | null = null;
  private connected = false;
  private error: string | null = null;
  private me: { id: string; name: string } | null = null;
  private roster: TeamMember[] = [];
  private retry: ReturnType<typeof setTimeout> | null = null;
  private expiry: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: Database,
    private agents: AgentStore,
    private chat: ChatStore,
    private runtimes: () => RuntimeManager,
    private vault: Vault,
    private broadcast: Broadcast,
  ) {}

  private config(): Config | null {
    const r = this.db.query("SELECT value FROM settings WHERE key = 'team'").get() as {
      value: string;
    } | null;
    return r ? (JSON.parse(r.value) as Config) : null;
  }

  private setConfig(c: Config | null) {
    if (c)
      this.db
        .query("INSERT OR REPLACE INTO settings (key, value) VALUES ('team', ?)")
        .run(JSON.stringify(c));
    else this.db.query("DELETE FROM settings WHERE key = 'team'").run();
  }

  status(): TeamStatus {
    const c = this.config();
    return {
      configured: c !== null,
      url: c?.url ?? null,
      connected: this.connected,
      error: this.error,
      me: this.me,
      members: this.roster,
      sharedAgentIds: c?.sharedAgentIds ?? [],
    };
  }

  private emit() {
    this.broadcast("team.updated", this.status());
  }

  start() {
    this.expirePending();
    this.expiry ??= setInterval(
      () => this.expirePending(),
      Math.max(100, Math.min(REPLY_TTL_MS / 2, 60_000)),
    );
    this.expiry.unref?.();
    if (this.config()) this.open(1000);
  }

  private expirePending() {
    const rows = this.db
      .query(
        "SELECT id FROM team_messages WHERE direction = 'out' AND status = 'pending' AND created_at <= ?",
      )
      .all(Date.now() - REPLY_TTL_MS) as { id: string }[];
    for (const { id } of rows) {
      this.db
        .query(
          "UPDATE team_messages SET reply = ?, status = 'failed' WHERE id = ? AND status = 'pending'",
        )
        .run(EXPIRED_REPLY, id);
      this.emitRow(id);
    }
  }

  connect(url: string, token: string): TeamStatus {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new RpcError("bad_request", "invalid relay URL");
    }
    if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol))
      throw new RpcError("bad_request", "invalid relay URL");
    this.vault.set("team.token", token.trim(), []);
    this.setConfig({
      url: u.href.replace(/\/$/, ""),
      sharedAgentIds: this.config()?.sharedAgentIds ?? [],
    });
    this.close();
    this.open(1000);
    return this.status();
  }

  disconnect(): void {
    this.close();
    this.setConfig(null);
    this.vault.delete("team.token");
    this.roster = [];
    this.me = null;
    this.error = null;
    this.emit();
  }

  share(agentIds: string[]): TeamStatus {
    const c = this.config();
    if (!c) throw new RpcError("bad_request", "join a team first");
    for (const id of agentIds)
      if (!this.agents.get(id)) throw new RpcError("not_found", "agent not found");
    this.setConfig({ ...c, sharedAgentIds: [...new Set(agentIds)] });
    this.sendShare();
    this.emit();
    return this.status();
  }

  messages(): TeamMessage[] {
    const rows = this.db
      .query("SELECT * FROM team_messages ORDER BY created_at DESC, rowid DESC LIMIT 200")
      .all() as MsgRow[];
    return rows.reverse().map(toMessage);
  }

  send(memberId: string, agentId: string, text: string): TeamMessage {
    if (!this.connected || !this.ws)
      throw new RpcError("bad_request", "not connected to the team relay");
    const member = this.roster.find((m) => m.id === memberId);
    const agent = member?.agents.find((a) => a.id === agentId);
    if (!member || !agent) throw new RpcError("not_found", "that teammate agent is not available");
    const requestId = crypto.randomUUID();
    this.ws.send(JSON.stringify({ type: "send", requestId, to: { memberId, agentId }, text }));
    return this.record({
      requestId,
      direction: "out",
      memberId,
      memberName: member.name,
      agentId,
      agentName: agent.name,
      text,
    });
  }

  private record(m: {
    requestId: string;
    direction: "out" | "in";
    memberId: string;
    memberName: string;
    agentId: string;
    agentName: string;
    text: string;
  }): TeamMessage {
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO team_messages (id, request_id, direction, member_id, member_name, agent_id, agent_name, text, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        id,
        m.requestId,
        m.direction,
        m.memberId,
        m.memberName,
        m.agentId,
        m.agentName,
        m.text,
        Date.now(),
      );
    return this.emitMessage(m.requestId, m.direction)!;
  }

  private emitMessage(requestId: string, direction: "out" | "in"): TeamMessage | null {
    const r = this.db
      .query("SELECT * FROM team_messages WHERE request_id = ? AND direction = ?")
      .get(requestId, direction) as MsgRow | null;
    if (!r) return null;
    const msg = toMessage(r);
    this.broadcast("team.message", msg);
    return msg;
  }

  private emitRow(id: string) {
    const r = this.db.query("SELECT * FROM team_messages WHERE id = ?").get(id) as MsgRow | null;
    if (r) this.broadcast("team.message", toMessage(r));
  }

  private sendShare() {
    if (!this.connected || !this.ws) return;
    const ids = this.config()?.sharedAgentIds ?? [];
    const agents = ids
      .map((id) => this.agents.get(id))
      .filter((a) => a !== null)
      .map((a) => ({ id: a.id, name: a.name, provider: a.provider, avatar: a.avatar }));
    this.ws.send(JSON.stringify({ type: "share", agents }));
  }

  private close() {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    ws?.close();
  }

  private open(backoff: number) {
    const c = this.config();
    if (!c) return;
    let token: string;
    try {
      token = this.vault.revealInternal("team.token");
    } catch {
      this.error = "missing team token";
      this.emit();
      return;
    }
    const wsUrl = `${c.url.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.error = null;
      this.sendShare();
      this.emit();
    };
    ws.onmessage = (ev) => this.onFrame(String(ev.data));
    ws.onerror = () => {
      this.error = "could not reach the team relay";
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.roster = [];
      if (ev.code === 4001) this.error = "you were removed from the team";
      this.emit();
      if (ev.code === 4001) {
        console.error(`[upbotd] team relay closed code=${ev.code}`);
        return;
      }
      console.error(`[upbotd] team relay closed code=${ev.code} retryInMs=${backoff}`);
      this.retry = setTimeout(() => this.open(Math.min(backoff * 2, 30_000)), backoff);
    };
  }

  private onFrame(raw: string) {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (m.type === "welcome") {
      this.me = m.member as { id: string; name: string };
      this.emit();
    } else if (m.type === "roster") {
      this.roster = (m.members as TeamMember[]).filter((x) => x.id !== this.me?.id);
      this.emit();
    } else if (m.type === "incoming") {
      this.onIncoming(
        m as {
          requestId: string;
          from: { memberId: string; name: string };
          agentId: string;
          text: string;
        },
      );
    } else if (m.type === "reply") {
      const status = m.status === "failed" ? "failed" : "completed";
      this.db
        .query(
          "UPDATE team_messages SET reply = ?, status = ? WHERE request_id = ? AND direction = 'out'",
        )
        .run(String(m.text ?? ""), status, String(m.requestId));
      this.emitMessage(String(m.requestId), "out");
    }
  }

  private onIncoming(m: {
    requestId: string;
    from: { memberId: string; name: string };
    agentId: string;
    text: string;
  }) {
    const shared = this.config()?.sharedAgentIds ?? [];
    const agent = this.agents.get(m.agentId);
    const fail = (text: string, reason: string) => {
      console.error(
        `[upbotd] team request rejected requestId=${logId(m.requestId)} agentId=${logId(m.agentId)} reason=${reason}`,
      );
      this.ws?.send(
        JSON.stringify({
          type: "reply",
          requestId: m.requestId,
          toMemberId: m.from.memberId,
          status: "failed",
          text,
        }),
      );
    };
    if (!agent || !shared.includes(agent.id)) {
      fail("that agent is not shared", "not_shared");
      return;
    }
    const row = this.record({
      requestId: m.requestId,
      direction: "in",
      memberId: m.from.memberId,
      memberName: m.from.name,
      agentId: agent.id,
      agentName: agent.name,
      text: m.text,
    });
    const prompt = `<team_message from="${m.from.name.replace(/[<>"&]/g, "")}">\n${m.text}\n</team_message>\nA teammate sent this through the UpBot team relay; your final reply is sent back to them.`;
    try {
      this.runtimes().sendFrom(agent.id, m.text, {
        agentId: null,
        hops: 0,
        prompt,
        meta: {
          team: {
            requestId: m.requestId,
            memberId: m.from.memberId,
            memberName: m.from.name,
            agentId: agent.id,
          },
        },
      });
    } catch (e) {
      const text = (e as Error).message;
      const code = (e as { code?: unknown }).code;
      fail(text, typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : "error");
      this.db
        .query("UPDATE team_messages SET reply = ?, status = 'failed' WHERE id = ?")
        .run(text, row.id);
      this.emitRow(row.id);
    }
  }

  onTurnEnded(turn: Turn, queueRow: { meta_json: string | null } | null) {
    if (!queueRow?.meta_json) return;
    const meta = JSON.parse(queueRow.meta_json) as {
      team?: { requestId: string; memberId: string; agentId?: string };
    };
    if (!meta.team) return;
    const text =
      turn.status === "completed"
        ? this.chat
            .itemsForTurn(turn.id)
            .filter((i) => i.kind === "agent_message")
            .map((i) => ("text" in i ? i.text : ""))
            .join("\n\n")
            .trim() || "(no reply)"
        : turn.status === "failed"
          ? `The agent failed: ${turn.error ?? "unknown error"}`
          : "The agent stopped before replying.";
    const status = turn.status === "completed" ? "completed" : "failed";
    // Only means the reply was handed to an open relay socket: the relay has no delivery
    // ack and drops replies to members that are offline, so the teammate may never get it.
    const handedToRelay = this.connected && this.ws?.readyState === WebSocket.OPEN;
    if (handedToRelay) {
      this.ws?.send(
        JSON.stringify({
          type: "reply",
          requestId: meta.team.requestId,
          toMemberId: meta.team.memberId,
          status,
          text,
        }),
      );
    } else {
      console.error(
        `[upbotd] team reply not delivered requestId=${logId(meta.team.requestId)} agentId=${meta.team.agentId ? logId(meta.team.agentId) : "unknown"} memberId=${logId(meta.team.memberId)} status=${status}`,
      );
    }
    this.db
      .query(
        "UPDATE team_messages SET reply = ?, status = ? WHERE request_id = ? AND direction = 'in'",
      )
      .run(text, handedToRelay ? status : "failed", meta.team.requestId);
    this.emitMessage(meta.team.requestId, "in");
  }
}
