import { useState } from "react";

export function Composer({
  running,
  onSend,
  onStop,
}: {
  running: boolean;
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    setError(null);
    try {
      await onSend(t);
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="border-t border-zinc-800 px-4 py-3">
      {error && <div className="mb-2 text-xs text-red-400">{error}</div>}
      <div className="flex items-end gap-2">
        <textarea
          className="max-h-40 min-h-10 flex-1 resize-y rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-zinc-500 focus:outline-none"
          placeholder="Message the agent…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!running) void submit();
            }
          }}
        />
        {running ? (
          <button
            type="button"
            onClick={onStop}
            className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-600"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!text.trim()}
            className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-40"
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
