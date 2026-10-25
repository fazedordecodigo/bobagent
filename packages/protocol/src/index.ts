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

export const Agent = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(80),
  instructions: z.string(),
  provider: ProviderId,
  config: z.record(z.string(), z.string()),
  workspacePath: z.string(),
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
  .object({ agentId: z.string(), text: z.string().min(1).max(100000) })
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
};
export type DaemonEventName = keyof DaemonEventMap;
