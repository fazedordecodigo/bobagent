import type { Approval, ApprovalDecision, EmailDraft } from "@boto/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDaemonState } from "../hooks/useDaemonState";
import { permissionActions } from "../lib/app-permissions";
import { approvalAction, decideApproval } from "../lib/approval-decisions";
import { describeApproval, requiresFullReview } from "../lib/approval-description";
import { DaemonClient } from "../lib/daemon";
import { errorMessage } from "../lib/errors";
import {
  GLOBAL_PAUSE_KEY,
  type GlobalPauseAction,
  globalPauseAction,
  reconcileGlobalPause,
  toggleGlobalPause,
} from "../lib/global-pause";
import { addMenuResult, expireMenuResults, type MenuResult } from "../lib/menu-results";
import { nativeCommand } from "../lib/native";
import { useThemePref } from "../lib/theme";
import { ConfirmDialog } from "./ConfirmDialog";
import { Button, IconButton, KeyboardShortcut, StatusDot } from "./ds/controls";
import {
  CardIcon,
  FileIcon,
  LockIcon,
  MailIcon,
  PlaneIcon,
  PlugIcon,
  SideIcon,
  BotoSimboloCurrentcolorIcon,
  UpIcon,
} from "./ds/icons";
import { Menu } from "./ds/Menu";
import { Icon } from "./icons";
import s from "./MenuBar.module.css";

function relativeTime(createdAt: number, now: number) {
  const minutes = Math.max(0, Math.floor((now - createdAt) / 60000));
  return minutes < 1
    ? "agora"
    : minutes < 60
      ? `há ${minutes} min`
      : minutes < 1440
        ? `há ${Math.floor(minutes / 60)} h`
        : `há ${Math.floor(minutes / 1440)} d`;
}

function ApprovalIcon({ approval }: { approval: Approval }) {
  if (approval.kind === "secret") return <LockIcon />;
  if (approval.permission === "send") return <MailIcon />;
  if (approval.permission === "pay") return <CardIcon />;
  if (approval.permission === "book") return <PlaneIcon />;
  return approval.appId ? <PlugIcon /> : <FileIcon />;
}

