import type {
  Agent,
  AgentAvatar,
  AgentIconId,
  ConfigOption,
  ConnectedApp,
  EmailAccount,
  ProviderId,
  Routine,
} from "@upbot/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useLayerFocus } from "../hooks/useLayerFocus";
import {
  type AgentConfig,
  abbreviatePath,
  configFromServer,
  type DraftRoutine,
  deepEqual,
  formatCustomSchedule,
  isValidTime,
  planMutations,
  rebase,
  routineWhenText,
  toRoutineSchedule,
} from "../lib/agent-config";
import type { DaemonClient } from "../lib/daemon";
import { errorMessage } from "../lib/errors";
import { isWindows, mod } from "../lib/platform";
import s from "./AgentConfigScreen.module.css";
import { PermissionNotice } from "./AgentSettings";
import { Button, Field, SegmentedControl, Switch } from "./ds/controls";
import {
  CalIcon,
  ChartIcon,
  ChevIcon,
  ClockIcon,
  CopyIcon,
  CursorIcon,
  EyeIcon,
  HandIcon,
  HookIcon,
  MailIcon,
  PlaneIcon,
  PlusIcon,
  ReceiptIcon,
  SheetIcon,
  UpbotSimboloCurrentcolorIcon,
} from "./ds/icons";

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
const PROVIDER_NAME: Record<ProviderId, string> = {
  devin: "Devin",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
  gemini: "Gemini",
  claude: "Claude",
  codex: "Codex",
  "openai-compatible": "Compatível com OpenAI",
};
const ICONS: AgentIconId[] = ["sym", "mail", "receipt", "plane", "chart", "cal", "sheet"];
const EMPTY: AgentConfig = {
  name: "",
  icon: { icon: "sym" },
  provider: "devin",
  model: null,
  effort: null,
  options: {},
  computerUse: false,
  instructions: "",
  memories: [],
  routines: [],
};

function Mark({ icon, size = 24 }: { icon: AgentIconId; size?: number }) {
  const props = { width: size, height: size };
  return icon === "sym" ? (
    <UpbotSimboloCurrentcolorIcon {...props} />
  ) : icon === "mail" ? (
    <MailIcon {...props} />
  ) : icon === "receipt" ? (
    <ReceiptIcon {...props} />
  ) : icon === "plane" ? (
    <PlaneIcon {...props} />
  ) : icon === "chart" ? (
    <ChartIcon {...props} />
  ) : icon === "cal" ? (
    <CalIcon {...props} />
  ) : (
    <SheetIcon {...props} />
  );
}

function asIcon(icon: AgentConfig["icon"]): AgentIconId | null {
  return "icon" in icon ? icon.icon : null;
}

