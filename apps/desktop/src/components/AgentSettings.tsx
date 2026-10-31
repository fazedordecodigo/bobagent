import {
  type Agent,
  type ConfigOption,
  PROVIDER_PERMISSION_CONFIG,
  type ProviderId,
} from "@boto/protocol";
import { useEffect, useState } from "react";
import type { DaemonClient } from "../lib/daemon";
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
const optionLabel = (name: string) => (name.toLowerCase() === "model" ? "Modelo" : name);

export { btnCls, inputCls, PROVIDERS };

export function PermissionNotice({ provider }: { provider: ProviderId }) {
  const path = PROVIDER_PERMISSION_CONFIG[provider];
  if (!path) return null;
  return (
    <p className="meta">
      Permissões: {provider} define quais ações pedem sua aprovação nas configurações próprias em{" "}
      <code className="font-mono text-zinc-400">{path}</code>. Ações já permitidas pelo provedor são
      executadas sem perguntar.
    </p>
  );
}

export function AgentSettings({
  agent,
  client,
  onUpdate,
  onDelete,
}: {
  agent: Agent;
  client: DaemonClient;
  onUpdate: (
    id: string,
    patch: { name?: string; instructions?: string; provider?: ProviderId },
  ) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState(agent.name);
  const [provider, setProvider] = useState<ProviderId>(agent.provider);
  const [instructions, setInstructions] = useState(agent.instructions);
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [options, setOptions] = useState<ConfigOption[] | null>(null);
  const [optionsErr, setOptionsErr] = useState<string | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);

  useEffect(() => {
    setName(agent.name);
    setProvider(agent.provider);
    setInstructions(agent.instructions);
    setOptions(null);
    setOptionsErr(null);
    setOptionsLoading(true);
    let alive = true;
    client
      .request("agents.configOptions", { agentId: agent.id })
      .then((r) => {
        if (alive) {
          setOptions(r.configOptions);
          setOptionsLoading(false);
        }
      })
      .catch((e) => {
        if (alive) {
          setOptionsErr(String((e as Error).message ?? e));
          setOptionsLoading(false);
        }
      });
    const off = client.on("agent.config", (d) => {
      if (d.agentId === agent.id) setOptions(d.configOptions);
    });
    return () => {
      alive = false;
      off();
    };
  }, [agent.id, agent.provider, client, agent.name, agent.instructions]);

  return (
    <form
      className="mx-auto max-w-lg space-y-4 p-6"
      onSubmit={async (e) => {
        e.preventDefault();
        await onUpdate(agent.id, { name, provider, instructions });
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      }}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Configurações do bot</h2>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className={`${btnCls} bg-red-900/60 text-red-300 hover:bg-red-900`}
        >
          Excluir
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
            {p === "openai-compatible" ? "Compatível com OpenAI" : p}
          </option>
        ))}
      </select>
      <textarea
        className={`${inputCls} min-h-32`}
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
      />

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-zinc-300">Opções do provedor</h3>
        {optionsLoading && <div className="text-xs text-zinc-500">Iniciando provedor…</div>}
        {optionsErr && <div className="text-xs text-red-400">{optionsErr}</div>}
        {options?.map((opt) => (
          <label key={opt.id} className="block text-xs text-zinc-400">
            {optionLabel(opt.name)}
            <select
              className={`${inputCls} mt-1`}
              value={agent.config[opt.id] ?? opt.currentValue}
              onChange={async (e) => {
                try {
                  const r = await client.request("agents.setConfig", {
                    agentId: agent.id,
                    configId: opt.id,
                    value: e.target.value,
                  });
                  setOptions(r.configOptions);
                  setOptionsErr(null);
                } catch (err) {
                  setOptionsErr(String((err as Error).message ?? err));
                }
              }}
            >
              {opt.options.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <div className="text-xs text-zinc-500">Pasta de trabalho: {agent.workspacePath}</div>
      <div className="flex items-center gap-3">
        <button type="submit" className={`${btnCls} bg-sky-600 hover:bg-sky-500`}>
          Salvar
        </button>
        {saved && <span className="text-xs text-emerald-400">Salvo</span>}
      </div>
      {confirming && (
        <ConfirmDialog
          title="Excluir bot"
          body={`Excluir "${agent.name}"? A pasta de trabalho e o histórico de conversa serão mantidos.`}
          confirmLabel="Excluir"
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
