import { z } from "zod";

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
  model: z.string().nullable(),
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

export const ErrorCode = z.enum(["bad_request", "not_found", "internal"]);
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
    model: z.string().trim().min(1).nullable().optional(),
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
    model: z.string().trim().min(1).nullable().optional(),
  })
  .strict();
export type AgentsUpdateParams = z.infer<typeof AgentsUpdateParams>;
export const AgentsUpdateResult = Agent;

export const AgentsDeleteParams = z.object({ id: z.string() }).strict();
export type AgentsDeleteParams = z.infer<typeof AgentsDeleteParams>;
export const AgentsDeleteResult = z.object({ ok: z.literal(true) });

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
} as const;

export type MethodName = keyof typeof methodMap;
export type MethodParams<M extends MethodName> = z.input<(typeof methodMap)[M]["params"]>;
export type MethodResult<M extends MethodName> = z.infer<(typeof methodMap)[M]["result"]>;

export type DaemonEventMap = {
  "agent.created": Agent;
  "agent.updated": Agent;
  "agent.deleted": { id: string };
};
export type DaemonEventName = keyof DaemonEventMap;
