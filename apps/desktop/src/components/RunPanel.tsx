import type { Agent, ApprovalRule } from "@upbot/protocol";
import { useMemo, useRef, useState } from "react";
import { useChatApi } from "../hooks/useChat";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import { useLayerFocus, useMediaQuery } from "../hooks/useLayerFocus";
import type { AgentOverview } from "../hooks/useOverview";
import type { DaemonClient } from "../lib/daemon";
import { errorMessage } from "../lib/errors";
import { Pill, type UiStatus } from "../lib/ui";
import { Icon, type IconName } from "./icons";
import { UsageBar } from "./UsageBar";

const toolStatus: Record<string, UiStatus> = {
  pending: "queue",
  in_progress: "run",
  completed: "ok",
  failed: "err",
};
function appIcon(name: string): IconName {
  const normalized = name.toLowerCase();
  if (normalized.includes("email") || normalized.includes("e-mail") || normalized.includes("gmail"))
    return "mail";
  if (normalized.includes("github")) return "code";
  if (normalized.includes("brave") || normalized.includes("web")) return "web";
  if (normalized.includes("airtable") || normalized.includes("sheet")) return "sheet";
  if (normalized.includes("stripe")) return "card";
  if (normalized.includes("notion")) return "doc";
  return "plug";
}

export function RunPanel({
  client,
  agent,
  overview,
  onClose,
  onOpenApps,
  overlayOpen,
}: {
  client: DaemonClient;
  agent: Agent;
  overview: AgentOverview;
  onClose: () => void;
  onOpenApps: () => void;
  overlayOpen: boolean;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const overlay = useMediaQuery("(max-width: 1180px)");
  useLayerFocus(panelRef, overlay && overlayOpen);
  const chat = useChatApi();
  const {
    data: rules = [],
    error: rulesLoadError,
    loaded: rulesLoaded,
    reload: reloadRules,
  } = useDaemonQuery(
    client,
    "approvals.rules",
    {},
    {
      events: { "approvals.rulesChanged": true },
    },
  );
  const { data: memories = [] } = useDaemonQuery(
    client,
    "memories.list",
    { agentId: agent.id },
    { events: { "memories.changed": (event) => event.agentId === agent.id } },
  );
  const { data: placements } = useDaemonQuery(
    client,
    "placements.list",
    {},
    {
      events: { "placement.updated": (next) => next.agentId === agent.id },
    },
  );
  const placement = placements?.find((item) => item.agentId === agent.id) ?? null;
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [rulesBusy, setRulesBusy] = useState(false);

  const currentTurnId = chat.runningTurn?.id ?? overview.latestTurn?.id;
  const turns = chat.items.filter(
    (item) => item.kind === "tool_call" && item.turnId === currentTurnId,
  );
  const completed = turns.filter(
    (item) => item.kind === "tool_call" && item.status === "completed",
  ).length;
  const progress = turns.length ? Math.round((completed / turns.length) * 100) : 0;
  const globalRule = rules.find((rule) => rule.pattern === "*" && rule.agentId === agent.id);
  const specificRules = rules.filter((rule) => rule.agentId === agent.id && rule.pattern !== "*");
  const busy = chat.status.status === "running" || chat.status.status === "starting";
  const microVm = placement?.isolation === "firecracker";
  const vmActive = microVm && (overview.status === "run" || overview.status === "wait");

  const saveRules = async (next: ApprovalRule[]) => {
    setRulesBusy(true);
    setRulesError(null);
    try {
      // approvals.setRules replaces the whole list; the rulesChanged event it
      // broadcasts refreshes `rules` through the query above.
      await client.request("approvals.setRules", { rules: next });
    } catch (e) {
      setRulesError(errorMessage(e));
    } finally {
      setRulesBusy(false);
    }
  };

  const toggleGlobal = () => {
    if (globalRule?.action === "allow") {
      void saveRules(rules.filter((rule) => rule.id !== globalRule.id));
      return;
    }
    if (globalRule) {
      void saveRules(
        rules.map((rule) => (rule.id === globalRule.id ? { ...rule, action: "allow" } : rule)),
      );
    } else {
      void saveRules([
        ...rules,
        { id: crypto.randomUUID(), pattern: "*", action: "allow", agentId: agent.id },
      ]);
    }
  };

  const toggleRule = (rule: ApprovalRule) => {
    void saveRules(
      rules.map((item) =>
        item.id === rule.id ? { ...item, action: item.action === "allow" ? "ask" : "allow" } : item,
      ),
    );
  };

  const connectedApps = useMemo(
    () =>
      overview.apps.map((app) => ({
        id: app.id,
        name: app.name,
        detail:
          app.status === "ready"
            ? "Conectado"
            : app.status === "error"
              ? "Com erro"
              : app.status === "starting"
                ? "Conectando…"
                : "Desligado",
        icon: appIcon(app.name),
      })),
    [overview.apps],
  );
  const allConnections = [
    ...connectedApps,
    ...overview.emailAccounts.map((account) => ({
      id: account.id,
      name: account.label,
      detail: account.address,
      icon: "mail" as const,
    })),
  ];

  return (
    <aside
      ref={panelRef}
      className="panel"
      id="panel"
      aria-label="Execução"
      data-od-id="run-panel"
      {...(overlay && overlayOpen ? { role: "dialog" as const, "aria-modal": true } : {})}
    >
      <div className="panel-head">
        <h3>Execução</h3>
        <button type="button" className="icon-btn" aria-label="Fechar painel" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="panel-sec" data-od-id="panel-progress">
        <p className="eyebrow">Tarefa atual</p>
        <h3 className="panel-task">{overview.task ?? "Nenhuma tarefa em andamento"}</h3>
        {turns.length ? (
          <>
            <div className={`progress${progress === 100 ? " ok" : ""}`}>
              <i style={{ width: `${progress}%` }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span className="meta num">
                {completed} de {turns.length} etapas
              </span>
              <Pill st={overview.status} />
            </div>
            <div className="p-steps">
              {turns.map((item) => {
                if (item.kind !== "tool_call") return null;
                const st = toolStatus[item.status];
                return (
                  <div className={`p-step ${st}`} key={item.id}>
                    <i className={`dot s-${st}`} />
                    {item.title}
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <p className="meta" style={{ marginTop: 8 }}>
            Quando você pedir algo, as etapas aparecem aqui.
          </p>
        )}
      </div>
      <div className="panel-sec">
        <p className="eyebrow">Uso de contexto</p>
        <UsageBar client={client} agentId={agent.id} busy={busy} />
      </div>
      <div className="panel-sec" data-od-id="panel-vm">
        <div className="vm-head">
          <p className="eyebrow">Computador do bot</p>
          <span className="vm-live">
            <i className={`dot ${vmActive ? "s-run" : "s-idle"}`} />
            {microVm ? (vmActive ? "Em uso" : "Configurada") : "Desligado"}
          </span>
        </div>
        <div className="vm-off">
          <span>
            {microVm ? (
              <>
                <b>
                  MicroVM isolada · {placement.vcpus} vCPU · {placement.memMib} MiB
                </b>
                {!vmActive && (
                  <span>Liga quando uma tarefa começa e pode continuar ligada entre tarefas.</span>
                )}
              </>
            ) : (
              <>
                <b>Nenhuma VM ligada</b>
                <span>
                  O bot {agent.name} usa só integrações por enquanto. A VM liga quando uma tarefa
                  precisa de navegador ou terminal.
                </span>
              </>
            )}
          </span>
        </div>
      </div>
      <div className="panel-sec" data-od-id="panel-tools">
        <p className="eyebrow">Ferramentas conectadas</p>
        {allConnections.length ? (
          <div className="tools">
            {allConnections.map((item) => (
              <div className="tool-row" key={item.id}>
                <span className="ti">
                  <Icon name={item.icon} />
                </span>
                <span>{item.name}</span>
                <span className="meta">{item.detail}</span>
              </div>
            ))}
          </div>
        ) : (
          <div>
            <p className="meta">Nenhuma ferramenta conectada.</p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onOpenApps}>
              Conectar apps
            </button>
          </div>
        )}
      </div>
      <div className="panel-sec" data-od-id="panel-perms">
        <p className="eyebrow">Permissões</p>
        <div className="perm">
          <span>
            Agir sem perguntar
            <small>
              {globalRule?.action === "allow"
                ? "Autônomo · ações sensíveis ainda pedem aprovação"
                : "Pede aprovação em ações sensíveis"}
            </small>
          </span>
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={globalRule?.action === "allow"}
            aria-label="Agir sem perguntar"
            disabled={rulesBusy || !rulesLoaded}
            onClick={toggleGlobal}
          />
        </div>
        {specificRules.map((rule) => (
          <div className="perm" key={rule.id}>
            <span>
              {rule.pattern}
              <small>{rule.action === "ask" ? "Pergunta antes" : "Permitido"}</small>
            </span>
            <button
              type="button"
              className="switch"
              role="switch"
              aria-checked={rule.action === "allow"}
              aria-label={rule.pattern}
              disabled={rulesBusy || !rulesLoaded}
              onClick={() => toggleRule(rule)}
            />
          </div>
        ))}
        {rulesError && <p className="meta">{rulesError}</p>}
        {rulesLoadError && (
          <p className="meta">
            Não foi possível carregar as regras.{" "}
            <button type="button" className="btn btn-ghost btn-sm" onClick={reloadRules}>
              Tentar novamente
            </button>
          </p>
        )}
      </div>
      <div className="panel-sec memory" data-od-id="panel-memory">
        <p className="eyebrow" style={{ margin: 0 }}>
          O que ele lembra
        </p>
        <ul>
          {memories.map((memory) => (
            <li key={memory.id}>{memory.text}</li>
          ))}
          {memories.length === 0 && <li>Nada ainda.</li>}
        </ul>
      </div>
    </aside>
  );
}
