export const migrations: string[] = [
  // 1: agents table
  `CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL,
    model TEXT,
    workspace_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
  // 2: chat turns, items, provider sessions
  `CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    status TEXT NOT NULL,
    stop_reason TEXT,
    error TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE TABLE items (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    turn_id TEXT REFERENCES turns(id),
    kind TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX items_agent_seq ON items(agent_id, seq);
  CREATE INDEX turns_agent ON turns(agent_id, started_at);
  CREATE TABLE agent_sessions (
    agent_id TEXT PRIMARY KEY REFERENCES agents(id),
    provider TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
];
