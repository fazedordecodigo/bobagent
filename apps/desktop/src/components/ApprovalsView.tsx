import {
  type Agent,
  type Approval,
  type ApprovalDecision,
  type ApprovalRule,
  isSensitivePermission,
} from "@upbot/protocol";
import { useCallback, useEffect, useState } from "react";
import { permissionActions, permissionLabels } from "../lib/app-permissions";
import { approvalAction, decideApproval } from "../lib/approval-decisions";
import { describeApproval } from "../lib/approval-description";
import type { DaemonClient } from "../lib/daemon";
import { btnCls, inputCls } from "./AgentSettings";
import { useApprovalFeedback } from "./ApprovalFeedback";
import s from "./Approvals.module.css";
import { Button, Field, StatusPill } from "./ds/controls";

function useApprovals(client: DaemonClient, agentId?: string) {
  const [items, setItems] = useState<Approval[]>([]);
  const load = useCallback(() => {
    client
      .request("approvals.list", agentId ? { agentId } : {})
      .then(setItems)
      .catch(() => {});
  }, [client, agentId]);
  useEffect(() => {
    load();
    return client.on("approval.updated", (a) => {
      if (!agentId || a.agentId === agentId) load();
    });
  }, [client, agentId, load]);
  return items;
}

function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((until - now) / 1000));
  return (
    <span>
      Expira em {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </span>
  );
}

