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
import { errorMessage } from "../lib/errors";
import { errorFields, logWarn } from "../lib/log";

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
    const res = await client.request("chat.history", { agentId: forAgent });
    if (activeAgent.current !== forAgent) return; // stale load after switching agents
    seqCursor.current = res.items[0]?.seq ?? null;
    const running = res.turns.find((t) => t.status === "running") ?? null;
    const queue = await client.request("queue.get", { agentId: forAgent }).catch((e: unknown) => {
      logWarn("queue.get_failed", { agentId: forAgent, ...errorFields(e) });
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
      error: null,
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
      error: null,
    });
    seqCursor.current = null;
    if (!agentId) return;
    load().catch((e: unknown) => {
      logWarn("chat.history_failed", { agentId, ...errorFields(e) });
      setState((s) => ({ ...s, error: errorMessage(e) }));
    });
    client
      .request("agents.statuses", {})
      .then((st) => {
        const info = st[agentId];
        if (info) setState((s) => ({ ...s, status: info }));
      })
      .catch((e: unknown) => logWarn("agents.statuses_failed", { agentId, ...errorFields(e) }));

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
        setState((s) => ({ ...s, status: { status: d.status, error: d.error } }));
      }),
      client.on("queue.updated", (q) => {
        if (!matches(q.agentId)) return;
        setState((s) => ({ ...s, queue: q }));
      }),
      client.onReconnect(() => {
        load().catch((e: unknown) => {
          logWarn("chat.history_failed", { agentId, ...errorFields(e) });
          setState((s) => ({ ...s, error: errorMessage(e) }));
        });
        client
          .request("agents.statuses", {})
          .then((st) => {
            const info = st[agentId];
            if (info) setState((s) => ({ ...s, status: info }));
          })
          .catch((e: unknown) => logWarn("agents.statuses_failed", { agentId, ...errorFields(e) }));
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

  const queueFail = useCallback(
    (method: string, fields: Record<string, unknown>) => (e: unknown) => {
      logWarn(`${method}_failed`, { ...fields, ...errorFields(e) });
      setState((s) => ({ ...s, error: errorMessage(e) }));
    },
    [],
  );
  const queuePause = useCallback(() => {
    if (agentId)
      client.request("queue.pause", { agentId }).catch(queueFail("queue.pause", { agentId }));
  }, [client, agentId, queueFail]);
  const queueResume = useCallback(() => {
    if (agentId)
      client.request("queue.resume", { agentId }).catch(queueFail("queue.resume", { agentId }));
  }, [client, agentId, queueFail]);
  const queueRemove = useCallback(
    (queueId: string) => {
      client.request("queue.remove", { queueId }).catch(queueFail("queue.remove", { queueId }));
    },
    [client, queueFail],
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
