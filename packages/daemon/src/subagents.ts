// Subagents: an agent spawns short-lived child agents that work in parallel (each with its
// own provider session and, on a Firecracker host, its own microVM — placement is copied
// from the parent). Each child gets its task as an agent message; when every child of a
// batch has finished, the parent receives one <subagent_results> message. Non-kept children
// are deleted afterwards, which stops their provider process and microVM.

import type { Database } from "bun:sqlite";
import type { Agent, Subagent, Turn } from "@upbot/protocol";
import type { AgentStore } from "./agents";
import type { ChatStore, QueueRow, QueueStore } from "./chat-store";
import type { HostStore } from "./remote/hosts";
import type { RuntimeManager } from "./runtime/runtime-manager";

type Row = {
  agent_id: string;
  parent_id: string;
  batch_id: string;
  task: string;
  status: Subagent["status"];
  result: string | null;
  keep: number;
  created_at: number;
  finished_at: number | null;
};

export const MAX_SUBAGENTS_PER_CALL = 8;
export const MAX_SUBAGENT_DEPTH = 2;
const maxActive = () => Number(process.env.UPBOT_MAX_SUBAGENTS || 8);

export class SubagentService {
  constructor(
    private db: Database,
    private agents: AgentStore,
    private chat: ChatStore,
    private queue: QueueStore,
    private runtimes: () => RuntimeManager,
    private hosts: HostStore,
    private broadcast: (event: string, data: unknown) => void,
  ) {}

  private toSub(r: Row): Subagent {
    return {
      agentId: r.agent_id,
      parentId: r.parent_id,
      batchId: r.batch_id,
      task: r.task,
      status: r.status,
      result: r.result,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
    };
  }

  private row(agentId: string): Row | null {
    return this.db.query("SELECT * FROM subagents WHERE agent_id = ?").get(agentId) as Row | null;
  }

  list(parentId?: string): Subagent[] {
    const rows = (
      parentId
        ? this.db
            .query("SELECT * FROM subagents WHERE parent_id = ? ORDER BY created_at")
            .all(parentId)
        : this.db.query("SELECT * FROM subagents ORDER BY created_at").all()
    ) as Row[];
    return rows.map((r) => this.toSub(r));
  }

  parentOf(agentId: string): string | null {
    return this.row(agentId)?.parent_id ?? null;
  }

  depth(agentId: string): number {
    let d = 0;
    let cur = this.parentOf(agentId);
    while (cur && d < 10) {
      d++;
      cur = this.parentOf(cur);
    }
    return d;
  }

  spawn(
    parent: Agent,
    tasks: { task: string; name?: string }[],
    opts: { provider?: Agent["provider"]; keep?: boolean; hops: number },
  ): { batchId: string; agents: { id: string; name: string }[] } {
    if (!tasks.length) throw new Error("`tasks` must not be empty");
    if (tasks.length > MAX_SUBAGENTS_PER_CALL)
      throw new Error(`at most ${MAX_SUBAGENTS_PER_CALL} subagents per call`);
    if (this.depth(parent.id) + 1 > MAX_SUBAGENT_DEPTH)
      throw new Error(`subagents cannot nest deeper than ${MAX_SUBAGENT_DEPTH} levels`);
    const active = (
      this.db
        .query("SELECT COUNT(*) AS n FROM subagents WHERE parent_id = ? AND status = 'running'")
        .get(parent.id) as { n: number }
    ).n;
    if (active + tasks.length > maxActive())
      throw new Error(`too many running subagents (${active}/${maxActive()}); wait for results`);
    for (const t of tasks) {
      if (typeof t.task !== "string" || !t.task.trim() || t.task.length > 50_000)
        throw new Error("each task needs 1-50000 characters of `task`");
    }
    const batchId = crypto.randomUUID();
    const out: { id: string; name: string }[] = [];
    tasks.forEach((t, i) => {
      const label = (t.name?.trim() || `sub ${i + 1}`).slice(0, 40);
      const agent = this.agents.create({
        name: `${parent.name} · ${label}`.slice(0, 80),
        provider: opts.provider ?? parent.provider,
        instructions:
          `You are a subagent of ${parent.name} (agent id ${parent.id}). Complete the task you are given, then reply with a concise result; the reply is returned to ${parent.name} automatically. You can talk to other agents with send_message.\n\n${parent.instructions}`.trim(),
        avatar: parent.avatar,
      });
      this.hosts.copyPlacement(parent.id, agent.id);
      this.db
        .query(
          "INSERT INTO subagents (agent_id, parent_id, batch_id, task, status, keep, created_at) VALUES (?, ?, ?, ?, 'running', ?, ?)",
        )
        .run(agent.id, parent.id, batchId, t.task, opts.keep ? 1 : 0, Date.now());
      this.broadcast("agent.created", agent);
      this.broadcast("subagent.updated", this.toSub(this.row(agent.id)!));
      out.push({ id: agent.id, name: agent.name });
    });
    // enqueue after all rows exist so a fast first finisher cannot close the batch early
    for (const s of out) {
      const r = this.row(s.id)!;
      this.runtimes().sendFrom(s.id, r.task, { agentId: parent.id, hops: opts.hops });
    }
    return { batchId, agents: out };
  }

