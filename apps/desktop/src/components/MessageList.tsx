import type { ChatItem, PermissionOption } from "@bobagent/protocol";
import { useEffect, useRef, useState } from "react";

const statusBadge: Record<string, string> = {
  pending: "bg-zinc-700 text-zinc-300",
  in_progress: "bg-sky-900 text-sky-300",
  completed: "bg-emerald-900/60 text-emerald-300",
  failed: "bg-red-900/60 text-red-300",
};

function ToolCallRow({ item }: { item: Extract<ChatItem, { kind: "tool_call" }> }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-medium text-zinc-200">{item.title || "Tool call"}</span>
        {item.toolKind && <span className="text-zinc-500">{item.toolKind}</span>}
        <span
          className={`ml-auto rounded px-1.5 py-0.5 ${statusBadge[item.status] ?? statusBadge.pending}`}
        >
          {item.status}
        </span>
      </div>
      {item.detail && (
        <details className="mt-1">
          <summary className="cursor-pointer text-zinc-500">detail</summary>
          <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap text-zinc-400">
            {item.detail}
          </pre>
        </details>
      )}
    </div>
  );
}

function PermissionCard({
  item,
  onRespond,
}: {
  item: Extract<ChatItem, { kind: "permission" }>;
  onRespond: (requestId: string, optionId: string | null) => void;
}) {
  const [clicked, setClicked] = useState(false);
  const resolved = item.resolution !== null || clicked;
  const isReject = (o: PermissionOption) => o.kind.startsWith("reject");
  return (
    <div className="rounded-md border border-amber-800/60 bg-amber-950/40 px-3 py-2">
      <div className="text-sm font-medium text-amber-200">{item.title}</div>
      {item.resolution ? (
        <div className="mt-1 text-xs text-zinc-400">
          Resolved:{" "}
          {item.resolution.optionId === null
            ? "Cancelled"
            : (item.options.find((o) => o.optionId === item.resolution?.optionId)?.name ??
              item.resolution.optionId)}
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {item.options.map((o) => (
            <button
              key={o.optionId}
              type="button"
              disabled={resolved}
              onClick={() => {
                setClicked(true);
                onRespond(item.requestId, o.optionId);
              }}
              className={`rounded px-2.5 py-1 text-xs font-medium disabled:opacity-40 ${
                isReject(o)
                  ? "bg-zinc-700 text-zinc-200 hover:bg-zinc-600"
                  : "bg-sky-600 text-white hover:bg-sky-500"
              }`}
            >
              {o.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function MessageList({
  items,
  hasMore,
  onLoadEarlier,
  onPermissionRespond,
}: {
  items: ChatItem[];
  hasMore: boolean;
  onLoadEarlier: () => void;
  onPermissionRespond: (requestId: string, optionId: string | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, []);

  return (
    <div
      ref={ref}
      className="flex-1 space-y-3 overflow-y-auto px-6 py-4"
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {hasMore && (
        <button
          type="button"
          onClick={onLoadEarlier}
          className="mx-auto block rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
        >
          Load earlier
        </button>
      )}
      {items.map((item) => {
        switch (item.kind) {
          case "user_message":
            return (
              <div key={item.id} className="flex justify-end">
                <div
                  className={`max-w-[75%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${item.from ? "bg-violet-800/70" : "bg-sky-700/80"}`}
                >
                  {item.from && (
                    <div className="mb-1 text-xs text-violet-200">From agent {item.from.name}</div>
                  )}
                  {item.text}
                </div>
              </div>
            );
          case "agent_message":
            return (
              <div key={item.id} className="flex">
                <div className="max-w-[75%] rounded-lg bg-zinc-800 px-3 py-2 text-sm whitespace-pre-wrap">
                  {item.text}
                </div>
              </div>
            );
          case "agent_thought":
            return (
              <details key={item.id} className="text-xs text-zinc-500">
                <summary className="cursor-pointer">Thinking</summary>
                <div className="mt-1 whitespace-pre-wrap pl-3">{item.text}</div>
              </details>
            );
          case "tool_call":
            return <ToolCallRow key={item.id} item={item} />;
          case "permission":
            return <PermissionCard key={item.id} item={item} onRespond={onPermissionRespond} />;
          case "error":
            return (
              <div
                key={item.id}
                className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300"
              >
                {item.message}
              </div>
            );
          default:
            return null;
        }
      })}
      {items.length === 0 && (
        <p className="pt-8 text-center text-sm text-zinc-500">No messages yet. Say hi.</p>
      )}
    </div>
  );
}
