import { expect, test } from "bun:test";
import type { DaemonClient } from "../src/lib/daemon";
import { GLOBAL_PAUSE_KEY, globallyPaused, toggleGlobalPause } from "../src/lib/global-pause";

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

test("empty, already paused and deleted queues never cause unrelated resumes", async () => {
  const h = harness();
  await toggleGlobalPause(h.client, h.storage);
  h.queues.set("individual", true);
  await toggleGlobalPause(h.client, h.storage);
  expect(h.calls).toEqual([]);
  h.values.set(GLOBAL_PAUSE_KEY, '["deleted"]');
  await toggleGlobalPause(h.client, h.storage);
  expect(h.calls).toEqual([]);
  expect(globallyPaused(h.storage)).toEqual([]);
});

test("partial failures retain successful ownership and failed resumes can be retried", async () => {
  const h = harness({ first: false, second: false });
  h.failOn("second");
  await expect(toggleGlobalPause(h.client, h.storage)).rejects.toThrow("offline");
  expect(globallyPaused(h.storage)).toEqual(["first"]);
  h.failOn("first");
  await expect(toggleGlobalPause(h.client, h.storage)).rejects.toThrow("offline");
  expect(globallyPaused(h.storage)).toEqual(["first"]);
  h.failOn();
  await toggleGlobalPause(h.client, h.storage);
  expect(Object.fromEntries(h.queues)).toEqual({ first: false, second: false });
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
