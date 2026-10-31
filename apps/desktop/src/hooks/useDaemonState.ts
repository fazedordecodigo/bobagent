import type { Agent, AgentStatusInfo, Channel } from "@boto/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DaemonClient } from "../lib/daemon";
import { errorFields, logError } from "../lib/log";

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Connects to the daemon and keeps agents, statuses and channels in sync. Ready
// means the first refresh succeeded, including after reconnecting.
// Reconnect policy is caller-owned: subscribe `client.onReconnect` and call
// `refresh()` with the error handling that fits the window (App stays silent,
// MenuBar surfaces the error). `onRefresh` runs inside every `refresh()` so
// callers can piggyback extra loads on the same cycle.
export function useDaemonState(
  client: DaemonClient,
  {
    includeChannels = true,
    onRefresh,
  }: {
    includeChannels?: boolean;
    onRefresh?: () => Promise<unknown>;
  } = {},
) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [statuses, setStatuses] = useState<Record<string, AgentStatusInfo>>({});
  const [channels, setChannels] = useState<Channel[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const connectionError = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const version = ++generation.current;
    const [list, nextStatuses, nextChannels] = await Promise.all([
      client.request("agents.list", {}),
      client.request("agents.statuses", {}),
      includeChannels
        ? client.request("channels.list", { includeArchived: true })
        : Promise.resolve(null),
    ]);
    if (version !== generation.current) return;
    setAgents(list);
    setStatuses(nextStatuses);
    if (nextChannels) setChannels(nextChannels);
    await onRefresh?.();
    if (version !== generation.current) return;
    setReady(true);
    const failed = connectionError.current;
    if (failed !== null) {
      connectionError.current = null;
      setError((prev) => (prev === failed ? null : prev));
    }
  }, [client, includeChannels, onRefresh]);

  useEffect(() => {
    let alive = true;
    void client
      .connect()
      .then(refresh)
      .catch((e: unknown) => {
        logError("app.connect_failed", errorFields(e));
        if (!alive) return;
        const message = errorMessage(e);
        connectionError.current = message;
        setError(message);
      });
    const offs = [
      client.on("agent.created", (agent) =>
        setAgents((prev) => (prev.some((item) => item.id === agent.id) ? prev : [...prev, agent])),
      ),
      client.on("agent.updated", (agent) =>
        setAgents((prev) => prev.map((item) => (item.id === agent.id ? agent : item))),
      ),
      client.on("agent.deleted", ({ id }) => {
        setAgents((prev) => prev.filter((agent) => agent.id !== id));
      }),
      client.on("agent.status", ({ agentId, status, error: statusError }) =>
        setStatuses((prev) => ({
          ...prev,
          [agentId]: { status, error: statusError },
        })),
      ),
    ];
    if (includeChannels) {
      offs.push(
        client.on("channel.created", (channel) =>
          setChannels((prev) =>
            prev.some((item) => item.id === channel.id) ? prev : [...prev, channel],
          ),
        ),
        client.on("channel.updated", (channel) =>
          setChannels((prev) => prev.map((item) => (item.id === channel.id ? channel : item))),
        ),
      );
    }
    return () => {
      alive = false;
      generation.current++;
      for (const off of offs) off();
      client.close();
    };
  }, [client, refresh, includeChannels]);

  return { agents, setAgents, statuses, channels, ready, error, setError, refresh };
}
