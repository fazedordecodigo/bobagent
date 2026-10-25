import { type MethodName, methodMap } from "@bobagent/protocol";
import type { AgentStore } from "./agents";
import type { ChatStore, QueueStore } from "./chat-store";
import { ProviderError } from "./providers/types";
import { RpcError } from "./runtime/agent-runtime";
import type { RuntimeManager } from "./runtime/runtime-manager";

export type Broadcast = (event: string, data: unknown) => void;

export class Rpc {
  constructor(
    private agents: AgentStore,
    private chat: ChatStore,
    private queue: QueueStore,
    private runtimes: RuntimeManager,
    private broadcast: Broadcast,
  ) {}

  /** Returns the response payload string for one raw incoming message. */
  async handle(raw: string): Promise<string> {
    let parsed: { id?: unknown; method?: unknown; params?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return JSON.stringify({ id: "", error: { code: "bad_request", message: "invalid JSON" } });
    }
    const id = typeof parsed.id === "string" ? parsed.id : "";
    const method = parsed.method;
    if (typeof method !== "string" || !(method in methodMap)) {
      return JSON.stringify({
        id,
        error: { code: "bad_request", message: `unknown method: ${String(method)}` },
      });
    }
    const def = methodMap[method as MethodName];
    const paramsRes = def.params.safeParse(parsed.params ?? {});
    if (!paramsRes.success) {
      return JSON.stringify({
        id,
        error: {
          code: "bad_request",
          message: paramsRes.error.issues[0]?.message ?? "invalid params",
        },
      });
    }
    try {
      const result = await this.dispatch(method as MethodName, paramsRes.data);
      return JSON.stringify({ id, result });
    } catch (e) {
      if (e instanceof RpcError) {
        return JSON.stringify({ id, error: { code: e.code, message: e.message } });
      }
      if (e instanceof ProviderError) {
        return JSON.stringify({ id, error: { code: e.code, message: e.message } });
      }
      console.error("[bobagentd] handler error", e);
      return JSON.stringify({ id, error: { code: "internal", message: "internal error" } });
    }
  }

  private async dispatch(method: MethodName, params: unknown): Promise<unknown> {
    switch (method) {
      case "agents.list":
        return this.agents.list();
      case "agents.create": {
        const agent = this.agents.create(params as Parameters<AgentStore["create"]>[0]);
        queueMicrotask(() => this.broadcast("agent.created", agent));
        return agent;
      }
      case "agents.update": {
        const p = params as Parameters<AgentStore["update"]>[0];
        const before = this.agents.get(p.id);
        const agent = this.agents.update(p);
        if (!agent) throw new RpcError("not_found", "agent not found");
        if (before) void this.runtimes.agentUpdated(agent, before.provider !== agent.provider);
        queueMicrotask(() => this.broadcast("agent.updated", agent));
        return agent;
      }
      case "agents.delete": {
        const p = params as { id: string };
        const ok = this.agents.softDelete(p.id);
        if (!ok) throw new RpcError("not_found", "agent not found");
        this.queue.removeAllForAgent(p.id);
        this.runtimes.agentDeleted(p.id);
        queueMicrotask(() => this.broadcast("agent.deleted", { id: p.id }));
        return { ok: true };
      }
      case "chat.history": {
        const p = params as { agentId: string; beforeSeq?: number; limit?: number };
        if (!this.agents.get(p.agentId)) throw new RpcError("not_found", "agent not found");
        const { items, hasMore } = this.chat.history(p.agentId, p.beforeSeq, p.limit ?? 200);
        const turnIds = [...new Set(items.map((i) => i.turnId).filter((t): t is string => !!t))];
        return { items, turns: this.chat.turnsByIds(turnIds), hasMore };
      }
      case "chat.send": {
        const p = params as { agentId: string; text: string };
        return this.runtimes.send(p.agentId, p.text);
      }
      case "queue.get": {
        const p = params as { agentId: string };
        return this.runtimes.getQueue(p.agentId);
      }
      case "queue.remove": {
        const p = params as { queueId: string };
        this.runtimes.removeQueued(p.queueId);
        return { ok: true };
      }
      case "queue.pause": {
        const p = params as { agentId: string };
        return this.runtimes.pauseQueue(p.agentId);
      }
      case "queue.resume": {
        const p = params as { agentId: string };
        return this.runtimes.resumeQueue(p.agentId);
      }
      case "agents.configOptions": {
        const p = params as { agentId: string };
        return { configOptions: await this.runtimes.configOptions(p.agentId) };
      }
      case "agents.setConfig": {
        const p = params as { agentId: string; configId: string; value: string };
        return { configOptions: await this.runtimes.setConfig(p.agentId, p.configId, p.value) };
      }
      case "chat.cancel": {
        const p = params as { agentId: string };
        this.runtimes.cancel(p.agentId);
        return { ok: true };
      }
      case "agents.statuses":
        return this.runtimes.statuses();
      case "permissions.list":
        return this.runtimes.pendingPermissions();
      case "permissions.respond": {
        const p = params as { requestId: string; optionId: string | null };
        this.runtimes.respondPermission(p.requestId, p.optionId);
        return { ok: true };
      }
    }
  }
}
