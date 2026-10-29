import { z } from "zod";

export const PROVIDER_PERMISSION_CONFIG: Record<string, string | null> = {
  devin: "~/.config/devin/config.json",
  cursor: "~/.cursor/cli-config.json",
  grok: "~/.grok/config.toml",
  opencode: "~/.config/opencode/opencode.json",
  gemini: "~/.gemini/settings.json",
  claude: "~/.claude/settings.json",
  codex: "~/.codex/config.toml",
  "openai-compatible": null,
};

export const ProviderId = z.enum([
  "devin",
  "cursor",
  "grok",
  "opencode",
  "gemini",
  "claude",
  "codex",
  "openai-compatible",
]);
export type ProviderId = z.infer<typeof ProviderId>;

export const AgentAvatar = z.object({
  emoji: z.string().min(1).max(16),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});
export type AgentAvatar = z.infer<typeof AgentAvatar>;

export const GatewayKind = z.enum(["telegram", "slack", "discord"]);
export type GatewayKind = z.infer<typeof GatewayKind>;
export const ChatAttachment = z.object({
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  path: z.string(),
  extractedTo: z.string().optional(),
});
export type ChatAttachment = z.infer<typeof ChatAttachment>;
export const RoutineTrigger = z.enum(["schedule", "webhook", "manual"]);
export type RoutineTrigger = z.infer<typeof RoutineTrigger>;

export const Agent = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(80),
  instructions: z.string(),
  provider: ProviderId,
  config: z.record(z.string(), z.string()),
  workspacePath: z.string(),
  avatar: AgentAvatar.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Agent = z.infer<typeof Agent>;

// ---- Wire envelopes ----

export const RequestEnvelope = z.object({
  id: z.string(),
  method: z.string(),
  params: z.unknown().optional(),
});
export type RequestEnvelope = z.infer<typeof RequestEnvelope>;

