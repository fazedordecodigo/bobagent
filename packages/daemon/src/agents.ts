import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Agent, AgentsCreateParams, AgentsUpdateParams } from "@upbot/protocol";

type Row = {
  id: string;
  name: string;
  instructions: string;
  provider: string;
  model: string | null;
  config_json: string | null;
  avatar_json: string | null;
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
    config: r.config_json ? (JSON.parse(r.config_json) as Record<string, string>) : {},
    workspacePath: r.workspace_path,
    avatar: r.avatar_json ? (JSON.parse(r.avatar_json) as Agent["avatar"]) : null,
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
        `INSERT INTO agents (id, name, instructions, provider, config_json, workspace_path, avatar_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.name,
        params.instructions ?? "",
        params.provider,
        "{}",
        workspacePath,
        params.avatar ? JSON.stringify(params.avatar) : null,
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
    const avatar = params.avatar === undefined ? existing.avatar : params.avatar;
    this.db
      .query(
        "UPDATE agents SET name = ?, instructions = ?, provider = ?, avatar_json = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        name,
        instructions,
        provider,
        avatar ? JSON.stringify(avatar) : null,
        Date.now(),
        params.id,
      );
    return this.get(params.id);
  }

  setConfig(id: string, config: Record<string, string>): void {
    this.db
      .query("UPDATE agents SET config_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(config), Date.now(), id);
  }

  queuePaused(id: string): boolean {
    const r = this.db.query("SELECT queue_paused AS p FROM agents WHERE id = ?").get(id) as {
      p: number;
    } | null;
    return (r?.p ?? 0) === 1;
  }

  setQueuePaused(id: string, paused: boolean): void {
    this.db.query("UPDATE agents SET queue_paused = ? WHERE id = ?").run(paused ? 1 : 0, id);
  }

  softDelete(id: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    this.db.query("UPDATE agents SET deleted_at = ? WHERE id = ?").run(Date.now(), id);
    return true;
  }
}