export function ApprovalCard({
  client,
  approval: a,
  botName,
  primary = true,
}: {
  client: DaemonClient;
  approval: Approval;
  botName?: string;
  primary?: boolean;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const feedback = useApprovalFeedback();
  const respond = async (decision: ApprovalDecision, v?: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      feedback(await decideApproval(client, a, decision, v));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const label =
    a.kind === "secret"
      ? "Segredo solicitado"
      : a.kind === "takeover"
        ? "Sua vez"
        : "Aprovação necessária";
  const appTool = Boolean(a.appId && a.permission);
  const sensitive = a.permission && isSensitivePermission(a.permission);
  const approveLabel = a.permission ? permissionActions[a.permission] : approvalAction(a.tool);
  const copy = a.kind === "tool" ? describeApproval(a, botName) : null;
  return (
    <div className={s.card} data-testid="approval">
      <div className={s.head}>
        <h3 className={s.title}>{label}</h3>
        {a.status === "pending" ? (
          <StatusPill status="wait" />
        ) : (
          <span className={s.meta}>
            {
              { approved: "Aprovado", denied: "Recusado", expired: "Expirado", done: "Concluído" }[
                a.status
              ]
            }
          </span>
        )}
      </div>
      <div className={s.body}>
        <div className={s.meta}>
          {a.appName}
          {a.permission ? ` · ${permissionLabels[a.permission]} · ` : ""}
          {botName}
          {a.background ? " · Em segundo plano" : ""}
        </div>
        {appTool && (
          <time className={s.meta} dateTime={new Date(a.createdAt).toISOString()}>
            {new Date(a.createdAt).toLocaleString("pt-BR")}
          </time>
        )}
        {sensitive && (
          <p className={s.meta}>
            Este tipo de ação sempre pede aprovação. Não é possível permitir sempre.
          </p>
        )}
        <div className={s.title}>{copy ? copy.description : a.title}</div>
        {copy?.context && <div className={s.meta}>{copy.context}</div>}
        {copy?.arguments && <div className={s.arguments}>{copy.arguments}</div>}
        {!copy && a.detail && <div>{a.detail}</div>}
        {a.kind === "takeover" && a.status === "pending" && (
          <div className={s.meta}>
            Use a janela do navegador do UpBot para entrar na conta ou concluir a verificação.
            Depois, selecione Concluir etapa. O bot não vê o que você digita.
          </div>
        )}
        {a.status === "pending" && (
          <span className={s.meta}>
            <Countdown until={a.expiresAt} />
          </span>
        )}
        {error && <div role="alert">{error}</div>}
      </div>
      {a.status === "pending" && (
        <form
          className={s.footer}
          onSubmit={(e) => {
            e.preventDefault();
            if (a.kind === "secret") void respond("approve", value);
          }}
        >
          {a.kind === "secret" && (
            <Field
              label={`Valor de ${a.secretName}`}
              type="password"
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
          {a.kind === "tool" && !appTool && (
            <>
              <Button disabled={busy} onClick={() => respond("always")}>
                Permitir sempre
              </Button>
            </>
          )}
          {a.kind === "secret" && (
            <Button
              type="submit"
              variant={primary ? "primary" : "secondary"}
              disabled={busy || !value}
            >
              Salvar no cofre
            </Button>
          )}
          {a.kind === "takeover" && (
            <Button
              variant={primary ? "primary" : "secondary"}
              disabled={busy}
              onClick={() => respond("done")}
            >
              Concluir etapa
            </Button>
          )}
          <Button variant="ghost" disabled={busy} onClick={() => respond("deny")}>
            {a.kind === "tool" ? "Recusar" : "Cancelar"}
          </Button>
          {appTool && !sensitive && (
            <>
              <Button disabled={busy} onClick={() => respond("task")}>
                Só nesta tarefa
              </Button>
              <Button
                variant={primary ? "primary" : "secondary"}
                disabled={busy}
                onClick={() => respond("always")}
              >
                Permitir
              </Button>
            </>
          )}
          {a.kind === "tool" && (!appTool || sensitive) && (
            <Button
              variant={primary ? "primary" : "secondary"}
              disabled={busy}
              onClick={() => respond("approve")}
            >
              {approveLabel}
            </Button>
          )}
        </form>
      )}
    </div>
  );
}

/** Pending approvals of one bot, shown above the composer. */
export function ApprovalCards({
  client,
  agentId,
  botName,
}: {
  client: DaemonClient;
  agentId: string;
  botName: string;
}) {
  const pending = useApprovals(client, agentId).filter((a) => a.status === "pending");
  if (!pending.length) return null;
  return (
    <div className={s.cards}>
      {pending.map((a, index) => (
        <ApprovalCard
          key={a.id}
          client={client}
          approval={a}
          botName={botName}
          primary={index === 0}
        />
      ))}
    </div>
  );
}

export function AppApprovalCards({
  client,
  agents,
  primary = true,
}: {
  client: DaemonClient;
  agents: Agent[];
  primary?: boolean;
}) {
  const pending = useApprovals(client).filter(
    (a) => a.status === "pending" && a.kind === "tool" && Boolean(a.appId),
  );
  if (!pending.length) return null;
  return (
    <section aria-label="Pedidos de apps conectados" className={s.cards}>
      <h3>Pedidos pendentes</h3>
      {pending.map((a, index) => (
        <ApprovalCard
          key={a.id}
          client={client}
          approval={a}
          primary={primary && index === 0}
          botName={agents.find((bot) => bot.id === a.agentId)?.name ?? "Bot removido"}
        />
      ))}
    </section>
  );
}

export function ApprovalsView({ client, agents }: { client: DaemonClient; agents: Agent[] }) {
  const items = useApprovals(client);
  const [rules, setRules] = useState<ApprovalRule[]>([]);
  const [form, setForm] = useState({ pattern: "", action: "ask" as "ask" | "allow", agentId: "" });
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    client
      .request("approvals.rules", {})
      .then(setRules)
      .catch(() => {});
  }, [client]);
  useEffect(() => {
    load();
    return client.on("approvals.rulesChanged", load);
  }, [client, load]);
  const save = (next: ApprovalRule[]) =>
    client
      .request("approvals.setRules", { rules: next })
      .then(setRules)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  const nameOf = (id: string | null) =>
    id ? (agents.find((a) => a.id === id)?.name ?? "Bot removido") : "Todos os bots";
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <h2 className="text-lg font-semibold">Aprovações</h2>
      <p className="text-xs text-zinc-500">
        As regras usam nomes de ferramentas e o curinga *. Perguntar antes tem prioridade sobre
        permitir. Sem regra, o nome da ferramenta determina se uma ação de app conectado pede
        aprovação. Cada pedido mostra seu prazo.
      </p>
      <ul className="space-y-1">
        {rules.map((r) => (
          <li
            key={r.id}
            className="flex items-center gap-2 rounded border border-zinc-800 px-3 py-2 text-sm"
          >
            <span className={r.action === "ask" ? "text-amber-300" : "text-emerald-300"}>
              {r.action === "ask" ? "Perguntar antes" : "Permitir"}
            </span>
            <code className="text-xs">{r.pattern}</code>
            <span className="text-xs text-zinc-500">{nameOf(r.agentId)}</span>
            <button
              type="button"
              className="ml-auto text-xs text-zinc-500 hover:text-red-400"
              onClick={() => save(rules.filter((x) => x.id !== r.id))}
            >
              Remover
            </button>
          </li>
        ))}
        {rules.length === 0 && <li className="text-sm text-zinc-500">Nenhuma regra ainda.</li>}
      </ul>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          void save([
            ...rules,
            {
              id: crypto.randomUUID(),
              pattern: form.pattern.trim(),
              action: form.action,
              agentId: form.agentId || null,
            },
          ]).then(() => setForm({ ...form, pattern: "" }));
        }}
      >
        <select
          className={inputCls}
          value={form.action}
          aria-label="Ação da regra"
          onChange={(e) => setForm({ ...form, action: e.target.value as "ask" | "allow" })}
        >
          <option value="ask">Perguntar antes</option>
          <option value="allow">Permitir</option>
        </select>
        <input
          className={`${inputCls} font-mono`}
          required
          placeholder="Nome ou padrão da ferramenta"
          aria-label="Padrão da regra"
          value={form.pattern}
          onChange={(e) => setForm({ ...form, pattern: e.target.value })}
        />
        <select
          className={inputCls}
          value={form.agentId}
          aria-label="Bot da regra"
          onChange={(e) => setForm({ ...form, agentId: e.target.value })}
        >
          <option value="">Todos os bots</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <button type="submit" className={`${btnCls} bg-zinc-700 hover:bg-zinc-600`}>
          Adicionar
        </button>
      </form>
      {error && <div className="text-xs text-red-400">{error}</div>}
      <h3 className="text-sm font-semibold text-zinc-300">Pedidos</h3>
      <div className="space-y-2">
        {items.map((a) => (
          <ApprovalCard
            key={`${a.id}:${a.status}`}
            client={client}
            approval={a}
            primary={a.id === items.find((item) => item.status === "pending")?.id}
            botName={nameOf(a.agentId)}
          />
        ))}
        {items.length === 0 && <p className="text-sm text-zinc-500">Nenhum pedido ainda.</p>}
      </div>
    </div>
  );
}
