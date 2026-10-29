import type { Agent } from "@upbot/protocol";
import { useEffect, useState } from "react";
import { useChat } from "../hooks/useChat";
import type { AgentOverview } from "../hooks/useOverview";
import type { DaemonClient } from "../lib/daemon";
import { moveControlFocus } from "../lib/keyboard";
import { MonoAv, Pill, role } from "../lib/ui";
import { PermissionNotice } from "./AgentSettings";
import { ApprovalCards } from "./ApprovalsView";
import { Composer } from "./Composer";
import { DraftCards } from "./EmailView";
import { Icon } from "./icons";
import { MessageList } from "./MessageList";

export function ChatView({
  client,
  agent,
  overview,
  onOpenSettings,
  notice,
  onNoticeDismiss,
  onPanelToggle,
}: {
  client: DaemonClient;
  agent: Agent;
  overview: AgentOverview | undefined;
  onOpenSettings: () => void;
  notice: string | null;
  onNoticeDismiss: () => void;
  onPanelToggle: () => void;
}) {
  const {
    items,
    hasMore,
    runningTurn,
    loaded,
    queue,
    error,
    loadEarlier,
    queuePause,
    queueResume,
    queueRemove,
  } = useChat(client, agent.id);
  const [sendBusy, setSendBusy] = useState(false);
  const [voice, setVoice] = useState({ tts: false, stt: false });
  const [composerText, setComposerText] = useState("");
  const [modeError, setModeError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    client
      .request("voice.status", {})
      .then(setVoice)
      .catch(() => {});
  }, [client]);

  const isClaude = agent.provider === "claude";
  const isCodex = agent.provider === "codex";
  const supportsModes = isClaude || isCodex;
  const mode = agent.config?.mode ?? (isClaude ? "default" : "auto");
  const safeMode = mode === "plan" || mode === "read-only";
  const latestUser = [...items].reverse().find((item) => item.kind === "user_message");
  const isDirectMessage =
    latestUser?.kind === "user_message" &&
    !latestUser.from &&
    !latestUser.gateway &&
    !latestUser.routine &&
    !latestUser.channelId &&
    !latestUser.team;
  const retryHasAttachments =
    latestUser?.kind === "user_message" &&
    isDirectMessage &&
    Boolean(latestUser.attachments?.length);
  const canRetry =
    latestUser?.kind === "user_message" &&
    isDirectMessage &&
    !retryHasAttachments &&
    !latestUser.attachments?.length;

  const setMode = async (value: string) => {
    setModeError(null);
    try {
      await client.request("agents.setConfig", { agentId: agent.id, configId: "mode", value });
    } catch (e) {
      setModeError(e instanceof Error ? e.message : String(e));
    }
  };

  const send = async (
    text: string,
    attachments: { name: string; mime: string; dataBase64: string }[],
  ) => {
    setSendBusy(true);
    setSendError(null);
    try {
      await client.request("chat.send", {
        agentId: agent.id,
        text,
        ...(attachments.length ? { attachments } : {}),
      });
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setSendBusy(false);
    }
  };

  const retry = () => {
    if (latestUser?.kind === "user_message") void send(latestUser.text, []);
  };
  const displayStatus = overview?.status ?? "idle";
  const isAsking = supportsModes && safeMode;
  const placeholder = isAsking
    ? `Pergunte algo para ${agent.name}`
    : `Peça uma tarefa para ${agent.name}`;
  const hint = supportsModes
    ? isAsking
      ? "Modo Perguntar: responde e sugere um plano, sem executar nada."
      : "Modo Agir: executa sozinho e pede aprovação em ações sensíveis."
    : "Enter envia · Shift+Enter quebra linha";

  return (
    <div className="main" style={{ flex: 1 }} data-od-id="chat-view">
      <header className="main-head" data-tauri-drag-region>
        <MonoAv agent={agent} status={displayStatus} lg />
        <div className="title">
          <h2>{agent.name}</h2>
          <p>{overview?.task || role(agent)}</p>
        </div>
        <Pill st={displayStatus} />
        {supportsModes && (
          <>
            {/* biome-ignore lint/a11y/useSemanticElements: Required by the mockup's div role group. */}
            <div className="seg" role="group" aria-label="Modo do bot" onKeyDown={moveControlFocus}>
              <button
                type="button"
                aria-pressed={isAsking}
                tabIndex={isAsking ? 0 : -1}
                onClick={() => void setMode(isClaude ? "plan" : "read-only")}
              >
                Perguntar
              </button>
              <button
                type="button"
                aria-pressed={!isAsking}
                tabIndex={isAsking ? -1 : 0}
                onClick={() => void setMode(isClaude ? "default" : "auto")}
              >
                Agir
              </button>
            </div>
          </>
        )}
        <button
          type="button"
          className="icon-btn"
          aria-label="Configurar bot"
          onClick={onOpenSettings}
        >
          <Icon name="gear" />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Alternar painel de execução"
          onClick={onPanelToggle}
        >
          <Icon name="panel" />
        </button>
      </header>
      {modeError && <div className="notice is-err">{modeError}</div>}
      {error && (
        <div className="notice is-err" role="alert">
          {error}
        </div>
      )}
      <MessageList
        agent={agent}
        status={displayStatus}
        items={items}
        hasMore={hasMore}
        loaded={loaded}
        emptyNotice={<PermissionNotice provider={agent.provider} />}
        running={runningTurn !== null || displayStatus === "run"}
        onLoadEarlier={() => void loadEarlier().catch(() => {})}
        onPermissionRespond={(requestId, optionId) => {
          void client.request("permissions.respond", { requestId, optionId }).catch((e) => {
            setSendError(e instanceof Error ? e.message : String(e));
          });
        }}
        onSpeak={
          voice.tts
            ? (text) => void client.request("voice.speak", { text }).catch(() => {})
            : undefined
        }
        onRetry={retry}
        canRetry={canRetry}
        retryHasAttachments={retryHasAttachments}
        onSuggestion={setComposerText}
      />
      <Composer
        text={composerText}
        onTextChange={setComposerText}
        running={runningTurn !== null || sendBusy}
        placeholder={placeholder}
        hint={hint}
        hintError={sendError}
        onSend={send}
        onStop={() => void client.request("chat.cancel", { agentId: agent.id }).catch(() => {})}
        onTranscribe={
          voice.stt
            ? async (audioBase64, mime) =>
                (await client.request("voice.transcribe", { audioBase64, mime })).text
            : undefined
        }
      >
        {notice && (
          <div className="notice">
            {notice}
            <button type="button" aria-label="Dispensar aviso" onClick={onNoticeDismiss}>
              ×
            </button>
          </div>
        )}
        {queue && (queue.items.length > 0 || queue.paused) && (
          <div className="quiet">
            <span className="meta">
              {queue.paused ? "Fila pausada" : `${queue.items.length} na fila`}
            </span>
            {queue.items.map((item) => (
              <span className="chip" key={item.id}>
                {item.text.slice(0, 60)}
                <button
                  type="button"
                  aria-label="Remover da fila"
                  onClick={() => void queueRemove(item.id)}
                >
                  ×
                </button>
              </span>
            ))}
            {queue.paused ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void queueResume()}
              >
                Retomar fila
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void queuePause()}
              >
                Pausar fila
              </button>
            )}
          </div>
        )}
        <ApprovalCards client={client} agentId={agent.id} botName={agent.name} />
        <DraftCards client={client} agentId={agent.id} />
      </Composer>
    </div>
  );
}
