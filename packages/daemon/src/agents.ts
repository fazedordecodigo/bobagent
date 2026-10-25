import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Agent, AgentsCreateParams, AgentsUpdateParams } from "@openagent/protocol";

type Row = {
  id: string;
  name: string;
  instructions: string;
  provider: string;
  model: string | null;
  workspace_path: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

function rowToAgent(r: Row): Agent {
  return {
    id: r.id,
    name: r.name,
    instructions: r.instructions,
    provider: r.provider as Agent["provider"],
    model: r.model,
    workspacePath: r.workspace_path,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class AgentStore {
  constructor(
    private db: Database,
    private agentsRoot: string,
  ) {}

  list(): Agent[] {
    const rows = this.db
      .query("SELECT * FROM agents WHERE deleted_at IS NULL ORDER BY created_at ASC")
      .all() as Row[];
    return rows.map(rowToAgent);
  }

  get(id: string): Agent | null {
    const row = this.db
      .query("SELECT * FROM agents WHERE id = ? AND deleted_at IS NULL")
      .get(id) as Row | null;
    return row ? rowToAgent(row) : null;
  }

  create(params: AgentsCreateParams): Agent {
    const id = crypto.randomUUID();
    const now = Date.now();
    const workspacePath = join(this.agentsRoot, id);
    mkdirSync(workspacePath, { recursive: true });
    this.db
      .query(
        `INSERT INTO agents (id, name, instructions, provider, model, workspace_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.name,
        params.instructions ?? "",
        params.provider,
        params.model ?? null,
        workspacePath,
        now,
        now,
      );
    return this.get(id)!;
  }

  update(params: AgentsUpdateParams): Agent | null {
    const existing = this.get(params.id);
    if (!existing) return null;
    const name = params.name ?? existing.name;
    const instructions = params.instructions ?? existing.instructions;
    const provider = params.provider ?? existing.provider;
    const model = params.model === undefined ? existing.model : params.model;
    this.db
      .query(
        "UPDATE agents SET name = ?, instructions = ?, provider = ?, model = ?, updated_at = ? WHERE id = ?",
      )
      .run(name, instructions, provider, model, Date.now(), params.id);
    return this.get(params.id);
  }

  softDelete(id: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    this.db.query("UPDATE agents SET deleted_at = ? WHERE id = ?").run(Date.now(), id);
    return true;
  }
}
