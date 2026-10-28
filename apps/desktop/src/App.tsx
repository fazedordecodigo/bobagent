import type {
  Agent,
  AgentAvatar,
  AgentStatusInfo,
  ApprovalRule,
  Channel,
  ProviderId,
} from "@upbot/protocol";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentSettings, PROVIDERS } from "./components/AgentSettings";
import { ChannelCreateForm, ChannelView } from "./components/ChannelView";
import { ChatView } from "./components/ChatView";
import { CommandPalette, type PaletteItem } from "./components/CommandPalette";
import { IconButton } from "./components/ds/controls";
import { Icon } from "./components/icons";
import { AvatarEditor, ComputerUsePanel, MemoriesPanel, RoutinesPanel } from "./components/Library";
import { NotificationSettings } from "./components/NotificationSettings";
import { PagesView } from "./components/PagesView";
import { RunPanel } from "./components/RunPanel";
import { TABS, ToolBody, type ToolTab } from "./components/ToolsView";
import { UpdateButton } from "./components/UpdateButton";
import { useOverview } from "./hooks/useOverview";
import { DaemonClient } from "./lib/daemon";
import { useNativeNotifications } from "./lib/native-notifications";
import { mod } from "./lib/platform";
import { MonoAv, mono, Pill, role, type UiStatus } from "./lib/ui";

type View =
  | "chat"
  | "agents"
  | "tasks"
  | "settings"
  | "channel"
  | "pages"
  | "agent-settings"
  | "channel-new";
type RailView = Extract<View, "chat" | "agents" | "tasks" | "settings">;
type Autonomy = "ask" | "sensitive" | "auto";
type ThemePreference = "light" | "dark" | "auto";
const RAIL_VIEWS: RailView[] = ["chat", "agents", "tasks", "settings"];
const PROVIDER_NAMES: Record<ProviderId, string> = {
  devin: "Devin",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
  gemini: "Gemini",
  claude: "Claude",
  codex: "Codex",
  "openai-compatible": "Compatível com OpenAI",
};
const TASK_ORDER: Record<UiStatus, number> = {
  err: 0,
  wait: 1,
  run: 2,
  queue: 3,
  ok: 4,
  idle: 5,
};
const STATUS_NOTES = {
  run: "Agindo agora",
  wait: "Precisa de você",
  ok: "Entregue",
  err: "Falhou",
};

