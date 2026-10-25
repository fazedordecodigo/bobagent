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
  // 3: agent config + message queue
  `ALTER TABLE agents ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';
  UPDATE agents SET config_json = json_object('model', model) WHERE model IS NOT NULL;
  ALTER TABLE agents ADD COLUMN queue_paused INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE queue (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    text TEXT NOT NULL,
    status TEXT NOT NULL,
    turn_id TEXT REFERENCES turns(id),
    created_at INTEGER NOT NULL,
    started_at INTEGER
  );
  CREATE INDEX queue_agent_status ON queue(agent_id, status, created_at)`,
  // 4: link turns to the queue item that started them
  `ALTER TABLE turns ADD COLUMN queue_id TEXT`,
  // 5: agent-to-agent messages (sender + hop count for loop limits)
  `ALTER TABLE queue ADD COLUMN from_agent_id TEXT;
  ALTER TABLE queue ADD COLUMN hops INTEGER NOT NULL DEFAULT 0`,
  // 6: channels
  `CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_agent_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE channel_members (
    channel_id TEXT NOT NULL REFERENCES channels(id),
    agent_id TEXT NOT NULL REFERENCES agents(id),
    PRIMARY KEY (channel_id, agent_id)
  );
  CREATE TABLE channel_messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id),
    seq INTEGER NOT NULL,
    author_kind TEXT NOT NULL,
    author_agent_id TEXT,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX channel_messages_seq ON channel_messages(channel_id, seq);
  ALTER TABLE queue ADD COLUMN channel_id TEXT;
  ALTER TABLE queue ADD COLUMN prompt TEXT`,
  // 7: per-agent token usage + context
  `CREATE TABLE agent_usage (
    agent_id TEXT PRIMARY KEY REFERENCES agents(id),
    used_tokens INTEGER,
    context_window INTEGER,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    compactions INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  // 8: avatars + per-agent memories
  `ALTER TABLE agents ADD COLUMN avatar_json TEXT;
  CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX memories_agent ON memories(agent_id, created_at)`,
];
