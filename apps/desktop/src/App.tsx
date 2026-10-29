import { listen } from "@tauri-apps/api/event";
import type { Agent, ApprovalRule } from "@upbot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentConfigScreen } from "./components/AgentConfigScreen";
import agentConfigStyles from "./components/AgentConfigScreen.module.css";
import { AgentsView } from "./components/AgentsView";
import { ChannelCreateForm, ChannelView } from "./components/ChannelView";
import { ChatView } from "./components/ChatView";
import { CommandPalette, type PaletteItem } from "./components/CommandPalette";
import { CreateAgentDialog, type NewAgentForm } from "./components/CreateAgentDialog";
import { IconButton } from "./components/ds/controls";
import { Icon } from "./components/icons";
import { PagesView } from "./components/PagesView";
import { RunPanel } from "./components/RunPanel";
import { ScheduledView } from "./components/ScheduledView";
import { SettingsView } from "./components/SettingsView";
import { Sidebar } from "./components/Sidebar";
import { TasksView } from "./components/TasksView";
import { TABS, type ToolTab } from "./components/ToolsView";
import { ChatProvider } from "./hooks/useChat";
import { useDaemonState } from "./hooks/useDaemonState";
import { useLayerFocus, useMediaQuery } from "./hooks/useLayerFocus";
import { useOverview } from "./hooks/useOverview";
import { DaemonClient } from "./lib/daemon";
import { errorMessage } from "./lib/errors";
import { nativeCommand } from "./lib/native";
import { useNativeNotifications } from "./lib/native-notifications";
import { mod } from "./lib/platform";
import { role, statusProvider } from "./lib/ui";

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
const RAIL_VIEWS: RailView[] = ["chat", "agents", "tasks", "settings"];

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

export default function App() {
  const [client] = useState(() => new DaemonClient());
  const {
    agents,
    setAgents,
    statuses,
    channels,
    ready: clientReady,
    error,
    setError,
    refresh,
  } = useDaemonState(client);
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
  const [channelId, setChannelId] = useState<string | null>(null);
  const [view, setView] = useState<View>(readView);
  const [creating, setCreating] = useState(false);
  const [settingsTab, setSettingsTab] = useState<ToolTab | "general">("general");
  const [profileName, setProfileName] = useState(() => readStorage("upbot.profile.name") ?? "");
  const [palette, setPalette] = useState<{ group?: string } | null>(null);
  const [paletteItems, setPaletteItems] = useState<PaletteItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [noPanel, setNoPanel] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const sideRef = useRef<HTMLElement>(null);
  const narrow = useMediaQuery("(max-width: 759px)");
  useLayerFocus(sideRef, sideOpen && narrow);
  useEffect(() => {
    if (!narrow) setSideOpen(false);
  }, [narrow]);

  useEffect(() => {
    const offs = [
      client.on("agent.deleted", ({ id }) => {
        setSelectedId((selected) => (selected === id ? null : selected));
      }),
      client.onReconnect(() => {
        void refresh().catch(() => {});
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [client, refresh]);

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
          `Não deu para desfazer: ${e instanceof Error ? e.message : String(e)}`,
          () => void restoreDeletedAgent(agentId),
        );
      }
    },
    [client, navigate, setAgents, showAgentUndoToast],
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
  }, [clientReady, navigate, openAgent, setError]);

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
    async (form: NewAgentForm) => {
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
    [client, navigate, setAgents],
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
