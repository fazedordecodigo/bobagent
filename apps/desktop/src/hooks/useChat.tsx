import type { AgentStatusInfo, ChatItem, QueueState, Turn } from "@upbot/protocol";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { DaemonClient } from "../lib/daemon";
import { errorFields, logWarn } from "../lib/log";

export type ChatErrorSource = "history" | "queue" | "status" | "earlier" | "action";

export type ChatState = {
  queue: QueueState | null;
  items: ChatItem[];
  turns: Map<string, Turn>;
  hasMore: boolean;
  runningTurn: Turn | null;
  status: AgentStatusInfo;
  loaded: boolean;
  errors: Record<ChatErrorSource, string | null>;
};

const EMPTY_ERRORS: Record<ChatErrorSource, string | null> = {
  history: null,
  queue: null,
  status: null,
  earlier: null,
  action: null,
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
    errors: EMPTY_ERRORS,
    queue: null as QueueState | null,
  });
  const seqCursor = useRef<number | null>(null);
  const activeAgent = useRef(agentId);
  activeAgent.current = agentId;
  const setError = useCallback((source: ChatErrorSource, message: string | null) => {
    setState((s) => ({ ...s, errors: { ...s.errors, [source]: message } }));
  }, []);

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
        logWarn("queue.get_failed", { agentId: forAgent, ...errorFields(e) });
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
        errors: { ...s.errors, history: null, queue: queueError },
      }));
    } catch (e) {
      if (activeAgent.current !== forAgent) return;
      logWarn("chat.history_failed", { agentId: forAgent, ...errorFields(e) });
      setState((s) => ({ ...s, loaded: true }));
      setError("history", `Não foi possível carregar o histórico: ${describe(e)}`);
    }
  }, [client, agentId, setError]);

  const refreshStatus = useCallback(() => {
    if (!agentId) return;
    const forAgent = agentId;
    client
      .request("agents.statuses", {})
      .then((st) => {
        if (activeAgent.current !== forAgent) return;
        const info = st[forAgent];
        if (info) setState((s) => ({ ...s, status: info }));
        setError("status", null);
      })
      .catch((e: unknown) => {
        if (activeAgent.current !== forAgent) return;
        logWarn("agents.statuses_failed", { agentId: forAgent, ...errorFields(e) });
        setError("status", `Não foi possível carregar o status: ${describe(e)}`);
      });
  }, [client, agentId, setError]);

  useEffect(() => {
    setState({
      queue: null,
      items: [],
      turns: new Map(),
      hasMore: false,
      runningTurn: null,
      status: { status: "idle", error: null },
      loaded: false,
      errors: EMPTY_ERRORS,
    });
    seqCursor.current = null;
    if (!agentId) return;
    const sync = () => {
      void load();
      refreshStatus();
    };
    sync();

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
        setState((s) => {
          // Recent items change most often — scan backwards and replace one index.
          for (let i = s.items.length - 1; i >= 0; i--) {
            if (s.items[i]?.id !== item.id) continue;
            const items = s.items.slice();
            items[i] = item;
            return { ...s, items };
          }
          return s;
        });
      }),
      client.on("item.delta", (d) => {
        if (!matches(d.agentId)) return;
        setState((s) => {
          // The streaming item is almost always the last one — scan backwards.
          for (let i = s.items.length - 1; i >= 0; i--) {
            const item = s.items[i];
            if (item?.id !== d.itemId) continue;
            if (item.kind !== "agent_message" && item.kind !== "agent_thought") return s;
            const items = s.items.slice();
            items[i] = { ...item, text: item.text + d.text };
            return { ...s, items };
          }
          return s;
        });
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
        setState((s) => ({
          ...s,
          status: { status: d.status, error: d.error },
          errors: { ...s.errors, status: null },
        }));
      }),
      client.on("queue.updated", (q) => {
        if (!matches(q.agentId)) return;
        setState((s) => ({ ...s, queue: q, errors: { ...s.errors, queue: null } }));
      }),
      client.onReconnect(sync),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [client, agentId, load, refreshStatus]);

  const loadEarlier = useCallback(async () => {
    const forAgent = agentId;
    if (!forAgent || seqCursor.current === null) return;
    try {
      const res = await client.request("chat.history", {
        agentId: forAgent,
        beforeSeq: seqCursor.current,
      });
      if (activeAgent.current !== forAgent) return; // stale load after switching agents
      if (res.items.length > 0) seqCursor.current = res.items[0]?.seq ?? null;
      setState((s) => ({
        ...s,
        items: [...res.items, ...s.items],
        turns: new Map([...res.turns, ...s.turns.values()].map((t) => [t.id, t])),
        hasMore: res.hasMore,
      }));
      setError("earlier", null);
    } catch (e) {
      if (activeAgent.current !== forAgent) return;
      setError("earlier", `Não foi possível carregar mensagens anteriores: ${describe(e)}`);
    }
  }, [client, agentId, setError]);

  const queuePause = useCallback(async () => {
    const forAgent = agentId;
    if (!forAgent) return;
    try {
      await client.request("queue.pause", { agentId: forAgent });
      if (activeAgent.current !== forAgent) return;
      setError("action", null);
    } catch (e) {
      if (activeAgent.current !== forAgent) return;
      logWarn("queue.pause_failed", { agentId: forAgent, ...errorFields(e) });
      setError("action", `Não foi possível pausar a fila: ${describe(e)}`);
    }
  }, [client, agentId, setError]);
  const queueResume = useCallback(async () => {
    const forAgent = agentId;
    if (!forAgent) return;
    try {
      await client.request("queue.resume", { agentId: forAgent });
      if (activeAgent.current !== forAgent) return;
      setError("action", null);
    } catch (e) {
      if (activeAgent.current !== forAgent) return;
      logWarn("queue.resume_failed", { agentId: forAgent, ...errorFields(e) });
      setError("action", `Não foi possível retomar a fila: ${describe(e)}`);
    }
  }, [client, agentId, setError]);
  const queueRemove = useCallback(
    async (queueId: string) => {
      const forAgent = activeAgent.current;
      if (!forAgent) return;
      try {
        await client.request("queue.remove", { queueId });
        if (activeAgent.current !== forAgent) return;
        setError("action", null);
      } catch (e) {
        if (activeAgent.current !== forAgent) return;
        logWarn("queue.remove_failed", { queueId, ...errorFields(e) });
        setError("action", `Não foi possível remover da fila: ${describe(e)}`);
      }
    },
    [client, setError],
  );

  return { ...state, loadEarlier, queuePause, queueResume, queueRemove };
}

export type ChatApi = ReturnType<typeof useChat>;

// Keeps the per-token setState inside this component: its children prop is a
// stable element tree, so a delta re-renders only the context consumers.
export function ChatProvider({
  client,
  agentId,
  children,
}: {
  client: DaemonClient;
  agentId: string | null;
  children: ReactNode;
}) {
  const chat = useChat(client, agentId);
  return <ChatContext.Provider value={chat}>{children}</ChatContext.Provider>;
}

const ChatContext = createContext<ChatApi | null>(null);

export function useChatApi(): ChatApi {
  const chat = useContext(ChatContext);
  if (!chat) throw new Error("useChatApi must be used inside ChatProvider");
  return chat;
}
