import type { Database } from "bun:sqlite";
import {
  type AgentUsage,
  ChatAttachment,
  type ChatItem,
  GatewayKind,
  RoutineTrigger,
  type Turn,
  type TurnStatus,
} from "@upbot/protocol";
import { z } from "zod";

type TurnRow = {
  id: string;
  agent_id: string;
  status: string;
  queue_id: string | null;
  stop_reason: string | null;
  error: string | null;
  started_at: number;
  ended_at: number | null;
};

type ItemRow = {
  seq: number;
  id: string;
  agent_id: string;
  turn_id: string | null;
  kind: string;
  data_json: string;
  created_at: number;
  updated_at: number;
};

function rowToTurn(r: TurnRow): Turn {
  return {
    id: r.id,
    agentId: r.agent_id,
    queueId: r.queue_id,
    status: r.status as TurnStatus,
    stopReason: r.stop_reason,
    error: r.error,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

function rowToItem(r: ItemRow): ChatItem {
  const data = JSON.parse(r.data_json) as Record<string, unknown>;
  return {
    id: r.id,
    seq: r.seq,
    agentId: r.agent_id,
    turnId: r.turn_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    kind: r.kind,
    ...data,
  } as ChatItem;
}

export class ChatStore {
  constructor(private db: Database) {}

  interruptRunningTurns(): void {
    this.db
      .query("UPDATE turns SET status = 'interrupted', ended_at = ? WHERE status = 'running'")
      .run(Date.now());
  }

  createTurn(agentId: string, queueId: string | null = null): Turn {
    const id = crypto.randomUUID();
    this.db
      .query(
        "INSERT INTO turns (id, agent_id, status, queue_id, started_at) VALUES (?, ?, 'running', ?, ?)",
      )
      .run(id, agentId, queueId, Date.now());
    return this.getTurn(id)!;
  }

  getTurn(id: string): Turn | null {
    const r = this.db.query("SELECT * FROM turns WHERE id = ?").get(id) as TurnRow | null;
    return r ? rowToTurn(r) : null;
  }

  endTurn(
    id: string,
    status: Exclude<TurnStatus, "running">,
    stopReason: string | null,
    error: string | null,
  ): Turn {
    this.db
      .query("UPDATE turns SET status = ?, stop_reason = ?, error = ?, ended_at = ? WHERE id = ?")
      .run(status, stopReason, error, Date.now(), id);
    return this.getTurn(id)!;
  }

  turnsByIds(ids: string[]): Turn[] {
    if (ids.length === 0) return [];
    const marks = ids.map(() => "?").join(",");
    const rows = this.db
      .query(`SELECT * FROM turns WHERE id IN (${marks})`)
      .all(...ids) as TurnRow[];
    return rows.map(rowToTurn);
  }

  createItem(agentId: string, turnId: string | null, kind: string, data: object): ChatItem {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .query(
        "INSERT INTO items (id, agent_id, turn_id, kind, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, agentId, turnId, kind, JSON.stringify(data), now, now);
    return this.getItem(id)!;
  }

  getItem(id: string): ChatItem | null {
    const r = this.db.query("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | null;
    return r ? rowToItem(r) : null;
  }

  updateItemData(id: string, data: object): ChatItem {
    this.db
      .query("UPDATE items SET data_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(data), Date.now(), id);
    return this.getItem(id)!;
  }

  appendItemText(id: string, chunk: string): ChatItem {
    const item = this.getItem(id)!;
    const text = ((item as { text?: string }).text ?? "") + chunk;
    return this.updateItemData(id, { ...stripBase(item), text });
  }

  findToolCallItem(turnId: string, toolCallId: string): ChatItem | null {
    const r = this.db
      .query(
        "SELECT * FROM items WHERE turn_id = ? AND kind = 'tool_call' AND json_extract(data_json, '$.toolCallId') = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(turnId, toolCallId) as ItemRow | null;
    return r ? rowToItem(r) : null;
  }

  itemsForTurn(turnId: string): ChatItem[] {
    const rows = this.db
      .query("SELECT * FROM items WHERE turn_id = ? ORDER BY seq ASC")
      .all(turnId) as ItemRow[];
    return rows.map(rowToItem);
  }

  history(
    agentId: string,
    beforeSeq: number | undefined,
    limit: number,
  ): { items: ChatItem[]; hasMore: boolean } {
    const rows = (
      beforeSeq === undefined
        ? (this.db
            .query("SELECT * FROM items WHERE agent_id = ? ORDER BY seq DESC LIMIT ?")
            .all(agentId, limit + 1) as ItemRow[])
        : (this.db
            .query("SELECT * FROM items WHERE agent_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?")
            .all(agentId, beforeSeq, limit + 1) as ItemRow[])
    ) as ItemRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    return { items: page.map(rowToItem), hasMore };
  }

  clearAgentSession(agentId: string): void {
    this.db.query("DELETE FROM agent_sessions WHERE agent_id = ?").run(agentId);
  }

  getUsage(agentId: string): AgentUsage {
    const r = this.db.query("SELECT * FROM agent_usage WHERE agent_id = ?").get(agentId) as {
      used_tokens: number | null;
      context_window: number | null;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
      compactions: number;
      updated_at: number;
    } | null;
    return {
      agentId,
      usedTokens: r?.used_tokens ?? null,
      contextWindow: r?.context_window ?? null,
      inputTokens: r?.input_tokens ?? 0,
      outputTokens: r?.output_tokens ?? 0,
      costUsd: r?.cost_usd ?? 0,
      compactions: r?.compactions ?? 0,
      updatedAt: r?.updated_at ?? 0,
    };
  }

  private putUsage(u: AgentUsage): AgentUsage {
    this.db
      .query(
        `INSERT OR REPLACE INTO agent_usage
         (agent_id, used_tokens, context_window, input_tokens, output_tokens, cost_usd, compactions, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        u.agentId,
        u.usedTokens,
        u.contextWindow,
        u.inputTokens,
        u.outputTokens,
        u.costUsd,
        u.compactions,
        u.updatedAt,
      );
    return u;
  }

  applyUsage(
    agentId: string,
    d: {
      usedTokens?: number | null;
      contextWindow?: number | null;
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
    },
  ): AgentUsage {
    const u = this.getUsage(agentId);
    return this.putUsage({
      ...u,
      usedTokens: d.usedTokens ?? u.usedTokens,
      contextWindow: d.contextWindow ?? u.contextWindow,
      inputTokens: u.inputTokens + (d.inputTokens ?? 0),
      outputTokens: u.outputTokens + (d.outputTokens ?? 0),
      costUsd: u.costUsd + (d.costUsd ?? 0),
      updatedAt: Date.now(),
    });
  }

  markCompacted(agentId: string): AgentUsage {
    const u = this.getUsage(agentId);
    return this.putUsage({
      ...u,
      usedTokens: null,
      compactions: u.compactions + 1,
      updatedAt: Date.now(),
    });
  }

  getAgentSession(agentId: string): { provider: string; sessionId: string } | null {
    const r = this.db
      .query("SELECT provider, session_id FROM agent_sessions WHERE agent_id = ?")
      .get(agentId) as { provider: string; session_id: string } | null;
    return r ? { provider: r.provider, sessionId: r.session_id } : null;
  }

  upsertAgentSession(agentId: string, provider: string, sessionId: string): void {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO agent_sessions (agent_id, provider, session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET provider = excluded.provider, session_id = excluded.session_id, updated_at = excluded.updated_at`,
      )
      .run(agentId, provider, sessionId, now, now);
  }
}

function stripBase(item: ChatItem): Record<string, unknown> {
  const data = { ...(item as unknown as Record<string, unknown>) };
  for (const key of ["id", "seq", "agentId", "turnId", "createdAt", "updatedAt", "kind"]) {
    delete data[key];
  }
  return data;
}

// ---- Queue ----

export type QueueRow = {
  id: string;
  agent_id: string;
  text: string;
  status: string;
  turn_id: string | null;
  created_at: number;
  started_at: number | null;
  from_agent_id: string | null;
  hops: number;
  channel_id: string | null;
  prompt: string | null;
  meta_json: string | null;
};

export type QueueItemLite = {
  id: string;
  agentId: string;
  text: string;
  createdAt: number;
  fromAgentId: string | null;
};

export type QueueSource = {
  agentId: string | null;
  hops: number;
  channelId?: string | null;
  /** Provider prompt when it differs from the displayed text. */
  prompt?: string;
  /** Extra fields stored on the user_message item (routine, attachments). */
  meta?: Record<string, unknown>;
};

// meta_json on a queue row: extra fields producers attach for the drain loop and for the
// services that consume the turn's user_message item (routines, gateways, team, attachments).
export const QueueMeta = z
  .object({
    routine: z.object({ id: z.string(), name: z.string(), trigger: RoutineTrigger }).optional(),
    gateway: z
      .object({
        id: z.string(),
        kind: GatewayKind,
        name: z.string(),
        chatId: z.string(),
        userId: z.string(),
        userName: z.string(),
        replyTo: z.string().optional(),
      })
      .loose()
      .optional(),
    team: z
      .object({ requestId: z.string(), memberId: z.string(), memberName: z.string() })
      .optional(),
    attachments: z.array(ChatAttachment).optional(),
  })
  .loose();
export type QueueMeta = z.infer<typeof QueueMeta>;

/** Parses a queue row's meta_json; corrupt or malformed meta degrades to no meta. */
export function parseQueueMeta(row: { meta_json: string | null } | null | undefined): QueueMeta {
  if (!row?.meta_json) return {};
  try {
    const parsed = QueueMeta.safeParse(JSON.parse(row.meta_json));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function rowToQueueItem(r: QueueRow): QueueItemLite {
  return {
    id: r.id,
    agentId: r.agent_id,
    text: r.text,
    createdAt: r.created_at,
    fromAgentId: r.from_agent_id,
  };
}

export class QueueStore {
  constructor(private db: Database) {}

  enqueue(agentId: string, text: string, from: QueueSource | null = null): QueueItemLite {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .query(
        "INSERT INTO queue (id, agent_id, text, status, created_at, from_agent_id, hops, channel_id, prompt, meta_json) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        agentId,
        text,
        now,
        from?.agentId ?? null,
        from?.hops ?? 0,
        from?.channelId ?? null,
        from?.prompt ?? null,
        from?.meta ? JSON.stringify(from.meta) : null,
      );
    return { id, agentId, text, createdAt: now, fromAgentId: from?.agentId ?? null };
  }

  queued(agentId: string): QueueItemLite[] {
    const rows = this.db
      .query("SELECT * FROM queue WHERE agent_id = ? AND status = 'queued' ORDER BY created_at ASC")
      .all(agentId) as QueueRow[];
    return rows.map(rowToQueueItem);
  }

  peek(agentId: string): QueueRow | null {
    return this.db
      .query(
        "SELECT * FROM queue WHERE agent_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1",
      )
      .get(agentId) as QueueRow | null;
  }

  row(queueId: string): QueueRow | null {
    return this.db.query("SELECT * FROM queue WHERE id = ?").get(queueId) as QueueRow | null;
  }

  markStarted(queueId: string, turnId: string): void {
    this.db
      .query("UPDATE queue SET status = 'started', turn_id = ?, started_at = ? WHERE id = ?")
      .run(turnId, Date.now(), queueId);
  }

  remove(queueId: string): boolean {
    const r = this.db
      .query("UPDATE queue SET status = 'removed' WHERE id = ? AND status = 'queued'")
      .run(queueId);
    return (r.changes ?? 0) > 0;
  }

  removeAllForAgent(agentId: string): void {
    this.db
      .query("UPDATE queue SET status = 'removed' WHERE agent_id = ? AND status = 'queued'")
      .run(agentId);
  }

  agentsWithQueued(): string[] {
    const rows = this.db
      .query("SELECT DISTINCT agent_id FROM queue WHERE status = 'queued'")
      .all() as { agent_id: string }[];
    return rows.map((r) => r.agent_id);
  }
}
