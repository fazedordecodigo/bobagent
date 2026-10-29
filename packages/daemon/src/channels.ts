import type { Database } from "bun:sqlite";
import type { Channel, ChannelMessage, Turn } from "@upbot/protocol";
import type { AgentStore } from "./agents";
import { MAX_HOPS } from "./bridge";
import type { ChatStore } from "./chat-store";
import type { Broadcast } from "./rpc";
import { RpcError, xmlAttr } from "./runtime/agent-runtime";
import type { RuntimeManager } from "./runtime/runtime-manager";

// Channels: a shared conversation between the user and several agents. User posts go
// to the channel owner; the owner can delegate to members (upbot `delegate` tool).
// When a channel-triggered turn ends, the agent's reply is posted to the channel, and
// a member's reply is forwarded to the owner.

const TRANSCRIPT_MESSAGES = 20;

type ChannelRow = {
  id: string;
  name: string;
  owner_agent_id: string | null;
  status: Channel["status"];
  created_at: number;
  updated_at: number;
};

type MessageRow = {
  id: string;
  channel_id: string;
  seq: number;
  author_kind: ChannelMessage["authorKind"];
  author_agent_id: string | null;
  text: string;
  created_at: number;
  reply_to?: string | null;
};

function rowToMessage(r: MessageRow): ChannelMessage {
  return {
    id: r.id,
    channelId: r.channel_id,
    seq: r.seq,
    authorKind: r.author_kind,
    authorAgentId: r.author_agent_id,
    text: r.text,
    createdAt: r.created_at,
    replyTo: r.reply_to ?? null,
  };
}

export class ChannelService {
  constructor(
    private db: Database,
    private agents: AgentStore,
    private chat: ChatStore,
    private runtimes: () => RuntimeManager,
    private broadcast: Broadcast,
  ) {}

  private row(id: string): ChannelRow | null {
    return this.db.query("SELECT * FROM channels WHERE id = ?").get(id) as ChannelRow | null;
  }

  private members(id: string): string[] {
    const rows = this.db
      .query(
        `SELECT m.agent_id FROM channel_members m JOIN agents a ON a.id = m.agent_id
         WHERE m.channel_id = ? AND a.deleted_at IS NULL ORDER BY m.rowid ASC`,
      )
      .all(id) as { agent_id: string }[];
    return rows.map((r) => r.agent_id);
  }

