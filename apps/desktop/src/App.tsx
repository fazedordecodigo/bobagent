import type {
  Agent,
  AgentAvatar,
  AgentStatusInfo,
  Channel,
  PendingPermission,
  ProviderId,
} from "@bobagent/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentSettings, btnCls, inputCls, PROVIDERS } from "./components/AgentSettings";
import { ChannelCreateForm, ChannelView } from "./components/ChannelView";
import { ChatView } from "./components/ChatView";
import {
  AvatarBadge,
  AvatarEditor,
  BrowserView,
  MemoriesPanel,
  RoutinesPanel,
  SkillsView,
} from "./components/Library";
import { DaemonClient } from "./lib/daemon";

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [statuses, setStatuses] = useState<Record<string, AgentStatusInfo>>({});
  const [pendingCounts, setPendingCounts] = useState<Record<string, number>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<DaemonClient | null>(null);
  const [clientReady, setClientReady] = useState(false);

  const refreshAll = useCallback(async (client: DaemonClient) => {
    const [list, st, perms, chans] = await Promise.all([
      client.request("agents.list", {}),
      client.request("agents.statuses", {}),
      client.request("permissions.list", {}),
      client.request("channels.list", { includeArchived: true }),
    ]);
    setChannels(chans);
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
      client.on("channel.created", (ch) => setChannels((prev) => [...prev, ch])),
      client.on("channel.updated", (ch) =>
        setChannels((prev) => prev.map((p) => (p.id === ch.id ? ch : p))),
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
  const selectedChannel = channels.find((ch) => ch.id === channelId) ?? null;
  const openAgent = (id: string | null) => {
    setSkillsOpen(false);
    setBrowserOpen(false);
    setSelectedId(id);
    setChannelId(null);
    setCreating(false);
    setCreatingChannel(false);
    setSettingsOpen(false);
  };
  const createChannel = useCallback(
    async (form: { name: string; memberIds: string[]; ownerId: string | null }) => {
      const client = clientRef.current;
      if (!client) return;
      const ch = await client.request("channels.create", form);
      setCreatingChannel(false);
      setChannelId(ch.id);
    },
    [],
  );

  const createAgent = useCallback(
    async (form: {
      name: string;
      provider: ProviderId;
      instructions: string;
      avatar: AgentAvatar | null;
    }) => {
      const client = clientRef.current;
      if (!client) return;
      const agent = await client.request("agents.create", {
        name: form.name,
        provider: form.provider,
        instructions: form.instructions,
        avatar: form.avatar,
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
        avatar?: AgentAvatar | null;
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
              openAgent(null);
              setCreating(true);
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
                  onClick={() => openAgent(a.id)}
                  className={`w-full px-4 py-2 text-left text-sm hover:bg-zinc-900 ${
                    a.id === selectedId ? "bg-zinc-900" : ""
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <AvatarBadge agent={a} />
                    <span className="truncate font-medium">{a.name}</span>
                    <StatusDot status={st} />
                    {pending > 0 && (
                      <span className="ml-auto rounded-full bg-amber-600 px-1.5 text-[10px] font-bold text-white">
                        {pending}
                      </span>
                    )}
                  </div>
                  <div className="pl-7 text-xs text-zinc-500">{a.provider}</div>
                </button>
              </li>
            );
          })}
          {agents.length === 0 && (
            <li className="px-4 py-6 text-sm text-zinc-500">No agents yet.</li>
          )}
          <li className="mt-2 flex items-center justify-between border-t border-zinc-800 px-4 pt-3 pb-1">
            <span className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">
              Channels
            </span>
            <button
              type="button"
              className="text-xs text-sky-400 hover:text-sky-300"
              onClick={() => {
                openAgent(null);
                setCreatingChannel(true);
              }}
            >
              + New
            </button>
          </li>
          <li className="mt-2 border-t border-zinc-800 px-4 pt-3">
            <button
              type="button"
              className={`text-xs font-semibold tracking-wide uppercase ${skillsOpen ? "text-sky-400" : "text-zinc-400"} hover:text-zinc-200`}
              onClick={() => {
                openAgent(null);
                setCreatingChannel(false);
                setSkillsOpen(true);
              }}
            >
              Skills library
            </button>
            <button
              type="button"
              className={`ml-4 text-xs font-semibold tracking-wide uppercase ${browserOpen ? "text-sky-400" : "text-zinc-400"} hover:text-zinc-200`}
              onClick={() => {
                openAgent(null);
                setCreatingChannel(false);
                setBrowserOpen(true);
              }}
            >
              Browser
            </button>
          </li>
          {channels.map((ch) => (
            <li key={ch.id}>
              <button
                type="button"
                onClick={() => {
                  openAgent(null);
                  setChannelId(ch.id);
                }}
                className={`w-full px-4 py-1.5 text-left text-sm hover:bg-zinc-900 ${
                  ch.id === channelId ? "bg-zinc-900" : ""
                } ${ch.status === "archived" ? "text-zinc-600" : ""}`}
              >
                # {ch.name}
                {ch.status !== "active" && (
                  <span className="ml-2 text-xs text-zinc-500">{ch.status}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main className="flex-1 overflow-hidden">
        {browserOpen && clientReady ? (
          <BrowserView client={clientRef.current!} agents={agents} />
        ) : skillsOpen && clientReady ? (
          <SkillsView client={clientRef.current!} />
        ) : creatingChannel ? (
          <ChannelCreateForm
            agents={agents}
            onSubmit={createChannel}
            onCancel={() => setCreatingChannel(false)}
          />
        ) : selectedChannel && clientReady ? (
          <ChannelView client={clientRef.current!} channel={selectedChannel} agents={agents} />
        ) : creating ? (
          <CreateForm
            onSubmit={createAgent}
            onCancel={() => setCreating(false)}
            draft={(prompt) => clientRef.current!.request("agents.draft", { prompt })}
          />
        ) : selected && settingsOpen ? (
          <div className="h-full overflow-y-auto">
            <AgentSettings
              client={clientRef.current!}
              agent={selected}
              onUpdate={updateAgent}
              onDelete={deleteAgent}
            />
            <AvatarEditor
              key={selected.id}
              agent={selected}
              onSave={(avatar) => updateAgent(selected.id, { avatar })}
            />
            <MemoriesPanel client={clientRef.current!} agentId={selected.id} />
            <RoutinesPanel client={clientRef.current!} agentId={selected.id} />
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
  draft,
}: {
  onSubmit: (f: {
    name: string;
    provider: ProviderId;
    instructions: string;
    avatar: AgentAvatar | null;
  }) => Promise<void>;
  onCancel: () => void;
  draft: (prompt: string) => Promise<{ name: string; instructions: string; avatar: AgentAvatar }>;
}) {
  const [describe, setDescribe] = useState("");
  const [avatar, setAvatar] = useState<AgentAvatar | null>(null);
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
          await onSubmit({ name, provider, instructions, avatar });
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 className="text-lg font-semibold">New agent</h2>
      <div className="flex gap-2">
        <input
          className={inputCls}
          placeholder="Describe the agent you want…"
          value={describe}
          onChange={(e) => setDescribe(e.target.value)}
        />
        <button
          type="button"
          className={`${btnCls} bg-zinc-700 hover:bg-zinc-600`}
          disabled={!describe.trim()}
          onClick={async () => {
            const d = await draft(describe);
            setName(d.name);
            setInstructions(d.instructions);
            setAvatar(d.avatar);
          }}
        >
          Draft
        </button>
      </div>
      {avatar && (
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <AvatarBadge agent={{ name, avatar }} size={28} /> avatar
        </div>
      )}
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
