import type {
  Agent,
  AgentStatusInfo,
  Approval,
  ChatItem,
  ConnectedApp,
  EmailAccount,
  QueueState,
  Turn,
} from "@upbot/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DaemonClient } from "../lib/daemon";
import { errorFields, logWarn } from "../lib/log";
import { fmtTime, status, type UiStatus } from "../lib/ui";

export type AgentOverview = {
  task: string | null;
  updated: string;
  latestTurn: Turn | null;
  queued: number;
  pending: number;
  status: UiStatus;
  apps: ConnectedApp[];
  emailAccounts: EmailAccount[];
  items: ChatItem[];
};

const taskText = (items: ChatItem[], latestTurn: Turn | null) => {
  const userItems = items
    .filter((item) => item.kind === "user_message")
    .sort((a, b) => a.createdAt - b.createdAt);
  const item =
    (latestTurn && userItems.find((message) => message.turnId === latestTurn.id)) ??
    userItems.at(-1);
  if (item?.kind !== "user_message") return null;
  const first = item.text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return first.length > 60 ? first.slice(0, 60) : first || null;
};

export function useOverview(
  client: DaemonClient,
  agents: Agent[],
  statuses: Record<string, AgentStatusInfo>,
  enabled = true,
) {
  const [histories, setHistories] = useState<
    Record<string, { items: ChatItem[]; turn: Turn | null }>
  >({});
  const [queues, setQueues] = useState<Record<string, QueueState>>({});
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [apps, setApps] = useState<ConnectedApp[]>([]);
  const [emailAccounts, setEmailAccounts] = useState<EmailAccount[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const loadAgent = useCallback(
    async (agentId: string) => {
      const [history, queue] = await Promise.all([
        client.request("chat.history", { agentId, limit: 50 }).catch((e: unknown) => {
          logWarn("overview.history_failed", { agentId, ...errorFields(e) });
          return null;
        }),
        client.request("queue.get", { agentId }).catch((e: unknown) => {
          logWarn("overview.queue_failed", { agentId, ...errorFields(e) });
          return null;
        }),
      ]);
      if (history) {
        const latestTurn = [...history.turns].sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
        setHistories((prev) => ({
          ...prev,
          [agentId]: { items: history.items, turn: latestTurn },
        }));
      }
      if (queue) setQueues((prev) => ({ ...prev, [agentId]: queue }));
    },
    [client],
  );

  const refreshApprovals = useCallback(() => {
    client
      .request("approvals.list", {})
      .then(setApprovals)
      .catch((e: unknown) => logWarn("overview.approvals_failed", errorFields(e)));
  }, [client]);
  const refreshApps = useCallback(() => {
    client
      .request("apps.list", {})
      .then(setApps)
      .catch((e: unknown) => logWarn("overview.apps_failed", errorFields(e)));
  }, [client]);
  const refreshEmail = useCallback(() => {
    client
      .request("email.accounts.list", {})
      .then(setEmailAccounts)
      .catch((e: unknown) => logWarn("overview.email_failed", errorFields(e)));
  }, [client]);

  useEffect(() => {
    if (!enabled) return;
    for (const agent of agents) void loadAgent(agent.id);
    refreshApprovals();
    refreshApps();
    refreshEmail();
    const schedule = (agentId: string) => {
      const old = timers.current.get(agentId);
      if (old) clearTimeout(old);
      timers.current.set(
        agentId,
        setTimeout(() => {
          timers.current.delete(agentId);
          void loadAgent(agentId);
        }, 300),
      );
    };
    const offs = [
      client.on("turn.started", (turn) => schedule(turn.agentId)),
      client.on("turn.ended", (turn) => schedule(turn.agentId)),
      client.on("queue.updated", (queue) => {
        setQueues((prev) => ({ ...prev, [queue.agentId]: queue }));
        schedule(queue.agentId);
      }),
      client.on("item.created", (item) => {
        if (item.kind === "user_message") schedule(item.agentId);
      }),
      client.on("approval.updated", (approval) =>
        setApprovals((prev) => {
          const found = prev.some((item) => item.id === approval.id);
          return found
            ? prev.map((item) => (item.id === approval.id ? approval : item))
            : [...prev, approval];
        }),
      ),
      client.on("apps.changed", refreshApps),
      client.on("email.accounts.changed", refreshEmail),
      client.on("approvals.rulesChanged", refreshApprovals),
      client.onReconnect(() => {
        for (const agent of agents) void loadAgent(agent.id);
        refreshApprovals();
        refreshApps();
        refreshEmail();
      }),
    ];
    return () => {
      for (const off of offs) off();
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    };
  }, [agents, client, enabled, loadAgent, refreshApprovals, refreshApps, refreshEmail]);

  return useMemo(() => {
    const pendingByAgent = new Map<string, number>();
    for (const approval of approvals) {
      if (approval.status === "pending")
        pendingByAgent.set(approval.agentId, (pendingByAgent.get(approval.agentId) ?? 0) + 1);
    }
    const result: Record<string, AgentOverview> = {};
    for (const agent of agents) {
      const history = histories[agent.id];
      const queue = queues[agent.id];
      const latestTurn = history?.turn ?? null;
      const pending = pendingByAgent.get(agent.id) ?? 0;
      const connectedApps = apps.filter(
        (app) => app.enabled && (app.agentIds.length === 0 || app.agentIds.includes(agent.id)),
      );
      const accounts = emailAccounts.filter(
        (account) => account.agentIds.length === 0 || account.agentIds.includes(agent.id),
      );
      result[agent.id] = {
        task: history ? taskText(history.items, latestTurn) : null,
        updated: fmtTime(latestTurn?.endedAt ?? latestTurn?.startedAt),
        latestTurn,
        queued: queue?.items.length ?? 0,
        pending,
        status: status(statuses[agent.id]?.status, queue?.items.length ?? 0, latestTurn, pending),
        apps: connectedApps,
        emailAccounts: accounts,
        items: history?.items ?? [],
      };
    }
    return result;
  }, [agents, apps, approvals, emailAccounts, histories, queues, statuses]);
}