function LayerDialog({
  title,
  children,
  onClose,
  initialFocus,
  testId,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  initialFocus?: string;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayerFocus(ref, true);
  useEffect(() => {
    const target = initialFocus ? ref.current?.querySelector<HTMLElement>(initialFocus) : null;
    target?.focus();
  }, [initialFocus]);
  useEffect(() => {
    const scrim = ref.current?.parentElement;
    const closeOutside = (event: PointerEvent) => {
      if (event.target === scrim) onClose();
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [onClose]);
  return (
    <div className={s.scrim}>
      <div
        ref={ref}
        className={s.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-od-id={testId}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function AgentConfigScreen({
  agent,
  client,
  onBack,
  onHome,
  onName,
  onDeleted,
  onOpenApps,
  deleted = false,
}: {
  agent: Agent;
  client: DaemonClient;
  onBack: () => void;
  onHome: () => void;
  onName: (id: string, name: string | null) => void;
  onDeleted: (agent: Agent, committed?: boolean) => void;
  onOpenApps: () => void;
  deleted?: boolean;
}) {
  const [saved, setSaved] = useState<AgentConfig>(EMPTY);
  const [draft, setDraft] = useState<AgentConfig>(EMPTY);
  const [options, setOptions] = useState<ConfigOption[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [optionsError, setOptionsError] = useState("");
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [computer, setComputer] = useState({ available: false, agentIds: [] as string[] });
  const [apps, setApps] = useState<ConnectedApp[]>([]);
  const [emailAccounts, setEmailAccounts] = useState<EmailAccount[]>([]);
  const [memoryText, setMemoryText] = useState("");
  const [popover, setPopover] = useState(false);
  const [dialog, setDialog] = useState<"routine" | "computer" | "delete" | null>(null);
  const [routineDraft, setRoutineDraft] = useState<DraftRoutine | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const savedRef = useRef(saved);
  const draftRef = useRef(draft);
  const reloadSequence = useRef(0);
  const appliedReload = useRef(0);
  const [error, setError] = useState("");
  const currentIcon = asIcon(draft.icon);
  const agentId = agent.id;
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const avatarButton = useRef<HTMLButtonElement>(null);
  const iconPopover = useRef<HTMLFieldSetElement>(null);
  useLayerFocus(iconPopover, popover);
  const dirty = !deepEqual(saved, draft);
  const agentName = saved.name || agent.name;
  const routineToUndo = useRef<{ routine: DraftRoutine; index: number } | null>(null);
  const abort = useRef<ReturnType<typeof setTimeout> | null>(null);
  const change = (patch: Partial<AgentConfig>) => setDraft((current) => ({ ...current, ...patch }));
  const showToast = useCallback((text: string, undo?: () => void) => {
    if (abort.current) clearTimeout(abort.current);
    setToast({ text, ...(undo ? { undo } : {}) });
    abort.current = setTimeout(() => setToast(null), 5000);
  }, []);

  const reload = useCallback(
    async (external = false) => {
      const sequence = ++reloadSequence.current;
      const [memories, nextRoutines, access, nextAgent] = await Promise.all([
        client.request("memories.list", { agentId }),
        client.request("routines.list", { agentId }),
        client.request("computer.access", {}),
        client
          .request("agents.list", {})
          .then((items) => items.find((item) => item.id === agentId) ?? agentRef.current),
      ]);
      let nextOptions: ConfigOption[] = [];
      let nextOptionsError = "";
      try {
        const config = await client.request("agents.configOptions", { agentId });
        nextOptions = config.configOptions;
      } catch (e) {
        const message = errorMessage(e);
        nextOptionsError = `Não deu para carregar os modelos: ${message === "internal error" ? "erro interno" : message}`;
      }
      const computerUse = access.agentIds.includes(agentId);
      const incoming = configFromServer(nextAgent, memories, nextRoutines, computerUse);
      const modelOption = nextOptions.find(
        (option) => option.id === "model" || option.category === "model",
      );
      const effortOption = nextOptions.find((option) =>
        /effort|reasoning|thought/i.test(`${option.id} ${option.name} ${option.category ?? ""}`),
      );
      incoming.model ??= modelOption?.currentValue || null;
      incoming.effort ??= effortOption?.currentValue || null;
      if (sequence < appliedReload.current) return;
      appliedReload.current = sequence;
      flushSync(() => {
        setRoutines(nextRoutines);
        setComputer(access);
        setOptions(nextOptions);
        setOptionsError(nextOptionsError);
        setOptionsLoading(false);
        if (external) {
          const nextDraft = rebase(savedRef.current, incoming, draftRef.current);
          setSaved(incoming);
          setDraft(nextDraft);
          savedRef.current = incoming;
          draftRef.current = nextDraft;
        } else {
          setSaved(incoming);
          setDraft(incoming);
          savedRef.current = incoming;
          draftRef.current = incoming;
        }
      });
    },
    [agentId, client],
  );

  useEffect(() => {
    let alive = true;
    setOptionsLoading(true);
    setOptionsError("");
    void reload().catch(() => {
      if (alive) {
        setError("Não deu para carregar as configurações.");
        setOptionsLoading(false);
      }
    });
    const refresh = () => void reload(true).catch(() => {});
    const off = [
      client.on("memories.changed", (event) => event.agentId === agentId && refresh()),
      client.on("routine.updated", (event) => event.agentId === agentId && refresh()),
      client.on("routine.deleted", refresh),
      client.on("computer.changed", refresh),
      client.on("agent.config", (event) => event.agentId === agentId && refresh()),
      client.on("agent.updated", (event) => event.id === agentId && refresh()),
      client.onReconnect(refresh),
      client.on("apps.changed", () => {
        void client
          .request("apps.list", {})
          .then(setApps)
          .catch(() => {});
      }),
      client.on("email.accounts.changed", () => {
        void client
          .request("email.accounts.list", {})
          .then(setEmailAccounts)
          .catch(() => {});
      }),
    ];
    return () => {
      alive = false;
      for (const unsubscribe of off) unsubscribe();
      if (abort.current) clearTimeout(abort.current);
      onName(agentId, null);
    };
  }, [agentId, client, onName, reload]);

  useEffect(() => {
    if (!popover) return;
    const selected = iconPopover.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
    (selected ?? iconPopover.current?.querySelector<HTMLElement>("button"))?.focus();
    const outside = (event: PointerEvent) => {
      if (
        !iconPopover.current?.contains(event.target as Node) &&
        !avatarButton.current?.contains(event.target as Node)
      ) {
        setPopover(false);
      }
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [popover]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    onName(agent.id, draft.name);
  }, [agent.id, draft.name, onName]);

  const efforts = options.find((option) =>
    /effort|reasoning|thought/i.test(`${option.id} ${option.name} ${option.category ?? ""}`),
  );
  const models = options.find((option) => option.id === "model" || option.category === "model");
  const connectedNames = useMemo(() => {
    const values = [
      ...apps
        .filter((app) => app.enabled && (!app.agentIds.length || app.agentIds.includes(agent.id)))
        .map((app) => app.name),
      ...emailAccounts
        .filter((account) => !account.agentIds.length || account.agentIds.includes(agent.id))
        .map((account) => account.address),
    ];
    return values;
  }, [apps, emailAccounts, agent.id]);
  useEffect(() => {
    void Promise.all([client.request("apps.list", {}), client.request("email.accounts.list", {})])
      .then(([a, e]) => {
        setApps(a);
        setEmailAccounts(e);
      })
      .catch(() => {});
  }, [client]);
  const appsText = connectedNames.length
    ? `${connectedNames.slice(0, 3).join(", ")}${connectedNames.length > 3 ? ` e mais ${connectedNames.length - 3}` : ""}. Cada app tem as próprias permissões.`
    : "Nenhum app conectado ainda.";

  const save = useCallback(async () => {
    setError("");
    const plan = planMutations(saved, draft);
    const failed = new Set<string>();
    let message = "";
    const section = (type: string) =>
      type.startsWith("memory")
        ? "memories"
        : type.startsWith("routine")
          ? "routines"
          : type === "computer"
            ? "computerUse"
            : type === "setConfig"
              ? "config"
              : "identity";
    for (const mutation of plan) {
      try {
        if (mutation.type === "updateAgent") {
          const patch = {
            ...mutation.patch,
            avatar: mutation.patch.icon as AgentAvatar | undefined,
          };
          delete (patch as Record<string, unknown>).icon;
          await client.request("agents.update", { id: agent.id, ...patch });
        } else if (mutation.type === "setConfig") {
          await client.request("agents.setConfig", {
            agentId: agent.id,
            configId: mutation.configId,
            value: mutation.value,
          });
        } else if (mutation.type === "memoryAdd") {
          await client.request("memories.add", { agentId: agent.id, text: mutation.text });
        } else if (mutation.type === "memoryUpdate") {
          await client.request("memories.update", { id: mutation.id, text: mutation.text });
        } else if (mutation.type === "memoryDelete") {
          await client.request("memories.delete", { id: mutation.id });
        } else if (mutation.type === "routineDelete") {
          await client.request("routines.delete", { id: mutation.id });
        } else if (mutation.type === "routineCreate" || mutation.type === "routineUpdate") {
          const routine = mutation.routine;
          const args = {
            name: routine.name,
            prompt: routine.prompt,
            schedule: toRoutineSchedule(routine),
            webhook: routine.hook,
            enabled: routine.enabled,
          };
          if (mutation.type === "routineCreate")
            await client.request("routines.create", { agentId: agent.id, ...args });
          else await client.request("routines.update", { id: mutation.id, ...args });
        } else if (mutation.type === "computer") {
          const access = await client.request("computer.access", {});
          const ids = new Set(access.agentIds);
          mutation.enabled ? ids.add(agent.id) : ids.delete(agent.id);
          await client.request("computer.setAccess", { agentIds: [...ids] });
        }
      } catch (e) {
        failed.add(section(mutation.type));
        message ||= errorMessage(e);
      }
    }
    try {
      await reload();
      if (failed.size) {
        setDraft((current) => {
          const preserved = { ...current };
          if (failed.has("identity"))
            Object.assign(preserved, {
              name: draft.name,
              icon: draft.icon,
              provider: draft.provider,
              instructions: draft.instructions,
            });
          if (failed.has("config"))
            Object.assign(preserved, {
              model: draft.model,
              effort: draft.effort,
              options: draft.options,
            });
          if (failed.has("memories")) preserved.memories = draft.memories;
          if (failed.has("routines")) preserved.routines = draft.routines;
          if (failed.has("computerUse")) preserved.computerUse = draft.computerUse;
          return preserved;
        });
        showToast(`Não deu para salvar: ${message}`);
      } else {
        showToast("Configurações salvas.");
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [agent.id, client, draft, reload, saved, showToast]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (dirty && draft.name.trim()) void save();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [dirty, draft.name, save]);

  const deleteRoutine = (index: number) => {
    const routine = draft.routines[index];
    if (!routine) return;
    routineToUndo.current = { routine, index };
    change({ routines: draft.routines.filter((_, i) => i !== index) });
    showToast("Rotina removida.", () => {
      const item = routineToUndo.current;
      if (!item) return;
      const next = [...draftRef.current.routines];
      next.splice(item.index, 0, item.routine);
      change({ routines: next });
      routineToUndo.current = null;
    });
  };

  if (deleted) {
    return (
      <div className={s.screen}>
        <header className={s.top} data-agent-config-top="">
          <button
            type="button"
            onClick={onBack}
            aria-label={`Voltar para ${agentName || "Sem nome"}`}
          >
            ‹ <span>{agentName || "Sem nome"}</span>
          </button>
          <span aria-hidden="true">/</span>
          <strong>Configurações</strong>
        </header>
        <section className={s.deleted}>
          <h1>{agentName} foi excluído.</h1>
          <p>As conversas continuam no histórico.</p>
          <Button onClick={onHome}>Voltar ao início</Button>
        </section>
      </div>
    );
  }

  return (
    <div className={s.screen}>
      <header className={s.top} data-agent-config-top="">
        <button
          type="button"
          onClick={onBack}
          aria-label={`Voltar para ${draft.name.trim() || "Sem nome"}`}
        >
          ‹ <span>{draft.name || "Sem nome"}</span>
        </button>
        <span aria-hidden="true">/</span>
        <strong>Configurações</strong>
      </header>
      <div className={s.scroll} data-agent-config-scroll="">
        <main className={s.column}>
          <section className={s.identity}>
            <div className={s.avatarWrap}>
              <button
                type="button"
                ref={avatarButton}
                className={s.avatar}
                aria-label="Trocar ícone do agente"
                aria-expanded={popover}
                aria-controls="agent-icons"
                onClick={() => setPopover(!popover)}
              >
                {currentIcon ? (
                  <Mark icon={currentIcon} size={32} />
                ) : (
                  (draft.icon as { emoji: string }).emoji
                )}
                <span>Trocar</span>
              </button>
              {popover && (
                <fieldset
                  ref={iconPopover}
                  className={s.popover}
                  id="agent-icons"
                  aria-label="Ícone do agente"
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setPopover(false);
                      avatarButton.current?.focus();
                    }
                  }}
                >
                  <p className={s.popoverHint}>Ícone na lateral e nas notificações</p>
                  {ICONS.map((icon) => (
                    <button
                      key={icon}
                      type="button"
                      aria-label={`Ícone ${icon}`}
                      aria-pressed={asIcon(draft.icon) === icon}
                      onClick={() => {
                        change({ icon: { icon } });
                        setPopover(false);
                        avatarButton.current?.focus();
                      }}
                    >
                      <Mark icon={icon} />
                    </button>
                  ))}
                </fieldset>
              )}
            </div>
            <div className={s.identityText}>
              <label className={s.sr} htmlFor="agent-name">
                Nome do agente
              </label>
              <input
                id="agent-name"
                className={s.name}
                maxLength={40}
                value={draft.name}
                onChange={(event) => change({ name: event.target.value })}
              />
              <p>Agente de uso geral · Criado em {createdDate(agent.createdAt)}</p>
            </div>
          </section>
          <section className={s.section}>
            <h2>Instruções</h2>
            <p>O agente lê isto no início de cada tarefa.</p>
            <textarea
              aria-label="Instruções"
              className={s.instructions}
              spellCheck
              value={draft.instructions}
              onChange={(event) => change({ instructions: event.target.value })}
            />
            <div className={s.counter}>
              <span>Escreva como falaria com alguém de confiança.</span>
              <span>{draft.instructions.length.toLocaleString("pt-BR")} caracteres</span>
            </div>
          </section>
          <section className={s.section}>
            <h2>Modelo</h2>
            <div className={s.box}>
              <label className={s.row}>
                <span>Modelo</span>
                <select
                  value={draft.provider === saved.provider ? (draft.model ?? "") : draft.provider}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (PROVIDERS.includes(value as ProviderId))
                      change({
                        provider: value as ProviderId,
                        model: null,
                        effort: null,
                        options: {},
                      });
                    else change({ model: value || null });
                  }}
                >
                  {PROVIDERS.map((provider) => (
                    <optgroup key={provider} label={PROVIDER_NAME[provider]}>
                      {provider === draft.provider &&
                      draft.provider === saved.provider &&
                      models ? (
                        <>
                          <option value="">Modelo padrão</option>
                          {models.options.map((option) => (
                            <option value={option.value} key={option.value}>
                              {option.name}
                            </option>
                          ))}
                        </>
                      ) : provider === draft.provider && optionsLoading ? (
                        <option disabled value={draft.model ?? ""}>
                          Carregando modelos…
                        </option>
                      ) : (
                        <option value={provider === draft.provider ? "" : provider}>
                          Modelo padrão
                        </option>
                      )}
                    </optgroup>
                  ))}
                </select>
              </label>
              {optionsError && (
                <div className={`${s.row} ${s.modelErrorRow}`} role="status">
                  <span />
                  <p>{optionsError}</p>
                </div>
              )}
              {draft.provider === saved.provider &&
                efforts &&
                ["low", "medium", "high"].every((value) =>
                  efforts.options.some((item) => item.value === value),
                ) && (
                  <div className={s.row}>
                    <div>
                      <b>Raciocínio</b>
                      <p>
                        {{
                          low: "Responde mais rápido.",
                          medium: "Equilíbrio entre tempo e cuidado.",
                          high: "Pensa mais antes de agir.",
                        }[draft.effort ?? ""] ?? ""}
                      </p>
                    </div>
                    <SegmentedControl
                      label="Raciocínio"
                      options={[
                        { value: "low", label: "Baixo" },
                        { value: "medium", label: "Médio" },
                        { value: "high", label: "Alto" },
                      ]}
                      value={draft.effort ?? ""}
                      onValueChange={(value) => change({ effort: value })}
                    />
                  </div>
                )}
            </div>
          </section>
          <section className={s.section}>
            <h2>Memórias</h2>
            <p>Fatos que o agente lembra em toda tarefa nova.</p>
            <div className={s.box}>
              {draft.memories.map((memory, index) => (
                <div className={s.memory} key={memory.id ?? index}>
                  <span>{memory.text}</span>
                  <button
                    type="button"
                    aria-label={`Remover memória: ${memory.text}`}
                    onClick={() =>
                      change({ memories: draft.memories.filter((_, i) => i !== index) })
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
              {!draft.memories.length && (
                <p className={s.empty}>O agente ainda não tem memórias.</p>
              )}
              <div className={s.add}>
                <input
                  aria-label="Nova memória"
                  maxLength={2_000}
                  value={memoryText}
                  placeholder={`Algo que o ${draft.name || "agente"} deve lembrar`}
                  onChange={(event) => setMemoryText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && memoryText.trim()) {
                      event.preventDefault();
                      change({ memories: [...draft.memories, { text: memoryText.trim() }] });
                      setMemoryText("");
                    }
                  }}
                />
                <Button
                  onClick={() => {
                    if (memoryText.trim()) {
                      change({ memories: [...draft.memories, { text: memoryText.trim() }] });
                      setMemoryText("");
                    }
                  }}
                >
                  Adicionar
                </Button>
              </div>
            </div>
          </section>
          <section className={s.section}>
            <div className={s.sectionHead}>
              <div>
                <h2>Rotinas</h2>
                <p>Tarefas que o agente começa sozinho, num horário ou por webhook.</p>
              </div>
              <Button
                small
                aria-label="+ Nova rotina"
                onClick={() => {
                  setRoutineDraft({
                    name: "",
                    when: "demand",
                    time: "",
                    schedule: null,
                    prompt: "",
                    hook: false,
                    enabled: true,
                  });
                  setDialog("routine");
                }}
              >
                <PlusIcon />
                Nova rotina
              </Button>
            </div>
            <div className={s.box}>
              {draft.routines.map((routine, index) => (
                <button
                  type="button"
                  className={s.routine}
                  key={routine.id ?? index}
                  onClick={() => {
                    setRoutineDraft({ ...routine });
                    setDialog("routine");
                  }}
                >
                  <span className={s.routineIcon}>
                    {routine.hook ? <HookIcon /> : <ClockIcon />}
                  </span>
                  <span className={s.routineCopy}>
                    <b>{routine.name}</b>
                    <small>{routine.prompt}</small>
                  </span>
                  <Tag>{routineWhenText(routine)}</Tag>
                  <span aria-hidden="true">›</span>
                </button>
              ))}
              {!draft.routines.length && <p className={s.empty}>Nenhuma rotina ainda.</p>}
            </div>
          </section>
          {computer.available && (
            <section className={s.section}>
              <h2>Acesso</h2>
              <div className={s.box}>
                <div className={`${s.row} ${s.rowSplit}`}>
                  <div>
                    <b>Usar o computador</b>
                    <p>Ver a tela e controlar mouse e teclado. Pergunta antes de cada sessão.</p>
                  </div>
                  <Switch
                    checked={draft.computerUse}
                    aria-label="Usar o computador"
                    onCheckedChange={(value) => {
                      if (value) setDialog("computer");
                      else change({ computerUse: false });
                    }}
                  />
                </div>
                <div className={`${s.row} ${s.rowSplit}`}>
                  <div>
                    <b>Apps conectados</b>
                    <p>{appsText}</p>
                  </div>
                  <Button variant="ghost" arrow onClick={onOpenApps}>
                    Gerenciar
                  </Button>
                </div>
              </div>
            </section>
          )}
          <details className={s.advanced}>
            <summary>
              <ChevIcon aria-hidden="true" />
              Avançado
            </summary>
            <div className={s.box}>
              <div className={s.row}>
                <b>Pasta de trabalho</b>
                <div className={s.workdirControl}>
                  <code title={agent.workspacePath}>{abbreviatePath(agent.workspacePath)}</code>
                  <Button
                    small
                    aria-label="Copiar caminho"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(agent.workspacePath)
                        .then(() => showToast("Caminho copiado."))
                    }
                  >
                    <CopyIcon />
                  </Button>
                </div>
              </div>
              {draft.provider === saved.provider &&
                options
                  .filter((option) => option.id !== "model" && option.id !== efforts?.id)
                  .map((option) => (
                    <label className={s.row} key={option.id}>
                      <span>{option.name}</span>
                      <select
                        value={draft.options[option.id] ?? option.currentValue}
                        onChange={(event) =>
                          change({ options: { ...draft.options, [option.id]: event.target.value } })
                        }
                      >
                        {option.options.map((choice) => (
                          <option key={choice.value} value={choice.value}>
                            {choice.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
              <div className={s.permissionNotice}>
                <PermissionNotice provider={draft.provider} />
              </div>
              <div className={`${s.row} ${s.rowSplit}`}>
                <div>
                  <b>Excluir agente</b>
                  <p>As rotinas param. As conversas continuam no histórico.</p>
                </div>
                <Button className={s.deleteButton} onClick={() => setDialog("delete")}>
                  Excluir…
                </Button>
              </div>
            </div>
          </details>
          {error && (
            <p role="alert" className={s.error}>
              {error}
            </p>
          )}
        </main>
      </div>
      {dirty && !dialog && (
        <div className={s.savebar}>
          <span>
            <i />
            Alterações não salvas
          </span>
          <Button
            variant="ghost"
            small
            onClick={() => {
              setDraft(saved);
              setError("");
            }}
          >
            Descartar
          </Button>
          <Button variant="primary" small disabled={!draft.name.trim()} onClick={() => void save()}>
            Salvar <kbd>{mod}S</kbd>
          </Button>
        </div>
      )}
      {toast && (
        <div role="status" className={s.toast}>
          {toast.text}
          {toast.undo && (
            <button type="button" onClick={toast.undo}>
              Desfazer
            </button>
          )}
        </div>
      )}
      {dialog === "computer" && (
        <LayerDialog
          title="Deixar o agente usar o computador?"
          onClose={() => setDialog(null)}
          initialFocus='[data-action="allow"]'
          {...(isWindows ? { testId: "computer-dialog-windows" } : {})}
        >
          <div className={s.dialogHeader}>
            <h2>Deixar {agentName} usar o computador?</h2>
            <p>Serve para tarefas em apps que não têm conexão direta.</p>
          </div>
          <div className={s.computerBody}>
            <ul className={s.computerItems}>
              <li>
                <EyeIcon />
                <span>Vê a tela enquanto trabalha numa tarefa.</span>
              </li>
              <li>
                <CursorIcon />
                <span>
                  Move o mouse e digita. Você pode parar a qualquer momento com <kbd>Esc</kbd>.
                </span>
              </li>
              <li>
                <HandIcon />
                <span>Pergunta antes de cada sessão e antes de pagar, enviar ou apagar.</span>
              </li>
            </ul>
            <p className={s.computerNote}>
              {isWindows
                ? "O Windows não pede permissão à parte. O agente não controla janelas abertas como administrador nem os avisos do Controle de Conta de Usuário."
                : "Na primeira vez, o macOS pede as permissões de Gravação de Tela e Acessibilidade."}
            </p>
          </div>
          <footer className={isWindows ? s.windowsButtons : undefined}>
            {isWindows ? (
              <>
                <Button
                  data-action="allow"
                  variant="primary"
                  onClick={() => {
                    change({ computerUse: true });
                    setDialog(null);
                  }}
                >
                  Permitir
                </Button>
                <Button data-action="deny" onClick={() => setDialog(null)}>
                  Agora não
                </Button>
              </>
            ) : (
              <>
                <Button data-action="deny" onClick={() => setDialog(null)}>
                  Agora não
                </Button>
                <Button
                  data-action="allow"
                  variant="primary"
                  onClick={() => {
                    change({ computerUse: true });
                    setDialog(null);
                  }}
                >
                  Permitir
                </Button>
              </>
            )}
          </footer>
        </LayerDialog>
      )}
      {dialog === "delete" && (
        <LayerDialog
          title={`Excluir ${agentName}?`}
          onClose={() => setDialog(null)}
          initialFocus='[data-action="cancel"]'
        >
          <div className={s.dialogBody}>
            <h2>Excluir {agentName}?</h2>
            <p>
              {draft.routines.length > 1
                ? `As ${draft.routines.length} rotinas param de rodar. `
                : draft.routines.length === 1
                  ? "A rotina para de rodar. "
                  : ""}
              A pasta de trabalho e as conversas continuam guardadas.
            </p>
          </div>
          <footer>
            <Button data-action="cancel" onClick={() => setDialog(null)}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                try {
                  const snapshot = { ...agent, name: agentName };
                  onDeleted(snapshot);
                  await client.request("agents.delete", { id: agent.id });
                  onDeleted(snapshot, true);
                  if (abort.current) clearTimeout(abort.current);
                  setToast(null);
                } catch (e) {
                  setError(errorMessage(e));
                }
                setDialog(null);
              }}
            >
              Excluir agente
            </Button>
          </footer>
        </LayerDialog>
      )}
      {dialog === "routine" && routineDraft && (
        <LayerDialog
          title={routineDraft.id ? "Editar rotina" : "Nova rotina"}
          onClose={() => setDialog(null)}
          initialFocus="input"
        >
          <RoutineEditor
            value={routineDraft}
            saved={saved.routines.find((item) => item.id === routineDraft.id)}
            serverRoutine={routines.find((item) => item.id === routineDraft.id)}
            onToast={showToast}
            onChange={setRoutineDraft}
            onCancel={() => setDialog(null)}
            onDelete={() => {
              const index = draft.routines.findIndex((item) => item.id === routineDraft.id);
              if (index >= 0) deleteRoutine(index);
              setDialog(null);
            }}
            onRun={async () => {
              if (routineDraft.id) {
                await client.request("routines.run", { id: routineDraft.id });
                showToast("Rotina iniciada.");
              }
            }}
            onSave={() => {
              const index = draft.routines.findIndex((item) => item.id === routineDraft.id);
              const list = [...draft.routines];
              if (index >= 0) list[index] = routineDraft;
              else list.push(routineDraft);
              change({ routines: list });
              setDialog(null);
            }}
          />
        </LayerDialog>
      )}
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className={s.tag}>{children}</span>;
}

function createdDate(timestamp: number) {
  const date = new Date(timestamp);
  const parts = new Intl.DateTimeFormat("pt-BR", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).formatToParts(date);
  const day = parts.find((part) => part.type === "day")?.value;
  const month = parts.find((part) => part.type === "month")?.value.replace(".", "");
  const year = parts.find((part) => part.type === "year")?.value;
  return [day, month, year !== String(new Date().getFullYear()) ? year : ""]
    .filter(Boolean)
    .join(" ");
}

function RoutineEditor({
  value,
  saved,
  serverRoutine,
  onChange,
  onToast,
  onSave,
  onCancel,
  onDelete,
  onRun,
}: {
  value: DraftRoutine;
  saved?: DraftRoutine | undefined;
  serverRoutine?: Routine | undefined;
  onChange: (value: DraftRoutine) => void;
  onToast: (text: string, undo?: () => void) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onRun: () => void;
}) {
  const update = (patch: Partial<DraftRoutine>) => onChange({ ...value, ...patch });
  const [attempted, setAttempted] = useState(false);
  const timeInvalid =
    (value.when === "daily" || value.when === "weekly") && !isValidTime(value.time, value.when);
  const webhookUrl = serverRoutine?.webhookUrl;
  const webhookCommand =
    serverRoutine?.webhookToken && webhookUrl
      ? `curl -X POST -H "Authorization: Bearer ${serverRoutine.webhookToken}" ${webhookUrl}`
      : null;
  return (
    <>
      <div className={s.dialogBody}>
        <h2 tabIndex={-1}>{value.id ? "Editar rotina" : "Nova rotina"}</h2>
        <p className={s.dialogDescription}>
          O agente começa a tarefa sozinho e pergunta antes de pagar, enviar ou apagar.
        </p>
        <Field
          label="Nome"
          fieldClassName={s.dialogField}
          maxLength={60}
          value={value.name}
          onChange={(event) => update({ name: event.target.value })}
        />
        <div className={s.formRow}>
          <label>
            <span>Quando</span>
            <select
              value={value.when}
              onChange={(event) => update({ when: event.target.value as DraftRoutine["when"] })}
            >
              <option value="demand">Quando você pedir</option>
              <option value="30m">A cada 30 min</option>
              <option value="daily">Todo dia</option>
              <option value="weekly">Toda semana</option>
              {value.when === "custom" && (
                <option value="custom">{formatCustomSchedule(value.schedule)}</option>
              )}
            </select>
          </label>
          <Field
            label="Horário"
            fieldClassName={s.dialogField}
            className={s.monoInput}
            disabled={!["daily", "weekly"].includes(value.when)}
            value={value.time}
            placeholder={value.when === "weekly" ? "sex 17:00" : "09:00"}
            error={
              attempted && timeInvalid
                ? `Use o formato ${value.when === "weekly" ? "sex 17:00" : "09:00"}`
                : ""
            }
            onChange={(event) => update({ time: event.target.value })}
          />
        </div>
        <Field
          label="O que fazer"
          fieldClassName={s.dialogField}
          multiline
          value={value.prompt}
          onChange={(event) => update({ prompt: event.target.value })}
        />
        <div className={s.webhookSwitch}>
          <span>
            Também começar por webhook
            <small>Um endereço local que outro app pode chamar.</small>
          </span>
          <Switch
            aria-label="Também começar por webhook"
            checked={value.hook}
            onCheckedChange={(hook) => update({ hook })}
          />
        </div>
        {value.id && (
          <>
            <div className={s.dialogSwitch}>
              <span>Ativa</span>
              <Switch
                aria-label="Ativa"
                checked={value.enabled}
                onCheckedChange={(enabled) => update({ enabled })}
              />
            </div>
            <Button small disabled={!saved || !deepEqual(saved, value)} onClick={onRun}>
              Rodar agora
            </Button>
          </>
        )}
        {serverRoutine?.webhook && webhookUrl && webhookCommand && (
          <div className={s.webhook}>
            <code title={webhookUrl}>{webhookUrl}</code>
            <div>
              <Button
                small
                onClick={() =>
                  void navigator.clipboard
                    .writeText(webhookUrl)
                    .then(() => onToast("Endereço copiado."))
                }
              >
                Copiar endereço
              </Button>
              <Button
                small
                onClick={() =>
                  void navigator.clipboard
                    .writeText(webhookCommand)
                    .then(() => onToast("Comando copiado."))
                }
              >
                Copiar curl
              </Button>
            </div>
          </div>
        )}
      </div>
      <footer>
        <span>
          {value.id && (
            <Button variant="ghost" className={s.removeRoutine} onClick={onDelete}>
              Remover rotina
            </Button>
          )}
        </span>
        <Button onClick={onCancel}>Cancelar</Button>
        <Button
          variant="primary"
          disabled={!value.name.trim() || !value.prompt.trim()}
          onClick={() => {
            setAttempted(true);
            if (!timeInvalid) onSave();
          }}
        >
          {value.id ? "Concluir" : "Criar rotina"}
        </Button>
      </footer>
    </>
  );
}
