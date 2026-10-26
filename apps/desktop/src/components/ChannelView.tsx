import type { Agent, Channel, ChannelMessage } from "@upbot/protocol";
import { useEffect, useRef, useState } from "react";
import type { DaemonClient } from "../lib/daemon";
import { btnCls, inputCls } from "./AgentSettings";

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
  const name = (id: string | null) => agents.find((a) => a.id === id)?.name ?? "deleted bot";

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

  const archived = channel.status === "archived";
  const byId = new Map(messages.map((m) => [m.id, m]));
  const author = (m: ChannelMessage) =>
    m.authorKind === "agent" ? name(m.authorAgentId) : m.authorKind === "user" ? "You" : "system";
  const mention = /(^|\s)@([\w-]*)$/.exec(text);
  const suggestions = mention
    ? ["everyone", ...channel.memberIds.map((id) => name(id))].filter((n) =>
        n.toLowerCase().startsWith(mention[2]!.toLowerCase()),
      )
    : [];
  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-3">
        <h2 className="text-sm font-semibold"># {channel.name}</h2>
        <span className="text-xs text-zinc-500">{channel.status}</span>
        <span className="text-xs text-zinc-500">
          members: {channel.memberIds.map((id) => name(id)).join(", ")}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <label className="text-xs text-zinc-400">
            Owner{" "}
            <select
              className={`${inputCls} w-auto py-1`}
              value={channel.ownerId ?? ""}
              disabled={archived}
              onChange={(e) =>
                act(() =>
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
          {channel.status === "active" && (
            <button
              type="button"
              className={`${btnCls} bg-red-800 hover:bg-red-700`}
              onClick={() => act(() => client.request("channels.stop", { channelId: channel.id }))}
            >
              Stop
            </button>
          )}
          {channel.status === "stopped" && (
            <button
              type="button"
              className={`${btnCls} bg-zinc-800 hover:bg-zinc-700`}
              onClick={() =>
                act(() => client.request("channels.resume", { channelId: channel.id }))
              }
            >
              Resume
            </button>
          )}
          {archived ? (
            <button
              type="button"
              className={`${btnCls} bg-zinc-800 hover:bg-zinc-700`}
              onClick={() =>
                act(() => client.request("channels.restore", { channelId: channel.id }))
              }
            >
              Restore
            </button>
          ) : (
            <button
              type="button"
              className={`${btnCls} bg-zinc-800 hover:bg-zinc-700`}
              onClick={() =>
                act(() => client.request("channels.archive", { channelId: channel.id }))
              }
            >
              Archive
            </button>
          )}
        </div>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.map((m) =>
          m.authorKind === "system" ? (
            <p key={m.id} className="text-center text-xs text-zinc-500">
              {m.text}
            </p>
          ) : (
            <div
              key={m.id}
              className={`group flex items-start gap-1 ${m.authorKind === "user" ? "flex-row-reverse" : ""}`}
            >
              <div
                className={`max-w-[75%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                  m.authorKind === "user" ? "bg-sky-700/80" : "bg-zinc-800"
                }`}
              >
                {m.replyTo && byId.get(m.replyTo) && (
                  <div className="mb-1 border-l-2 border-zinc-500 pl-2 text-xs text-zinc-300 opacity-80">
                    {author(byId.get(m.replyTo)!)}: {byId.get(m.replyTo)!.text.slice(0, 140)}
                  </div>
                )}
                {m.authorKind === "agent" && (
                  <div className="mb-1 text-xs text-zinc-400">
                    {name(m.authorAgentId)}
                    {m.authorAgentId === channel.ownerId ? " (owner)" : ""}
                  </div>
                )}
                {m.text}
              </div>
              {channel.status === "active" && (
                <button
                  type="button"
                  className="invisible mt-1 text-xs text-zinc-500 group-hover:visible hover:text-zinc-300"
                  title="Reply"
                  aria-label="Reply"
                  onClick={() => setReplyTo(m)}
                >
                  ↩ Reply
                </button>
              )}
            </div>
          ),
        )}
        {messages.length === 0 && (
          <p className="text-sm text-zinc-500">
            Messages go to the owner, who can delegate to the other bots. Use @Name to talk to a bot
            directly, @everyone to ask all of them, or reply to a bot's message.
          </p>
        )}
        <div ref={bottomRef} />
      </div>
      {error && <p className="px-4 text-xs text-red-400">{error}</p>}
      {replyTo && (
        <div className="flex items-center gap-2 border-t border-zinc-800 px-4 py-1 text-xs text-zinc-400">
          Replying to {author(replyTo)}:{" "}
          <span className="truncate">{replyTo.text.slice(0, 100)}</span>
          <button
            type="button"
            className="ml-auto hover:text-zinc-200"
            aria-label="Cancel reply"
            onClick={() => setReplyTo(null)}
          >
            ×
          </button>
        </div>
      )}
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1 border-t border-zinc-800 px-4 py-1">
          {suggestions.map((n) => (
            <button
              key={n}
              type="button"
              className="rounded bg-zinc-800 px-2 py-0.5 text-xs hover:bg-zinc-700"
              onClick={() => {
                setText(text.replace(/@([\w-]*)$/, `@${n} `));
                inputRef.current?.focus();
              }}
            >
              @{n}
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-2 border-t border-zinc-800 p-3">
        <textarea
          ref={inputRef}
          className={`${inputCls} min-h-[44px] flex-1 resize-none`}
          placeholder={
            channel.status === "active"
              ? `Message #${channel.name}`
              : `Group chat is ${channel.status}`
          }
          disabled={channel.status !== "active"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          type="button"
          className={`${btnCls} bg-sky-700 hover:bg-sky-600`}
          disabled={channel.status !== "active" || !text.trim()}
          onClick={send}
        >
          Send
        </button>
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