  private toChannel(r: ChannelRow): Channel {
    return {
      id: r.id,
      name: r.name,
      ownerId: r.owner_agent_id,
      memberIds: this.members(r.id),
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  get(id: string): Channel {
    const r = this.row(id);
    if (!r) throw new RpcError("not_found", "channel not found");
    return this.toChannel(r);
  }

  list(includeArchived = false): Channel[] {
    const rows = this.db
      .query(
        includeArchived
          ? "SELECT * FROM channels ORDER BY created_at ASC"
          : "SELECT * FROM channels WHERE status != 'archived' ORDER BY created_at ASC",
      )
      .all() as ChannelRow[];
    return rows.map((r) => this.toChannel(r));
  }

  forAgent(agentId: string): Channel[] {
    return this.list().filter((c) => c.memberIds.includes(agentId));
  }

  private checkMembers(memberIds: string[], ownerId: string | null) {
    for (const id of memberIds) {
      if (!this.agents.get(id)) throw new RpcError("not_found", `agent ${id} not found`);
    }
    if (ownerId && !memberIds.includes(ownerId)) {
      throw new RpcError("bad_request", "the owner must be a channel member");
    }
  }

  create(p: { name: string; memberIds: string[]; ownerId?: string | null }): Channel {
    const memberIds = [...new Set(p.memberIds)];
    const ownerId = p.ownerId ?? memberIds[0] ?? null;
    this.checkMembers(memberIds, ownerId);
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .query(
        "INSERT INTO channels (id, name, owner_agent_id, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
      )
      .run(id, p.name, ownerId, now, now);
    const ins = this.db.query("INSERT INTO channel_members (channel_id, agent_id) VALUES (?, ?)");
    for (const m of memberIds) ins.run(id, m);
    const ch = this.get(id);
    this.broadcast("channel.created", ch);
    return ch;
  }

  private update(
    id: string,
    fields: { status?: Channel["status"]; ownerId?: string | null },
  ): Channel {
    const r = this.row(id);
    if (!r) throw new RpcError("not_found", "channel not found");
    this.db
      .query("UPDATE channels SET status = ?, owner_agent_id = ?, updated_at = ? WHERE id = ?")
      .run(
        fields.status ?? r.status,
        fields.ownerId === undefined ? r.owner_agent_id : fields.ownerId,
        Date.now(),
        id,
      );
    const ch = this.get(id);
    this.broadcast("channel.updated", ch);
    return ch;
  }

  history(channelId: string, limit = 200): { channel: Channel; messages: ChannelMessage[] } {
    const channel = this.get(channelId);
    const rows = this.db
      .query("SELECT * FROM channel_messages WHERE channel_id = ? ORDER BY seq DESC LIMIT ?")
      .all(channelId, limit) as MessageRow[];
    return { channel, messages: rows.reverse().map(rowToMessage) };
  }

  private append(
    channelId: string,
    authorKind: ChannelMessage["authorKind"],
    authorAgentId: string | null,
    text: string,
    replyTo: string | null = null,
  ): ChannelMessage {
    const seqRow = this.db
      .query("SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM channel_messages WHERE channel_id = ?")
      .get(channelId) as { s: number };
    const row: MessageRow = {
      id: crypto.randomUUID(),
      channel_id: channelId,
      seq: seqRow.s,
      author_kind: authorKind,
      author_agent_id: authorAgentId,
      text,
      created_at: Date.now(),
      reply_to: replyTo,
    };
    this.db
      .query(
        "INSERT INTO channel_messages (id, channel_id, seq, author_kind, author_agent_id, text, created_at, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.id,
        row.channel_id,
        row.seq,
        row.author_kind,
        row.author_agent_id,
        row.text,
        row.created_at,
        row.reply_to ?? null,
      );
    const msg = rowToMessage(row);
    this.broadcast("channel.message", msg);
    return msg;
  }

  private name(agentId: string | null): string {
    return (agentId && this.agents.get(agentId)?.name) || "deleted agent";
  }

  private transcript(channelId: string): string {
    const { messages } = this.history(channelId, TRANSCRIPT_MESSAGES);
    return messages
      .map((m) => {
        const who =
          m.authorKind === "user"
            ? "user"
            : m.authorKind === "system"
              ? "system"
              : this.name(m.authorAgentId);
        return `[${who}] ${m.text}`;
      })
      .join("\n");
  }

  /** Provider prompt for a channel delivery. */
  private framePrompt(ch: Channel, agentId: string, intro: string, text: string): string {
    const role = ch.ownerId === agentId ? "owner" : "member";
    const members = ch.memberIds.map((id) => this.name(id)).join(", ");
    const ownerHint =
      role === "owner"
        ? `You own this channel's task. Delegate work to members with the upbot delegate tool (channel="${xmlAttr(ch.name)}"), then combine their results.`
        : "You are a member helping the channel owner. Your final reply is posted to the channel automatically.";
    return `<channel_context name="${xmlAttr(ch.name)}" id="${ch.id}" role="${role}" members="${xmlAttr(members)}">
${ownerHint}
Your final reply in this turn is posted to the channel.
<recent_messages>
${this.transcript(ch.id)}
</recent_messages>
</channel_context>
${intro}
${text}`;
  }

  private deliver(
    ch: Channel,
    agentId: string,
    display: string,
    prompt: string,
    from: string | null,
    hops: number,
  ) {
    this.runtimes().sendFrom(agentId, display, { agentId: from, hops, channelId: ch.id, prompt });
  }

  private requireActive(channelId: string): Channel {
    const ch = this.get(channelId);
    if (ch.status !== "active") throw new RpcError("bad_request", `channel is ${ch.status}`);
    return ch;
  }

  private message(channelId: string, id: string): ChannelMessage {
    const r = this.db
      .query("SELECT * FROM channel_messages WHERE id = ? AND channel_id = ?")
      .get(id, channelId) as MessageRow | null;
    if (!r) throw new RpcError("not_found", "message not found in this channel");
    return rowToMessage(r);
  }

  /** Members addressed with @Name, or every member for @everyone / @all. */
  mentioned(ch: Channel, text: string): { ids: string[]; everyone: boolean } {
    if (/(^|\s)@(everyone|all)(?![\w-])/i.test(text))
      return { ids: [...ch.memberIds], everyone: true };
    const lower = text.toLowerCase();
    const ids = ch.memberIds.filter((id) => {
      const n = this.agents.get(id)?.name;
      if (!n) return false;
      const re = new RegExp(
        `(^|\\s)@${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`,
      );
      return re.test(lower);
    });
    return { ids, everyone: false };
  }

  post(channelId: string, text: string, replyTo?: string): { messageId: string } {
    const ch = this.requireActive(channelId);
    if (!ch.memberIds.length) throw new RpcError("bad_request", "channel has no members");
    const quoted = replyTo ? this.message(ch.id, replyTo) : null;
    const { ids, everyone } = this.mentioned(ch, text);
    const repliedBot =
      quoted?.authorKind === "agent" &&
      quoted.authorAgentId &&
      ch.memberIds.includes(quoted.authorAgentId)
        ? quoted.authorAgentId
        : null;
    const targets = ids.length ? ids : [repliedBot ?? ch.ownerId ?? (ch.memberIds[0] as string)];
    const intro = everyone
      ? "The user addressed everyone in the channel:"
      : ids.length
        ? "The user mentioned you:"
        : repliedBot
          ? "The user replied to your message:"
          : "The user posted:";
    const msg = this.append(ch.id, "user", null, text, quoted?.id ?? null);
    const quote = quoted
      ? `<in_reply_to author="${xmlAttr(quoted.authorKind === "agent" ? this.name(quoted.authorAgentId) : quoted.authorKind)}">\n${quoted.text.slice(0, 4000)}\n</in_reply_to>\n`
      : "";
    for (const t of targets)
      this.deliver(ch, t, text, this.framePrompt(ch, t, intro, quote + text), null, 0);
    return { messageId: msg.id };
  }

  /** Bridge: `delegate` from an agent in the channel. */
  delegate(
    fromAgentId: string,
    channelKey: string,
    to: string,
    task: string,
    hops: number,
  ): string {
    const ch = this.resolveForAgent(fromAgentId, channelKey);
    if (ch.status !== "active") throw new Error(`channel is ${ch.status}`);
    const target = ch.memberIds
      .map((id) => this.agents.get(id))
      .find((a) => a && (a.id === to || a.name.toLowerCase() === to.trim().toLowerCase()));
    if (!target) throw new Error(`"${to}" is not a member of channel ${ch.name}`);
    if (target.id === fromAgentId) throw new Error("you cannot delegate to yourself");
    this.append(ch.id, "agent", fromAgentId, `@${target.name} ${task}`);
    const intro = `${this.name(fromAgentId)} delegated this task to you:`;
    this.deliver(
      ch,
      target.id,
      task,
      this.framePrompt(ch, target.id, intro, task),
      fromAgentId,
      hops,
    );
    return `delegated to ${target.name} in ${ch.name}`;
  }

  resolveForAgent(agentId: string, key: string): Channel {
    const mine = this.forAgent(agentId);
    const k = key.trim().toLowerCase();
    const ch = mine.find((c) => c.id === key) ?? mine.find((c) => c.name.toLowerCase() === k);
    if (!ch) throw new Error(`you are not a member of a channel named "${key}"`);
    return ch;
  }

  /** Called for every turn.ended event. */
  onTurnEnded(
    turn: Turn,
    queueRow: { channel_id: string | null; hops: number; from_agent_id?: string | null } | null,
  ) {
    if (!queueRow?.channel_id) return;
    const r = this.row(queueRow.channel_id);
    if (!r || r.status !== "active") return;
    const ch = this.toChannel(r);
    if (turn.status === "failed") {
      this.append(
        ch.id,
        "system",
        null,
        `${this.name(turn.agentId)} failed: ${turn.error ?? "unknown error"}`,
      );
      return;
    }
    if (turn.status !== "completed") return;
    const reply = this.chat.finalReply(turn.id);
    if (!reply) return;
    this.append(ch.id, "agent", turn.agentId, reply);
    const hops = queueRow.hops + 1;
    // a member's reply goes back to the owner only when the owner (or another bot) asked
    if (
      queueRow.from_agent_id &&
      ch.ownerId &&
      ch.ownerId !== turn.agentId &&
      ch.memberIds.includes(ch.ownerId) &&
      hops <= MAX_HOPS
    ) {
      const intro = `${this.name(turn.agentId)} replied in the channel:`;
      this.deliver(
        ch,
        ch.ownerId,
        reply,
        this.framePrompt(ch, ch.ownerId, intro, reply),
        turn.agentId,
        hops,
      );
    }
  }

  stop(channelId: string): Channel {
    const ch = this.get(channelId);
    if (ch.status === "archived") throw new RpcError("bad_request", "channel is archived");
    this.halt(ch);
    const out = this.update(channelId, { status: "stopped" });
    this.append(channelId, "system", null, "Channel stopped by the user.");
    return out;
  }

  private halt(ch: Channel) {
    this.db
      .query("UPDATE queue SET status = 'removed' WHERE channel_id = ? AND status = 'queued'")
      .run(ch.id);
    this.runtimes().cancelChannelTurns(ch.id);
  }

  resume(channelId: string): Channel {
    const ch = this.get(channelId);
    if (ch.status === "archived")
      throw new RpcError("bad_request", "channel is archived; restore it first");
    const out = this.update(channelId, { status: "active" });
    this.append(channelId, "system", null, "Channel resumed.");
    return out;
  }

  reassign(channelId: string, ownerId: string): Channel {
    const ch = this.get(channelId);
    if (!ch.memberIds.includes(ownerId))
      throw new RpcError("bad_request", "the owner must be a channel member");
    const out = this.update(channelId, { ownerId });
    this.append(channelId, "system", null, `Owner is now ${this.name(ownerId)}.`);
    return out;
  }

  archive(channelId: string): Channel {
    const ch = this.get(channelId);
    this.halt(ch);
    return this.update(channelId, { status: "archived" });
  }

  restore(channelId: string): Channel {
    this.get(channelId);
    return this.update(channelId, { status: "active" });
  }
}
