import { listen } from "@tauri-apps/api/event";
import type {
  Agent,
  AgentAvatar,
  AgentStatusInfo,
  ApprovalRule,
  Channel,
  ProviderId,
} from "@upbot/protocol";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentConfigScreen } from "./components/AgentConfigScreen";
import agentConfigStyles from "./components/AgentConfigScreen.module.css";
import { PROVIDERS } from "./components/AgentSettings";
import { ChannelCreateForm, ChannelView } from "./components/ChannelView";
import { ChatView } from "./components/ChatView";
import { CommandPalette, type PaletteItem } from "./components/CommandPalette";
import { IconButton } from "./components/ds/controls";
import { Icon } from "./components/icons";
import { NotificationSettings } from "./components/NotificationSettings";
import { PagesView } from "./components/PagesView";
import { RunPanel } from "./components/RunPanel";
import { ScheduledView } from "./components/ScheduledView";
import { Sidebar } from "./components/Sidebar";
import { TABS, ToolBody, type ToolTab } from "./components/ToolsView";
import { UpdateButton } from "./components/UpdateButton";
import { ChatProvider } from "./hooks/useChat";
import { useLayerFocus, useMediaQuery } from "./hooks/useLayerFocus";
import { useOverview } from "./hooks/useOverview";
import { DaemonClient } from "./lib/daemon";
import { errorMessage } from "./lib/errors";
import { moveControlFocus } from "./lib/keyboard";
import { nativeCommand } from "./lib/native";
import { useNativeNotifications } from "./lib/native-notifications";
import { mod } from "./lib/platform";
import { useThemePref } from "./lib/theme";
import { MonoAv, Pill, role, type UiStatus } from "./lib/ui";

type View =
  | "home"
  | "scheduled"
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

