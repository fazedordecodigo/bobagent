import { expect, test } from "bun:test";
import type { DaemonClient } from "../src/lib/daemon";
import {
  GLOBAL_PAUSE_KEY,
  globallyPaused,
  globalPauseAction,
  globalPauseState,
  reconcileGlobalPause,
  toggleGlobalPause,
} from "../src/lib/global-pause";

function harness(initial: Record<string, boolean> = {}) {
  const queues = new Map(Object.entries(initial));
  const values = new Map<string, string>();
  const calls: string[] = [];
  let fail: string | undefined;
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const client = {
    request: async (method: string, params: { agentId?: string }) => {
      if (method === "agents.list") return [...queues.keys()].map((id) => ({ id }));
      const id = params.agentId ?? "";
      if (method === "queue.get") return { agentId: id, paused: queues.get(id), items: [] };
      calls.push(`${method}:${id}`);
      if (id === fail) throw new Error("offline");
      queues.set(id, method === "queue.pause");
      return { agentId: id, paused: queues.get(id), items: [] };
    },
  } as Pick<DaemonClient, "request">;
  return {
    queues,
    calls,
    storage,
    values,
    client,
    failOn: (id?: string) => {
      fail = id;
    },
  };
}

test("global pause owns only queues it paused; resume survives reload and ignores new bots", async () => {
  const h = harness({ individual: true, first: false, second: false });
  await toggleGlobalPause(h.client, h.storage);
  expect(globallyPaused(h.storage)).toEqual(["first", "second"]);
  expect(globalPauseState(h.storage).mode).toBe("paused");
  h.queues.set("new-paused", true);
  h.queues.set("new-running", false);
  await toggleGlobalPause(h.client, { ...h.storage });
  expect(Object.fromEntries(h.queues)).toEqual({
    individual: true,
    first: false,
    second: false,
    "new-paused": true,
    "new-running": false,
  });
  expect(globallyPaused(h.storage)).toEqual([]);
  expect(h.calls).toEqual([
    "queue.pause:first",
    "queue.pause:second",
    "queue.resume:first",
    "queue.resume:second",
  ]);
});

test("individual resume then re-pause relinquishes ownership and stays paused on global resume", async () => {
  const h = harness({ first: false, second: false });
  await toggleGlobalPause(h.client, h.storage);
  reconcileGlobalPause(h.storage, { agentId: "first", paused: false });
  h.queues.set("first", true);
  reconcileGlobalPause(h.storage, { agentId: "first", paused: true });
  await toggleGlobalPause(h.client, h.storage);
  expect(h.queues).toEqual(
    new Map([
      ["first", true],
      ["second", false],
    ]),
  );
  expect(globallyPaused(h.storage)).toEqual([]);
});

test("empty, already paused and deleted queues never cause unrelated resumes", async () => {
  const h = harness();
  await toggleGlobalPause(h.client, h.storage);
  h.queues.set("individual", true);
  await toggleGlobalPause(h.client, h.storage);
  expect(h.calls).toEqual([]);
  expect(globalPauseAction(h.storage)).toBe("pause");
  expect(globalPauseState(h.storage)).toEqual({ mode: "pausing", owned: [] });
  h.values.set(GLOBAL_PAUSE_KEY, '["deleted"]');
  await toggleGlobalPause(h.client, h.storage);
  expect(h.calls).toEqual([]);
  expect(globallyPaused(h.storage)).toEqual([]);
});

test("all individually paused is idle; creating a bot never pauses it and stale resume cannot pause", async () => {
  const h = harness({ individual: true });
  await toggleGlobalPause(h.client, h.storage);
  expect(globalPauseAction(h.storage)).toBe("pause");
  h.queues.set("new-bot", false);
  await toggleGlobalPause(h.client, h.storage, new Set(), "resume");
  expect(h.queues.get("new-bot")).toBe(false);
  expect(h.calls).toEqual([]);
  await toggleGlobalPause(h.client, h.storage);
  expect(h.calls).toEqual(["queue.pause:new-bot"]);
  expect(globalPauseAction(h.storage)).toBe("resume");
});

test("partial failures retain successful ownership and failed resumes can be retried", async () => {
  const h = harness({ first: false, second: false });
  h.failOn("second");
  await expect(toggleGlobalPause(h.client, h.storage)).rejects.toThrow("offline");
  expect(globallyPaused(h.storage)).toEqual(["first"]);
  expect(globalPauseState(h.storage).mode).toBe("pausing");
  h.failOn();
  await toggleGlobalPause(h.client, h.storage);
  expect(Object.fromEntries(h.queues)).toEqual({ first: true, second: true });
  expect(globalPauseState(h.storage).mode).toBe("paused");
});

test("resume failures keep ownership for a later retry", async () => {
  const h = harness({ first: true, second: true });
  h.values.set(GLOBAL_PAUSE_KEY, JSON.stringify({ mode: "paused", owned: ["first", "second"] }));
  h.failOn("second");
  await expect(toggleGlobalPause(h.client, h.storage)).rejects.toThrow("offline");
  expect(globallyPaused(h.storage)).toEqual(["second"]);
  h.failOn();
  await toggleGlobalPause(h.client, h.storage);
  expect(globallyPaused(h.storage)).toEqual([]);
});

test("unavailable storage prevents mutation; corrupt ownership never authorizes resume", async () => {
  const h = harness({ individual: true });
  for (const value of ["bad JSON", "{}", "[null]"]) {
    h.values.set(GLOBAL_PAUSE_KEY, value);
    expect(globallyPaused(h.storage)).toEqual([]);
    await toggleGlobalPause(h.client, h.storage);
  }
  await expect(
    toggleGlobalPause(h.client, {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage full");
      },
    }),
  ).rejects.toThrow("storage full");
  expect(h.calls).toEqual([]);
});
