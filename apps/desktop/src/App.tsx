import type { Agent, ProviderId } from "@openagent/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { DaemonClient } from "./lib/daemon";

const PROVIDERS: ProviderId[] = [
  "devin",
  "cursor",
  "grok",
  "opencode",
  "gemini",
  "claude",
  "codex",
  "openai-compatible",
];

const inputCls =
  "w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-zinc-500 focus:outline-none";
const btnCls = "rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50";

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<DaemonClient | null>(null);

  useEffect(() => {
    const client = new DaemonClient();
    clientRef.current = client;
    let alive = true;
    client
      .connect()
      .then(() => client.request("agents.list", {}))
      .then((list) => {
        if (alive) setAgents(list);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    const offs = [
      client.on("agent.created", (a) => setAgents((prev) => [...prev, a])),
      client.on("agent.updated", (a) =>
        setAgents((prev) => prev.map((p) => (p.id === a.id ? a : p))),
      ),
      client.on("agent.deleted", ({ id }) => {
        setAgents((prev) => prev.filter((p) => p.id !== id));
        setSelectedId((sel) => (sel === id ? null : sel));
      }),
    ];
    return () => {
      alive = false;
      for (const off of offs) off();
      client.close();
    };
  }, []);

  const selected = agents.find((a) => a.id === selectedId) ?? null;

  const createAgent = useCallback(
    async (form: { name: string; provider: ProviderId; instructions: string; model: string }) => {
      const client = clientRef.current;
      if (!client) return;
      const agent = await client.request("agents.create", {
        name: form.name,
        provider: form.provider,
        instructions: form.instructions,
        ...(form.model ? { model: form.model } : {}),
      });
      setCreating(false);
      setSelectedId(agent.id);
    },
    [],
  );

  const updateAgent = useCallback(
    async (
      id: string,
      patch: { name?: string; instructions?: string; model?: string | null; provider?: ProviderId },
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
    if (!window.confirm("Delete this agent? Its workspace folder is kept.")) return;
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
          <h1 className="text-sm font-semibold">OpenAgent</h1>
          <button
            type="button"
            className={`${btnCls} bg-zinc-800 hover:bg-zinc-700`}
            onClick={() => {
              setCreating(true);
              setSelectedId(null);
            }}
          >
            New agent
          </button>
        </div>
        <ul className="flex-1 overflow-y-auto">
          {agents.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => {
                  setSelectedId(a.id);
                  setCreating(false);
                }}
                className={`w-full px-4 py-2 text-left text-sm hover:bg-zinc-900 ${
                  a.id === selectedId ? "bg-zinc-900" : ""
                }`}
              >
                <div className="truncate font-medium">{a.name}</div>
                <div className="text-xs text-zinc-500">{a.provider}</div>
              </button>
            </li>
          ))}
          {agents.length === 0 && (
            <li className="px-4 py-6 text-sm text-zinc-500">No agents yet.</li>
          )}
        </ul>
      </aside>
      <main className="flex-1 overflow-y-auto p-6">
        {creating ? (
          <CreateForm onSubmit={createAgent} onCancel={() => setCreating(false)} />
        ) : selected ? (
          <Detail agent={selected} onUpdate={updateAgent} onDelete={deleteAgent} />
        ) : (
          <p className="text-sm text-zinc-500">Select an agent or create a new one.</p>
        )}
      </main>
    </div>
  );
}

function CreateForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (f: {
    name: string;
    provider: ProviderId;
    instructions: string;
    model: string;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<ProviderId>("devin");
  const [instructions, setInstructions] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="mx-auto max-w-lg space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSubmit({ name, provider, instructions, model });
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
      <input
        className={inputCls}
        placeholder="Model (optional)"
        value={model}
        onChange={(e) => setModel(e.target.value)}
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

function Detail({
  agent,
  onUpdate,
  onDelete,
}: {
  agent: Agent;
  onUpdate: (
    id: string,
    patch: { name?: string; instructions?: string; model?: string | null; provider?: ProviderId },
  ) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState(agent.name);
  const [provider, setProvider] = useState<ProviderId>(agent.provider);
  const [instructions, setInstructions] = useState(agent.instructions);
  const [model, setModel] = useState(agent.model ?? "");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setName(agent.name);
    setProvider(agent.provider);
    setInstructions(agent.instructions);
    setModel(agent.model ?? "");
  }, [agent.name, agent.provider, agent.instructions, agent.model]);

  return (
    <form
      className="mx-auto max-w-lg space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        await onUpdate(agent.id, {
          name,
          provider,
          instructions,
          model: model || null,
        });
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      }}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Agent</h2>
        <button
          type="button"
          onClick={() => onDelete(agent.id)}
          className={`${btnCls} bg-red-900/60 text-red-300 hover:bg-red-900`}
        >
          Delete
        </button>
      </div>
      <input
        className={inputCls}
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
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
      />
      <input
        className={inputCls}
        placeholder="Model (optional)"
        value={model}
        onChange={(e) => setModel(e.target.value)}
      />
      <div className="text-xs text-zinc-500">Workspace: {agent.workspacePath}</div>
      <div className="flex items-center gap-3">
        <button type="submit" className={`${btnCls} bg-sky-600 hover:bg-sky-500`}>
          Save
        </button>
        {saved && <span className="text-xs text-emerald-400">Saved</span>}
      </div>
    </form>
  );
}