  async onTurnEnded(turn: Turn, queueRow: QueueRow | null): Promise<void> {
    const r = this.row(turn.agentId);
    if (!r || r.status !== "running" || !queueRow || queueRow.from_agent_id !== r.parent_id) return;
    if (turn.status === "completed") {
      const text = this.chat
        .itemsForTurn(turn.id)
        .filter((i) => i.kind === "agent_message")
        .map((i) => ("text" in i ? i.text : ""))
        .join("\n\n")
        .trim();
      await this.finish(r, "done", text || "(no reply)");
    } else {
      await this.finish(r, "failed", `${turn.status}: ${turn.error ?? "no result"}`);
    }
  }

  async stop(parentId: string, agentId: string): Promise<void> {
    const r = this.row(agentId);
    if (!r || r.parent_id !== parentId) throw new Error(`no subagent "${agentId}" of yours`);
    if (r.status !== "running") return;
    this.runtimes().cancel(agentId);
    await this.finish(r, "stopped", "stopped by parent");
  }

  private async finish(r: Row, status: Subagent["status"], result: string): Promise<void> {
    this.db
      .query("UPDATE subagents SET status = ?, result = ?, finished_at = ? WHERE agent_id = ?")
      .run(status, result.slice(0, 100_000), Date.now(), r.agent_id);
    this.broadcast("subagent.updated", this.toSub(this.row(r.agent_id)!));
    const batch = this.db
      .query("SELECT * FROM subagents WHERE batch_id = ? ORDER BY created_at")
      .all(r.batch_id) as Row[];
    if (batch.some((b) => b.status === "running")) return;
    const names = new Map(
      batch.map((b) => [b.agent_id, this.agents.get(b.agent_id)?.name ?? b.agent_id]),
    );
    for (const b of batch) {
      if (b.keep) continue;
      if (this.agents.softDelete(b.agent_id)) {
        this.queue.removeAllForAgent(b.agent_id);
        await this.runtimes().agentDeleted(b.agent_id);
        this.broadcast("agent.deleted", { id: b.agent_id });
      }
    }
    const parent = this.agents.get(r.parent_id);
    if (parent) {
      const body = batch
        .map((b) => {
          const name = names.get(b.agent_id) ?? b.agent_id;
          return `## ${name} [${b.status}]\nTask: ${b.task.slice(0, 500)}\n\n${b.result ?? ""}`;
        })
        .join("\n\n");
      this.runtimes().sendFrom(
        parent.id,
        `<subagent_results batch="${r.batch_id}">\n${body}\n</subagent_results>`,
        { agentId: r.agent_id, hops: 0 },
      );
    }
  }
}
