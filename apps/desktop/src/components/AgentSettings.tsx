import type { Agent, ProviderId } from "@openagent/protocol";
import { useEffect, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";

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

export { btnCls, inputCls, PROVIDERS };

export function AgentSettings({
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
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setName(agent.name);
    setProvider(agent.provider);
    setInstructions(agent.instructions);
    setModel(agent.model ?? "");
  }, [agent.name, agent.provider, agent.instructions, agent.model]);

  return (
    <form
      className="mx-auto max-w-lg space-y-4 p-6"
      onSubmit={async (e) => {
        e.preventDefault();
        await onUpdate(agent.id, { name, provider, instructions, model: model || null });
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      }}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Agent settings</h2>
        <button
          type="button"
          onClick={() => setConfirming(true)}
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
      {confirming && (
        <ConfirmDialog
          title="Delete agent"
          body={`Delete "${agent.name}"? Its workspace folder and chat history are kept.`}
          confirmLabel="Delete"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void onDelete(agent.id);
          }}
        />
      )}
    </form>
  );
}
