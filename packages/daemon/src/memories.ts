import type { Database } from "bun:sqlite";
import type { Memory } from "@boto/protocol";

const PROMPT_BUDGET = 8_000;

type Row = { id: string; agent_id: string; text: string; created_at: number; updated_at: number };

const toMemory = (r: Row): Memory => ({
  id: r.id,
  agentId: r.agent_id,
  text: r.text,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class MemoryStore {
  constructor(private db: Database) {}

  list(agentId: string): Memory[] {
    const rows = this.db
      .query(
        "SELECT * FROM memories WHERE agent_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, rowid ASC",
      )
      .all(agentId) as Row[];
    return rows.map(toMemory);
  }

  get(id: string): Memory | null {
    const r = this.db
      .query("SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL")
      .get(id) as Row | null;
    return r ? toMemory(r) : null;
  }

  add(agentId: string, text: string): Memory {
    const id = crypto.randomUUID().slice(0, 8);
    const now = Date.now();
    this.db
      .query(
        "INSERT INTO memories (id, agent_id, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, agentId, text.trim(), now, now);
    return this.get(id)!;
  }

  update(id: string, text: string): Memory | null {
    this.db
      .query("UPDATE memories SET text = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(text.trim(), Date.now(), id);
    return this.get(id);
  }

  delete(id: string): boolean {
    const r = this.db
      .query("UPDATE memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(Date.now(), id);
    return r.changes > 0;
  }

  /** `<agent_memories>` block for the first prompt of a fresh session ("" when empty). */
  promptBlock(agentId: string): string {
    const lines: string[] = [];
    let total = 0;
    for (const m of this.list(agentId).reverse()) {
      const line = `- [${m.id}] ${m.text}`;
      if (total + line.length > PROMPT_BUDGET && lines.length > 0) break;
      lines.unshift(line);
      total += line.length + 1;
    }
    if (lines.length === 0) return "";
    return `<agent_memories>\nThings you chose to remember earlier (manage them with the boto remember/forget tools):\n${lines.join("\n")}\n</agent_memories>\n\n`;
  }
}
