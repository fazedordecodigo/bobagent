import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { Icon, type IconName } from "./icons";

export type OutgoingAttachment = { name: string; mime: string; dataBase64: string };

const MAX_BYTES = 25 * 1024 * 1024;

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function Composer({
  running,
  text,
  onTextChange,
  placeholder,
  hint,
  hintError,
  toolCount,
  contextIcon,
  onTools,
  onSend,
  onStop,
  onTranscribe,
  children,
}: {
  running: boolean;
  text: string;
  onTextChange: (text: string) => void;
  placeholder: string;
  hint: string;
  hintError?: string | null;
  toolCount: number;
  contextIcon: IconName;
  onTools: () => void;
  onSend: (text: string, attachments: OutgoingAttachment[]) => Promise<void>;
  onStop: () => void;
  onTranscribe?: ((audioBase64: string, mime: string) => Promise<string>) | undefined;
  children?: ReactNode;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const toggleMic = async () => {
    if (!onTranscribe) return;
    if (recorder.current) {
      recorder.current.stop();
      return;
    }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      mediaRecorder.ondataavailable = (event) => chunks.push(event.data);
      mediaRecorder.onstop = async () => {
        for (const track of stream.getTracks()) track.stop();
        recorder.current = null;
        setRecording(false);
        const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
        try {
          const data = await readBase64(
            new File([blob], "voice", { type: mediaRecorder.mimeType }),
          );
          const transcript = await onTranscribe(data, mediaRecorder.mimeType);
          if (transcript) onTextChange(text ? `${text} ${transcript}` : transcript);
          textRef.current?.focus();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      };
      recorder.current = mediaRecorder;
      mediaRecorder.start();
      setRecording(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const outgoingText = text.trim() || (files.length ? "Veja os arquivos anexados." : "");
    if (!outgoingText) return;
    setError(null);
    try {
      if (files.reduce((total, file) => total + file.size, 0) > MAX_BYTES)
        throw new Error("Os anexos excedem 25 MB.");
      const attachments = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          mime: file.type || "application/octet-stream",
          dataBase64: await readBase64(file),
        })),
      );
      await onSend(outgoingText, attachments);
      onTextChange("");
      setFiles([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const hintText = error ?? hintError ?? hint;
  return (
    <div className="composer-wrap" data-od-id="composer">
      {children}
      {files.length > 0 && (
        <div className="suggest">
          {files.map((file, index) => (
            <button
              key={`${file.name}-${file.size}-${file.lastModified}`}
              type="button"
              className="chip"
              title="Remover anexo"
              onClick={() => setFiles((prev) => prev.filter((_, i) => i !== index))}
            >
              {file.name} ×
            </button>
          ))}
        </div>
      )}
      <form className="composer" onSubmit={(event) => void submit(event)}>
        <label className="sr" htmlFor="prompt">
          Mensagem para o agente
        </label>
        <textarea
          ref={textRef}
          id="prompt"
          rows={1}
          placeholder={placeholder}
          value={text}
          onChange={(event) => {
            onTextChange(event.target.value);
            event.target.style.height = "auto";
            event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="composer-bar">
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            accept="image/*,audio/*,video/*,.zip,.mp3,.mov,.pdf,.txt,.md,.json,.csv"
            onChange={(event) => {
              setFiles((prev) => [...prev, ...Array.from(event.target.files ?? [])].slice(0, 10));
              event.target.value = "";
            }}
          />
          <button
            type="button"
            className="icon-btn"
            aria-label="Anexar arquivo"
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="clip" />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Escolher ferramentas"
            onClick={onTools}
          >
            <Icon name="plug" />
          </button>
          {onTranscribe && (
            <button
              type="button"
              className="icon-btn"
              aria-label={recording ? "Parar gravação" : "Ditado por voz"}
              title={recording ? "Parar e transcrever" : "Ditado por voz"}
              style={recording ? { color: "var(--st-err)" } : undefined}
              onClick={() => void toggleMic()}
            >
              <Icon name={recording ? "stop" : "mic"} />
            </button>
          )}
          <span className="ctx" id="ctxChip">
            <Icon name={contextIcon} size={14} />
            {toolCount === 0 ? "Sem ferramentas" : `${toolCount} ferramenta${toolCount > 1 ? "s" : ""}`}
          </span>
          <span className="grow" />
          {running && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onStop}>
              <Icon name="stop" />
              Parar
            </button>
          )}
          <button
            type="submit"
            className="send"
            aria-label="Enviar"
            disabled={!text.trim() && files.length === 0}
            data-od-id="send-button"
          >
            <Icon name="up" />
          </button>
        </div>
      </form>
      <p className={`hint${error || hintError ? " is-err" : ""}`} aria-live="polite">
        {hintText}
      </p>
    </div>
  );
}
