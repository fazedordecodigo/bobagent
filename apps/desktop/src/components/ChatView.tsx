import type { Agent } from "@openagent/protocol";
import { useState } from "react";
import { useChat } from "../hooks/useChat";
import type { DaemonClient } from "../lib/daemon";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";

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
  const { items, hasMore, runningTurn, status, loadEarlier } = useChat(client, agent.id);
  const [sendBusy, setSendBusy] = useState(false);

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
        <button
          type="button"
          onClick={onOpenSettings}
          className="ml-auto rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          title="Agent settings"
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
      <MessageList
        items={items}
        hasMore={hasMore}
        onLoadEarlier={loadEarlier}
        onPermissionRespond={(requestId, optionId) => {
          void client.request("permissions.respond", { requestId, optionId }).catch(() => {});
        }}
      />
      <Composer
        running={runningTurn !== null || sendBusy}
        onSend={async (text) => {
          setSendBusy(true);
          try {
            await client.request("chat.send", { agentId: agent.id, text });
          } finally {
            setSendBusy(false);
          }
        }}
        onStop={() => void client.request("chat.cancel", { agentId: agent.id }).catch(() => {})}
      />
    </div>
  );
}
