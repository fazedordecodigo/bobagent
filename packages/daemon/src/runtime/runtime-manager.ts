import type { Agent, AgentStatusInfo, PendingPermission } from "@openagent/protocol";
import type { AgentStore } from "../agents";
import type { ChatStore } from "../chat-store";
import { AgentRuntime, type Broadcast, RpcError } from "./agent-runtime";

export class RuntimeManager {
  private runtimes = new Map<string, AgentRuntime>();

  constructor(
    private agents: AgentStore,
    private chat: ChatStore,
    private broadcast: Broadcast,
  ) {}

  private runtimeFor(agentId: string): AgentRuntime {
    let rt = this.runtimes.get(agentId);
    if (!rt) {
      const agent = this.agents.get(agentId);
      if (!agent) throw new RpcError("not_found", "agent not found");
      rt = new AgentRuntime(agent, this.chat, this.broadcast);
      this.runtimes.set(agentId, rt);
    }
    return rt;
  }

  send(agentId: string, text: string): { turnId: string } {
    return this.runtimeFor(agentId).send(text);
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

  onAgentUpdated(before: Agent, after: Agent): void {
    const rt = this.runtimes.get(after.id);
    if (!rt) return;
    if (before.provider !== after.provider) {
      rt.kill().catch(() => {});
      this.runtimes.delete(after.id);
    } else {
      rt.updateAgent(after);
    }
  }

  onAgentDeleted(agentId: string): void {
    const rt = this.runtimes.get(agentId);
    this.runtimes.delete(agentId);
    rt?.kill().catch(() => {});
  }

  async closeAll(): Promise<void> {
    const all = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.allSettled(all.map((rt) => rt.dispose()));
  }
}
