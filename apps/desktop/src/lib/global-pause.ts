import type { DaemonClient } from "./daemon";

export const GLOBAL_PAUSE_KEY = "upbot.menubar.pausedQueues.v1";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export function globallyPaused(storage: Storage): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(GLOBAL_PAUSE_KEY) ?? "[]");
    return Array.isArray(value) && value.every((id) => typeof id === "string")
      ? [...new Set(value)]
      : [];
  } catch {
    return [];
  }
}

export async function toggleGlobalPause(client: Pick<DaemonClient, "request">, storage: Storage) {
  let owned = globallyPaused(storage);
  const agents = await client.request("agents.list", {});
  const resume = owned.length > 0;
  storage.setItem(GLOBAL_PAUSE_KEY, JSON.stringify(owned));
  if (resume) {
    const present = new Set(agents.map((agent) => agent.id));
    for (const id of [...owned]) {
      if (present.has(id)) await client.request("queue.resume", { agentId: id });
      owned = owned.filter((item) => item !== id);
      storage.setItem(GLOBAL_PAUSE_KEY, JSON.stringify(owned));
    }
  } else {
    for (const agent of agents) {
      const queue = await client.request("queue.get", { agentId: agent.id });
      if (queue.paused) continue;
      await client.request("queue.pause", { agentId: agent.id });
      owned.push(agent.id);
      storage.setItem(GLOBAL_PAUSE_KEY, JSON.stringify(owned));
    }
  }
}
