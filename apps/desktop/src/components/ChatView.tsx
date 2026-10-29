import type { Agent } from "@upbot/protocol";
import { useCallback, useEffect, useState } from "react";
import { useChatApi } from "../hooks/useChat";
import type { AgentOverview } from "../hooks/useOverview";
import type { DaemonClient } from "../lib/daemon";
import { errorMessage } from "../lib/errors";
import { moveControlFocus } from "../lib/keyboard";
import { errorFields, logWarn } from "../lib/log";
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
    error: chatError,
    loadEarlier,
    queuePause,
    queueResume,
    queueRemove,
  } = useChatApi();
  const [sendBusy, setSendBusy] = useState(false);
  const [voice, setVoice] = useState({ tts: false, stt: false });
  const [composerText, setComposerText] = useState("");
  const [modeError, setModeError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    client
      .request("voice.status", {})
      .then(setVoice)
      .catch((e: unknown) => logWarn("voice.status_failed", errorFields(e)));
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
      setModeError(errorMessage(e));
    }
  };

  const send = useCallback(
    async (text: string, attachments: { name: string; mime: string; dataBase64: string }[]) => {
      setSendBusy(true);
      setSendError(null);
      try {
        await client.request("chat.send", {
          agentId: agent.id,
          text,
          ...(attachments.length ? { attachments } : {}),
        });
      } catch (e) {
        setSendError(errorMessage(e));
        throw e;
      } finally {
        setSendBusy(false);
      }
    },
    [client, agent.id],
  );

  const retry = useCallback(() => {
    if (latestUser?.kind === "user_message") void send(latestUser.text, []);
  }, [latestUser, send]);

  const respondPermission = useCallback(
    (requestId: string, optionId: string | null) => {
      void client.request("permissions.respond", { requestId, optionId }).catch((e) => {
        setSendError(errorMessage(e));
      });
    },
    [client],
  );

  const speak = useCallback(
    (text: string) =>
      void client
        .request("voice.speak", { text })
        .catch((e: unknown) => logWarn("voice.speak_failed", errorFields(e))),
    [client],
  );

  const loadEarlierItems = useCallback(() => {
    void loadEarlier().catch((e: unknown) =>
      logWarn("chat.history_earlier_failed", { agentId: agent.id, ...errorFields(e) }),
    );
  }, [agent.id, loadEarlier]);
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
      {chatError && <div className="notice is-err">{chatError}</div>}
      <MessageList
        agent={agent}
        status={displayStatus}
        items={items}
        hasMore={hasMore}
        loaded={loaded}
        emptyNotice={<PermissionNotice provider={agent.provider} />}
        running={runningTurn !== null || displayStatus === "run"}
        onLoadEarlier={loadEarlierItems}
        onPermissionRespond={respondPermission}
        onSpeak={voice.tts ? speak : undefined}
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
        onStop={() =>
          void client.request("chat.cancel", { agentId: agent.id }).catch((e: unknown) => {
            logWarn("chat.cancel_failed", { agentId: agent.id, ...errorFields(e) });
            setSendError(`Não foi possível parar: ${errorMessage(e)}`);
          })
        }
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
                  onClick={() => queueRemove(item.id)}
                >
                  ×
                </button>
              </span>
            ))}
            {queue.paused ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={queueResume}>
                Retomar fila
              </button>
            ) : (
              <button type="button" className="btn btn-ghost btn-sm" onClick={queuePause}>
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
