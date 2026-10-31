import type { Agent, AgentStatusInfo, Channel } from "@upbot/protocol";
import type { RefObject } from "react";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import type { AgentOverview } from "../hooks/useOverview";
import type { DaemonClient } from "../lib/daemon";
import { moveControlFocus } from "../lib/keyboard";
import { mod } from "../lib/platform";
import { useThemePref } from "../lib/theme";
import { fmtTime } from "../lib/ui";
import {
  ClockIcon,
  HomeIcon,
  MoonIcon,
  PlugIcon,
  PlusIcon,
  SearchIcon,
  SunIcon,
  UpbotSimboloCurrentcolorIcon,
} from "./ds/icons";
import { Icon } from "./icons";

export function Sidebar({
  client,
  ready,
  agents,
  channels,
  overview,
  statuses,
  selectedId,
  agentNameOverride,
  channelId,
  current,
  profileName,
  drawer,
  sideRef,
  onClose,
  onNew,
  onSearch,
  onHome,
  onScheduled,
  onApps,
  onSettings,
  onAgent,
  onChannel,
}: {
  client: DaemonClient;
  ready: boolean;
  agents: Agent[];
  channels: Channel[];
  overview: Record<string, AgentOverview>;
  statuses: Record<string, AgentStatusInfo>;
  selectedId: string | null;
  agentNameOverride?: { agentId: string; name: string } | null;
  channelId: string | null;
  current: string;
  profileName: string;
  drawer: boolean;
  sideRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onNew: () => void;
  onSearch: () => void;
  onHome: () => void;
  onScheduled: () => void;
  onApps: () => void;
  onSettings: () => void;
  onAgent: (id: string) => void;
  onChannel: (id: string) => void;
}) {
  const { data: approvals = [] } = useDaemonQuery(
    client,
    "approvals.list",
    {},
    {
      enabled: ready,
      events: { "approval.updated": true },
    },
  );
  const [theme, setTheme] = useThemePref();
  const pending = approvals.filter((item) => item.status === "pending" && item.appId).length;
  const dark =
    theme === "auto" ? document.documentElement.dataset.theme === "dark" : theme === "dark";
  const name = profileName.trim() || "Você";
  return (
    <aside
      ref={sideRef}
      id="bot-drawer"
      className="side"
      aria-label="Bots e tarefas"
      {...(drawer ? { role: "dialog" as const, "aria-modal": true } : {})}
    >
      {drawer && (
        <button
          type="button"
          className="icon-btn side-close"
          aria-label="Fechar barra lateral"
          onClick={onClose}
        >
          <Icon name="x" />
        </button>
      )}
      <div className="side-titlebar" data-tauri-drag-region />
      <div className="side-brand" role="img" aria-label="UpBot">
        <UpbotSimboloCurrentcolorIcon />
        <span>UpBot</span>
      </div>
      <nav className="side-actions" aria-label="Navegação principal">
        <button type="button" className="side-btn new" onClick={onNew}>
          <PlusIcon />
          <span>Nova tarefa</span>
          <kbd>{mod}N</kbd>
        </button>
        <button type="button" className="side-btn" onClick={onSearch}>
          <SearchIcon />
          <span>Buscar</span>
          <kbd>{mod}K</kbd>
        </button>
        <button
          type="button"
          className="side-btn"
          aria-current={current === "home" ? "page" : undefined}
          onClick={onHome}
        >
          <HomeIcon />
          <span>Início</span>
        </button>
        <button
          type="button"
          className="side-btn"
          aria-current={current === "scheduled" ? "page" : undefined}
          onClick={onScheduled}
        >
          <ClockIcon />
          <span>Agendadas</span>
        </button>
        <button
          type="button"
          className="side-btn"
          aria-current={current === "apps" ? "page" : undefined}
          onClick={onApps}
        >
          <PlugIcon />
          <span>Apps conectados</span>
          {pending > 0 && (
            <span
              className="side-count"
              role="status"
              aria-label={`${pending} ${pending === 1 ? "pedido pendente" : "pedidos pendentes"}`}
            >
              {pending}
            </span>
          )}
        </button>
      </nav>
      <div className="side-scroll">
        <h2 className="side-label" id="sidebar-bots">
          SEUS AGENTES
        </h2>
        <ul className="side-bots" aria-labelledby="sidebar-bots">
          {agents.map((agent) => {
            const item = overview[agent.id];
            const state = item?.pending ? "wait" : (item?.status ?? "idle");
            const summary =
              state === "wait"
                ? "Aguardando sua aprovação"
                : state === "run"
                  ? "Em execução"
                  : state === "queue"
                    ? `${item?.queued ?? 0} na fila`
                    : state === "err"
                      ? "Erro na última tarefa"
                      : state === "ok"
                        ? `Concluído · ${fmtTime(item?.latestTurn?.endedAt)}`
                        : "Pronto para uma tarefa";
            return (
              <li key={agent.id}>
                <button
                  type="button"
                  className="side-bot"
                  aria-current={
                    (current === "chat" || current === "agent-settings") && selectedId === agent.id
                      ? "true"
                      : undefined
                  }
                  onClick={() => onAgent(agent.id)}
                >
                  <b>
                    {agentNameOverride?.agentId === agent.id
                      ? agentNameOverride.name.trim() || "Sem nome"
                      : agent.name}
                  </b>
                  <small title={state === "err" ? (statuses[agent.id]?.error ?? summary) : summary}>
                    {summary}
                  </small>
                  <i className={`dot s-${state}`} aria-hidden="true" />
                </button>
              </li>
            );
          })}
          {agents.length === 0 && <li className="side-empty">Nenhum bot ainda.</li>}
          {channels.map((channel) => (
            <li key={channel.id}>
              <button
                type="button"
                className="side-bot"
                aria-current={
                  current === "channel" && channelId === channel.id ? "true" : undefined
                }
                onClick={() => onChannel(channel.id)}
              >
                <b># {channel.name}</b>
                <small>
                  {channel.status === "active"
                    ? "Conversa ativa"
                    : channel.status === "archived"
                      ? "Conversa arquivada"
                      : "Conversa parada"}
                </small>
                <i
                  className={`dot ${channel.status === "active" ? "s-run" : "s-idle"}`}
                  aria-hidden="true"
                />
              </button>
            </li>
          ))}
        </ul>
      </div>
      <footer className="side-foot">
        <span className="side-avatar" aria-hidden="true">
          {name.slice(0, 1).toLocaleUpperCase("pt-BR")}
        </span>
        <div className="side-who">
          <b title={name}>{name}</b>
          <span>Pessoal</span>
        </div>
        <fieldset className="side-theme" onKeyDown={moveControlFocus}>
          <legend className="sr">Tema da interface</legend>
          <button
            type="button"
            aria-label="Tema claro"
            aria-pressed={!dark}
            tabIndex={dark ? -1 : 0}
            onClick={() => setTheme("light")}
          >
            <SunIcon />
          </button>
          <button
            type="button"
            aria-label="Tema escuro"
            aria-pressed={dark}
            tabIndex={dark ? 0 : -1}
            onClick={() => setTheme("dark")}
          >
            <MoonIcon />
          </button>
        </fieldset>
        <button
          type="button"
          className="side-settings"
          aria-label="Configurações"
          onClick={onSettings}
        >
          <Icon name="gear" />
        </button>
      </footer>
    </aside>
  );
}
