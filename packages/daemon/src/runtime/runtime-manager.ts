import type {
  Agent,
  AgentStatusInfo,
  ConfigOption,
  PendingPermission,
  QueueState,
} from "@bobagent/protocol";
import type { AgentStore } from "../agents";
import type { ChatStore, QueueStore } from "../chat-store";
import { AgentRuntime, type Broadcast, RpcError } from "./agent-runtime";

export class RuntimeManager {
  private runtimes = new Map<string, AgentRuntime>();

  constructor(
    private agents: AgentStore,
    private chat: ChatStore,
    private queue: QueueStore,
    private broadcast: Broadcast,
  ) {}

  private runtimeFor(agentId: string): AgentRuntime {
    let rt = this.runtimes.get(agentId);
    if (!rt) {
      const agent = this.agents.get(agentId);
      if (!agent) throw new RpcError("not_found", "agent not found");
      rt = new AgentRuntime(agent, this.agents, this.chat, this.queue, this.broadcast);
      this.runtimes.set(agentId, rt);
    }
    return rt;
  }

  send(agentId: string, text: string): { queueId: string } {
    return this.runtimeFor(agentId).send(text);
  }

  getQueue(agentId: string): QueueState {
    if (!this.agents.get(agentId)) throw new RpcError("not_found", "agent not found");
    const rt = this.runtimes.get(agentId);
    if (rt) return rt.getQueue();
    return {
      agentId,
      paused: this.agents.queuePaused(agentId),
      items: this.queue.queued(agentId),
    };
  }

  removeQueued(queueId: string): void {
    for (const rt of this.runtimes.values()) {
      if (rt.getQueue().items.some((i) => i.id === queueId)) {
        rt.removeQueued(queueId);
        return;
      }
    }
    if (!this.queue.remove(queueId)) {
      throw new RpcError("not_found", "queue item not found or already started");
    }
  }

  pauseQueue(agentId: string): QueueState {
    return this.runtimeFor(agentId).pauseQueue();
  }

  resumeQueue(agentId: string): QueueState {
    return this.runtimeFor(agentId).resumeQueue();
  }

  async configOptions(agentId: string): Promise<ConfigOption[]> {
    return this.runtimeFor(agentId).configOptionsList();
  }

  async setConfig(agentId: string, configId: string, value: string): Promise<ConfigOption[]> {
    return this.runtimeFor(agentId).setConfig(configId, value);
  }

  /** Resume draining for every agent that still has queued items (startup). */
  resumeAllQueues(): void {
    for (const agentId of this.queue.agentsWithQueued()) {
      if (this.agents.queuePaused(agentId)) continue;
      try {
        this.runtimeFor(agentId).drain();
      } catch (e) {
        console.error(`[bobagentd] drain failed for ${agentId}:`, (e as Error).message);
      }
    }
  }

  cancel(agentId: string): void {
    const rt = this.runtimes.get(agentId);
    if (!rt) {
      if (!this.agents.get(agentId)) throw new RpcError("not_found", "agent not found");
      return;
    }
    rt.cancel();
  }

  respondPermission(requestId: string, optionId: string | null): void {
    for (const rt of this.runtimes.values()) {
      if (rt.listPending().some((p) => p.requestId === requestId)) {
        rt.respondPermission(requestId, optionId);
        return;
      }
    }
    throw new RpcError("not_found", "permission request not found or already resolved");
  }

  pendingPermissions(): PendingPermission[] {
    return [...this.runtimes.values()].flatMap((rt) => rt.listPending());
  }

  statuses(): Record<string, AgentStatusInfo> {
    const out: Record<string, AgentStatusInfo> = {};
    for (const agent of this.agents.list()) {
      const rt = this.runtimes.get(agent.id);
      out[agent.id] = rt
        ? { status: rt.status, error: rt.statusError }
        : { status: "idle", error: null };
    }
    return out;
  }

  /** Agent update: refresh the runtime's cached agent; kill session if provider changed. */
  async agentUpdated(agent: Agent, providerChanged: boolean): Promise<void> {
    const rt = this.runtimes.get(agent.id);
    if (!rt) return;
    rt.updateAgent(agent);
    if (providerChanged) await rt.dispose(true);
  }

  async agentDeleted(agentId: string): Promise<void> {
    const rt = this.runtimes.get(agentId);
    this.runtimes.delete(agentId);
    await rt?.dispose();
  }

  async closeAll(): Promise<void> {
    const all = [...this.runtimes.values()].map((rt) => rt.dispose());
    await Promise.allSettled(all);
    this.runtimes.clear();
  }
}
