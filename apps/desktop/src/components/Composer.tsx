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
  onTranscribe,
}: {
  running: boolean;
  onSend: (text: string, attachments: OutgoingAttachment[]) => Promise<void>;
  onStop: () => void;
  onTranscribe?: ((audioBase64: string, mime: string) => Promise<string>) | undefined;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const [recording, setRecording] = useState(false);

  const toggleMic = async () => {
    if (!onTranscribe) return;
    if (recorder.current) {
      recorder.current.stop();
      return;
    }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = async () => {
        for (const t of stream.getTracks()) t.stop();
        recorder.current = null;
        setRecording(false);
        const blob = new Blob(chunks, { type: rec.mimeType });
        try {
          const b64 = await readBase64(new File([blob], "voice", { type: rec.mimeType }));
          const heard = await onTranscribe(b64, rec.mimeType);
          if (heard) setText((t) => (t ? `${t} ${heard}` : heard));
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      };
      recorder.current = rec;
      rec.start();
      setRecording(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

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
        {onTranscribe && (
          <button
            type="button"
            onClick={() => void toggleMic()}
            className={`rounded-md px-2 py-2 text-sm hover:bg-zinc-800 ${recording ? "animate-pulse text-red-400" : "text-zinc-400 hover:text-zinc-200"}`}
            title={recording ? "Stop and transcribe" : "Dictate"}
          >
            🎙
          </button>
        )}
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
