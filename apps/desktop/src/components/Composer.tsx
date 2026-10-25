import { useRef, useState } from "react";

export type OutgoingAttachment = { name: string; mime: string; dataBase64: string };

const MAX_BYTES = 25 * 1024 * 1024;

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",", 2)[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function Composer({
  running,
  onSend,
  onStop,
}: {
  running: boolean;
  onSend: (text: string, attachments: OutgoingAttachment[]) => Promise<void>;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    const t = text.trim() || (files.length > 0 ? "See the attached files." : "");
    if (!t) return;
    setError(null);
    try {
      if (files.reduce((n, f) => n + f.size, 0) > MAX_BYTES)
        throw new Error("attachments exceed 25 MB");
      const attachments = await Promise.all(
        files.map(async (f) => ({
          name: f.name,
          mime: f.type || "application/octet-stream",
          dataBase64: await readBase64(f),
        })),
      );
      await onSend(t, attachments);
      setText("");
      setFiles([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="border-t border-zinc-800 px-4 py-3">
      {error && <div className="mb-2 text-xs text-red-400">{error}</div>}
      {files.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {files.map((f, i) => (
            <button
              key={`${f.name}-${f.size}-${f.lastModified}`}
              type="button"
              className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-700"
              title="Remove"
              onClick={() => setFiles(files.filter((_, j) => j !== i))}
            >
              📎 {f.name} ×
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          accept="image/*,audio/*,video/*,.zip,.mp3,.mov,.pdf,.txt,.md,.json,.csv"
          onChange={(e) => {
            setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 10));
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="rounded-md px-2 py-2 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          title="Attach files"
        >
          📎
        </button>
        <textarea
          className="max-h-40 min-h-10 flex-1 resize-y rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-zinc-500 focus:outline-none"
          placeholder="Message the agent…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {running && (
          <button
            type="button"
            onClick={onStop}
            className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-600"
          >
            Stop
          </button>
        )}
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!text.trim() && files.length === 0}
          className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}
