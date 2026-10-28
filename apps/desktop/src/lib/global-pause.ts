import type { DaemonClient } from "./daemon";

export const GLOBAL_PAUSE_KEY = "upbot.menubar.pausedQueues.v1";

export type GlobalPauseState = { mode: "pausing" | "paused"; owned: string[] };
export type GlobalPauseAction = "pause" | "resume";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
type QueueUpdate = { agentId: string; paused: boolean };

function parseState(value: unknown): GlobalPauseState {
  if (Array.isArray(value) && value.every((id) => typeof id === "string"))
    return { mode: value.length ? "paused" : "pausing", owned: [...new Set(value)] };
  if (value && typeof value === "object") {
    const candidate = value as { mode?: unknown; owned?: unknown };
    if (
      (candidate.mode === "pausing" || candidate.mode === "paused") &&
      Array.isArray(candidate.owned) &&
      candidate.owned.every((id) => typeof id === "string")
    )
      return { mode: candidate.mode, owned: [...new Set(candidate.owned)] };
  }
  return { mode: "pausing", owned: [] };
}

export function globalPauseState(storage: Storage): GlobalPauseState {
  try {
    return parseState(JSON.parse(storage.getItem(GLOBAL_PAUSE_KEY) ?? "null"));
  } catch {
    return { mode: "pausing", owned: [] };
  }
}

export function globallyPaused(storage: Storage): string[] {
  return globalPauseState(storage).owned;
}

export function globalPauseAction(storage: Storage): GlobalPauseAction {
  const current = globalPauseState(storage);
  return current.mode === "paused" && current.owned.length > 0 ? "resume" : "pause";
}

function save(storage: Storage, value: GlobalPauseState) {
  storage.setItem(GLOBAL_PAUSE_KEY, JSON.stringify(value));
}

export function reconcileGlobalPause(
  storage: Storage,
  queue: QueueUpdate,
  inFlight: ReadonlySet<string> = new Set(),
) {
  if (queue.paused || inFlight.has(queue.agentId)) return;
  const current = globalPauseState(storage);
  if (current.owned.includes(queue.agentId))
    save(storage, { ...current, owned: current.owned.filter((id) => id !== queue.agentId) });
}

export async function toggleGlobalPause(
  client: Pick<DaemonClient, "request">,
  storage: Storage,
  inFlight: Set<string> = new Set(),
  action = globalPauseAction(storage),
) {
  let current = globalPauseState(storage);
  const agents = await client.request("agents.list", {});
  const present = new Set(agents.map((agent) => agent.id));
  const errors: unknown[] = [];
  if (action === "resume") {
    for (const id of [...current.owned]) {
      if (!present.has(id)) {
        current = { ...current, owned: current.owned.filter((item) => item !== id) };
        save(storage, current);
        continue;
      }
      inFlight.add(id);
      try {
        await client.request("queue.resume", { agentId: id });
        current = { ...current, owned: current.owned.filter((item) => item !== id) };
        save(storage, current);
      } catch (error) {
        errors.push(error);
      } finally {
        inFlight.delete(id);
      }
    }
    if (errors.length) throw errors[0];
    save(storage, { mode: "pausing", owned: [] });
    return;
  }
  current = { mode: "pausing", owned: current.owned };
  save(storage, current);
  for (const agent of agents) {
    if (current.owned.includes(agent.id)) continue;
    const queue = await client.request("queue.get", { agentId: agent.id });
    if (queue.paused) continue;
    inFlight.add(agent.id);
    try {
      await client.request("queue.pause", { agentId: agent.id });
      current = { mode: "pausing", owned: [...current.owned, agent.id] };
      save(storage, current);
    } catch (error) {
      errors.push(error);
    } finally {
      inFlight.delete(agent.id);
    }
  }
  const active = await Promise.all(
    agents.map(async (agent) => (await client.request("queue.get", { agentId: agent.id })).paused),
  );
  current = {
    mode:
      current.owned.length > 0 && active.every(Boolean) && !errors.length ? "paused" : "pausing",
    owned: current.owned,
  };
  save(storage, current);
  if (errors.length) throw errors[0];
}
