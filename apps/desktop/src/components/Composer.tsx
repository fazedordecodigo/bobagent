import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { errorMessage } from "../lib/errors";
import { Icon } from "./icons";

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
  onSend: (text: string, attachments: OutgoingAttachment[]) => Promise<void>;
  onStop: () => void;
  onTranscribe?: ((audioBase64: string, mime: string) => Promise<string>) | undefined;
  children?: ReactNode;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [micPending, setMicPending] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const activeStream = useRef<MediaStream | null>(null);
  const micPendingRef = useRef(false);
  const unmounted = useRef(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      const activeRecorder = recorder.current;
      recorder.current = null;
      if (activeRecorder && activeRecorder.state !== "inactive") activeRecorder.stop();
      activeStream.current?.getTracks().forEach((track) => {
        track.stop();
      });
      activeStream.current = null;
    };
  }, []);

  const toggleMic = async () => {
    if (!onTranscribe || micPendingRef.current) return;
    if (recorder.current) {
      recorder.current.stop();
      return;
    }
    micPendingRef.current = true;
    setMicPending(true);
    setError(null);
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (unmounted.current) {
        mediaStream.getTracks().forEach((track) => {
          track.stop();
        });
        return;
      }
      activeStream.current = mediaStream;
      const mediaRecorder = new MediaRecorder(mediaStream);
      const chunks: Blob[] = [];
      mediaRecorder.ondataavailable = (event) => chunks.push(event.data);
      mediaRecorder.onstop = async () => {
        for (const track of mediaStream.getTracks()) track.stop();
        activeStream.current = null;
        recorder.current = null;
        if (unmounted.current) return;
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
          setError(errorMessage(e));
        }
      };
      recorder.current = mediaRecorder;
      mediaRecorder.start();
      setRecording(true);
    } catch (e) {
      if (!unmounted.current) setError(errorMessage(e));
    } finally {
      micPendingRef.current = false;
      if (!unmounted.current) setMicPending(false);
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
      setError(errorMessage(e));
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
        <div className="composer-row">
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
          <label className="sr" htmlFor="prompt">
            Mensagem para o bot
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
          {onTranscribe && (
            <button
              type="button"
              className="icon-btn"
              aria-label={recording ? "Parar gravação" : "Ditado por voz"}
              title={recording ? "Parar e transcrever" : "Ditado por voz"}
              disabled={micPending}
              aria-busy={micPending}
              style={recording ? { color: "var(--st-err)" } : undefined}
              onClick={() => void toggleMic()}
            >
              <Icon name={recording ? "stop" : "mic"} />
            </button>
          )}
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
