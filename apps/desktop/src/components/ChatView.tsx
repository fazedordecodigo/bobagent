import type { Agent } from "@upbot/protocol";
import { useEffect, useState } from "react";
import { useChat } from "../hooks/useChat";
import type { DaemonClient } from "../lib/daemon";
import { PermissionNotice } from "./AgentSettings";
import { Composer } from "./Composer";
import { DraftCards } from "./EmailView";
import { MessageList } from "./MessageList";
import { UsageBar } from "./UsageBar";

const dotCls: Record<string, string> = {
  idle: "bg-zinc-500",
  starting: "bg-sky-400 animate-pulse",
  running: "bg-emerald-400 animate-pulse",
  awaiting_permission: "bg-amber-400",
  error: "bg-red-500",
};

export function ChatView({
  client,
  agent,
  onOpenSettings,
}: {
  client: DaemonClient;
  agent: Agent;
  onOpenSettings: () => void;
}) {
  const {
    items,
    hasMore,
    runningTurn,
    loaded,
    status,
    queue,
    loadEarlier,
    queuePause,
    queueResume,
    queueRemove,
  } = useChat(client, agent.id);
  const [sendBusy, setSendBusy] = useState(false);
  const [voice, setVoice] = useState({ tts: false, stt: false });
  useEffect(() => {
    client
      .request("voice.status", {})
      .then(setVoice)
      .catch(() => {});
  }, [client]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${dotCls[status.status] ?? dotCls.idle}`}
          title={status.error ?? status.status}
        />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{agent.name}</div>
          <div className="text-xs text-zinc-500">
            {agent.provider}
            {status.status !== "idle" ? ` · ${status.status}` : ""}
          </div>
        </div>
        <div className="ml-auto">
          <UsageBar
            client={client}
            agentId={agent.id}
            busy={status.status !== "idle" && status.status !== "error"}
          />
        </div>
        <button
          type="button"
          onClick={onOpenSettings}
          className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          title="Bot settings"
        >
          <svg
            role="img"
            aria-label="Settings"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
      {items.length === 0 && loaded && (
        <div className="px-4 pt-3">
          <PermissionNotice provider={agent.provider} />
        </div>
      )}
      <MessageList
        items={items}
        hasMore={hasMore}
        onLoadEarlier={loadEarlier}
        onSpeak={
          voice.tts
            ? (text) => void client.request("voice.speak", { text }).catch(() => {})
            : undefined
        }
        onPermissionRespond={(requestId, optionId) => {
          void client.request("permissions.respond", { requestId, optionId }).catch(() => {});
        }}
      />
      {queue && queue.items.length > 0 && (
        <div className="border-t border-zinc-800 px-4 py-2">
          {queue.paused && (
            <div className="mb-2 flex items-center justify-between rounded bg-amber-900/40 px-2 py-1 text-xs text-amber-300">
              Queue paused
              <button type="button" className="underline" onClick={queueResume}>
                Resume
              </button>
            </div>
          )}
          {!queue.paused && (
            <div className="mb-1 flex justify-end">
              <button
                type="button"
                className="text-xs text-zinc-500 underline"
                onClick={queuePause}
              >
                Pause queue
              </button>
            </div>
          )}
          <ul className="space-y-1">
            {queue.items.map((q) => (
              <li
                key={q.id}
                className="flex items-center justify-between rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
              >
                <span className="truncate">Queued: {q.text.slice(0, 80)}</span>
                <button
                  type="button"
                  aria-label="Remove queued message"
                  className="ml-2 text-zinc-500 hover:text-zinc-200"
                  onClick={() => queueRemove(q.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {queue?.paused && queue.items.length === 0 && (
        <div className="border-t border-zinc-800 px-4 py-2">
          <div className="flex items-center justify-between rounded bg-amber-900/40 px-2 py-1 text-xs text-amber-300">
            Queue paused
            <button type="button" className="underline" onClick={queueResume}>
              Resume
            </button>
          </div>
        </div>
      )}
      <DraftCards client={client} agentId={agent.id} />
      <Composer
        onTranscribe={
          voice.stt
            ? async (audioBase64, mime) =>
                (await client.request("voice.transcribe", { audioBase64, mime })).text
            : undefined
        }
        running={runningTurn !== null || sendBusy}
        onSend={async (text, attachments) => {
          setSendBusy(true);
          try {
            await client.request("chat.send", {
              agentId: agent.id,
              text,
              ...(attachments.length ? { attachments } : {}),
            });
          } finally {
            setSendBusy(false);
          }
        }}
        onStop={() => void client.request("chat.cancel", { agentId: agent.id }).catch(() => {})}
      />
    </div>
  );
}
