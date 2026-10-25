import type { AgentStatusInfo, ChatItem, QueueState, Turn } from "@bobagent/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DaemonClient } from "../lib/daemon";

export type ChatState = {
  queue: QueueState | null;
  items: ChatItem[];
  turns: Map<string, Turn>;
  hasMore: boolean;
  runningTurn: Turn | null;
  status: AgentStatusInfo;
  loaded: boolean;
};

export function useChat(client: DaemonClient, agentId: string | null) {
  const [state, setState] = useState<ChatState>({
    items: [],
    turns: new Map(),
    hasMore: false,
    runningTurn: null,
    status: { status: "idle", error: null },
    loaded: false,
    queue: null as QueueState | null,
  });
  const seqCursor = useRef<number | null>(null);
  const activeAgent = useRef(agentId);
  activeAgent.current = agentId;

  const load = useCallback(async () => {
    if (!agentId) return;
    const forAgent = agentId;
    const res = await client.request("chat.history", { agentId: forAgent });
    if (activeAgent.current !== forAgent) return; // stale load after switching agents
    seqCursor.current = res.items[0]?.seq ?? null;
    const running = res.turns.find((t) => t.status === "running") ?? null;
    const queue = await client.request("queue.get", { agentId: forAgent }).catch(() => null);
    if (activeAgent.current !== forAgent) return;
    setState((s) => ({
      ...s,
      items: res.items,
      turns: new Map(res.turns.map((t) => [t.id, t])),
      hasMore: res.hasMore,
      runningTurn: running,
      queue,
      loaded: true,
    }));
  }, [client, agentId]);

  useEffect(() => {
    setState({
      queue: null,
      items: [],
      turns: new Map(),
      hasMore: false,
      runningTurn: null,
      status: { status: "idle", error: null },
      loaded: false,
    });
    seqCursor.current = null;
    if (!agentId) return;
    load().catch(() => {});
    client
      .request("agents.statuses", {})
      .then((st) => {
        const info = st[agentId];
        if (info) setState((s) => ({ ...s, status: info }));
      })
      .catch(() => {});

    const matches = (id: string | undefined | null) => id === agentId;
    const offs = [
      client.on("item.created", (item) => {
        if (!matches(item.agentId)) return;
        setState((s) =>
          s.items.some((i) => i.id === item.id) ? s : { ...s, items: [...s.items, item] },
        );
      }),
      client.on("item.updated", (item) => {
        if (!matches(item.agentId)) return;
        setState((s) => ({
          ...s,
          items: s.items.map((i) => (i.id === item.id ? item : i)),
        }));
      }),
      client.on("item.delta", (d) => {
        if (!matches(d.agentId)) return;
        setState((s) => ({
          ...s,
          items: s.items.map((i) =>
            i.id === d.itemId && (i.kind === "agent_message" || i.kind === "agent_thought")
              ? { ...i, text: i.text + d.text }
              : i,
          ),
        }));
      }),
      client.on("turn.started", (t) => {
        if (!matches(t.agentId)) return;
        setState((s) => ({
          ...s,
          runningTurn: t,
          turns: new Map(s.turns).set(t.id, t),
        }));
      }),
      client.on("turn.ended", (t) => {
        if (!matches(t.agentId)) return;
        setState((s) => ({
          ...s,
          runningTurn: s.runningTurn?.id === t.id ? null : s.runningTurn,
          turns: new Map(s.turns).set(t.id, t),
        }));
      }),
      client.on("agent.status", (d) => {
        if (!matches(d.agentId)) return;
        setState((s) => ({ ...s, status: { status: d.status, error: d.error } }));
      }),
      client.on("queue.updated", (q) => {
        if (!matches(q.agentId)) return;
        setState((s) => ({ ...s, queue: q }));
      }),
      client.onReconnect(() => {
        load().catch(() => {});
        client
          .request("agents.statuses", {})
          .then((st) => {
            const info = st[agentId];
            if (info) setState((s) => ({ ...s, status: info }));
          })
          .catch(() => {});
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [client, agentId, load]);

  const loadEarlier = useCallback(async () => {
    if (!agentId || seqCursor.current === null) return;
    const res = await client.request("chat.history", {
      agentId,
      beforeSeq: seqCursor.current,
    });
    if (res.items.length > 0) seqCursor.current = res.items[0]?.seq ?? null;
    setState((s) => ({
      ...s,
      items: [...res.items, ...s.items],
      turns: new Map([...res.turns, ...s.turns.values()].map((t) => [t.id, t])),
      hasMore: res.hasMore,
    }));
  }, [client, agentId]);

  const queuePause = useCallback(() => {
    if (agentId) client.request("queue.pause", { agentId }).catch(() => {});
  }, [client, agentId]);
  const queueResume = useCallback(() => {
    if (agentId) client.request("queue.resume", { agentId }).catch(() => {});
  }, [client, agentId]);
  const queueRemove = useCallback(
    (queueId: string) => {
      client.request("queue.remove", { queueId }).catch(() => {});
    },
    [client],
  );

  return { ...state, loadEarlier, queuePause, queueResume, queueRemove };
}
