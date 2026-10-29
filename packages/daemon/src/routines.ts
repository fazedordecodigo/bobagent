import type { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import type { Routine, RoutineRun, RoutineTrigger } from "@upbot/protocol";
import type { AgentStore } from "./agents";
import type { Broadcast } from "./rpc";
import { RpcError } from "./runtime/agent-runtime";
import type { RuntimeManager } from "./runtime/runtime-manager";

// Routines: saved prompts sent to an agent on a schedule, via a local webhook, or manually.
// Schedules: "every <n>m|h|d", "daily HH:MM", "weekly mon..sun HH:MM" (local time).

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const PAYLOAD_LIMIT = 20_000;

export function parseSchedule(s: string): (from: number) => number {
  const t = s.trim().toLowerCase();
  let m = /^every\s+(\d+)\s*(m|h|d)$/.exec(t);
  if (m) {
    const ms = Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
    if (ms < 60_000) throw new Error("the shortest interval is 1 minute");
    return (from) => from + ms;
  }
  m = /^(daily|weekly\s+(sun|mon|tue|wed|thu|fri|sat))\s+(\d{1,2}):(\d{2})$/.exec(t);
  if (m) {
    const h = Number(m[3]);
    const min = Number(m[4]);
    if (h > 23 || min > 59) throw new Error("invalid time of day");
    const day = m[2] ? DAYS.indexOf(m[2]) : null;
    return (from) => {
      const d = new Date(from);
      d.setSeconds(0, 0);
      d.setHours(h, min);
      while (d.getTime() <= from || (day !== null && d.getDay() !== day))
        d.setDate(d.getDate() + 1);
      return d.getTime();
    };
  }
  throw new Error('schedule must look like "every 30m", "daily 09:00" or "weekly mon 09:00"');
}

type Row = {
  id: string;
  agent_id: string;
  name: string;
  prompt: string;
  schedule: string | null;
  webhook_token: string | null;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
};
type RunRow = {
  id: string;
  routine_id: string;
  trigger: string;
  queue_id: string | null;
  error: string | null;
  created_at: number;
};

const toRun = (r: RunRow): RoutineRun => ({
  id: r.id,
  routineId: r.routine_id,
  trigger: r.trigger as RoutineTrigger,
  queueId: r.queue_id,
  error: r.error,
  createdAt: r.created_at,
});

const newToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");

export class RoutineService {
  baseUrl = "";
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: Database,
    private agents: AgentStore,
    private runtimes: () => RuntimeManager,
    private broadcast: Broadcast,
  ) {}

  private toRoutine(r: Row): Routine {
    return {
      id: r.id,
      agentId: r.agent_id,
      name: r.name,
      prompt: r.prompt,
      schedule: r.schedule,
      webhook: r.webhook_token !== null,
      webhookUrl: r.webhook_token ? `${this.baseUrl}/hooks/${r.id}` : null,
      webhookToken: r.webhook_token,
      enabled: r.enabled === 1,
      lastRunAt: r.last_run_at,
      nextRunAt: r.next_run_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private row(id: string): Row | null {
    return this.db
      .query("SELECT * FROM routines WHERE id = ? AND deleted_at IS NULL")
      .get(id) as Row | null;
  }

  get(id: string): Routine {
    const r = this.row(id);
    if (!r) throw new RpcError("not_found", "routine not found");
    return this.toRoutine(r);
  }

  list(agentId?: string): Routine[] {
    const rows = (
      agentId
        ? this.db
            .query(
              "SELECT * FROM routines WHERE agent_id = ? AND deleted_at IS NULL ORDER BY created_at ASC",
            )
            .all(agentId)
        : this.db
            .query("SELECT * FROM routines WHERE deleted_at IS NULL ORDER BY created_at ASC")
            .all()
    ) as Row[];
    return rows.map((r) => this.toRoutine(r));
  }

  private nextRun(schedule: string | null, enabled: boolean, from = Date.now()): number | null {
    if (!schedule || !enabled) return null;
    try {
      return parseSchedule(schedule)(from);
    } catch (e) {
      throw new RpcError("bad_request", (e as Error).message);
    }
  }

  create(p: {
    agentId: string;
    name: string;
    prompt: string;
    schedule?: string | null | undefined;
    webhook?: boolean | undefined;
    enabled?: boolean | undefined;
  }): Routine {
    if (!this.agents.get(p.agentId)) throw new RpcError("not_found", "agent not found");
    const id = crypto.randomUUID();
    const now = Date.now();
    const schedule = p.schedule?.trim() || null;
    const enabled = p.enabled ?? true;
    this.db
      .query(
        `INSERT INTO routines (id, agent_id, name, prompt, schedule, webhook_token, enabled, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        p.agentId,
        p.name,
        p.prompt,
        schedule,
        p.webhook ? newToken() : null,
        enabled ? 1 : 0,
        this.nextRun(schedule, enabled, now),
        now,
        now,
      );
    return this.emit(id);
  }

  update(p: {
    id: string;
    name?: string | undefined;
    prompt?: string | undefined;
    schedule?: string | null | undefined;
    webhook?: boolean | undefined;
    enabled?: boolean | undefined;
  }): Routine {
    const r = this.row(p.id);
    if (!r) throw new RpcError("not_found", "routine not found");
    const schedule = p.schedule === undefined ? r.schedule : p.schedule?.trim() || null;
    const enabled = p.enabled ?? r.enabled === 1;
    const token =
      p.webhook === undefined
        ? r.webhook_token
        : p.webhook
          ? (r.webhook_token ?? newToken())
          : null;
    const next =
      schedule !== r.schedule || enabled !== (r.enabled === 1) || r.next_run_at === null
        ? this.nextRun(schedule, enabled)
        : r.next_run_at;
    this.db
      .query(
        "UPDATE routines SET name = ?, prompt = ?, schedule = ?, webhook_token = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        p.name ?? r.name,
        p.prompt ?? r.prompt,
        schedule,
        token,
        enabled ? 1 : 0,
        next,
        Date.now(),
        p.id,
      );
    return this.emit(p.id);
  }

  delete(id: string): void {
    if (!this.row(id)) throw new RpcError("not_found", "routine not found");
    this.db.query("UPDATE routines SET deleted_at = ? WHERE id = ?").run(Date.now(), id);
    this.broadcast("routine.deleted", { id });
  }

  runs(id: string): RoutineRun[] {
    const rows = this.db
      .query(
        "SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50",
      )
      .all(id) as RunRow[];
    return rows.map(toRun);
  }

  run(id: string, trigger: RoutineTrigger, payload?: string): RoutineRun {
    const r = this.row(id);
    if (!r) throw new RpcError("not_found", "routine not found");
    if (!this.agents.get(r.agent_id)) throw new RpcError("not_found", "agent not found");
    const body = payload
      ? `\n<webhook_payload>\n${payload.slice(0, PAYLOAD_LIMIT)}${payload.length > PAYLOAD_LIMIT ? "\n[truncated]" : ""}\n</webhook_payload>`
      : "";
    const prompt = `<routine name="${r.name.replace(/[<>"&]/g, "")}" trigger="${trigger}">\n${r.prompt}${body}\n</routine>`;
    let queueId: string | null = null;
    let error: string | null = null;
    try {
      ({ queueId } = this.runtimes().sendFrom(r.agent_id, r.prompt, {
        agentId: null,
        hops: 0,
        prompt,
        meta: { routine: { id: r.id, name: r.name, trigger } },
      }));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const runId = crypto.randomUUID();
    const now = Date.now();
    this.db
      .query(
        "INSERT INTO routine_runs (id, routine_id, trigger, queue_id, error, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(runId, id, trigger, queueId, error, now);
    this.db.query("UPDATE routines SET last_run_at = ? WHERE id = ?").run(now, id);
    this.emit(id);
    return toRun(this.db.query("SELECT * FROM routine_runs WHERE id = ?").get(runId) as RunRow);
  }

  /** Routine id for a webhook call, or null when the token does not match. */
  webhookRoutine(id: string, token: string): string | { notFound: true } | null {
    const r = this.row(id);
    if (!r?.webhook_token || !r.enabled) return null;
    const a = Buffer.from(r.webhook_token);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return this.agents.get(r.agent_id) ? r.id : { notFound: true };
  }

  tick(now = Date.now()): void {
    const due = this.db
      .query(
        "SELECT routines.* FROM routines JOIN agents ON agents.id = routines.agent_id WHERE routines.deleted_at IS NULL AND agents.deleted_at IS NULL AND routines.enabled = 1 AND routines.next_run_at IS NOT NULL AND routines.next_run_at <= ?",
      )
      .all(now) as Row[];
    for (const r of due) {
      // missed runs collapse into one; the next run is computed from now
      this.db
        .query("UPDATE routines SET next_run_at = ? WHERE id = ?")
        .run(this.nextRun(r.schedule, true, now), r.id);
      this.run(r.id, "schedule");
    }
  }

  start(): void {
    const n = Number(process.env.UPBOT_ROUTINE_TICK_MS);
    this.tick();
    this.timer = setInterval(() => this.tick(), Number.isFinite(n) && n > 0 ? n : 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private emit(id: string): Routine {
    const r = this.get(id);
    this.broadcast("routine.updated", r);
    return r;
  }
}
