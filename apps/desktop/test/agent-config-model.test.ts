import { expect, test } from "bun:test";
import type { Routine } from "@upbot/protocol";
import type { AgentConfig, DraftRoutine } from "../src/lib/agent-config";
import {
  abbreviatePath,
  deepEqual,
  formatCustomSchedule,
  fromRoutine,
  isDirty,
  planMutations,
  rebase,
  routineWhenText,
  toRoutineSchedule,
} from "../src/lib/agent-config";

const config = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name: "Relatório",
  icon: { icon: "sym" },
  provider: "devin",
  model: null,
  effort: null,
  options: {},
  computerUse: false,
  instructions: "",
  memories: [],
  routines: [],
  ...overrides,
});

const routine = (schedule: string | null): Routine =>
  ({
    id: "r1",
    agentId: "a1",
    name: "Resumo",
    prompt: "Resuma",
    schedule,
    webhook: false,
    webhookUrl: null,
    webhookToken: null,
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: 0,
    updatedAt: 0,
  }) as Routine;

test("deep equality tracks nested draft state and dirty state", () => {
  const saved = config({ memories: [{ id: "m1", text: "Preferências" }] });
  expect(deepEqual(saved, config({ memories: [{ id: "m1", text: "Preferências" }] }))).toBe(true);
  expect(deepEqual(saved, config({ memories: [{ id: "m1", text: "Outra coisa" }] }))).toBe(false);
  expect(isDirty(saved, saved)).toBe(false);
  expect(isDirty(config({ name: "Alterado" }), saved)).toBe(true);
});

test("rebase adopts untouched server fields and preserves locally edited fields", () => {
  const oldSaved = config();
  const incoming = config({ name: "Atualizado", instructions: "Servidor" });
  const draft = config({ instructions: "Edição local" });
  expect(rebase(oldSaved, incoming, draft)).toMatchObject({
    name: "Atualizado",
    instructions: "Edição local",
  });
});

test("routine schedules round-trip supported schedules and retain custom values", () => {
  expect(fromRoutine(routine(null)).when).toBe("demand");
  expect(fromRoutine(routine("every 30m")).when).toBe("30m");
  expect(fromRoutine(routine("daily 09:00"))).toMatchObject({ when: "daily", time: "09:00" });
  expect(fromRoutine(routine("weekly fri 17:00"))).toMatchObject({
    when: "weekly",
    time: "sex 17:00",
  });
  expect(toRoutineSchedule({ when: "weekly", time: "sáb 09:00", schedule: null })).toBe(
    "weekly sat 09:00",
  );
  expect(fromRoutine(routine("every 2h"))).toMatchObject({
    when: "custom",
    schedule: "every 2h",
  });
});

test("routine tags include custom labels, webhook, and paused state", () => {
  expect(formatCustomSchedule("every 3d")).toBe("A cada 3 dias");
  const paused: DraftRoutine = {
    name: "Resumo",
    when: "custom",
    time: "",
    schedule: "every 45m",
    prompt: "Resuma",
    hook: true,
    enabled: false,
  };
  expect(routineWhenText(paused)).toBe("Pausada · A cada 45 min · webhook");
});

test("workspace paths abbreviate Unix and Windows user homes", () => {
  expect(abbreviatePath("/Users/ana/UpBot/agents/a1")).toBe("~/UpBot/agents/a1");
  expect(abbreviatePath("C:\\Users\\Ana\\UpBot\\agents\\a1")).toBe("~\\UpBot\\agents\\a1");
});

test("mutation plan skips old-provider config and diffs memories, routines, and computer access", () => {
  const savedRoutine: DraftRoutine = {
    id: "r1",
    name: "Diária",
    when: "daily",
    time: "09:00",
    schedule: "daily 09:00",
    prompt: "Resumo",
    hook: false,
    enabled: true,
  };
  const saved = config({
    model: "old",
    memories: [{ id: "m1", text: "Antiga" }],
    routines: [savedRoutine],
  });
  const draft = config({
    provider: "claude",
    model: "new",
    computerUse: true,
    memories: [{ id: "m1", text: "Editada" }, { text: "Nova" }],
    routines: [
      { ...savedRoutine, name: "Atualizada" },
      {
        name: "Nova rotina",
        when: "30m",
        time: "",
        schedule: null,
        prompt: "Executar",
        hook: true,
        enabled: false,
      },
    ],
  });
  const plan = planMutations(saved, draft);
  expect(plan.filter((item) => item.type === "setConfig")).toEqual([]);
  expect(plan.map((item) => item.type)).toEqual([
    "updateAgent",
    "memoryUpdate",
    "memoryAdd",
    "routineUpdate",
    "routineCreate",
    "computer",
  ]);
  expect(plan.find((item) => item.type === "computer")).toEqual({
    type: "computer",
    enabled: true,
  });
});

test("mutation plan clears an explicit config value when returning to the provider default", () => {
  const saved = config({ model: "m2" });
  const draft = config({ model: null });
  expect(planMutations(saved, draft)).toContainEqual({
    type: "setConfig",
    configId: "model",
    value: null,
  });
});
