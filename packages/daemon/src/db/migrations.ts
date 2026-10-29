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
  // 9: routines + queue metadata (routine/attachments shown on the user message)
  `ALTER TABLE queue ADD COLUMN meta_json TEXT;
  CREATE TABLE routines (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schedule TEXT,
    webhook_token TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at INTEGER,
    next_run_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE TABLE routine_runs (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES routines(id),
    trigger TEXT NOT NULL,
    queue_id TEXT,
    error TEXT,
    created_at INTEGER NOT NULL
  )`,
  // 10: encrypted vault + key/value settings
  `CREATE TABLE vault (
    name TEXT PRIMARY KEY,
    iv TEXT NOT NULL,
    data TEXT NOT NULL,
    agent_ids TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // 11: messaging gateways (tokens live in the vault)
  `CREATE TABLE gateways (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    allowed_users TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
  // 12: paired mobile devices (token stored as sha256)
  `CREATE TABLE mobile_devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER
  )`,
  // 13: team relay messages (both directions)
  `CREATE TABLE team_messages (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    member_id TEXT NOT NULL,
    member_name TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    text TEXT NOT NULL,
    reply TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX team_messages_request ON team_messages(request_id, direction)`,
  // 14: remote hosts (SSH), per-agent placement/isolation, subagents
  `CREATE TABLE hosts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    target TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    identity_file TEXT,
    root TEXT,
    preflight_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE agent_placement (
    agent_id TEXT PRIMARY KEY,
    host_id TEXT,
    isolation TEXT NOT NULL DEFAULT 'none',
    vcpus INTEGER NOT NULL DEFAULT 2,
    mem_mib INTEGER NOT NULL DEFAULT 2048
  );
  CREATE TABLE subagents (
    agent_id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    task TEXT NOT NULL,
    status TEXT NOT NULL,
    result TEXT,
    keep INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX subagents_parent ON subagents(parent_id, status);
  CREATE INDEX subagents_batch ON subagents(batch_id)`,
  // 15: email accounts (password in the vault as email.<id>.password) and bot-drafted emails
  `CREATE TABLE email_accounts (
    id TEXT PRIMARY KEY,
    config_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE email_drafts (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    data_json TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX email_drafts_agent ON email_drafts(agent_id, status)`,
  // 16: connected apps (MCP servers; secrets in the vault as app.<id>.<KEY>)
  `CREATE TABLE connected_apps (
    id TEXT PRIMARY KEY,
    catalog_id TEXT NOT NULL,
    config_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  )`,
  // 17: pages (bot-published HTML in <workspace>/Pages/<id>/index.html)
  `CREATE TABLE pages (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // 18: replies in group chats
  `ALTER TABLE channel_messages ADD COLUMN reply_to TEXT`,
  `ALTER TABLE connected_apps ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '{"read":"allow","write":"ask","send":"ask","pay":"ask","book":"ask","del":"ask"}'`,
  // 20: persistent audit trail for approval decisions and permission/rule changes
  `CREATE TABLE approval_audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    approval_id TEXT,
    agent_id TEXT,
    turn_id TEXT,
    data_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX approval_audit_created ON approval_audit(created_at)`,
];
