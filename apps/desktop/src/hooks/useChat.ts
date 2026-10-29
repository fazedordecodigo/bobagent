import type { AgentStatusInfo, ChatItem, QueueState, Turn } from "@upbot/protocol";
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
  error: string | null;
};

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useChat(client: DaemonClient, agentId: string | null) {
  const [state, setState] = useState<ChatState>({
    items: [],
    turns: new Map(),
    hasMore: false,
    runningTurn: null,
    status: { status: "idle", error: null },
    loaded: false,
    error: null,
    queue: null as QueueState | null,
  });
  const seqCursor = useRef<number | null>(null);
  const activeAgent = useRef(agentId);
  activeAgent.current = agentId;

  const load = useCallback(async () => {
    if (!agentId) return;
    const forAgent = agentId;
    try {
      const res = await client.request("chat.history", { agentId: forAgent });
      if (activeAgent.current !== forAgent) return; // stale load after switching agents
      seqCursor.current = res.items[0]?.seq ?? null;
      const running = res.turns.find((t) => t.status === "running") ?? null;
      let queueError: string | null = null;
      const queue = await client.request("queue.get", { agentId: forAgent }).catch((e: unknown) => {
        queueError = `Não foi possível carregar a fila: ${describe(e)}`;
        return null;
      });
      if (activeAgent.current !== forAgent) return;
      setState((s) => ({
        ...s,
        items: res.items,
        turns: new Map(res.turns.map((t) => [t.id, t])),
        hasMore: res.hasMore,
        runningTurn: running,
        queue,
        loaded: true,
        error: queueError,
      }));
    } catch (e) {
      if (activeAgent.current !== forAgent) return;
      setState((s) => ({
        ...s,
        loaded: true,
        error: `Não foi possível carregar o histórico: ${describe(e)}`,
      }));
    }
  }, [client, agentId]);

  const refreshStatus = useCallback(() => {
    if (!agentId) return;
    const forAgent = agentId;
    client
      .request("agents.statuses", {})
      .then((st) => {
        if (activeAgent.current !== forAgent) return;
        const info = st[forAgent];
        if (info) setState((s) => ({ ...s, status: info }));
      })
      .catch((e: unknown) => {
        if (activeAgent.current !== forAgent) return;
        setState((s) => ({
          ...s,
          error: `Não foi possível carregar o status: ${describe(e)}`,
        }));
      });
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
      error: null,
    });
    seqCursor.current = null;
    if (!agentId) return;
    void load();
    refreshStatus();

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
        void load();
        refreshStatus();
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [client, agentId, load, refreshStatus]);

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

  const queuePause = useCallback(async () => {
    if (!agentId) return;
    try {
      await client.request("queue.pause", { agentId });
      setState((s) => ({ ...s, error: null }));
    } catch (e) {
      setState((s) => ({ ...s, error: `Não foi possível pausar a fila: ${describe(e)}` }));
    }
  }, [client, agentId]);
  const queueResume = useCallback(async () => {
    if (!agentId) return;
    try {
      await client.request("queue.resume", { agentId });
      setState((s) => ({ ...s, error: null }));
    } catch (e) {
      setState((s) => ({ ...s, error: `Não foi possível retomar a fila: ${describe(e)}` }));
    }
  }, [client, agentId]);
  const queueRemove = useCallback(
    async (queueId: string) => {
      try {
        await client.request("queue.remove", { queueId });
        setState((s) => ({ ...s, error: null }));
      } catch (e) {
        setState((s) => ({ ...s, error: `Não foi possível remover da fila: ${describe(e)}` }));
      }
    },
    [client],
  );

  return { ...state, loadEarlier, queuePause, queueResume, queueRemove };
}
