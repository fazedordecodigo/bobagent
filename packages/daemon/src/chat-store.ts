import type { Database } from "bun:sqlite";
import type { ChatItem, Turn, TurnStatus } from "@bobagent/protocol";

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
};

export type QueueItemLite = { id: string; agentId: string; text: string; createdAt: number };

function rowToQueueItem(r: QueueRow): QueueItemLite {
  return { id: r.id, agentId: r.agent_id, text: r.text, createdAt: r.created_at };
}

export class QueueStore {
  constructor(private db: Database) {}

  enqueue(agentId: string, text: string): QueueItemLite {
    const id = crypto.randomUUID();
    this.db
      .query(
        "INSERT INTO queue (id, agent_id, text, status, created_at) VALUES (?, ?, ?, 'queued', ?)",
      )
      .run(id, agentId, text, Date.now());
    return { id, agentId, text, createdAt: Date.now() };
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
