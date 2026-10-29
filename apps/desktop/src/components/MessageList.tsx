import type { Agent, ChatItem } from "@upbot/protocol";
import { type ReactNode, useEffect, useRef } from "react";
import { MonoAv, role, type UiStatus } from "../lib/ui";
import { CopyButton } from "./CopyButton";
import { Icon } from "./icons";
import { Markdown } from "./Markdown";

const TOOL_LABEL: Record<string, string> = {
  pending: "Na fila",
  in_progress: "Em execução",
  completed: "Concluído",
  failed: "Com erro",
};

export function messageDay(timestamp: number, now = Date.now()) {
  const date = new Date(timestamp);
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const month = date.toLocaleDateString("pt-BR", { month: "long" });
  if (sameDay(date, today)) return `Hoje · ${date.getDate()} de ${month}`;
  if (sameDay(date, yesterday)) return `Ontem · ${date.getDate()} de ${month}`;
  return `${date.getDate()} de ${month}`;
}

function PermissionCard({
  item,
  onRespond,
}: {
  item: Extract<ChatItem, { kind: "permission" }>;
  onRespond: (requestId: string, optionId: string | null) => void;
}) {
  const resolved = item.resolution !== null;
  const selected = item.options.find((option) => option.optionId === item.resolution?.optionId);
  return (
    <div className={`approval${resolved ? " done" : ""}`} data-od-id="approval-card">
      <div className="approval-head">
        <span className="status wait">
          <i className="dot s-wait" />
          Precisa de você
        </span>
      </div>
      <div style={{ padding: "0 16px" }}>
        <h3>{item.title}</h3>
      </div>
      {resolved ? (
        <div className="resolved">
          <Icon name="check" />
          {selected ? `Escolhido: ${selected.name}` : "Cancelado"}
        </div>
      ) : (
        <div className="approval-actions">
          {item.options.map((option, index) => (
            <button
              key={option.optionId}
              type="button"
              className={
                option.kind.startsWith("reject")
                  ? "btn btn-ghost"
                  : index === 0
                    ? "btn btn-primary"
                    : "btn btn-secondary"
              }
              onClick={() => onRespond(item.requestId, option.optionId)}
            >
              {option.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function MessageList({
  agent,
  status,
  items,
  hasMore,
  loaded,
  emptyNotice,
  running,
  onLoadEarlier,
  onPermissionRespond,
  onSpeak,
  onRetry,
  canRetry,
  retryHasAttachments,
  onSuggestion,
}: {
  agent: Agent;
  status: UiStatus;
  items: ChatItem[];
  hasMore: boolean;
  loaded: boolean;
  emptyNotice?: ReactNode;
  running: boolean;
  onLoadEarlier: () => void;
  onPermissionRespond: (requestId: string, optionId: string | null) => void;
  onSpeak?: ((text: string) => void) | undefined;
  onRetry: () => void;
  canRetry: boolean;
  retryHasAttachments: boolean;
  onSuggestion: (text: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    const element = ref.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  });
  const last = items.at(-1);
  const suggestions = [
    "O que você consegue fazer?",
    "Monte um plano para esta semana",
    "Resuma o que você lembra sobre mim",
  ];

  if (!items.length && loaded) {
    return (
      <div className="thread" ref={ref}>
        <div className="thread-inner">
          <div className="empty">
            <MonoAv agent={agent} status={status} lg />
            <h2>{agent.name}</h2>
            <p>{role(agent)}. Diga o que precisa; ele mostra o plano antes de agir.</p>
            <div className="suggest">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="chip"
                  onClick={() => onSuggestion(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
            {emptyNotice}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="thread"
      ref={ref}
      aria-live="polite"
      onScroll={(event) => {
        const element = event.currentTarget;
        atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
      }}
    >
      <div className="thread-inner">
        {hasMore && (
          <button type="button" className="chip" onClick={onLoadEarlier}>
            Carregar anteriores
          </button>
        )}
        {items.map((item, index) => {
          const previous = items[index - 1];
          const separator =
            !previous ||
            new Date(previous.createdAt).toDateString() !== new Date(item.createdAt).toDateString();
          return (
            <div key={item.id} className="thread-message">
              {separator && <p className="meta day">{messageDay(item.createdAt)}</p>}
              {item.kind === "user_message" ? (
                <div className="msg-user">
                  {item.from && <div className="meta">De {item.from.name}</div>}
                  {item.gateway && (
                    <div className="meta">
                      via {item.gateway.kind} · {item.gateway.userName}
                    </div>
                  )}
                  {item.routine && <div className="meta">Rotina {item.routine.name}</div>}
                  <p style={{ whiteSpace: "pre-wrap" }}>{item.text}</p>
                  {item.attachments?.map((attachment) => (
                    <div className="file" key={attachment.path}>
                      <span className="fi">
                        <Icon name="doc" />
                      </span>
                      <div>
                        <strong>{attachment.name}</strong>
                        <span className="meta">
                          {Math.max(1, Math.round(attachment.size / 1024))} KB
                        </span>
                      </div>
                    </div>
                  ))}
                  <time
                    className="message-time meta num"
                    dateTime={new Date(item.createdAt).toISOString()}
                  >
                    {new Date(item.createdAt).toLocaleTimeString("pt-BR", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
              ) : item.kind === "agent_message" ? (
                <div className="msg-agent">
                  <div className="body">
                    <Markdown text={item.text} />
                    <time
                      className="message-time meta num"
                      dateTime={new Date(item.createdAt).toISOString()}
                    >
                      {new Date(item.createdAt).toLocaleTimeString("pt-BR", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                    <div className="msg-actions">
                      <CopyButton text={item.text} />
                      {onSpeak && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => onSpeak(item.text)}
                        >
                          Ouvir
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ) : item.kind === "agent_thought" ? (
                <div className="msg-agent">
                  <div className="body">
                    <details className="thought">
                      <summary className="meta">Pensando</summary>
                      <Markdown text={item.text} />
                    </details>
                  </div>
                </div>
              ) : item.kind === "tool_call" ? (
                <div className="msg-agent">
                  <div className="body">
                    <div className="tool">
                      <b>{item.title}</b>
                      {item.toolKind ? ` · ${item.toolKind}` : ""} → {TOOL_LABEL[item.status]}
                      {item.detail && (
                        <details>
                          <summary>Detalhes</summary>
                          <pre>{item.detail}</pre>
                        </details>
                      )}
                    </div>
                  </div>
                </div>
              ) : item.kind === "permission" ? (
                <div className="msg-agent">
                  <div className="body">
                    <PermissionCard item={item} onRespond={onPermissionRespond} />
                  </div>
                </div>
              ) : item.kind === "error" ? (
                <div className="msg-agent">
                  <div className="body">
                    <div className="approval is-err" data-od-id="error-card">
                      <div className="approval-head">
                        <span className="status err">
                          <i className="dot s-err" />
                          Com erro
                        </span>
                      </div>
                      <div style={{ padding: "0 16px" }}>
                        <h3>Algo deu errado</h3>
                      </div>
                      <div className="errlog">{item.message}</div>
                      {index === items.length - 1 &&
                        (retryHasAttachments ? (
                          <p className="meta" style={{ padding: "0 16px 12px" }}>
                            Reenvie a mensagem manualmente para incluir os anexos.
                          </p>
                        ) : (
                          canRetry && (
                            <div className="approval-actions">
                              <button
                                type="button"
                                className="btn btn-primary"
                                data-od-id="error-retry"
                                onClick={onRetry}
                              >
                                Tentar de novo
                              </button>
                            </div>
                          )
                        ))}
                    </div>
                  </div>
                </div>
              ) : item.kind === "compaction" ? (
                <div>
                  <p className="meta day">
                    {item.status === "running"
                      ? "Compactando contexto…"
                      : item.status === "failed"
                        ? `Falha ao compactar: ${item.error ?? "erro desconhecido"}`
                        : "Contexto compactado"}
                  </p>
                  {item.status === "completed" && (
                    <details className="meta">
                      <summary>Resumo</summary>
                      <p>{item.summary}</p>
                    </details>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
        {running && last?.kind === "user_message" && (
          <div className="msg-agent">
            <div className="body">
              <span className="typing" role="status" aria-label="Digitando">
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
