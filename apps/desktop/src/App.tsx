import type { Agent, AgentStatusInfo, PendingPermission, ProviderId } from "@bobagent/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentSettings, btnCls, inputCls, PROVIDERS } from "./components/AgentSettings";
import { ChatView } from "./components/ChatView";
import { DaemonClient } from "./lib/daemon";

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [statuses, setStatuses] = useState<Record<string, AgentStatusInfo>>({});
  const [pendingCounts, setPendingCounts] = useState<Record<string, number>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<DaemonClient | null>(null);
  const [clientReady, setClientReady] = useState(false);

  const refreshAll = useCallback(async (client: DaemonClient) => {
    const [list, st, perms] = await Promise.all([
      client.request("agents.list", {}),
      client.request("agents.statuses", {}),
      client.request("permissions.list", {}),
    ]);
    setAgents(list);
    setStatuses(st);
    const counts: Record<string, number> = {};
    for (const p of perms as PendingPermission[]) {
      counts[p.agentId] = (counts[p.agentId] ?? 0) + 1;
    }
    setPendingCounts(counts);
  }, []);

  useEffect(() => {
    const client = new DaemonClient();
    clientRef.current = client;
    let alive = true;
    client
      .connect()
      .then(() => refreshAll(client))
      .then(() => {
        if (alive) setClientReady(true);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });

    const bump = (agentId: string, delta: number) =>
      setPendingCounts((prev) => ({
        ...prev,
        [agentId]: Math.max(0, (prev[agentId] ?? 0) + delta),
      }));

    const offs = [
      client.on("agent.created", (a) => setAgents((prev) => [...prev, a])),
      client.on("agent.updated", (a) =>
        setAgents((prev) => prev.map((p) => (p.id === a.id ? a : p))),
      ),
      client.on("agent.deleted", ({ id }) => {
        setAgents((prev) => prev.filter((p) => p.id !== id));
        setSelectedId((sel) => (sel === id ? null : sel));
      }),
      client.on("agent.status", ({ agentId, status, error }) =>
        setStatuses((prev) => ({ ...prev, [agentId]: { status, error } })),
      ),
      client.on("permission.requested", (p) => bump(p.agentId, +1)),
      client.on("permission.resolved", (p) => bump(p.agentId, -1)),
      client.onReconnect(() => {
        refreshAll(client).catch(() => {});
      }),
    ];
    return () => {
      alive = false;
      for (const off of offs) off();
      client.close();
    };
  }, [refreshAll]);

  const selected = agents.find((a) => a.id === selectedId) ?? null;

  const createAgent = useCallback(
    async (form: { name: string; provider: ProviderId; instructions: string }) => {
      const client = clientRef.current;
      if (!client) return;
      const agent = await client.request("agents.create", {
        name: form.name,
        provider: form.provider,
        instructions: form.instructions,
      });
      setCreating(false);
      setSelectedId(agent.id);
      setSettingsOpen(false);
    },
    [],
  );

  const updateAgent = useCallback(
    async (
      id: string,
      patch: {
        name?: string;
        instructions?: string;
        provider?: ProviderId;
      },
    ) => {
      const client = clientRef.current;
      if (!client) return;
      await client.request("agents.update", { id, ...patch });
    },
    [],
  );

  const deleteAgent = useCallback(async (id: string) => {
    const client = clientRef.current;
    if (!client) return;
    await client.request("agents.delete", { id });
  }, []);

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-sm text-red-400">Failed to connect to daemon: {error}</p>
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      <aside className="flex w-64 flex-col border-r border-zinc-800">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h1 className="text-sm font-semibold">BobAgent</h1>
          <button
            type="button"
            className={`${btnCls} bg-zinc-800 hover:bg-zinc-700`}
            onClick={() => {
              setCreating(true);
              setSelectedId(null);
              setSettingsOpen(false);
            }}
          >
            New agent
          </button>
        </div>
        <ul className="flex-1 overflow-y-auto">
          {agents.map((a) => {
            const st = statuses[a.id]?.status ?? "idle";
            const pending = pendingCounts[a.id] ?? 0;
            return (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(a.id);
                    setCreating(false);
                    setSettingsOpen(false);
                  }}
                  className={`w-full px-4 py-2 text-left text-sm hover:bg-zinc-900 ${
                    a.id === selectedId ? "bg-zinc-900" : ""
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <StatusDot status={st} />
                    <span className="truncate font-medium">{a.name}</span>
                    {pending > 0 && (
                      <span className="ml-auto rounded-full bg-amber-600 px-1.5 text-[10px] font-bold text-white">
                        {pending}
                      </span>
                    )}
                  </div>
                  <div className="pl-4 text-xs text-zinc-500">{a.provider}</div>
                </button>
              </li>
            );
          })}
          {agents.length === 0 && (
            <li className="px-4 py-6 text-sm text-zinc-500">No agents yet.</li>
          )}
        </ul>
      </aside>
      <main className="flex-1 overflow-hidden">
        {creating ? (
          <CreateForm onSubmit={createAgent} onCancel={() => setCreating(false)} />
        ) : selected && settingsOpen ? (
          <div className="h-full overflow-y-auto">
            <AgentSettings
              client={clientRef.current!}
              agent={selected}
              onUpdate={updateAgent}
              onDelete={deleteAgent}
            />
          </div>
        ) : selected && clientReady ? (
          <ChatView
            client={clientRef.current!}
            agent={selected}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        ) : (
          <p className="p-6 text-sm text-zinc-500">Select an agent or create a new one.</p>
        )}
      </main>
    </div>
  );
}

function StatusDot({ status }: { status: AgentStatusInfo["status"] }) {
  const cls =
    status === "running" || status === "starting"
      ? "bg-emerald-400 animate-pulse"
      : status === "awaiting_permission"
        ? "bg-amber-400"
        : status === "error"
          ? "bg-red-500"
          : "bg-zinc-600";
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${cls}`} />;
}

function CreateForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (f: { name: string; provider: ProviderId; instructions: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<ProviderId>("devin");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="mx-auto max-w-lg space-y-4 p-6"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSubmit({ name, provider, instructions });
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 className="text-lg font-semibold">New agent</h2>
      <input
        className={inputCls}
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        maxLength={80}
      />
      <select
        className={inputCls}
        value={provider}
        onChange={(e) => setProvider(e.target.value as ProviderId)}
      >
        {PROVIDERS.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <textarea
        className={`${inputCls} min-h-32`}
        placeholder="Instructions"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
      />
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={`${btnCls} bg-sky-600 hover:bg-sky-500`}>
          Create
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={`${btnCls} bg-zinc-800 hover:bg-zinc-700`}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
