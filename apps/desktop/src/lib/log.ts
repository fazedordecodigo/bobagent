import { error as logError_, info as logInfo_, warn as logWarn_ } from "@tauri-apps/plugin-log";

export type LogFields = Record<string, unknown>;

export const DAEMON_NOT_CONNECTED = "daemon not connected";
export const DAEMON_SOCKET_CLOSED = "daemon socket closed";
export const DAEMON_SOCKET_ERROR = "daemon socket error";

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

/** Returns safe error fields without including untrusted error messages. */
export function errorFields(error: unknown): LogFields {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return {
      code: typeof code === "string" && /^[a-z][a-z0-9_.-]{0,63}$/.test(code) ? code : "invalid",
    };
  }
  const message = errorMessage(error);
  if (
    message === DAEMON_NOT_CONNECTED ||
    message === DAEMON_SOCKET_CLOSED ||
    message === DAEMON_SOCKET_ERROR
  )
    return { error: message };
  return { errorType: error instanceof Error ? error.name : typeof error };
}
