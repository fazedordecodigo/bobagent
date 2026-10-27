import type { Agent, Channel, ChannelMessage } from "@upbot/protocol";
import { useEffect, useRef, useState } from "react";
import type { DaemonClient } from "../lib/daemon";
import { MonoAv } from "../lib/ui";
import { btnCls, inputCls } from "./AgentSettings";
import { CopyButton } from "./CopyButton";
import { Icon } from "./icons";
import { Markdown } from "./Markdown";
import { messageDay } from "./MessageList";

export function ChannelView({
  client,
  channel,
  agents,
}: {
  client: DaemonClient;
  channel: Channel;
  agents: Agent[];
}) {
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<ChannelMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const name = (id: string | null) => agents.find((a) => a.id === id)?.name ?? "bot removido";

  useEffect(() => {
    let alive = true;
    setMessages([]);
    client
      .request("channels.history", { channelId: channel.id })
      .then((r) => {
        if (alive) setMessages(r.messages);
      })
      .catch((e) => setError(String(e)));
    const off = client.on("channel.message", (m) => {
      if (m.channelId !== channel.id) return;
      setMessages((prev) => (prev.some((p) => p.id === m.id) ? prev : [...prev, m]));
    });
    return () => {
      alive = false;
      off();
    };
  }, [client, channel.id]);

  const count = messages.length;
  useEffect(() => {
    if (count > 0) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [count]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const send = () => {
    const t = text.trim();
    if (!t) return;
    act(async () => {
      await client.request("channels.post", {
        channelId: channel.id,
        text: t,
        ...(replyTo ? { replyTo: replyTo.id } : {}),
      });
      setText("");
      setReplyTo(null);
    });
  };

  const active = channel.status === "active";
  const archived = channel.status === "archived";
  const byId = new Map(messages.map((m) => [m.id, m]));
  const author = (m: ChannelMessage) =>
    m.authorKind === "agent" ? name(m.authorAgentId) : m.authorKind === "user" ? "Você" : "sistema";
  const quote = (m: ChannelMessage) => {
    const quoted = m.replyTo ? byId.get(m.replyTo) : null;
    return quoted ? (
      <div className="quote">
        <b>{author(quoted)}:</b> {quoted.text}
      </div>
    ) : null;
  };
  const time = (timestamp: number) =>
    new Date(timestamp).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const mention = /(^|\s)@([\w-]*)$/.exec(text);
  const mentionText = mention?.[2]?.toLowerCase() ?? "";
  const suggestions = mention
    ? ["everyone", ...channel.memberIds.map((id) => name(id))].filter((n) =>
        n.toLowerCase().startsWith(mentionText),
      )
    : [];
  const status =
    channel.status === "active"
      ? { className: "ok", dot: "s-ok", label: "Ativa" }
      : channel.status === "stopped"
        ? { className: "wait", dot: "s-wait", label: "Parada" }
        : { className: "", dot: "s-idle", label: "Arquivada" };
  return (
    <div className="main channel-view" style={{ flex: 1 }}>
      <header className="main-head channel-head">
        <span className="mono-av lg">#</span>
        <div className="title">
          <h2>{channel.name}</h2>
          <p>Membros: {channel.memberIds.map((id) => name(id)).join(", ")}</p>
        </div>
        <span className={`status${status.className ? ` ${status.className}` : ""}`}>
          <i className={`dot ${status.dot}`} />
          {status.label}
        </span>
        <label className="channel-owner">
          Dono
          <select
            className="input"
            aria-label="Dono"
            value={channel.ownerId ?? ""}
            disabled={archived}
            onChange={(e) =>
              void act(() =>
                client.request("channels.reassign", {
                  channelId: channel.id,
                  ownerId: e.target.value,
                }),
              )
            }
          >
            {channel.memberIds.map((id) => (
              <option key={id} value={id}>
                {name(id)}
              </option>
            ))}
          </select>
        </label>
        <div className="channel-actions">
          {active && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() =>
                void act(() => client.request("channels.stop", { channelId: channel.id }))
              }
            >
              Parar
            </button>
          )}
          {channel.status === "stopped" && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() =>
                void act(() => client.request("channels.resume", { channelId: channel.id }))
              }
            >
              Retomar
            </button>
          )}
          {archived ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() =>
                void act(() => client.request("channels.restore", { channelId: channel.id }))
              }
            >
              Restaurar
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() =>
                void act(() => client.request("channels.archive", { channelId: channel.id }))
              }
            >
              Arquivar
            </button>
          )}
        </div>
      </header>
      <div className="thread" aria-live="polite">
        <div className="thread-inner channel-thread-inner">
          {messages.map((m, index) => {
            const previous = messages[index - 1];
            const separator =
              !previous ||
              new Date(previous.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
            return (
              <div className="channel-message" key={m.id}>
                {separator && <p className="meta day">{messageDay(m.createdAt)}</p>}
                {m.authorKind === "system" ? (
                  <p className="meta day">{m.text}</p>
                ) : m.authorKind === "user" ? (
                  <div className="channel-user-row">
                    <div className="msg-user channel-user-bubble">
                      <div className="channel-user-who">
                        Você <span className="meta">{time(m.createdAt)}</span>
                      </div>
                      {quote(m)}
                      <p className="channel-user-text">{m.text}</p>
                    </div>
                    {active && (
                      <div className="msg-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            setReplyTo(m);
                            inputRef.current?.focus();
                          }}
                        >
                          Responder
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="msg-agent">
                    <MonoAv
                      agent={
                        agents.find((agent) => agent.id === m.authorAgentId) ?? {
                          name: "?",
                          avatar: null,
                        }
                      }
                      dot={false}
                    />
                    <div className="body">
                      <div className="who">
                        {name(m.authorAgentId)}
                        {m.authorAgentId === channel.ownerId && <span className="meta">dono</span>}
                        <span className="meta">{time(m.createdAt)}</span>
                        <div className="msg-actions">
                          <CopyButton text={m.text} />
                          {active && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => {
                                setReplyTo(m);
                                inputRef.current?.focus();
                              }}
                            >
                              Responder
                            </button>
                          )}
                        </div>
                      </div>
                      {quote(m)}
                      <Markdown text={m.text} />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {messages.length === 0 && (
            <div className="empty">
              <p>
                As mensagens vão para o dono, que pode delegar aos outros bots. Use @Nome para falar
                com um bot, @everyone para todos, ou responda a uma mensagem de um bot.
              </p>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
      <div className="composer-wrap channel-composer-wrap">
        {error && (
          <p className="meta channel-error" role="alert">
            {error}
          </p>
        )}
        <form
          className="composer channel-composer"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          {replyTo && (
            <div className="composer-reply channel-composer-reply">
              <span className="meta">
                Respondendo a {author(replyTo)}: {replyTo.text}
              </span>
              <button
                type="button"
                className="icon-btn"
                aria-label="Cancelar resposta"
                onClick={() => setReplyTo(null)}
              >
                <Icon name="x" />
              </button>
            </div>
          )}
          {suggestions.length > 0 && (
            <div className="channel-mentions">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="chip"
                  onClick={() => {
                    setText((current) => {
                      const match = /(^|\s)@([\w-]*)$/.exec(current);
                      if (!match) return current;
                      const end = match.index + (match[1]?.length ?? 0);
                      return `${current.slice(0, end)}@${suggestion} `;
                    });
                    inputRef.current?.focus();
                  }}
                >
                  @{suggestion}
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            rows={1}
            aria-label={`Mensagem para #${channel.name}`}
            placeholder={
              active
                ? `Mensagem para #${channel.name}`
                : archived
                  ? "Conversa em grupo arquivada"
                  : "Conversa em grupo parada"
            }
            disabled={!active}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="composer-bar">
            <span className="grow" />
            <button
              type="submit"
              className="send"
              aria-label="Enviar"
              disabled={!active || !text.trim()}
            >
              <Icon name="up" />
            </button>
          </div>
        </form>
        <p className="hint">Enter envia · Shift+Enter quebra linha</p>
      </div>
    </div>
  );
}

export function ChannelCreateForm({
  agents,
  onSubmit,
  onCancel,
}: {
  agents: Agent[];
  onSubmit: (form: { name: string; memberIds: string[]; ownerId: string | null }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const owner = ownerId && members.includes(ownerId) ? ownerId : (members[0] ?? null);
  return (
    <form
      className="max-w-lg space-y-4 p-6"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        onSubmit({ name: name.trim(), memberIds: members, ownerId: owner }).catch((err) =>
          setError(err instanceof Error ? err.message : String(err)),
        );
      }}
    >
      <h2 className="text-lg font-semibold">New group chat</h2>
      <label className="block text-sm">
        Name
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <fieldset className="space-y-1 text-sm">
        <legend>Members</legend>
        {agents.map((a) => (
          <label key={a.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={members.includes(a.id)}
              onChange={(e) =>
                setMembers((prev) =>
                  e.target.checked ? [...prev, a.id] : prev.filter((x) => x !== a.id),
                )
              }
            />
            {a.name} <span className="text-xs text-zinc-500">{a.provider}</span>
          </label>
        ))}
      </fieldset>
      <label className="block text-sm">
        Owner
        <select
          className={inputCls}
          value={owner ?? ""}
          onChange={(e) => setOwnerId(e.target.value)}
        >
          {members.map((id) => (
            <option key={id} value={id}>
              {agents.find((a) => a.id === id)?.name}
            </option>
          ))}
        </select>
      </label>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          className={`${btnCls} bg-sky-700 hover:bg-sky-600`}
          disabled={!name.trim() || members.length === 0}
        >
          Create
        </button>
        <button
          type="button"
          className={`${btnCls} bg-zinc-800 hover:bg-zinc-700`}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
