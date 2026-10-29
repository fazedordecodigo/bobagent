import { error as logError_, info as logInfo_, warn as logWarn_ } from "@tauri-apps/plugin-log";

export type LogFields = Record<string, unknown>;

function inTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function format(scope: string, fields?: LogFields) {
  const entries = fields ? Object.entries(fields).filter(([, v]) => v !== undefined) : [];
  return entries.length
    ? `[desktop] ${scope} ${JSON.stringify(Object.fromEntries(entries))}`
    : `[desktop] ${scope}`;
}

function send(level: "warn" | "error" | "info", scope: string, fields?: LogFields) {
  const message = format(scope, fields);
  if (inTauri()) {
    const fn = level === "warn" ? logWarn_ : level === "error" ? logError_ : logInfo_;
    // Logging observes; it must never break the caller.
    void fn(message).catch(() => {});
  } else {
    // Dev-only browser path (vite dev / smoke:ui): no Tauri log target.
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
    fn(message);
  }
}

export function logWarn(scope: string, fields?: LogFields) {
  send("warn", scope, fields);
}

export function logError(scope: string, fields?: LogFields) {
  send("error", scope, fields);
}

export function logInfo(scope: string, fields?: LogFields) {
  send("info", scope, fields);
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** `{ error, code? }` fields for an RPC failure; never includes params or payloads. */
export function errorFields(error: unknown): LogFields {
  const fields: LogFields = { error: errorMessage(error) };
  const code =
    error instanceof Error && "code" in error ? (error as { code?: unknown }).code : undefined;
  if (code !== undefined) fields.code = String(code);
  return fields;
}