export const ErrorCode = z.enum([
  "bad_request",
  "not_found",
  "internal",
  "busy",
  "provider_unavailable",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ResponseEnvelope = z.union([
  z.object({ id: z.string(), result: z.unknown() }),
  z.object({
    id: z.string(),
    error: z.object({ code: ErrorCode, message: z.string() }),
  }),
]);
export type ResponseEnvelope = z.infer<typeof ResponseEnvelope>;

export const EventEnvelope = z.object({
  event: z.string(),
  data: z.unknown(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

// ---- Method params/results ----

export const AgentsListParams = z.object({}).strict();
export const AgentsListResult = z.array(Agent);

export const AgentsCreateParams = z
  .object({
    name: z.string().trim().min(1).max(80),
    instructions: z.string().optional(),
    provider: ProviderId,
    avatar: AgentAvatar.nullable().optional(),
  })
  .strict();
export type AgentsCreateParams = z.infer<typeof AgentsCreateParams>;
export const AgentsCreateResult = Agent;

export const AgentsUpdateParams = z
  .object({
    id: z.string(),
    name: z.string().trim().min(1).max(80).optional(),
    instructions: z.string().optional(),
    provider: ProviderId.optional(),
    avatar: AgentAvatar.nullable().optional(),
  })
  .strict();
export type AgentsUpdateParams = z.infer<typeof AgentsUpdateParams>;
export const AgentsUpdateResult = Agent;

export const AgentsDeleteParams = z.object({ id: z.string() }).strict();
export type AgentsDeleteParams = z.infer<typeof AgentsDeleteParams>;
export const AgentsDeleteResult = z.object({ ok: z.literal(true) });

// ---- Chat types ----

export const AgentStatus = z.enum(["idle", "starting", "running", "awaiting_permission", "error"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const AgentStatusInfo = z.object({
  status: AgentStatus,
  error: z.string().nullable(),
});
export type AgentStatusInfo = z.infer<typeof AgentStatusInfo>;

export const TurnStatus = z.enum(["running", "completed", "cancelled", "failed", "interrupted"]);
export type TurnStatus = z.infer<typeof TurnStatus>;

export const Turn = z.object({
  id: z.string(),
  agentId: z.string(),
  queueId: z.string().nullable(),
  status: TurnStatus,
  stopReason: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
});
export type Turn = z.infer<typeof Turn>;

export const PermissionOptionKind = z.enum([
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
]);
export type PermissionOptionKind = z.infer<typeof PermissionOptionKind>;

export const PermissionOption = z.object({
  optionId: z.string(),
  name: z.string(),
  kind: PermissionOptionKind,
});
export type PermissionOption = z.infer<typeof PermissionOption>;

export const ToolCallStatus = z.enum(["pending", "in_progress", "completed", "failed"]);
export type ToolCallStatus = z.infer<typeof ToolCallStatus>;

const ChatItemBase = z.object({
  id: z.string(),
  seq: z.number(),
  agentId: z.string(),
  turnId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const ChatItem = z.discriminatedUnion("kind", [
  ChatItemBase.extend({
    kind: z.literal("user_message"),
    text: z.string(),
    from: z.object({ agentId: z.string(), name: z.string() }).nullable().optional(),
    channelId: z.string().nullable().optional(),
    team: z
      .object({ requestId: z.string(), memberId: z.string(), memberName: z.string() })
      .nullable()
      .optional(),
    gateway: z
      .object({
        id: z.string(),
        kind: GatewayKind,
        name: z.string(),
        chatId: z.string(),
        userId: z.string(),
        userName: z.string(),
      })
      .passthrough()
      .nullable()
      .optional(),
    routine: z
      .object({ id: z.string(), name: z.string(), trigger: RoutineTrigger })
      .nullable()
      .optional(),
    attachments: z.array(ChatAttachment).optional(),
  }),
  ChatItemBase.extend({ kind: z.literal("agent_message"), text: z.string() }),
  ChatItemBase.extend({ kind: z.literal("agent_thought"), text: z.string() }),
  ChatItemBase.extend({
    kind: z.literal("tool_call"),
    toolCallId: z.string(),
    title: z.string(),
    toolKind: z.string().nullable(),
    status: ToolCallStatus,
    detail: z.string().nullable(),
  }),
  ChatItemBase.extend({
    kind: z.literal("permission"),
    requestId: z.string(),
    title: z.string(),
    options: z.array(PermissionOption),
    resolution: z.object({ optionId: z.string().nullable() }).nullable(),
  }),
  ChatItemBase.extend({ kind: z.literal("error"), message: z.string() }),
  ChatItemBase.extend({
    kind: z.literal("compaction"),
    reason: z.enum(["auto", "manual"]),
    status: z.enum(["running", "completed", "failed"]),
    summary: z.string(),
    error: z.string().nullable().optional(),
  }),
]);
export type ChatItem = z.infer<typeof ChatItem>;

export const PendingPermission = z.object({
  requestId: z.string(),
  agentId: z.string(),
  turnId: z.string(),
  title: z.string(),
  toolKind: z.string().nullable(),
  options: z.array(PermissionOption),
});
export type PendingPermission = z.infer<typeof PendingPermission>;

// ---- Chat method params/results ----

export const ChatHistoryParams = z
  .object({
    agentId: z.string(),
    beforeSeq: z.number().int().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();
export type ChatHistoryParams = z.infer<typeof ChatHistoryParams>;
export const ChatHistoryResult = z.object({
  items: z.array(ChatItem),
  turns: z.array(Turn),
  hasMore: z.boolean(),
});

export const ChatSendParams = z
  .object({
    agentId: z.string(),
    text: z.string().min(1).max(100000),
    attachments: z
      .array(
        z.object({
          name: z.string().min(1).max(255),
          mime: z.string().max(255),
          dataBase64: z.string().max(36_000_000),
        }),
      )
      .max(10)
      .optional(),
  })
  .strict();
export type ChatSendParams = z.infer<typeof ChatSendParams>;
export const ChatSendResult = z.object({ queueId: z.string() });

// ---- Queue + config types ----

export const ConfigOption = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string().nullable(),
  currentValue: z.string(),
  options: z.array(
    z.object({ value: z.string(), name: z.string(), description: z.string().nullable() }),
  ),
});
export type ConfigOption = z.infer<typeof ConfigOption>;

export const QueueItem = z.object({
  id: z.string(),
  agentId: z.string(),
  text: z.string(),
  createdAt: z.number(),
  fromAgentId: z.string().nullable().optional(),
});
export type QueueItem = z.infer<typeof QueueItem>;

export const QueueState = z.object({
  agentId: z.string(),
  paused: z.boolean(),
  items: z.array(QueueItem),
});
export type QueueState = z.infer<typeof QueueState>;

export const QueueGetParams = z.object({ agentId: z.string() }).strict();
export const QueueGetResult = QueueState;
export const QueueRemoveParams = z.object({ queueId: z.string() }).strict();
export const QueueRemoveResult = z.object({ ok: z.literal(true) });
export const QueuePauseParams = z.object({ agentId: z.string() }).strict();
export const QueueResumeParams = z.object({ agentId: z.string() }).strict();
export const QueuePauseResumeResult = QueueState;

export const AgentsConfigOptionsParams = z.object({ agentId: z.string() }).strict();
export const AgentsConfigOptionsResult = z.object({
  configOptions: z.array(ConfigOption),
});
export const AgentsSetConfigParams = z
  .object({ agentId: z.string(), configId: z.string(), value: z.string() })
  .strict();
export type AgentsSetConfigParams = z.infer<typeof AgentsSetConfigParams>;
export const AgentsSetConfigResult = z.object({
  configOptions: z.array(ConfigOption),
});

export const ChatCancelParams = z.object({ agentId: z.string() }).strict();
export const ChatCancelResult = z.object({ ok: z.literal(true) });

export const AgentsStatusesParams = z.object({}).strict();
export const AgentsStatusesResult = z.record(z.string(), AgentStatusInfo);

export const PermissionsListParams = z.object({}).strict();
export const PermissionsListResult = z.array(PendingPermission);

export const PermissionsRespondParams = z
  .object({ requestId: z.string(), optionId: z.string().nullable() })
  .strict();
export type PermissionsRespondParams = z.infer<typeof PermissionsRespondParams>;
export const PermissionsRespondResult = z.object({ ok: z.literal(true) });

// ---- Memories + skills ----

export const Memory = z.object({
  id: z.string(),
  agentId: z.string(),
  text: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Memory = z.infer<typeof Memory>;
export const Skill = z.object({
  name: z.string(),
  description: z.string(),
  author: z.string().nullable(),
  body: z.string(),
  updatedAt: z.number(),
});
export type Skill = z.infer<typeof Skill>;
const MemoryText = z.string().trim().min(1).max(2_000);
export const SkillSaveParams = z
  .object({
    name: z.string().trim().min(1).max(64),
    description: z.string().max(500),
    body: z.string().min(1).max(200_000),
  })
  .strict();

// ---- Teams ----

export const TeamMember = z.object({
  id: z.string(),
  name: z.string(),
  online: z.boolean(),
  agents: z.array(
    z.object({ id: z.string(), name: z.string(), provider: z.string(), avatar: z.unknown() }),
  ),
});
export type TeamMember = z.infer<typeof TeamMember>;
export const TeamStatus = z.object({
  configured: z.boolean(),
  url: z.string().nullable(),
  connected: z.boolean(),
  error: z.string().nullable(),
  me: z.object({ id: z.string(), name: z.string() }).nullable(),
  members: z.array(TeamMember),
  sharedAgentIds: z.array(z.string()),
});
export type TeamStatus = z.infer<typeof TeamStatus>;
export const TeamMessage = z.object({
  id: z.string(),
  requestId: z.string(),
  direction: z.enum(["out", "in"]),
  memberId: z.string(),
  memberName: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  text: z.string(),
  reply: z.string().nullable(),
  status: z.enum(["pending", "completed", "failed"]),
  createdAt: z.number(),
});
export type TeamMessage = z.infer<typeof TeamMessage>;

// ---- Remote hosts, microVM isolation, subagents ----

export const Isolation = z.enum(["none", "firecracker"]);
export type Isolation = z.infer<typeof Isolation>;
export const HostPreflight = z
  .object({
    root: z.string(),
    os: z.string(),
    arch: z.string(),
    kernelRelease: z.string(),
    bun: z.string(),
    kvm: z.boolean(),
    firecracker: z.object({ path: z.string(), version: z.string().nullable() }).nullable(),
    kernelImage: z.string().nullable(),
    rootfs: z.string().nullable(),
    mkfsExt4: z.string().nullable(),
    guestHelperCurrent: z.boolean().nullable(),
    providers: z.record(z.string(), z.string().nullable()),
    firecrackerReady: z.boolean(),
  })
  .loose();
export type HostPreflight = z.infer<typeof HostPreflight>;
/** `user@host` or `host`; never starts with "-" so it cannot be read as an ssh option. */
export const SshTarget = z
  .string()
  .max(255)
  .regex(/^(?:[A-Za-z0-9._][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*$/, "expected user@host");
export const RemoteHost = z.object({
  id: z.string(),
  name: z.string(),
  target: SshTarget,
  port: z.number().int(),
  identityFile: z.string().nullable(),
  root: z.string().nullable(),
  preflight: HostPreflight.nullable(),
  createdAt: z.number(),
});
export type RemoteHost = z.infer<typeof RemoteHost>;
const IdentityFile = z
  .string()
  .max(1000)
  .regex(/^(?:\/|~\/)[^\n\r]*$/, "absolute path to a private key file")
  .nullable();
/** Provider logins injected into Firecracker microVM sessions (values never leave the daemon). */
export const VmCredentialProvider = z.enum(["claude", "codex", "gemini", "cursor"]);
export type VmCredentialProvider = z.infer<typeof VmCredentialProvider>;
export const VmCredentialKind = z.enum(["oauth_token", "api_key"]);
export type VmCredentialKind = z.infer<typeof VmCredentialKind>;
export const VmCredential = z.object({
  provider: VmCredentialProvider,
  kind: VmCredentialKind,
  updatedAt: z.number(),
});
export type VmCredential = z.infer<typeof VmCredential>;

export const AgentPlacement = z.object({
  agentId: z.string(),
  hostId: z.string().nullable(),
  isolation: Isolation,
  vcpus: z.number().int().min(1).max(32),
  memMib: z.number().int().min(256).max(65536),
});
export type AgentPlacement = z.infer<typeof AgentPlacement>;
export const Subagent = z.object({
  agentId: z.string(),
  parentId: z.string(),
  batchId: z.string(),
  task: z.string(),
  status: z.enum(["running", "done", "failed", "stopped"]),
  result: z.string().nullable(),
  createdAt: z.number(),
  finishedAt: z.number().nullable(),
});
export type Subagent = z.infer<typeof Subagent>;

// ---- Mobile companion ----

export const MobileDevice = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  lastSeenAt: z.number().nullable(),
});
export type MobileDevice = z.infer<typeof MobileDevice>;
export const MobileStatus = z.object({
  enabled: z.boolean(),
  urls: z.array(z.string()),
  devices: z.array(MobileDevice),
});
export type MobileStatus = z.infer<typeof MobileStatus>;

// ---- Marketplace ----

export const MarketplaceItem = z.object({
  id: z.string(),
  kind: z.enum(["skill", "agent"]),
  name: z.string(),
  description: z.string(),
  author: z.string(),
  version: z.string(),
  url: z.string(),
  sha256: z.string(),
  source: z.string(),
  installed: z.boolean(),
});
export type MarketplaceItem = z.infer<typeof MarketplaceItem>;

// ---- Messaging gateways ----

export const GatewayStatus = z.enum(["connecting", "connected", "error", "stopped"]);
export type GatewayStatus = z.infer<typeof GatewayStatus>;
export const EmailProvider = z.enum(["gmail", "icloud", "outlook", "custom"]);
export type EmailProvider = z.infer<typeof EmailProvider>;
export const EmailAccount = z.object({
  id: z.string(),
  label: z.string(),
  provider: EmailProvider,
  address: z.string(),
  username: z.string(),
  imapHost: z.string(),
  imapPort: z.number().int(),
  smtpHost: z.string(),
  smtpPort: z.number().int(),
  smtpSecure: z.boolean(),
  /** Bots allowed to use the account; empty = every bot. */
  agentIds: z.array(z.string()),
  hasPassword: z.boolean(),
  createdAt: z.number(),
});
export type EmailAccount = z.infer<typeof EmailAccount>;
export const EmailDraftStatus = z.enum(["pending", "sending", "sent", "discarded", "failed"]);
export const EmailDraft = z.object({
  id: z.string(),
  agentId: z.string(),
  accountId: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
  inReplyTo: z.string().nullable(),
  status: EmailDraftStatus,
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type EmailDraft = z.infer<typeof EmailDraft>;
const EmailAddressList = z.array(z.string().trim().email().max(320)).max(50);

export const Page = z.object({
  id: z.string(),
  agentId: z.string(),
  title: z.string(),
  description: z.string(),
  version: z.number().int(),
  /** index.html on disk */
  path: z.string(),
  /** Local view URL (token-protected) */
  url: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Page = z.infer<typeof Page>;

export const ApprovalRule = z.object({
  id: z.string(),
  pattern: z.string().trim().min(1).max(200),
  action: z.enum(["ask", "allow"]),
  /** null = every bot */
  agentId: z.string().nullable(),
});
export type ApprovalRule = z.infer<typeof ApprovalRule>;
export const AppPermissionKind = z.enum(["read", "write", "send", "pay", "book", "del"]);
export type AppPermissionKind = z.infer<typeof AppPermissionKind>;
export const AppPermissionLevel = z.enum(["off", "ask", "allow"]);
export type AppPermissionLevel = z.infer<typeof AppPermissionLevel>;
const SensitiveAppPermissionLevel = z.enum(["off", "ask"], {
  error: "Permissões sensíveis aceitam apenas off ou ask; allow não é permitido.",
});
export const AppPermissions = z
  .object({
    read: AppPermissionLevel,
    write: AppPermissionLevel,
    send: SensitiveAppPermissionLevel,
    pay: SensitiveAppPermissionLevel,
    book: SensitiveAppPermissionLevel,
    del: SensitiveAppPermissionLevel,
  })
  .strict();
export type AppPermissions = z.infer<typeof AppPermissions>;
export const defaultAppPermissions: AppPermissions = {
  read: "allow",
  write: "ask",
  send: "ask",
  pay: "ask",
  book: "ask",
  del: "ask",
};
export function isSensitivePermission(kind: AppPermissionKind): boolean {
  return kind !== "read" && kind !== "write";
}

const appToolOperations: [AppPermissionKind, RegExp][] = [
  ["del", /^(delete|remove|destroy|trash)$/],
  ["pay", /^(pay|charge|refund|transfer|payout|purchase)$/],
  ["book", /^(book|reserve)$/],
  [
    "send",
    /^(send|post|publish|invite|reply|forward|mail|email|message|dispatch|deliver|notify|broadcast|sms|text|chat|push|share|comment|dm|tweet)$/,
  ],
  [
    "write",
    /^(create|update|merge|write|edit|archive|cancel|move|rename|upload|patch|put|set|add|insert|close)$/,
  ],
  [
    "read",
    /^(get|list|search|read|query|fetch|retrieve|find|describe|lookup|view|show|count|check|status)$/,
  ],
];

/** Operation tokens of an app tool name (`<slug>-<operation>`): underscores, hyphens and camelCase. */
export function toolOperationTokens(tool: string): string[] {
  return tool
    .slice(tool.indexOf("-") + 1)
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_-]+/)
    .filter(Boolean);
}

/** Kind of a single operation verb; null when it is not a known verb. */
export function classifyToolVerb(verb: string): AppPermissionKind | null {
  return appToolOperations.find(([, pattern]) => pattern.test(verb))?.[0] ?? null;
}

/**
 * Kind of an app tool's operation (`<slug>-<operation>`): the leading verb
 * decides, and verbs after and/or/then can escalate it
 * (del > pay > book > send > write > read). A naming heuristic, not argument
 * or semantic inspection. Null when no known verb appears.
 */
export function classifyToolOperation(tool: string): AppPermissionKind | null {
  const tokens = toolOperationTokens(tool);
  const verbs = classifyToolVerb(tokens[0] ?? "")
    ? tokens.filter((_, index) => index === 0 || /^(and|or|then)$/.test(tokens[index - 1] ?? ""))
    : tokens;
  return (
    appToolOperations.find(([, pattern]) => verbs.some((verb) => pattern.test(verb)))?.[0] ?? null
  );
}

/** Permission kind of an app tool, failing closed to "write" on unknown verbs. */
export function classifyAppTool(tool: string): AppPermissionKind {
  return classifyToolOperation(tool) ?? "write";
}
export const ApprovalDecision = z.enum(["approve", "always", "task", "deny", "done"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;
export const Approval = z.object({
  id: z.string(),
  agentId: z.string(),
  turnId: z.string().nullable(),
  kind: z.enum(["tool", "secret", "takeover"]),
  title: z.string(),
  detail: z.string(),
  tool: z.string().nullable(),
  secretName: z.string().nullable(),
  appId: z.string().optional(),
  appName: z.string().optional(),
  permission: AppPermissionKind.optional(),
  previousLevel: AppPermissionLevel.optional(),
  background: z.boolean(),
  status: z.enum(["pending", "approved", "denied", "expired", "done"]),
  createdAt: z.number(),
  expiresAt: z.number(),
});
export type Approval = z.infer<typeof Approval>;

export const AppSecretSpec = z.object({
  key: z.string(),
  label: z.string(),
  hint: z.string(),
  /** "Header: template" with {value}; null = passed to the server as an env var. */
  header: z.string().nullable(),
});
export const AppCatalogEntry = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  transport: z.enum(["stdio", "http"]),
  command: z.array(z.string()).nullable(),
  url: z.string().nullable(),
  secrets: z.array(AppSecretSpec),
  docsUrl: z.string(),
});
export type AppCatalogEntry = z.infer<typeof AppCatalogEntry>;
export const ConnectedApp = z.object({
  permissions: AppPermissions,
  id: z.string(),
  catalogId: z.string(),
  name: z.string(),
  slug: z.string(),
  transport: z.enum(["stdio", "http"]),
  command: z.array(z.string()).nullable(),
  url: z.string().nullable(),
  secretKeys: z.array(z.string()),
  agentIds: z.array(z.string()),
  enabled: z.boolean(),
  status: z.enum(["stopped", "starting", "ready", "error"]),
  error: z.string().nullable(),
  tools: z.array(z.object({ name: z.string(), description: z.string() })),
  createdAt: z.number(),
});
export type ConnectedApp = z.infer<typeof ConnectedApp>;
const AppSecrets = z.record(z.string().max(64), z.string().max(20_000));

export const Gateway = z.object({
  id: z.string(),
  kind: GatewayKind,
  name: z.string(),
  agentId: z.string(),
  allowedUsers: z.array(z.string()),
  enabled: z.boolean(),
  status: GatewayStatus,
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Gateway = z.infer<typeof Gateway>;
const GatewayTokens = z.record(z.string(), z.string().max(500));

// ---- Vault, Computer Use, voice ----

export const VaultEntry = z.object({
  name: z.string(),
  agentIds: z.array(z.string()),
  updatedAt: z.number(),
});
export type VaultEntry = z.infer<typeof VaultEntry>;
const VaultName = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
const Ok = z.object({ ok: z.literal(true) });

// ---- Agent browser ----

export const BrowserTab = z.object({ agentId: z.string(), url: z.string(), title: z.string() });
export type BrowserTab = z.infer<typeof BrowserTab>;
export const BrowserState = z.object({
  available: z.boolean(),
  running: z.boolean(),
  tabs: z.array(BrowserTab),
});
export type BrowserState = z.infer<typeof BrowserState>;

// ---- Routines ----

export const Routine = z.object({
  id: z.string(),
  agentId: z.string(),
  name: z.string(),
  prompt: z.string(),
  schedule: z.string().nullable(),
  webhook: z.boolean(),
  webhookUrl: z.string().nullable(),
  webhookToken: z.string().nullable(),
  enabled: z.boolean(),
  lastRunAt: z.number().nullable(),
  nextRunAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Routine = z.infer<typeof Routine>;
export const RoutineRun = z.object({
  id: z.string(),
  routineId: z.string(),
  trigger: RoutineTrigger,
  queueId: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
});
export type RoutineRun = z.infer<typeof RoutineRun>;
const RoutineFields = {
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(20_000),
  schedule: z.string().max(64).nullable(),
  webhook: z.boolean(),
  enabled: z.boolean(),
};

// ---- Usage + compaction ----

export const AgentUsage = z.object({
  agentId: z.string(),
  /** Tokens in the provider's current context (null = provider does not report it). */
  usedTokens: z.number().nullable(),
  contextWindow: z.number().nullable(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
  compactions: z.number(),
  updatedAt: z.number(),
});
export type AgentUsage = z.infer<typeof AgentUsage>;
export const AgentsUsageParams = z.object({ agentId: z.string() }).strict();
export const AgentsCompactParams = z.object({ agentId: z.string() }).strict();

// ---- Channels ----

export const ChannelStatus = z.enum(["active", "stopped", "archived"]);
export type ChannelStatus = z.infer<typeof ChannelStatus>;
export const Channel = z.object({
  id: z.string(),
  name: z.string(),
  ownerId: z.string().nullable(),
  memberIds: z.array(z.string()),
  status: ChannelStatus,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Channel = z.infer<typeof Channel>;
export const ChannelMessage = z.object({
  id: z.string(),
  channelId: z.string(),
  seq: z.number(),
  authorKind: z.enum(["user", "agent", "system"]),
  authorAgentId: z.string().nullable(),
  text: z.string(),
  createdAt: z.number(),
  replyTo: z.string().nullable(),
});
export type ChannelMessage = z.infer<typeof ChannelMessage>;

const ChannelIdParams = z.object({ channelId: z.string() }).strict();
export const ChannelsListParams = z.object({ includeArchived: z.boolean().optional() }).strict();
export const ChannelsCreateParams = z
  .object({
    name: z.string().trim().min(1).max(80),
    memberIds: z.array(z.string()).min(1).max(20),
    ownerId: z.string().nullable().optional(),
  })
  .strict();
export const ChannelsHistoryParams = z
  .object({ channelId: z.string(), limit: z.number().int().min(1).max(1000).optional() })
  .strict();
export const ChannelsHistoryResult = z.object({
  channel: Channel,
  messages: z.array(ChannelMessage),
});
export const ChannelsPostParams = z
  .object({
    channelId: z.string(),
    text: z.string().trim().min(1).max(100_000),
    replyTo: z.string().optional(),
  })
  .strict();
export const ChannelsReassignParams = z
  .object({ channelId: z.string(), ownerId: z.string() })
  .strict();
export const ChannelsSetMembersParams = z
  .object({ channelId: z.string(), memberIds: z.array(z.string()).min(1).max(20) })
  .strict();

// ---- Events ----

export const AgentCreatedEvent = z.object({ event: z.literal("agent.created"), data: Agent });
export const AgentUpdatedEvent = z.object({ event: z.literal("agent.updated"), data: Agent });
export const AgentDeletedEvent = z.object({
  event: z.literal("agent.deleted"),
  data: z.object({ id: z.string() }),
});

// ---- Typed method map ----

export const methodMap = {
  "agents.list": { params: AgentsListParams, result: AgentsListResult },
  "agents.create": { params: AgentsCreateParams, result: AgentsCreateResult },
  "agents.update": { params: AgentsUpdateParams, result: AgentsUpdateResult },
  "agents.delete": { params: AgentsDeleteParams, result: AgentsDeleteResult },
  "chat.history": { params: ChatHistoryParams, result: ChatHistoryResult },
  "chat.send": { params: ChatSendParams, result: ChatSendResult },
  "chat.cancel": { params: ChatCancelParams, result: ChatCancelResult },
  "queue.get": { params: QueueGetParams, result: QueueGetResult },
  "queue.remove": { params: QueueRemoveParams, result: QueueRemoveResult },
  "queue.pause": { params: QueuePauseParams, result: QueuePauseResumeResult },
  "queue.resume": { params: QueueResumeParams, result: QueuePauseResumeResult },
  "agents.configOptions": { params: AgentsConfigOptionsParams, result: AgentsConfigOptionsResult },
  "agents.setConfig": { params: AgentsSetConfigParams, result: AgentsSetConfigResult },
  "agents.statuses": { params: AgentsStatusesParams, result: AgentsStatusesResult },
  "permissions.list": { params: PermissionsListParams, result: PermissionsListResult },
  "permissions.respond": { params: PermissionsRespondParams, result: PermissionsRespondResult },
  "agents.usage": { params: AgentsUsageParams, result: AgentUsage },
  "team.status": { params: z.object({}).strict(), result: TeamStatus },
  "team.connect": {
    params: z.object({ url: z.string().max(2000), token: z.string().min(1).max(500) }).strict(),
    result: TeamStatus,
  },
  "team.disconnect": { params: z.object({}).strict(), result: z.object({ ok: z.literal(true) }) },
  "team.share": {
    params: z.object({ agentIds: z.array(z.string()) }).strict(),
    result: TeamStatus,
  },
  "team.send": {
    params: z
      .object({ memberId: z.string(), agentId: z.string(), text: z.string().min(1).max(100_000) })
      .strict(),
    result: TeamMessage,
  },
  "team.messages": { params: z.object({}).strict(), result: z.array(TeamMessage) },
  "hosts.list": { params: z.object({}).strict(), result: z.array(RemoteHost) },
  "hosts.create": {
    params: z
      .object({
        name: z.string().trim().min(1).max(80),
        target: SshTarget,
        port: z.number().int().min(1).max(65535).optional(),
        identityFile: IdentityFile.optional(),
      })
      .strict(),
    result: RemoteHost,
  },
  "hosts.update": {
    params: z
      .object({
        id: z.string(),
        name: z.string().trim().min(1).max(80).optional(),
        target: SshTarget.optional(),
        port: z.number().int().min(1).max(65535).optional(),
        identityFile: IdentityFile.optional(),
      })
      .strict(),
    result: RemoteHost,
  },
  "hosts.delete": {
    params: z.object({ id: z.string() }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  "hosts.install": { params: z.object({ id: z.string() }).strict(), result: RemoteHost },
  "hosts.check": { params: z.object({ id: z.string() }).strict(), result: RemoteHost },
  "vmCredentials.list": { params: z.object({}).strict(), result: z.array(VmCredential) },
  "vmCredentials.set": {
    params: z
      .object({
        provider: VmCredentialProvider,
        kind: VmCredentialKind,
        value: z
          .string()
          .trim()
          .min(8)
          .max(8192)
          .regex(/^[\x21-\x7e]+$/, "credential must be a single token without spaces"),
      })
      .strict()
      .refine((p) => p.provider === "claude" || p.kind === "api_key", {
        message: "only claude accepts an OAuth token; other providers take an API key",
      }),
    result: VmCredential,
  },
  "vmCredentials.delete": {
    params: z.object({ provider: VmCredentialProvider }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  "placements.list": { params: z.object({}).strict(), result: z.array(AgentPlacement) },
  "placements.set": {
    params: z
      .object({
        agentId: z.string(),
        hostId: z.string().nullable(),
        isolation: Isolation,
        vcpus: z.number().int().min(1).max(32).optional(),
        memMib: z.number().int().min(256).max(65536).optional(),
      })
      .strict(),
    result: AgentPlacement,
  },
  "subagents.list": {
    params: z.object({ parentId: z.string().optional() }).strict(),
    result: z.array(Subagent),
  },
  "mobile.status": { params: z.object({}).strict(), result: MobileStatus },
  "mobile.enable": { params: z.object({ enabled: z.boolean() }).strict(), result: MobileStatus },
  "mobile.pair": {
    params: z.object({}).strict(),
    result: z.object({ code: z.string(), expiresAt: z.number() }),
  },
  "mobile.revoke": {
    params: z.object({ id: z.string() }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  "marketplace.list": {
    params: z.object({}).strict(),
    result: z.object({
      sources: z.array(z.string()),
      items: z.array(MarketplaceItem),
      errors: z.array(z.object({ source: z.string(), error: z.string() })),
    }),
  },
  "marketplace.install": {
    params: z
      .object({ source: z.string(), id: z.string(), provider: ProviderId.optional() })
      .strict(),
    result: z.object({ skills: z.array(z.string()), agent: Agent.nullable() }),
  },
  "marketplace.setSources": {
    params: z.object({ urls: z.array(z.string().max(2000)).max(20) }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  "gateways.list": { params: z.object({}).strict(), result: z.array(Gateway) },
  "gateways.create": {
    params: z
      .object({
        kind: GatewayKind,
        name: z.string().trim().min(1).max(80),
        agentId: z.string(),
        tokens: GatewayTokens,
        allowedUsers: z.array(z.string().max(100)).max(200).optional(),
        enabled: z.boolean().optional(),
      })
      .strict(),
    result: Gateway,
  },
  "gateways.update": {
    params: z
      .object({
        id: z.string(),
        name: z.string().trim().min(1).max(80).optional(),
        agentId: z.string().optional(),
        tokens: GatewayTokens.optional(),
        allowedUsers: z.array(z.string().max(100)).max(200).optional(),
        enabled: z.boolean().optional(),
      })
      .strict(),
    result: Gateway,
  },
  "gateways.delete": {
    params: z.object({ id: z.string() }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  "pages.list": { params: z.object({}).strict(), result: z.array(Page) },
  "pages.delete": {
    params: z.object({ id: z.string() }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  "approvals.list": {
    params: z.object({ agentId: z.string().optional() }).strict(),
    result: z.array(Approval),
  },
  "approvals.respond": {
    params: z
      .object({
        id: z.string(),
        decision: ApprovalDecision,
        value: z.string().max(20_000).optional(),
      })
      .strict(),
    result: Approval,
  },
  "approvals.rules": { params: z.object({}).strict(), result: z.array(ApprovalRule) },
  "approvals.setRules": {
    params: z.object({ rules: z.array(ApprovalRule).max(500) }).strict(),
    result: z.array(ApprovalRule),
  },
  "apps.catalog": { params: z.object({}).strict(), result: z.array(AppCatalogEntry) },
  "apps.list": { params: z.object({}).strict(), result: z.array(ConnectedApp) },
  "apps.connect": {
    params: z
      .object({
        catalogId: z.string(),
        permissions: AppPermissions.partial().optional(),
        name: z.string().trim().min(1).max(40).optional(),
        secrets: AppSecrets,
        command: z.array(z.string().max(1000)).min(1).max(50).optional(),
        url: z.string().url().max(2000).optional(),
        headers: z.record(z.string().max(100), z.string().max(2000)).optional(),
        agentIds: z.array(z.string()).max(200).optional(),
      })
      .strict(),
    result: ConnectedApp,
  },
  "apps.update": {
    params: z
      .object({
        id: z.string(),
        permissions: AppPermissions.partial().optional(),
        enabled: z.boolean().optional(),
        agentIds: z.array(z.string()).max(200).optional(),
        secrets: AppSecrets.optional(),
      })
      .strict(),
    result: ConnectedApp,
  },
  "apps.refresh": { params: z.object({ id: z.string() }).strict(), result: ConnectedApp },
  "apps.delete": {
    params: z.object({ id: z.string() }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  "email.accounts.list": { params: z.object({}).strict(), result: z.array(EmailAccount) },
  "email.accounts.save": {
    params: z
      .object({
        id: z.string().optional(),
        label: z.string().trim().max(80).optional(),
        provider: EmailProvider,
        address: z.string().trim().email().max(320),
        username: z.string().trim().max(320).optional(),
        password: z.string().min(1).max(1000).optional(),
        imapHost: z.string().trim().max(255).optional(),
        imapPort: z.number().int().min(1).max(65535).optional(),
        smtpHost: z.string().trim().max(255).optional(),
        smtpPort: z.number().int().min(1).max(65535).optional(),
        smtpSecure: z.boolean().optional(),
        agentIds: z.array(z.string()).max(200).optional(),
      })
      .strict(),
    result: EmailAccount,
  },
  "email.accounts.delete": {
    params: z.object({ id: z.string() }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  "email.accounts.test": {
    params: z.object({ id: z.string() }).strict(),
    result: z.object({ ok: z.boolean(), imap: z.string(), smtp: z.string() }),
  },
  "email.drafts.list": {
    params: z
      .object({ agentId: z.string().optional(), pendingOnly: z.boolean().optional() })
      .strict(),
    result: z.array(EmailDraft),
  },
  "email.drafts.update": {
    params: z
      .object({
        id: z.string(),
        to: EmailAddressList.min(1).optional(),
        cc: EmailAddressList.optional(),
        subject: z.string().max(998).optional(),
        body: z.string().max(200_000).optional(),
      })
      .strict(),
    result: EmailDraft,
  },
  "email.drafts.send": { params: z.object({ id: z.string() }).strict(), result: EmailDraft },
  "email.drafts.discard": { params: z.object({ id: z.string() }).strict(), result: EmailDraft },
  "vault.list": { params: z.object({}).strict(), result: z.array(VaultEntry) },
  "vault.set": {
    params: z
      .object({
        name: VaultName,
        value: z.string().min(1).max(100_000),
        agentIds: z.array(z.string()).default([]),
      })
      .strict(),
    result: Ok,
  },
  "vault.setAccess": {
    params: z.object({ name: VaultName, agentIds: z.array(z.string()) }).strict(),
    result: Ok,
  },
  "vault.delete": { params: z.object({ name: VaultName }).strict(), result: Ok },
  "computer.access": {
    params: z.object({}).strict(),
    result: z.object({ available: z.boolean(), agentIds: z.array(z.string()) }),
  },
  "computer.setAccess": {
    params: z.object({ agentIds: z.array(z.string()) }).strict(),
    result: Ok,
  },
  "voice.status": {
    params: z.object({}).strict(),
    result: z.object({ tts: z.boolean(), stt: z.boolean() }),
  },
  "voice.speak": { params: z.object({ text: z.string().min(1).max(20_000) }).strict(), result: Ok },
  "voice.stop": { params: z.object({}).strict(), result: Ok },
  "voice.transcribe": {
    params: z
      .object({ audioBase64: z.string().min(1).max(36_000_000), mime: z.string().max(100) })
      .strict(),
    result: z.object({ text: z.string() }),
  },
  "browser.status": { params: z.object({}).strict(), result: BrowserState },
  "browser.closeTab": {
    params: z.object({ agentId: z.string() }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  "browser.close": { params: z.object({}).strict(), result: z.object({ ok: z.literal(true) }) },
  "routines.list": {
    params: z.object({ agentId: z.string().optional() }).strict(),
    result: z.array(Routine),
  },
  "routines.create": {
    params: z
      .object({
        agentId: z.string(),
        name: RoutineFields.name,
        prompt: RoutineFields.prompt,
        schedule: RoutineFields.schedule.optional(),
        webhook: RoutineFields.webhook.optional(),
        enabled: RoutineFields.enabled.optional(),
      })
      .strict(),
    result: Routine,
  },
  "routines.update": {
    params: z
      .object({
        id: z.string(),
        name: RoutineFields.name.optional(),
        prompt: RoutineFields.prompt.optional(),
        schedule: RoutineFields.schedule.optional(),
        webhook: RoutineFields.webhook.optional(),
        enabled: RoutineFields.enabled.optional(),
      })
      .strict(),
    result: Routine,
  },
  "routines.delete": {
    params: z.object({ id: z.string() }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  "routines.run": { params: z.object({ id: z.string() }).strict(), result: RoutineRun },
  "routines.runs": { params: z.object({ id: z.string() }).strict(), result: z.array(RoutineRun) },
  "agents.draft": {
    params: z.object({ prompt: z.string().trim().min(1).max(4_000) }).strict(),
    result: z.object({ name: z.string(), instructions: z.string(), avatar: AgentAvatar }),
  },
  "memories.list": { params: z.object({ agentId: z.string() }).strict(), result: z.array(Memory) },
  "memories.add": {
    params: z.object({ agentId: z.string(), text: MemoryText }).strict(),
    result: Memory,
  },
  "memories.update": {
    params: z.object({ id: z.string(), text: MemoryText }).strict(),
    result: Memory,
  },
  "memories.delete": {
    params: z.object({ id: z.string() }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  "skills.list": { params: z.object({}).strict(), result: z.array(Skill) },
  "skills.get": { params: z.object({ name: z.string() }).strict(), result: Skill },
  "skills.save": { params: SkillSaveParams, result: Skill },
  "skills.delete": {
    params: z.object({ name: z.string() }).strict(),
    result: z.object({ ok: z.literal(true) }),
  },
  "agents.compact": { params: AgentsCompactParams, result: z.object({ ok: z.literal(true) }) },
  "channels.list": { params: ChannelsListParams, result: z.array(Channel) },
  "channels.create": { params: ChannelsCreateParams, result: Channel },
  "channels.history": { params: ChannelsHistoryParams, result: ChannelsHistoryResult },
  "channels.post": { params: ChannelsPostParams, result: z.object({ messageId: z.string() }) },
  "channels.stop": { params: ChannelIdParams, result: Channel },
  "channels.resume": { params: ChannelIdParams, result: Channel },
  "channels.archive": { params: ChannelIdParams, result: Channel },
  "channels.restore": { params: ChannelIdParams, result: Channel },
  "channels.reassign": { params: ChannelsReassignParams, result: Channel },
  "channels.setMembers": { params: ChannelsSetMembersParams, result: Channel },
} as const;

export type MethodName = keyof typeof methodMap;
export type MethodParams<M extends MethodName> = z.input<(typeof methodMap)[M]["params"]>;
export type MethodResult<M extends MethodName> = z.infer<(typeof methodMap)[M]["result"]>;

export type DaemonEventMap = {
  "agent.created": Agent;
  "agent.updated": Agent;
  "agent.deleted": { id: string };
  "turn.started": Turn;
  "turn.ended": Turn;
  "item.created": ChatItem;
  "item.updated": ChatItem;
  "item.delta": { agentId: string; itemId: string; text: string };
  "agent.status": { agentId: string; status: AgentStatus; error: string | null };
  "permission.requested": PendingPermission;
  "permission.resolved": { requestId: string; agentId: string; optionId: string | null };
  "queue.updated": QueueState;
  "agent.config": { agentId: string; configOptions: ConfigOption[] };
  "agent.usage": AgentUsage;
  "routine.updated": Routine;
  "gateway.updated": Gateway;
  "email.accounts.changed": Record<string, never>;
  "apps.changed": Record<string, never>;
  "approval.updated": Approval;
  "pages.changed": Record<string, never>;
  "approvals.rulesChanged": Record<string, never>;
  "email.draft.updated": EmailDraft;
  "team.updated": TeamStatus;
  "team.message": TeamMessage;
  "hosts.changed": Record<string, never>;
  "placement.updated": AgentPlacement;
  "subagent.updated": Subagent;
  "gateway.deleted": { id: string };
  "vault.changed": Record<string, never>;
  "computer.changed": { agentIds: string[] };
  "browser.updated": { running: boolean; tabs: BrowserTab[] };
  "routine.deleted": { id: string };
  "memories.changed": { agentId: string };
  "skills.changed": Record<string, never>;
  "channel.created": Channel;
  "channel.updated": Channel;
  "channel.message": ChannelMessage;
};
export type DaemonEventName = keyof DaemonEventMap;
