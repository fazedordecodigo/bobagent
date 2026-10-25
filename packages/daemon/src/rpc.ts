import { type MethodName, methodMap } from "@bobagent/protocol";
import type { AgentStore } from "./agents";
import { attachmentsBlock, saveAttachments } from "./attachments";
import type { ChannelService } from "./channels";
import type { ChatStore, QueueStore } from "./chat-store";
import { draftAgent } from "./draft";
import type { MemoryStore } from "./memories";
import { ProviderError } from "./providers/types";
import type { RoutineService } from "./routines";
import { RpcError } from "./runtime/agent-runtime";
import type { RuntimeManager } from "./runtime/runtime-manager";
import type { SkillLibrary } from "./skills";

export type Broadcast = (event: string, data: unknown) => void;

export class Rpc {
  constructor(
    private agents: AgentStore,
    private chat: ChatStore,
    private queue: QueueStore,
    private runtimes: RuntimeManager,
    private broadcast: Broadcast,
    private channels: ChannelService,
    private memories: MemoryStore,
    private skills: SkillLibrary,
    private routines: RoutineService,
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
        const p = params as {
          agentId: string;
          text: string;
          attachments?: { name: string; mime: string; dataBase64: string }[];
        };
        if (!p.attachments?.length) return this.runtimes.send(p.agentId, p.text);
        const agent = this.agents.get(p.agentId);
        if (!agent) throw new RpcError("not_found", "agent not found");
        const saved = saveAttachments(agent.workspacePath, p.attachments);
        return this.runtimes.sendFrom(p.agentId, p.text, {
          agentId: null,
          hops: 0,
          prompt: attachmentsBlock(saved) + p.text,
          meta: { attachments: saved },
        });
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
      case "agents.usage":
        return this.runtimes.usage((params as { agentId: string }).agentId);
      case "agents.compact":
        await this.runtimes.compact((params as { agentId: string }).agentId);
        return { ok: true };
      case "routines.list":
        return this.routines.list((params as { agentId?: string }).agentId);
      case "routines.create":
        return this.routines.create(params as Parameters<RoutineService["create"]>[0]);
      case "routines.update":
        return this.routines.update(params as Parameters<RoutineService["update"]>[0]);
      case "routines.delete":
        this.routines.delete((params as { id: string }).id);
        return { ok: true };
      case "routines.run":
        return this.routines.run((params as { id: string }).id, "manual");
      case "routines.runs":
        this.routines.get((params as { id: string }).id);
        return this.routines.runs((params as { id: string }).id);
      case "agents.draft":
        return draftAgent((params as { prompt: string }).prompt);
      case "memories.list": {
        const p = params as { agentId: string };
        if (!this.agents.get(p.agentId)) throw new RpcError("not_found", "agent not found");
        return this.memories.list(p.agentId);
      }
      case "memories.add": {
        const p = params as { agentId: string; text: string };
        if (!this.agents.get(p.agentId)) throw new RpcError("not_found", "agent not found");
        const m = this.memories.add(p.agentId, p.text);
        this.broadcast("memories.changed", { agentId: p.agentId });
        return m;
      }
      case "memories.update": {
        const p = params as { id: string; text: string };
        const m = this.memories.update(p.id, p.text);
        if (!m) throw new RpcError("not_found", "memory not found");
        this.broadcast("memories.changed", { agentId: m.agentId });
        return m;
      }
      case "memories.delete": {
        const m = this.memories.get((params as { id: string }).id);
        if (!m || !this.memories.delete(m.id)) throw new RpcError("not_found", "memory not found");
        this.broadcast("memories.changed", { agentId: m.agentId });
        return { ok: true };
      }
      case "skills.list":
        return this.skills.list();
      case "skills.get": {
        const s = this.skills.get((params as { name: string }).name);
        if (!s) throw new RpcError("not_found", "skill not found");
        return s;
      }
      case "skills.save": {
        const p = params as { name: string; description: string; body: string };
        try {
          const s = this.skills.save({ ...p, author: "user" }, "upsert");
          this.broadcast("skills.changed", {});
          return s;
        } catch (e) {
          throw new RpcError("bad_request", (e as Error).message);
        }
      }
      case "skills.delete": {
        if (!this.skills.delete((params as { name: string }).name)) {
          throw new RpcError("not_found", "skill not found");
        }
        this.broadcast("skills.changed", {});
        return { ok: true };
      }
      case "channels.list":
        return this.channels.list((params as { includeArchived?: boolean }).includeArchived);
      case "channels.create":
        return this.channels.create(params as Parameters<ChannelService["create"]>[0]);
      case "channels.history": {
        const p = params as { channelId: string; limit?: number };
        return this.channels.history(p.channelId, p.limit);
      }
      case "channels.post": {
        const p = params as { channelId: string; text: string };
        return this.channels.post(p.channelId, p.text);
      }
      case "channels.stop":
        return this.channels.stop((params as { channelId: string }).channelId);
      case "channels.resume":
        return this.channels.resume((params as { channelId: string }).channelId);
      case "channels.archive":
        return this.channels.archive((params as { channelId: string }).channelId);
      case "channels.restore":
        return this.channels.restore((params as { channelId: string }).channelId);
      case "channels.reassign": {
        const p = params as { channelId: string; ownerId: string };
        return this.channels.reassign(p.channelId, p.ownerId);
      }
      case "channels.setMembers": {
        const p = params as { channelId: string; memberIds: string[] };
        return this.channels.setMembers(p.channelId, p.memberIds);
      }
    }
  }
}