export default function App() {
  const [client] = useState(() => new DaemonClient());
  const [agents, setAgents] = useState<Agent[]>([]);
  const [statuses, setStatuses] = useState<Record<string, AgentStatusInfo>>({});
  const [selectedId, setSelectedId] = useState<string | null>(() => readStorage("upbot.agent"));
  const [agentNameDraft, setAgentNameDraft] = useState<{
    agentId: string;
    name: string;
  } | null>(null);
  const updateAgentNameDraft = useCallback(
    (agentId: string, name: string | null) =>
      setAgentNameDraft(name === null ? null : { agentId, name }),
    [],
  );
  const [deletedAgentSnapshot, setDeletedAgentSnapshot] = useState<Agent | null>(null);
  const [agentUndoToast, setAgentUndoToast] = useState<{
    text: string;
    undo?: () => void;
  } | null>(null);
  const agentUndoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [view, setView] = useState<View>(readView);
  const [creating, setCreating] = useState(false);
  const [settingsTab, setSettingsTab] = useState<ToolTab | "general">("general");
  const [profileName, setProfileName] = useState(() => readStorage("upbot.profile.name") ?? "");
  const [palette, setPalette] = useState<{ group?: string } | null>(null);
  const [paletteItems, setPaletteItems] = useState<PaletteItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [clientReady, setClientReady] = useState(false);
  const [noPanel, setNoPanel] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const sideRef = useRef<HTMLElement>(null);
  const narrow = useMediaQuery("(max-width: 759px)");
  useLayerFocus(sideRef, sideOpen && narrow);
  useEffect(() => {
    if (!narrow) setSideOpen(false);
  }, [narrow]);

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
        if (alive) setError(errorMessage(e));
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
  const settingsAgent = selected ?? deletedAgentSnapshot;
  const selectedOverview = selected ? overview[selected.id] : undefined;
  const selectedChannel = channels.find((channel) => channel.id === channelId) ?? null;

  const navigate = useCallback((next: View) => {
    setView(next);
    setSideOpen(false);
    if (RAIL_VIEWS.includes(next as RailView)) writeStorage("upbot.view", next);
    setCreating(false);
  }, []);

  const showAgentUndoToast = useCallback((text: string, undo?: () => void) => {
    if (agentUndoTimer.current) clearTimeout(agentUndoTimer.current);
    setAgentUndoToast({ text, ...(undo ? { undo } : {}) });
    agentUndoTimer.current = setTimeout(() => setAgentUndoToast(null), 5000);
  }, []);

  const restoreDeletedAgent = useCallback(
    async (agentId: string) => {
      if (agentUndoTimer.current) clearTimeout(agentUndoTimer.current);
      setAgentUndoToast(null);
      try {
        const restored = await client.request("agents.restore", { id: agentId });
        setDeletedAgentSnapshot(null);
        setAgents((current) =>
          current.some((item) => item.id === restored.id)
            ? current.map((item) => (item.id === restored.id ? restored : item))
            : [...current, restored],
        );
        setSelectedId(restored.id);
        writeStorage("upbot.agent", restored.id);
        navigate("agent-settings");
      } catch (e) {
        showAgentUndoToast(
          `Não deu para desfazer: ${errorMessage(e)}`,
          () => void restoreDeletedAgent(agentId),
        );
      }
    },
    [client, navigate, showAgentUndoToast],
  );

  useEffect(
    () => () => {
      if (agentUndoTimer.current) clearTimeout(agentUndoTimer.current);
    },
    [],
  );

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
    (target: string, message?: string) => {
      if (message) setNotice(message);
      if (target === "apps" || target === "approvals") {
        setSettingsTab(target);
        navigate("settings");
      } else openAgent(target);
    },
    [navigate, openAgent],
  );
  useNativeNotifications(client, clientReady, agents, reviewNotification, setError);

  useEffect(() => {
    if (!clientReady || !("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<string>("upbot://navigate", ({ payload }) => {
      const tab = TABS.find((item) => item.id === payload);
      if (tab) {
        setSettingsTab(tab.id);
        navigate("settings");
      } else if (RAIL_VIEWS.includes(payload as RailView) || payload === "pages") {
        navigate(payload as View);
      } else if (typeof payload === "string" && payload) {
        openAgent(payload);
      }
    })
      .then((off) => {
        if (disposed) off();
        else {
          unlisten = off;
          return nativeCommand("main_ready");
        }
      })
      .catch((e: unknown) => setError(errorMessage(e)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [clientReady, navigate, openAgent]);

  useEffect(() => {
    if (!clientReady || !agents.length) return;
    if (view === "agent-settings" && deletedAgentSnapshot) return;
    if (!selectedId || !agents.some((agent) => agent.id === selectedId)) {
      const first = agents[0];
      if (first) {
        setSelectedId(first.id);
        writeStorage("upbot.agent", first.id);
      }
    }
  }, [agents, clientReady, deletedAgentSnapshot, selectedId, view]);

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
      {
        id: "pages",
        group: "Navegação",
        label: "Páginas",
        hint: `${mod}P`,
        run: () => navigate("pages"),
      },
      { id: "bots", group: "Navegação", label: "Todos os bots", run: () => navigate("agents") },
      { id: "tasks", group: "Navegação", label: "Tarefas", run: () => navigate("tasks") },
      {
        id: "general",
        group: "Configurações",
        label: "Geral",
        run: () => {
          setSettingsTab("general");
          navigate("settings");
        },
      },
      ...agents.map((agent) => ({
        id: `agent:${agent.id}`,
        group: "Bots",
        label: agent.name,
        hint: statusProvider(agent.provider),
        searchTerms: [role(agent), agent.instructions, overview[agent.id]?.task ?? ""],
        matchHint: overview[agent.id]?.task ?? "",
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
    let active = true;
    void client
      .request("pages.list", {})
      .then((pages) => {
        if (!active) return;
        setPaletteItems([
          ...base,
          ...pages.map((page) => ({
            id: `page:${page.id}`,
            group: "Páginas",
            label: page.title,
            hint: page.description,
            run: () => navigate("pages"),
          })),
        ]);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [agents, channels, client, navigate, openAgent, overview, palette]);

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
            `Bot criado, mas não foi possível salvar a regra de autonomia: ${errorMessage(e)}`,
          );
        }
      }
    },
    [client, navigate],
  );

  const togglePanel = () => {
    if (window.matchMedia("(max-width: 1180px)").matches) setPanelOpen((open) => !open);
    else setNoPanel((hidden) => !hidden);
  };

  const appView =
    view === "home" ||
    view === "scheduled" ||
    view === "channel" ||
    view === "pages" ||
    view === "agent-settings" ||
    view === "channel-new"
      ? "settings"
      : view;
  const appClass = [
    "app",
    `view-${appView}`,
    view === "agent-settings" ? "agent-config-shell" : "",
    noPanel && view === "chat" ? "no-panel" : "",
    panelOpen && view === "chat" ? "panel-open" : "",
    sideOpen ? "side-open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={appClass}>
      <Sidebar
        client={client}
        ready={clientReady}
        agents={agents}
        channels={channels}
        overview={overview}
        statuses={statuses}
        selectedId={selectedId}
        agentNameOverride={agentNameDraft}
        channelId={channelId}
        current={view === "settings" && settingsTab === "apps" ? "apps" : view}
        profileName={profileName}
        drawer={sideOpen && narrow}
        sideRef={sideRef}
        onClose={() => setSideOpen(false)}
        onNew={() => {
          navigate("chat");
          setSelectedId(null);
          setCreating(true);
        }}
        onSearch={() => setPalette({})}
        onHome={() => navigate("home")}
        onScheduled={() => navigate("scheduled")}
        onApps={() => {
          setSettingsTab("apps");
          navigate("settings");
        }}
        onSettings={() => {
          setSettingsTab("general");
          navigate("settings");
        }}
        onAgent={openAgent}
        onChannel={(id) => {
          setChannelId(id);
          navigate("channel");
        }}
      />

      {sideOpen && (
        <button
          type="button"
          className="side-scrim"
          tabIndex={-1}
          aria-label="Fechar painel de bots"
          onClick={() => setSideOpen(false)}
        />
      )}

      <ChatProvider
        client={client}
        agentId={clientReady && view === "chat" ? (selected?.id ?? null) : null}
      >
        <main className="main">
          {notice && view !== "chat" && (
            <div className="notice" role="status">
              {notice}
              <button type="button" aria-label="Dispensar aviso" onClick={() => setNotice(null)}>
                ×
              </button>
            </div>
          )}
          <IconButton
            aria-label="Abrir barra lateral"
            aria-expanded={sideOpen && narrow}
            aria-controls="bot-drawer"
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
          ) : view === "scheduled" ? (
            <ScheduledView client={client} agents={agents} onOpen={openAgent} />
          ) : view === "home" ? (
            <section className="view on">
              <div className="empty">
                <h2>Escolha um bot ou crie um novo.</h2>
                <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
                  Criar bot
                </button>
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
                notice={notice}
                onNoticeDismiss={() => setNotice(null)}
                onPanelToggle={togglePanel}
              />
            ) : (
              <section className="view on">
                <div className="empty">
                  <h2>Escolha um bot ou crie um novo.</h2>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => setCreating(true)}
                  >
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
              profileName={profileName}
              onProfileName={(name) => {
                setProfileName(name);
                writeStorage("upbot.profile.name", name);
              }}
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
          ) : view === "agent-settings" && settingsAgent ? (
            <section className="view on">
              <AgentConfigScreen
                key={settingsAgent.id}
                agent={settingsAgent}
                client={client}
                deleted={!selected}
                onBack={() => navigate("chat")}
                onHome={() => {
                  setDeletedAgentSnapshot(null);
                  setSelectedId(null);
                  navigate("home");
                }}
                onName={updateAgentNameDraft}
                onDeleted={(deletedAgent, committed) => {
                  setDeletedAgentSnapshot(deletedAgent);
                  if (committed) {
                    setSelectedId(null);
                    setAgents((current) => current.filter((item) => item.id !== deletedAgent.id));
                    showAgentUndoToast(
                      "Agente excluído.",
                      () => void restoreDeletedAgent(deletedAgent.id),
                    );
                  }
                }}
                onOpenApps={() => {
                  setSettingsTab("apps");
                  navigate("settings");
                }}
              />
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
            overlayOpen={panelOpen && !sideOpen}
            onClose={togglePanel}
            onOpenApps={() => {
              setSettingsTab("apps");
              navigate("settings");
            }}
          />
        )}
      </ChatProvider>

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
      {agentUndoToast && (
        <div role="status" className={agentConfigStyles.toast}>
          {agentUndoToast.text}
          {agentUndoToast.undo && (
            <button type="button" onClick={agentUndoToast.undo}>
              Desfazer
            </button>
          )}
        </div>
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
  profileName,
  onProfileName,
}: {
  client: DaemonClient;
  agents: Agent[];
  selected: ToolTab | "general";
  onSelect: (tab: ToolTab | "general") => void;
  profileName: string;
  onProfileName: (name: string) => void;
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
          <div
            className="filters"
            role="tablist"
            aria-label="Configurações"
            onKeyDown={moveControlFocus}
          >
            <button
              type="button"
              className="chip"
              role="tab"
              aria-selected={selected === "general"}
              tabIndex={selected === "general" ? 0 : -1}
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
                tabIndex={selected === tab.id ? 0 : -1}
                title={tab.hint}
                onClick={() => onSelect(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {selected === "general" ? (
            <>
              <div className="set-group">
                <div>
                  <h2 style={{ fontSize: "var(--fs-h3)" }}>Perfil</h2>
                  <p>Nome exibido neste dispositivo.</p>
                </div>
                <label>
                  Seu nome
                  <input
                    className="field"
                    value={profileName}
                    maxLength={80}
                    placeholder="Seu nome"
                    onChange={(event) => onProfileName(event.target.value)}
                  />
                </label>
              </div>
              <NotificationSettings />
              <UpdateButton />
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
      setDraftError(errorMessage(e));
    } finally {
      setDrafting(false);
    }
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement as HTMLElement | null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => previous?.focus();
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
            setSubmitError(errorMessage(e));
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