function readStorage(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function readView(): RailView {
  const stored = readStorage("upbot.view");
  return RAIL_VIEWS.includes(stored as RailView) ? (stored as RailView) : "chat";
}

function statusProvider(provider: ProviderId) {
  return PROVIDER_NAMES[provider];
}

function isAskMode(agent: Agent) {
  return (
    (agent.provider === "claude" && agent.config.mode === "plan") ||
    (agent.provider === "codex" && agent.config.mode === "read-only")
  );
}

function useThemePref() {
  const [pref, setPref] = useState<ThemePreference>(() => {
    const current = document.documentElement.dataset.themePref;
    return current === "light" || current === "dark" ? current : "auto";
  });
  const setTheme = useCallback((next: ThemePreference) => {
    const root = document.documentElement;
    root.dataset.themePref = next;
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = next === "auto" ? (dark ? "dark" : "light") : next;
    writeStorage("upbot.theme", next);
    setPref(next);
  }, []);
  return [pref, setTheme] as const;
}

export default function App() {
  const [client] = useState(() => new DaemonClient());
  const [agents, setAgents] = useState<Agent[]>([]);
  const [statuses, setStatuses] = useState<Record<string, AgentStatusInfo>>({});
  const [selectedId, setSelectedId] = useState<string | null>(() => readStorage("upbot.agent"));
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [view, setView] = useState<View>(readView);
  const [creating, setCreating] = useState(false);
  const [settingsTab, setSettingsTab] = useState<ToolTab | "general">("general");
  const [search, setSearch] = useState("");
  const [palette, setPalette] = useState<{ group?: string } | null>(null);
  const [paletteItems, setPaletteItems] = useState<PaletteItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [clientReady, setClientReady] = useState(false);
  const [noPanel, setNoPanel] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);

  const refreshAll = useCallback(async () => {
    const [list, nextStatuses, nextChannels] = await Promise.all([
      client.request("agents.list", {}),
      client.request("agents.statuses", {}),
      client.request("channels.list", { includeArchived: true }),
    ]);
    setChannels(nextChannels);
    setAgents(list);
    setStatuses(nextStatuses);
  }, [client]);

  useEffect(() => {
    let alive = true;
    void client
      .connect()
      .then(refreshAll)
      .then(() => {
        if (alive) setClientReady(true);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    const offs = [
      client.on("agent.created", (agent) =>
        setAgents((prev) => (prev.some((item) => item.id === agent.id) ? prev : [...prev, agent])),
      ),
      client.on("agent.updated", (agent) =>
        setAgents((prev) => prev.map((item) => (item.id === agent.id ? agent : item))),
      ),
      client.on("agent.deleted", ({ id }) => {
        setAgents((prev) => prev.filter((agent) => agent.id !== id));
        setSelectedId((selected) => (selected === id ? null : selected));
      }),
      client.on("agent.status", ({ agentId, status, error: statusError }) =>
        setStatuses((prev) => ({
          ...prev,
          [agentId]: { status, error: statusError },
        })),
      ),
      client.on("channel.created", (channel) =>
        setChannels((prev) =>
          prev.some((item) => item.id === channel.id) ? prev : [...prev, channel],
        ),
      ),
      client.on("channel.updated", (channel) =>
        setChannels((prev) => prev.map((item) => (item.id === channel.id ? channel : item))),
      ),
      client.onReconnect(() => {
        void refreshAll().catch(() => {});
      }),
    ];
    return () => {
      alive = false;
      for (const off of offs) off();
      client.close();
    };
  }, [client, refreshAll]);

  const overview = useOverview(client, agents, statuses, clientReady);
  const selected = agents.find((agent) => agent.id === selectedId) ?? null;
  const selectedOverview = selected ? overview[selected.id] : undefined;
  const selectedChannel = channels.find((channel) => channel.id === channelId) ?? null;
  const pendingCount = agents.filter((agent) => overview[agent.id]?.status === "wait").length;

  const navigate = useCallback((next: View) => {
    setView(next);
    setSideOpen(false);
    if (RAIL_VIEWS.includes(next as RailView)) writeStorage("upbot.view", next);
    setCreating(false);
  }, []);

  const openAgent = useCallback(
    (id: string) => {
      setSelectedId(id);
      writeStorage("upbot.agent", id);
      setChannelId(null);
      navigate("chat");
    },
    [navigate],
  );

  const reviewNotification = useCallback(
    (target: string) => {
      if (target === "apps") {
        setSettingsTab("apps");
        navigate("settings");
      } else openAgent(target);
    },
    [navigate, openAgent],
  );
  useNativeNotifications(client, clientReady, agents, reviewNotification, setError);

  useEffect(() => {
    if (!clientReady || !agents.length) return;
    if (!selectedId || !agents.some((agent) => agent.id === selectedId)) {
      const first = agents[0];
      if (first) {
        setSelectedId(first.id);
        writeStorage("upbot.agent", first.id);
      }
    }
  }, [agents, clientReady, selectedId]);

  const shortcutsRef = useRef<(e: KeyboardEvent) => void>(() => {});
  shortcutsRef.current = (e) => {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      if (palette) setPalette(null);
      else if (creating) setCreating(false);
      else if (document.querySelector("dialog[open]")) return;
      else if (sideOpen) setSideOpen(false);
      else if (panelOpen) setPanelOpen(false);
      else return;
      e.preventDefault();
      return;
    }
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === "." && view === "chat" && selectedId) togglePanel();
    else if (key === "k") setPalette({});
    else if (key === "f" && e.shiftKey) setPalette({ group: "Bots" });
    else if (key === "n" && !e.shiftKey) {
      navigate("chat");
      setSelectedId(null);
      setCreating(true);
    } else if (key === ",") {
      setSettingsTab("general");
      navigate("settings");
    } else if (key === "p" && !e.shiftKey) navigate("pages");
    else if (/^[1-9]$/.test(key) && !e.shiftKey) {
      const agent = agents[Number(key) - 1];
      if (agent) openAgent(agent.id);
      else return;
    } else return;
    e.preventDefault();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => shortcutsRef.current(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!palette) return;
    const base: PaletteItem[] = [
      ...agents.map((agent) => ({
        id: `agent:${agent.id}`,
        group: "Bots",
        label: agent.name,
        hint: statusProvider(agent.provider),
        run: () => openAgent(agent.id),
      })),
      ...channels.map((channel) => ({
        id: `group:${channel.id}`,
        group: "Conversas em grupo",
        label: `# ${channel.name}`,
        hint: channel.status === "active" ? "ativo" : "arquivado",
        run: () => {
          setChannelId(channel.id);
          navigate("channel");
        },
      })),
      ...TABS.map((tab) => ({
        id: `settings:${tab.id}`,
        group: "Configurações",
        label: tab.label,
        hint: tab.hint,
        run: () => {
          setSettingsTab(tab.id);
          navigate("settings");
        },
      })),
      {
        id: "new-agent",
        group: "Ações",
        label: "Criar bot",
        run: () => {
          navigate("chat");
          setCreating(true);
        },
      },
      {
        id: "new-group",
        group: "Ações",
        label: "Nova conversa em grupo",
        run: () => navigate("channel-new"),
      },
    ];
    setPaletteItems(base);
    void client
      .request("pages.list", {})
      .then((pages) =>
        setPaletteItems([
          ...base,
          ...pages.map((page) => ({
            id: `page:${page.id}`,
            group: "Páginas",
            label: page.title,
            hint: page.description,
            run: () => navigate("pages"),
          })),
        ]),
      )
      .catch(() => {});
  }, [agents, channels, client, navigate, openAgent, palette]);

  const createChannel = useCallback(
    async (form: { name: string; memberIds: string[]; ownerId: string | null }) => {
      const channel = await client.request("channels.create", form);
      setChannelId(channel.id);
      navigate("channel");
    },
    [client, navigate],
  );

  const createAgent = useCallback(
    async (form: {
      name: string;
      provider: ProviderId;
      instructions: string;
      autonomy: Autonomy;
      avatar: AgentAvatar | null;
    }) => {
      const agent = await client.request("agents.create", {
        name: form.name,
        provider: form.provider,
        instructions: form.instructions,
        avatar: form.avatar,
      });
      setAgents((prev) => (prev.some((item) => item.id === agent.id) ? prev : [...prev, agent]));
      setSelectedId(agent.id);
      writeStorage("upbot.agent", agent.id);
      navigate("chat");
      if (form.autonomy !== "sensitive") {
        try {
          const rules = await client.request("approvals.rules", {});
          const rule: ApprovalRule = {
            id: crypto.randomUUID(),
            pattern: "*",
            action: form.autonomy === "ask" ? "ask" : "allow",
            agentId: agent.id,
          };
          await client.request("approvals.setRules", { rules: [...rules, rule] });
        } catch (e) {
          setNotice(
            `Bot criado, mas não foi possível salvar a regra de autonomia: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }
    },
    [client, navigate],
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
      await client.request("agents.update", { id, ...patch });
    },
    [client],
  );

  const deleteAgent = useCallback(
    async (id: string) => {
      await client.request("agents.delete", { id });
      setSelectedId(null);
      navigate("agents");
    },
    [client, navigate],
  );

  const togglePanel = () => {
    if (window.matchMedia("(max-width: 1180px)").matches) setPanelOpen((open) => !open);
    else setNoPanel((hidden) => !hidden);
  };

  const appView =
    view === "channel" || view === "pages" || view === "agent-settings" || view === "channel-new"
      ? "settings"
      : view;
  const appClass = [
    "app",
    `view-${appView}`,
    noPanel && view === "chat" ? "no-panel" : "",
    panelOpen && view === "chat" ? "panel-open" : "",
    sideOpen ? "side-open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const normalizedSearch = search.trim().toLocaleLowerCase("pt-BR");
  const filteredAgents = agents.filter((agent) => {
    if (!normalizedSearch) return true;
    const detail = overview[agent.id];
    return [agent.name, role(agent), detail?.task ?? ""]
      .join(" ")
      .toLocaleLowerCase("pt-BR")
      .includes(normalizedSearch);
  });
  const filteredTasks = agents.filter(
    (agent) =>
      overview[agent.id]?.task &&
      (!normalizedSearch ||
        `${agent.name} ${overview[agent.id]?.task}`
          .toLocaleLowerCase("pt-BR")
          .includes(normalizedSearch)),
  );

  return (
    <div className={appClass}>
      <nav className="rail" aria-label="Navegação principal">
        <div className="rail-titlebar" data-tauri-drag-region />
        <div className="logo" role="img" aria-label="UpBot">
          <svg
            viewBox="0 0 48 48"
            fill="none"
            stroke="currentColor"
            strokeWidth="6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9.2 24V29a10 10 0 0 0 20 0V14" />
            <circle cx="38.2" cy="9.5" r="3.6" fill="currentColor" stroke="none" />
          </svg>
        </div>
        {(
          [
            ["chat", "Conversas"],
            ["agents", "Bots"],
            ["tasks", "Tarefas"],
          ] as const
        ).map(([railView, label]) => (
          <button
            key={railView}
            type="button"
            className="rail-btn"
            data-view={railView}
            aria-label={label}
            aria-current={view === railView ? "page" : undefined}
            onClick={() => {
              if (
                railView === "chat" &&
                view === "chat" &&
                window.matchMedia("(max-width: 759px)").matches
              ) {
                setSideOpen((open) => !open);
              } else navigate(railView);
            }}
          >
            <Icon name={railView} />
            {railView === "chat" && pendingCount > 0 && (
              <span className="badge">{pendingCount}</span>
            )}
          </button>
        ))}
        <div className="rail-spacer" />
        <button
          type="button"
          className="rail-btn"
          data-view="settings"
          aria-label="Configurações"
          aria-current={view === "settings" ? "page" : undefined}
          onClick={() => {
            setSettingsTab("general");
            navigate("settings");
          }}
        >
          <Icon name="settings" />
        </button>
        <div className="avatar" title="Sua conta">
          EU
        </div>
      </nav>

      <aside className="side" aria-label="Bots e tarefas">
        <div className="side-titlebar" data-tauri-drag-region />
        <div className="side-head">
          <div className="row">
            <span className="brand">UpBot</span>
            <button
              type="button"
              className="icon-btn"
              aria-label="Criar bot"
              onClick={() => {
                setSelectedId(null);
                setCreating(true);
              }}
            >
              <Icon name="plus" />
            </button>
          </div>
          <label className="search">
            <span className="sr">Buscar bots e tarefas</span>
            <Icon name="search" />
            <input
              type="search"
              placeholder="Buscar bots e tarefas"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </div>
        <div className="side-scroll">
          <p className="eyebrow side-label">Seus bots</p>
          <div id="agentList">
            {filteredAgents.map((agent) => {
              const item = overview[agent.id];
              const summary =
                item?.status === "err"
                  ? `Falhou: ${statuses[agent.id]?.error ?? "erro na última tarefa"}`
                  : (item?.task ?? "Pronto para uma tarefa");
              return (
                <button
                  key={agent.id}
                  type="button"
                  className={`agent-item is-${item?.status ?? "idle"}`}
                  aria-current={selectedId === agent.id && view === "chat" ? "true" : undefined}
                  onClick={() => openAgent(agent.id)}
                >
                  <MonoAv agent={agent} status={item?.status ?? "idle"} />
                  <div>
                    <div className="name">{agent.name}</div>
                    <div className="sub">{summary}</div>
                  </div>
                  <span className="meta">{item?.updated ?? "—"}</span>
                </button>
              );
            })}
            {filteredAgents.length === 0 && (
              <p className="meta" style={{ padding: 8 }}>
                {agents.length === 0 ? "Nenhum bot ainda." : "Nada encontrado."}
              </p>
            )}
          </div>
          <p className="eyebrow side-label">Tarefas recentes</p>
          <div id="recentTasks">
            {filteredTasks.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className="task-item"
                onClick={() => openAgent(agent.id)}
              >
                <i className={`dot s-${overview[agent.id]?.status ?? "idle"}`} />
                <span>{overview[agent.id]?.task}</span>
                <span className="meta">{mono(agent.name)}</span>
              </button>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <p className="eyebrow side-label">Conversas em grupo</p>
            <button
              type="button"
              className="icon-btn"
              aria-label="Criar conversa em grupo"
              onClick={() => navigate("channel-new")}
            >
              <Icon name="plus" />
            </button>
          </div>
          <div>
            {channels.map((channel) => (
              <button
                key={channel.id}
                type="button"
                className="task-item"
                aria-current={channelId === channel.id && view === "channel" ? "true" : undefined}
                onClick={() => {
                  setChannelId(channel.id);
                  navigate("channel");
                }}
              >
                <i className={`dot ${channel.status === "active" ? "s-run" : "s-idle"}`} />
                <span># {channel.name}</span>
                <span className="meta">
                  {channel.status === "active"
                    ? "ativo"
                    : channel.status === "archived"
                      ? "arquivado"
                      : "parado"}
                </span>
              </button>
            ))}
          </div>
          <p className="eyebrow side-label">Biblioteca</p>
          <button type="button" className="task-item" onClick={() => navigate("pages")}>
            <Icon name="page" />
            <span>Páginas</span>
          </button>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            borderTop: "1px solid var(--border)",
            padding: "4px 8px 12px",
          }}
        >
          <button type="button" className="task-item" onClick={() => setPalette({})}>
            <Icon name="search" />
            <span>Buscar…</span>
            <span className="meta">{mod}K</span>
          </button>
          <UpdateButton />
        </div>
      </aside>

      {sideOpen && (
        <button
          type="button"
          className="side-scrim"
          aria-label="Fechar painel de bots"
          onClick={() => setSideOpen(false)}
        />
      )}

      <main className="main">
        <IconButton
          aria-label="Abrir barra lateral"
          className="window-menu"
          onClick={() => setSideOpen((open) => !open)}
        >
          <Icon name="panel" />
        </IconButton>
        {error ? (
          <section className="view on">
            <div className="empty">
              <h2>Não foi possível conectar ao UpBot</h2>
              <p className="meta">{error}</p>
            </div>
          </section>
        ) : !clientReady ? (
          <section className="view on">
            <div className="empty">
              <h2>Conectando ao UpBot…</h2>
            </div>
          </section>
        ) : view === "chat" ? (
          selected ? (
            <ChatView
              key={selected.id}
              client={client}
              agent={selected}
              overview={selectedOverview}
              onOpenSettings={() => navigate("agent-settings")}
              onOpenApps={() => {
                setSettingsTab("apps");
                navigate("settings");
              }}
              notice={notice}
              onNoticeDismiss={() => setNotice(null)}
              onPanelToggle={togglePanel}
            />
          ) : (
            <section className="view on">
              <div className="empty">
                <h2>Escolha um bot ou crie um novo.</h2>
                <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                  Criar bot
                </button>
              </div>
            </section>
          )
        ) : view === "agents" ? (
          <AgentsView
            agents={agents}
            overview={overview}
            onCreate={() => setCreating(true)}
            onOpen={openAgent}
          />
        ) : view === "tasks" ? (
          <TasksView agents={agents} overview={overview} onOpen={openAgent} />
        ) : view === "settings" ? (
          <SettingsView
            client={client}
            agents={agents}
            selected={settingsTab}
            onSelect={setSettingsTab}
          />
        ) : view === "channel-new" ? (
          <section className="view on">
            <ChannelCreateForm
              agents={agents}
              onSubmit={createChannel}
              onCancel={() => navigate("chat")}
            />
          </section>
        ) : view === "channel" && selectedChannel ? (
          <section className="view on">
            <ChannelView client={client} channel={selectedChannel} agents={agents} />
          </section>
        ) : view === "pages" ? (
          <section className="view on">
            <PagesView client={client} agents={agents} onOpenBot={openAgent} />
          </section>
        ) : view === "agent-settings" && selected ? (
          <section className="view on">
            <div className="page agent-settings-page">
              <div className="page-inner">
                <div className="page-top">
                  <div>
                    <h1>{selected.name}</h1>
                    <p>Configurações do bot</p>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => navigate("chat")}
                  >
                    Voltar à conversa
                  </button>
                </div>
                <AvatarEditor
                  agent={selected}
                  onSave={(avatar) => updateAgent(selected.id, { avatar })}
                />
                <AgentSettings
                  key={selected.id}
                  client={client}
                  agent={selected}
                  onUpdate={updateAgent}
                  onDelete={deleteAgent}
                />
                <MemoriesPanel client={client} agentId={selected.id} />
                <RoutinesPanel client={client} agentId={selected.id} />
                <ComputerUsePanel client={client} agentId={selected.id} />
              </div>
            </div>
          </section>
        ) : (
          <section className="view on">
            <div className="empty">
              <h2>Escolha um bot ou crie um novo.</h2>
            </div>
          </section>
        )}
      </main>

      {view === "chat" && selected && selectedOverview && (
        <RunPanel
          client={client}
          agent={selected}
          overview={selectedOverview}
          onClose={togglePanel}
          onOpenApps={() => {
            setSettingsTab("apps");
            navigate("settings");
          }}
        />
      )}

      {creating && (
        <CreateAgentDialog
          client={client}
          onSubmit={createAgent}
          onCancel={() => setCreating(false)}
        />
      )}
      {palette && (
        <CommandPalette
          items={paletteItems}
          {...(palette.group ? { initialGroup: palette.group } : {})}
          onClose={() => setPalette(null)}
        />
      )}
    </div>
  );
}

function AgentsView({
  agents,
  overview,
  onCreate,
  onOpen,
}: {
  agents: Agent[];
  overview: ReturnType<typeof useOverview>;
  onCreate: () => void;
  onOpen: (id: string) => void;
}) {
  const providers = useMemo(() => [...new Set(agents.map((agent) => agent.provider))], [agents]);
  const [filter, setFilter] = useState<ProviderId | "all">("all");
  const shown = filter === "all" ? agents : agents.filter((agent) => agent.provider === filter);
  return (
    <section className="view on">
      <div className="page">
        <div className="page-inner">
          <div className="page-top">
            <div>
              <h1>Bots</h1>
              <p>
                Cada bot tem uma função, as ferramentas que pode usar e o quanto pode agir sem
                perguntar.
              </p>
            </div>
            <button type="button" className="btn btn-primary" onClick={onCreate}>
              Criar bot
            </button>
          </div>
          <fieldset className="filters">
            <legend className="sr">Filtrar bots</legend>
            <button
              type="button"
              className="chip"
              aria-pressed={filter === "all"}
              onClick={() => setFilter("all")}
            >
              Todos
            </button>
            {providers.map((provider) => (
              <button
                key={provider}
                type="button"
                className="chip"
                aria-pressed={filter === provider}
                onClick={() => setFilter(provider)}
              >
                {statusProvider(provider)}
              </button>
            ))}
          </fieldset>
          <div className="grid" id="agentGrid">
            {shown.map((agent) => {
              const info = overview[agent.id];
              const appTags = info?.apps.flatMap((app) => app.tools.map((tool) => tool.name)) ?? [];
              const tools = [
                statusProvider(agent.provider),
                ...appTags,
                ...(info?.emailAccounts.length ? ["E-mail"] : []),
              ];
              return (
                <article className="a-card" key={agent.id}>
                  <div className="top">
                    <MonoAv agent={agent} status={info?.status ?? "idle"} lg />
                    <Pill st={info?.status ?? "idle"} />
                  </div>
                  <div>
                    <h3>{agent.name}</h3>
                    <p style={{ marginTop: 4 }}>{role(agent)}</p>
                  </div>
                  <div className="tags">
                    {tools.map((tool) => (
                      <span className="tag" key={tool}>
                        {tool}
                      </span>
                    ))}
                  </div>
                  <div className="foot">
                    <span className="meta">
                      {isAskMode(agent) ? "Só sugere" : "Age e pede aprovação"}
                    </span>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => onOpen(agent.id)}
                    >
                      Abrir conversa
                    </button>
                  </div>
                </article>
              );
            })}
            <button type="button" className="a-card new" onClick={onCreate}>
              <Icon name="plus" />
              <h3>Novo bot</h3>
              <span style={{ fontSize: 13 }}>Defina função, ferramentas e autonomia</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function TasksView({
  agents,
  overview,
  onOpen,
}: {
  agents: Agent[];
  overview: ReturnType<typeof useOverview>;
  onOpen: (id: string) => void;
}) {
  const tasks = agents
    .filter((agent) => overview[agent.id]?.task)
    .sort(
      (a, b) =>
        TASK_ORDER[overview[a.id]?.status ?? "idle"] - TASK_ORDER[overview[b.id]?.status ?? "idle"],
    );
  return (
    <section className="view on">
      <div className="page">
        <div className="page-inner">
          <div className="page-top">
            <div>
              <h1>Tarefas</h1>
              <p>
                Tudo o que seus bots estão fazendo, em um só lugar. O que espera por você vem
                primeiro.
              </p>
            </div>
          </div>
          <table className="ds-table" data-od-id="task-table">
            <thead>
              <tr>
                <th>Tarefa</th>
                <th>Bot</th>
                <th>Status</th>
                <th className="hide-sm">Atualizado</th>
              </tr>
            </thead>
            <tbody>
              {tasks.length === 0 ? (
                <tr>
                  <td colSpan={4} className="meta">
                    Nenhuma tarefa ainda.
                  </td>
                </tr>
              ) : (
                tasks.map((agent) => {
                  const info = overview[agent.id];
                  return (
                    <tr
                      key={agent.id}
                      tabIndex={0}
                      onClick={() => onOpen(agent.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") onOpen(agent.id);
                      }}
                    >
                      <td>{info?.task}</td>
                      <td className="agent">
                        <MonoAv agent={agent} dot={false} />
                        {agent.name}
                      </td>
                      <td>
                        <Pill st={info?.status ?? "idle"} />
                      </td>
                      <td className="meta hide-sm">{info?.updated ?? "—"}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function SettingsView({
  client,
  agents,
  selected,
  onSelect,
}: {
  client: DaemonClient;
  agents: Agent[];
  selected: ToolTab | "general";
  onSelect: (tab: ToolTab | "general") => void;
}) {
  const [theme, setTheme] = useThemePref();
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const dark = theme === "auto" ? systemDark : theme === "dark";
  return (
    <section className="view on">
      <div className="page">
        <div className="page-inner settings">
          <div className="page-top">
            <div>
              <h1>Configurações</h1>
              <p>Preferências desta conta, aplicadas em todos os seus bots.</p>
            </div>
          </div>
          <div className="filters" role="tablist" aria-label="Configurações">
            <button
              type="button"
              className="chip"
              role="tab"
              aria-selected={selected === "general"}
              onClick={() => onSelect("general")}
            >
              Geral
            </button>
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className="chip"
                role="tab"
                aria-selected={selected === tab.id}
                title={tab.hint}
                onClick={() => onSelect(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {selected === "general" ? (
            <>
              <NotificationSettings />
              <div className="set-group" data-od-id="settings-appearance">
                <div>
                  <h2 style={{ fontSize: "var(--fs-h3)" }}>Tema</h2>
                  <p>Escolha um tema fixo ou deixe o UpBot seguir o seu sistema.</p>
                </div>
                <div>
                  <fieldset className="theme-opts">
                    <legend className="sr">Tema da interface</legend>
                    <ThemeOption value="light" current={theme} onChange={setTheme}>
                      <span className="tp light">
                        <span className="tp-rail" />
                        <span className="tp-main">
                          <i style={{ width: "62%" }} />
                          <i style={{ width: "88%" }} />
                          <i style={{ width: "46%" }} />
                          <span className="tp-dots">
                            <b className="r" />
                            <b className="w" />
                            <b className="o" />
                          </span>
                        </span>
                      </span>
                      <span className="lbl">
                        <span>
                          Claro<small>Fundo branco</small>
                        </span>
                        <span className="tick">
                          <Icon name="ok" />
                        </span>
                      </span>
                    </ThemeOption>
                    <ThemeOption value="dark" current={theme} onChange={setTheme}>
                      <span className="tp dark">
                        <span className="tp-rail" />
                        <span className="tp-main">
                          <i style={{ width: "62%" }} />
                          <i style={{ width: "88%" }} />
                          <i style={{ width: "46%" }} />
                          <span className="tp-dots">
                            <b className="r" />
                            <b className="w" />
                            <b className="o" />
                          </span>
                        </span>
                      </span>
                      <span className="lbl">
                        <span>
                          Escuro<small>Fundo grafite</small>
                        </span>
                        <span className="tick">
                          <Icon name="ok" />
                        </span>
                      </span>
                    </ThemeOption>
                    <ThemeOption value="auto" current={theme} onChange={setTheme}>
                      <span className="tp auto">
                        <span className="tp light">
                          <span className="tp-rail" />
                          <span className="tp-main">
                            <i style={{ width: "80%" }} />
                            <i style={{ width: "100%" }} />
                            <i style={{ width: "60%" }} />
                            <span className="tp-dots">
                              <b className="r" />
                              <b className="w" />
                            </span>
                          </span>
                        </span>
                        <span className="tp dark">
                          <span className="tp-main">
                            <i style={{ width: "70%" }} />
                            <i style={{ width: "100%" }} />
                            <i style={{ width: "50%" }} />
                            <span className="tp-dots">
                              <b className="w" />
                              <b className="o" />
                            </span>
                          </span>
                        </span>
                      </span>
                      <span className="lbl">
                        <span>
                          Automático<small>Segue o sistema</small>
                        </span>
                        <span className="tick">
                          <Icon name="ok" />
                        </span>
                      </span>
                    </ThemeOption>
                  </fieldset>
                  <p className="theme-note" aria-live="polite">
                    {theme === "auto" ? (
                      <>
                        Seu sistema está no tema <b>{dark ? "escuro" : "claro"}</b>. O UpBot troca
                        junto quando ele mudar.
                      </>
                    ) : (
                      <>
                        Tema <b>{theme === "dark" ? "escuro" : "claro"}</b> fixo, independente do
                        sistema.
                      </>
                    )}
                  </p>
                </div>
              </div>
              <div className="set-group" data-od-id="settings-status-preview">
                <div>
                  <h2 style={{ fontSize: "var(--fs-h3)" }}>Cores de status</h2>
                  <p>
                    Os mesmos quatro estados nos dois temas. No escuro, o tom fica mais claro e
                    saturado.
                  </p>
                </div>
                <div className="st-demo">
                  {(["run", "wait", "ok", "err"] as const).map((st) => (
                    <div key={st}>
                      <Pill st={st} />
                      <span className="meta">{STATUS_NOTES[st]}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <ToolBody client={client} agents={agents} tab={selected} />
          )}
        </div>
      </div>
    </section>
  );
}

function ThemeOption({
  value,
  current,
  onChange,
  children,
}: {
  value: ThemePreference;
  current: ThemePreference;
  onChange: (value: ThemePreference) => void;
  children: ReactNode;
}) {
  return (
    <label className="theme-opt">
      <input
        type="radio"
        name="theme"
        value={value}
        checked={current === value}
        onChange={() => onChange(value)}
      />
      {children}
    </label>
  );
}

function CreateAgentDialog({
  client,
  onSubmit,
  onCancel,
}: {
  client: DaemonClient;
  onSubmit: (form: {
    name: string;
    provider: ProviderId;
    instructions: string;
    autonomy: Autonomy;
    avatar: AgentAvatar | null;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<ProviderId>("claude");
  const [instructions, setInstructions] = useState("");
  const [avatar, setAvatar] = useState<AgentAvatar | null>(null);
  const [autonomy, setAutonomy] = useState<Autonomy>("ask");
  const [nameError, setNameError] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  const suggest = async () => {
    setDraftError(null);
    setDrafting(true);
    try {
      const proposal = await client.request("agents.draft", { prompt: instructions.trim() });
      setName(proposal.name);
      setInstructions(proposal.instructions);
      setAvatar(proposal.avatar);
    } catch (e) {
      setDraftError(e instanceof Error ? e.message : String(e));
    } finally {
      setDrafting(false);
    }
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="dlgTitle"
      data-od-id="new-agent-dialog"
      onClose={onCancel}
    >
      <form
        noValidate
        onSubmit={async (event) => {
          event.preventDefault();
          const trimmedName = name.trim();
          if (!trimmedName) {
            setNameError(true);
            return;
          }
          setNameError(false);
          setSubmitError(null);
          setBusy(true);
          try {
            await onSubmit({
              name: trimmedName,
              provider,
              instructions: instructions.trim(),
              autonomy,
              avatar,
            });
          } catch (e) {
            setSubmitError(e instanceof Error ? e.message : String(e));
            setBusy(false);
          }
        }}
      >
        <div className="dlg-head">
          <h2 id="dlgTitle">Criar bot</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="Fechar"
            onClick={() => dialogRef.current?.close()}
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="dlg-body">
          <div className="field">
            <label htmlFor="fName">Nome</label>
            <input
              className="input"
              id="fName"
              placeholder="Ex.: Viagens"
              value={name}
              maxLength={80}
              aria-invalid={nameError}
              aria-describedby={nameError ? "fNameErr" : undefined}
              onChange={(event) => {
                setName(event.target.value);
                if (event.target.value.trim()) setNameError(false);
              }}
            />
            {nameError && (
              <span className="err" id="fNameErr">
                Dê um nome ao bot.
              </span>
            )}
          </div>
          <div className="field">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="fRole">O que ele faz</label>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={!instructions.trim() || drafting}
                onClick={() => void suggest()}
              >
                {drafting ? "Sugerindo…" : "Sugerir nome e instruções"}
              </button>
            </div>
            <input
              className="input"
              id="fRole"
              placeholder="Ex.: Reserva voos e hotéis dentro da política"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
            {draftError && <span className="err">{draftError}</span>}
          </div>
          <fieldset className="field">
            <legend>Provedor</legend>
            <div className="checks">
              {PROVIDERS.map((providerId) => (
                <label key={providerId}>
                  <input
                    type="radio"
                    name="provider"
                    value={providerId}
                    checked={provider === providerId}
                    onChange={() => setProvider(providerId)}
                  />
                  {statusProvider(providerId)}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="field">
            <legend>Autonomia</legend>
            <label className="opt">
              <input
                type="radio"
                name="auto"
                value="ask"
                checked={autonomy === "ask"}
                onChange={() => setAutonomy("ask")}
              />
              <span>
                Sempre perguntar
                <small>Mostra o plano e espera sua aprovação antes de cada ação.</small>
              </span>
            </label>
            <label className="opt">
              <input
                type="radio"
                name="auto"
                value="sensitive"
                checked={autonomy === "sensitive"}
                onChange={() => setAutonomy("sensitive")}
              />
              <span>
                Perguntar em ações sensíveis
                <small>Age sozinho, mas pede aprovação para pagar, enviar ou apagar.</small>
              </span>
            </label>
            <label className="opt">
              <input
                type="radio"
                name="auto"
                value="auto"
                checked={autonomy === "auto"}
                onChange={() => setAutonomy("auto")}
              />
              <span>
                Autônomo
                <small>
                  Executa do início ao fim e envia um resumo. Pagamentos, envios e exclusões ainda
                  pedem aprovação.
                </small>
              </span>
            </label>
          </fieldset>
          {submitError && <p className="err">{submitError}</p>}
        </div>
        <div className="dlg-foot">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => dialogRef.current?.close()}
          >
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Criar e abrir
          </button>
        </div>
      </form>
    </dialog>
  );
}
