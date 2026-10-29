import type { AgentUsage } from "@upbot/protocol";
import { useEffect, useState } from "react";
import type { DaemonClient } from "../lib/daemon";
import { errorMessage } from "../lib/errors";

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function UsageBar({
  client,
  agentId,
  busy,
}: {
  client: DaemonClient;
  agentId: string;
  busy: boolean;
}) {
  const [usage, setUsage] = useState<AgentUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setUsage(null);
    client
      .request("agents.usage", { agentId })
      .then((u) => {
        if (alive) setUsage(u);
      })
      .catch(() => {});
    const off = client.on("agent.usage", (u) => {
      if (u.agentId === agentId) setUsage(u);
    });
    return () => {
      alive = false;
      off();
    };
  }, [client, agentId]);

  if (!usage) return null;
  const pct =
    usage.usedTokens !== null && usage.contextWindow
      ? Math.min(100, Math.round((usage.usedTokens / usage.contextWindow) * 100))
      : null;
  const compact = () => {
    setError(null);
    client.request("agents.compact", { agentId }).catch((e) => setError(errorMessage(e)));
  };
  return (
    <div
      className="num flex flex-wrap items-center gap-2 text-xs text-zinc-500"
      title={error ?? undefined}
    >
      {pct !== null && (
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-16 overflow-hidden rounded bg-zinc-800">
            <span
              className={`block h-full ${pct >= 85 ? "bg-red-500" : pct >= 60 ? "bg-amber-500" : "bg-emerald-500"}`}
              style={{ width: `${pct}%` }}
            />
          </span>
          {pct}%
        </span>
      )}
      <span>
        {fmt(usage.inputTokens)} entrada · {fmt(usage.outputTokens)} saída
        {usage.costUsd > 0 ? ` · $${usage.costUsd.toFixed(2)}` : ""}
      </span>
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={compact}>
        Compactar
      </button>
      {error && <span role="alert">Erro ao compactar</span>}
    </div>
  );
}
