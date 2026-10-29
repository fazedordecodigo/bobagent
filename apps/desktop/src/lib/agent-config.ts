import type { Agent, AgentAvatar, Memory, ProviderId, Routine } from "@upbot/protocol";

export type Effort = "low" | "medium" | "high";
export type RoutineWhen = "demand" | "30m" | "daily" | "weekly" | "custom";
export interface DraftMemory {
  id?: string;
  text: string;
}
export interface DraftRoutine {
  id?: string;
  name: string;
  when: RoutineWhen;
  time: string;
  schedule: string | null;
  prompt: string;
  hook: boolean;
  enabled: boolean;
}
export interface AgentConfig {
  name: string;
  icon: AgentAvatar | { icon: "sym" | "mail" | "receipt" | "plane" | "chart" | "cal" | "sheet" };
  provider: ProviderId;
  model: string | null;
  effort: string | null;
  options: Record<string, string>;
  computerUse: boolean;
  instructions: string;
  memories: DraftMemory[];
  routines: DraftRoutine[];
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => deepEqual(v, b[i]))
    );
  }
  const left = Object.keys(a);
  const right = Object.keys(b);
  return (
    left.length === right.length &&
    left.every(
      (key) =>
        Object.hasOwn(b, key) &&
        deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}

export function isDirty(draft: AgentConfig, saved: AgentConfig): boolean {
  return !deepEqual(draft, saved);
}

export function rebase<T extends object>(oldSaved: T, newSaved: T, draft: T): T {
  const result = { ...draft };
  for (const key of Object.keys(newSaved) as (keyof T)[]) {
    if (deepEqual(draft[key], oldSaved[key])) Object.assign(result, { [key]: newSaved[key] });
  }
  return result as T;
}

const EN_TO_PT: Record<string, string> = {
  sun: "dom",
  mon: "seg",
  tue: "ter",
  wed: "qua",
  thu: "qui",
  fri: "sex",
  sat: "sáb",
};
const PT_TO_EN = Object.fromEntries(Object.entries(EN_TO_PT).map(([en, pt]) => [pt, en]));

export function fromRoutine(routine: Routine): DraftRoutine {
  const schedule = routine.schedule;
  if (schedule === null) {
    return {
      id: routine.id,
      name: routine.name,
      when: "demand",
      time: "",
      schedule,
      prompt: routine.prompt,
      hook: routine.webhook,
      enabled: routine.enabled,
    };
  }
  if (/^every\s+30m$/i.test(schedule.trim())) {
    return {
      id: routine.id,
      name: routine.name,
      when: "30m",
      time: "",
      schedule,
      prompt: routine.prompt,
      hook: routine.webhook,
      enabled: routine.enabled,
    };
  }
  const daily = /^daily\s+(\d{1,2}:\d{2})$/i.exec(schedule.trim());
  const dailyTime = daily?.[1];
  if (dailyTime) {
    return {
      id: routine.id,
      name: routine.name,
      when: "daily",
      time: dailyTime,
      schedule,
      prompt: routine.prompt,
      hook: routine.webhook,
      enabled: routine.enabled,
    };
  }
  const weekly = /^weekly\s+(sun|mon|tue|wed|thu|fri|sat)\s+(\d{1,2}:\d{2})$/i.exec(
    schedule.trim(),
  );
  const weeklyDay = weekly?.[1]?.toLowerCase();
  const weeklyTime = weekly?.[2];
  const day = weeklyDay ? EN_TO_PT[weeklyDay] : undefined;
  if (weekly && day && weeklyTime) {
    return {
      id: routine.id,
      name: routine.name,
      when: "weekly",
      time: `${day} ${weeklyTime}`,
      schedule,
      prompt: routine.prompt,
      hook: routine.webhook,
      enabled: routine.enabled,
    };
  }
  return {
    id: routine.id,
    name: routine.name,
    when: "custom",
    time: "",
    schedule,
    prompt: routine.prompt,
    hook: routine.webhook,
    enabled: routine.enabled,
  };
}

export function toRoutineSchedule(
  routine: Pick<DraftRoutine, "when" | "time" | "schedule">,
): string | null {
  if (routine.when === "demand") return null;
  if (routine.when === "30m") return "every 30m";
  if (routine.when === "daily") return `daily ${routine.time}`;
  if (routine.when === "weekly") {
    const match = /^(dom|seg|ter|qua|qui|sex|sáb)\s+(\d{1,2}:\d{2})$/.exec(routine.time.trim());
    const day = match?.[1];
    return match
      ? `weekly ${PT_TO_EN[day ?? ""] ?? day ?? ""} ${match[2]}`
      : `weekly ${routine.time}`;
  }
  return routine.schedule;
}

export function isValidTime(value: string, when: "daily" | "weekly"): boolean {
  const pattern =
    when === "weekly"
      ? /^(dom|seg|ter|qua|qui|sex|sáb)\s+(\d{1,2}):(\d{2})$/
      : /^(\d{1,2}):(\d{2})$/;
  const match = pattern.exec(value.trim());
  if (!match) return false;
  const hour = Number(match[match.length - 2]);
  const minute = Number(match[match.length - 1]);
  return hour <= 23 && minute <= 59;
}

export function routineWhenText(
  routine: Pick<DraftRoutine, "when" | "time" | "schedule" | "hook" | "enabled">,
): string {
  let label =
    routine.when === "demand"
      ? "Quando você pedir"
      : routine.when === "30m"
        ? "A cada 30 min"
        : routine.when === "daily"
          ? `Todo dia, ${routine.time}`
          : routine.when === "weekly"
            ? `Toda semana, ${routine.time}`
            : formatCustomSchedule(routine.schedule);
  if (routine.hook) label += " · webhook";
  return routine.enabled ? label : `Pausada · ${label}`;
}

export function formatCustomSchedule(schedule: string | null): string {
  const interval = /^every\s+(\d+)\s*(m|h|d)$/i.exec(schedule?.trim() ?? "");
  if (!interval) return schedule ?? "Quando você pedir";
  const unitCode = interval[2]?.toLowerCase() as "m" | "h" | "d" | undefined;
  const unit = unitCode ? { m: "min", h: "h", d: "dias" }[unitCode] : "";
  return `A cada ${interval[1]} ${unit}`;
}

export function abbreviatePath(path: string, home = ""): string {
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  const unixHome = /^\/(?:Users|home)\/[^/]+(?=\/|$)/.exec(path)?.[0];
  if (unixHome) return `~${path.slice(unixHome.length)}`;
  const winHome = /^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/.exec(path)?.[0];
  if (winHome) return `~${path.slice(winHome.length)}`;
  return path;
}

export function configFromServer(
  agent: Agent,
  memories: Memory[],
  routines: Routine[],
  computerUse: boolean,
): AgentConfig {
  const { model = null, effort = null, ...options } = agent.config;
  return {
    name: agent.name,
    icon: agent.avatar ?? { icon: "sym" },
    provider: agent.provider,
    model,
    effort,
    options,
    computerUse,
    instructions: agent.instructions,
    memories: memories.map(({ id, text }) => ({ id, text })),
    routines: routines.map(fromRoutine),
  };
}

export type AgentMutation =
  | {
      type: "updateAgent";
      patch: Partial<Pick<AgentConfig, "name" | "instructions" | "provider" | "icon">>;
    }
  | { type: "setConfig"; configId: string; value: string | null }
  | { type: "memoryAdd"; text: string }
  | { type: "memoryUpdate"; id: string; text: string }
  | { type: "memoryDelete"; id: string }
  | { type: "routineCreate"; routine: Omit<DraftRoutine, "id"> }
  | { type: "routineUpdate"; id: string; routine: Omit<DraftRoutine, "id"> }
  | { type: "routineDelete"; id: string }
  | { type: "computer"; enabled: boolean };

export function planMutations(saved: AgentConfig, draft: AgentConfig): AgentMutation[] {
  const plan: AgentMutation[] = [];
  const patch: Partial<Pick<AgentConfig, "name" | "instructions" | "provider" | "icon">> = {};
  for (const key of ["name", "instructions", "provider", "icon"] as const) {
    if (!deepEqual(saved[key], draft[key])) patch[key] = draft[key] as never;
  }
  if (Object.keys(patch).length) plan.push({ type: "updateAgent", patch });
  if (saved.provider === draft.provider) {
    const before: Record<string, string | null> = {
      model: saved.model,
      effort: saved.effort,
      ...saved.options,
    };
    const after: Record<string, string | null> = {
      model: draft.model,
      effort: draft.effort,
      ...draft.options,
    };
    const configIds = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const configId of configIds) {
      const value = after[configId] ?? null;
      if (before[configId] !== value) plan.push({ type: "setConfig", configId, value });
    }
  }
  const savedMemories = new Map(
    saved.memories
      .filter((item): item is DraftMemory & { id: string } => !!item.id)
      .map((item) => [item.id, item]),
  );
  const draftMemories = new Map(
    draft.memories
      .filter((item): item is DraftMemory & { id: string } => !!item.id)
      .map((item) => [item.id, item]),
  );
  for (const [id, item] of savedMemories) {
    const next = draftMemories.get(id);
    if (!next) plan.push({ type: "memoryDelete", id });
    else if (next.text !== item.text) plan.push({ type: "memoryUpdate", id, text: next.text });
  }
  for (const item of draft.memories)
    if (!item.id) plan.push({ type: "memoryAdd", text: item.text });
  const savedRoutines = new Map(
    saved.routines
      .filter((item): item is DraftRoutine & { id: string } => !!item.id)
      .map((item) => [item.id, item]),
  );
  const draftRoutines = new Map(
    draft.routines
      .filter((item): item is DraftRoutine & { id: string } => !!item.id)
      .map((item) => [item.id, item]),
  );
  for (const [id, item] of savedRoutines) {
    const next = draftRoutines.get(id);
    if (!next) plan.push({ type: "routineDelete", id });
    else {
      if (!deepEqual({ ...item, id: undefined }, { ...next, id: undefined })) {
        plan.push({
          type: "routineUpdate",
          id,
          routine: {
            name: next.name,
            when: next.when,
            time: next.time,
            schedule: toRoutineSchedule(next),
            prompt: next.prompt,
            hook: next.hook,
            enabled: next.enabled,
          },
        });
      }
    }
  }
  for (const item of draft.routines) {
    if (!item.id)
      plan.push({
        type: "routineCreate",
        routine: {
          name: item.name,
          when: item.when,
          time: item.time,
          schedule: toRoutineSchedule(item),
          prompt: item.prompt,
          hook: item.hook,
          enabled: item.enabled,
        },
      });
  }
  if (saved.computerUse !== draft.computerUse)
    plan.push({ type: "computer", enabled: draft.computerUse });
  return plan;
}