export default function MenuBar() {
  const [client] = useState(() => new DaemonClient());
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [drafts, setDrafts] = useState<EmailDraft[]>([]);
  const [queueAction, setQueueAction] = useState<GlobalPauseAction>("pause");
  const [done, setDone] = useState<MenuResult[]>([]);
  const [busy, setBusy] = useState<string[]>([]);
  const working = useRef(new Set<string>());
  const globalOperation = useRef(new Set<string>());
  const generation = useRef(0);
  const [text, setText] = useState("");
  const [now, setNow] = useState(Date.now());
  const [quit, setQuit] = useState(false);
  const [, setTheme] = useThemePref();
  const dark = document.documentElement.dataset.theme === "dark";
  const loadPending = useCallback(async () => {
    const version = ++generation.current;
    const [pending, mail] = await Promise.all([
      client.request("approvals.list", {}),
      client.request("email.drafts.list", { pendingOnly: true }),
    ]);
    if (version !== generation.current) return;
    setApprovals(pending.filter((item) => item.status === "pending"));
    setDrafts(mail.filter((item) => item.status === "pending" || item.status === "failed"));
    setQueueAction(globalPauseAction(localStorage));
  }, [client]);
  const {
    agents,
    statuses,
    ready,
    error,
    setError,
    refresh: load,
  } = useDaemonState(client, {
    includeChannels: false,
    onRefresh: loadPending,
  });
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (!active) return;
      void load().catch((e: unknown) => setError(errorMessage(e)));
    };
    const offs = [
      client.onReconnect(refresh),
      client.on("approval.updated", refresh),
      client.on("email.draft.updated", refresh),
      client.on("agent.created", refresh),
      client.on("agent.updated", refresh),
      client.on("agent.deleted", refresh),
      client.on("agent.status", refresh),
      client.on("queue.updated", (queue) => {
        reconcileGlobalPause(localStorage, queue, globalOperation.current);
        refresh();
      }),
    ];
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => {
      active = false;
      generation.current++;
      for (const off of offs) off();
      clearInterval(timer);
    };
  }, [client, load, setError]);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === GLOBAL_PAUSE_KEY)
        void load().catch((e: unknown) => setError(errorMessage(e)));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [load, setError]);
  const perform = useCallback(
    async (id: string, action: () => Promise<unknown>) => {
      if (working.current.has(id)) return;
      working.current.add(id);
      setBusy([...working.current]);
      setError(null);
      try {
        await action();
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        working.current.delete(id);
        setBusy([...working.current]);
      }
    },
    [setError],
  );
  const count = approvals.length + drafts.length;
  useEffect(() => {
    if (!done.length) return;
    const expiresAt = Math.min(...done.map((item) => item.expiresAt));
    const timer = setTimeout(
      () => setDone((items) => expireMenuResults(items)),
      Math.max(0, expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [done]);
  useEffect(() => {
    if (ready)
      void nativeCommand("set_tray_count", { count }).catch((e: unknown) =>
        setError(errorMessage(e)),
      );
  }, [count, ready, setError]);
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !quit) {
        void nativeCommand("menubar_hide").catch((e: unknown) => setError(errorMessage(e)));
      }
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [quit, setError]);
  const open = (view?: string) =>
    void perform("open", () => nativeCommand("open_main", { view: view ?? null }));
  const nameOf = (id: string) => agents.find((agent) => agent.id === id)?.name ?? "Bot removido";
  const decide = (approval: Approval, decision: ApprovalDecision) =>
    void perform(approval.id, async () => {
      const result = await decideApproval(client, approval, decision);
      setApprovals((previous) => previous.filter((item) => item.id !== approval.id));
      setDone((previous) =>
        addMenuResult(previous, { ...result, id: approval.id, createdAt: approval.createdAt }),
      );
      await load();
    });
  const running = agents.filter(
    (agent) =>
      statuses[agent.id]?.status === "running" || statuses[agent.id]?.status === "starting",
  );
  const rows = [
    ...approvals.map((approval) => ({ id: approval.id, createdAt: approval.createdAt, approval })),
    ...drafts.map((draft) => ({ id: draft.id, createdAt: draft.createdAt, draft })),
    ...done.map((result) => ({ id: result.id, createdAt: result.createdAt, result })),
  ].sort((a, b) => b.createdAt - a.createdAt);
  const firstPending = rows.find((row) => !("result" in row))?.id;
  return (
    <main className={s.window} aria-label="Boto" data-testid="menubar">
      <header className={s.header}>
        <BotoSimboloCurrentcolorIcon className={s.symbol} />
        <div className={s.heading}>
          <h1>Boto</h1>
          <p className={s.meta} aria-live="polite">
            {!ready
              ? "Conectando…"
              : count === 0
                ? "Nada aguardando você"
                : `${count} ${count === 1 ? "tarefa" : "tarefas"} aguardando você`}
          </p>
        </div>
        <div className={s.tools}>
          <IconButton aria-label="Abrir o app" onClick={() => open()}>
            <SideIcon />
          </IconButton>
          <Menu
            label="Mais opções"
            items={[
              { label: "Abrir o Boto", onSelect: () => open() },
              {
                label: queueAction === "resume" ? "Retomar bots" : "Pausar bots",
                disabled:
                  !ready ||
                  (queueAction === "pause" && agents.length === 0) ||
                  busy.includes("queues"),
                onSelect: () =>
                  void perform("queues", async () => {
                    try {
                      await toggleGlobalPause(
                        client,
                        localStorage,
                        globalOperation.current,
                        queueAction,
                      );
                    } finally {
                      await load();
                    }
                  }),
              },
              {
                label: "Tema escuro",
                checked: dark,
                onSelect: () => setTheme(dark ? "light" : "dark"),
              },
              { label: "Sair do Boto", onSelect: () => setQuit(true) },
            ]}
          >
            …
          </Menu>
        </div>
      </header>
      {error && (
        <div className={s.error} role="alert">
          {error}
          <Button small onClick={() => void perform("retry", load)}>
            Tentar novamente
          </Button>
        </div>
      )}
      <div className={s.body}>
        <section aria-label={`Aguardando você (${count})`}>
          <h2 className={s.group}>
            <StatusDot status="wait" />
            Aguardando você<span>{count}</span>
          </h2>
          {rows.map((row) => {
            if ("result" in row)
              return (
                <div
                  key={row.id}
                  className={`${s.item} ${s.done}`}
                  data-testid="menubar-done"
                  role="status"
                >
                  <span className={s.check}>
                    <Icon name="ok" size={12} />
                  </span>
                  <div>
                    {row.result.message}
                    {row.result.undo && (
                      <Button
                        small
                        variant="ghost"
                        disabled={busy.includes(row.id)}
                        onClick={() =>
                          void perform(row.id, async () => {
                            await row.result.undo?.();
                            setDone((previous) =>
                              previous.map((item) =>
                                item.id === row.id
                                  ? {
                                      id: item.id,
                                      createdAt: item.createdAt,
                                      expiresAt: item.expiresAt,
                                      message:
                                        "Preferência restaurada. A ação já aprovada não foi desfeita.",
                                    }
                                  : item,
                              ),
                            );
                          })
                        }
                      >
                        Desfazer
                      </Button>
                    )}
                  </div>
                </div>
              );
            if ("draft" in row)
              return (
                <article key={row.id} className={s.item} data-testid="menubar-draft">
                  <span className={s.icon}>
                    <MailIcon />
                  </span>
                  <div>
                    <div className={s.itemHead}>
                      <b>{nameOf(row.draft.agentId)}</b>
                      <time className={s.meta}>{relativeTime(row.createdAt, now)}</time>
                    </div>
                    <p>{row.draft.subject || "Rascunho de e-mail"}</p>
                    <p>
                      Para {row.draft.to.join(", ")}. Revise o conteúdo e os destinatários antes de
                      enviar.
                    </p>
                    <div className={s.actions}>
                      <Button small onClick={() => open(row.draft.agentId)}>
                        Revisar no app
                      </Button>
                    </div>
                  </div>
                </article>
              );
            const a = row.approval;
            const copy = a.kind === "tool" ? describeApproval(a, nameOf(a.agentId)) : null;
            const sensitive = requiresFullReview(a);
            const appTool = Boolean(a.appId && a.permission);
            const variant = a.id === firstPending ? "primary" : "secondary";
            const disabled = busy.includes(a.id);
            return (
              <article
                key={a.id}
                className={s.item}
                data-testid="menubar-approval"
                aria-label={a.appName ?? nameOf(a.agentId)}
              >
                <span className={s.icon}>
                  <ApprovalIcon approval={a} />
                </span>
                <div>
                  <div className={s.itemHead}>
                    <b>{a.appName ?? nameOf(a.agentId)}</b>
                    <time className={s.meta}>{relativeTime(a.createdAt, now)}</time>
                  </div>
                  <p className={s.description}>{copy ? copy.description : a.title}</p>
                  {copy?.context && <p className={s.context}>{copy.context}</p>}
                  {copy?.arguments && <p className={s.arguments}>{copy.arguments}</p>}
                  {!copy && a.detail && <p>{a.detail}</p>}
                  {sensitive && <p>Esta ação sempre pede aprovação.</p>}
                  <div className={s.actions}>
                    {a.kind !== "tool" || sensitive ? (
                      <Button small variant={variant} onClick={() => open(a.agentId)}>
                        Revisar no app
                      </Button>
                    ) : (
                      <>
                        <Button
                          small
                          variant="ghost"
                          disabled={disabled}
                          onClick={() => decide(a, "deny")}
                        >
                          Recusar
                        </Button>
                        {appTool && !sensitive ? (
                          <>
                            <Button small disabled={disabled} onClick={() => decide(a, "task")}>
                              Só nesta tarefa
                            </Button>
                            <Button
                              small
                              variant={variant}
                              disabled={disabled}
                              onClick={() => decide(a, "always")}
                            >
                              Permitir
                            </Button>
                          </>
                        ) : (
                          <>
                            {!appTool && (
                              <Button small disabled={disabled} onClick={() => decide(a, "always")}>
                                Permitir sempre
                              </Button>
                            )}
                            <Button
                              small
                              variant={variant}
                              disabled={disabled}
                              onClick={() => decide(a, "approve")}
                            >
                              {a.permission
                                ? permissionActions[a.permission]
                                : approvalAction(a.tool)}
                            </Button>
                          </>
                        )}
                      </>
                    )}
                    {a.kind === "tool" && !sensitive && (
                      <Button small variant="ghost" onClick={() => open(a.agentId)}>
                        Revisar no app
                      </Button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
          {ready && count === 0 && (
            <div className={s.empty}>
              <b>Nada aguardando você.</b>
              <p>Eu aviso aqui quando uma tarefa precisar da sua decisão.</p>
            </div>
          )}
        </section>
        <section aria-label={`Em execução (${running.length})`}>
          <h2 className={s.group}>
            <StatusDot status="run" />
            Em execução<span>{running.length}</span>
          </h2>
          {running.map((agent) => (
            <button
              className={s.running}
              type="button"
              key={agent.id}
              onClick={() => open(agent.id)}
            >
              <StatusDot status="run" />
              <span>{agent.name}</span>
            </button>
          ))}
        </section>
      </div>
      <footer className={s.footer}>
        <form
          className={s.quick}
          onSubmit={(event) => {
            event.preventDefault();
            const agent = agents.find((item) => item.name === "Boto") ?? agents[0];
            if (!agent || !text.trim()) return;
            void perform("send", async () => {
              await client.request("chat.send", { agentId: agent.id, text: text.trim() });
              setText("");
              await load();
            });
          }}
        >
          <input
            aria-label="Peça uma tarefa ao Boto"
            placeholder="Peça uma tarefa ao Boto"
            value={text}
            disabled={!ready || agents.length === 0 || busy.includes("send")}
            onChange={(event) => setText(event.target.value)}
          />
          <IconButton
            className={s.send}
            type="submit"
            aria-label="Enviar tarefa"
            disabled={!ready || agents.length === 0 || !text.trim() || busy.includes("send")}
          >
            <UpIcon />
          </IconButton>
        </form>
        <div className={s.footRow}>
          <button type="button" onClick={() => open("apps")}>
            Apps conectados →
          </button>
          <span>
            <KeyboardShortcut>⌥</KeyboardShortcut> <KeyboardShortcut>⌘</KeyboardShortcut>{" "}
            <KeyboardShortcut>U</KeyboardShortcut> abre esta janela
          </span>
        </div>
      </footer>
      {quit && (
        <ConfirmDialog
          title="Sair do Boto?"
          body="As tarefas agendadas não rodam até você abrir o app de novo."
          confirmLabel="Sair do Boto"
          onCancel={() => setQuit(false)}
          onConfirm={() => void perform("quit", () => nativeCommand("quit_app"))}
        />
      )}
    </main>
  );
}
