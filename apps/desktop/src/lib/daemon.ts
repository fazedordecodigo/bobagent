import { invoke } from "@tauri-apps/api/core";
import type { DaemonEventMap, MethodName, MethodParams, MethodResult } from "@boto/protocol";
import {
  DAEMON_NOT_CONNECTED,
  DAEMON_SOCKET_CLOSED,
  DAEMON_SOCKET_ERROR,
  errorFields,
  logInfo,
  logWarn,
} from "./log";

type DaemonConnection = { port: number; token: string };

type EventHandler<E extends keyof DaemonEventMap> = (data: DaemonEventMap[E]) => void;

export class DaemonClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  private handlers = new Map<string, Set<(data: never) => void>>();
  private reconnectDelay = 500;
  private closed = false;
  private connection: DaemonConnection | null = null;
  private everConnected = false;
  private reconnectCbs = new Set<() => void>();
  private failureCbs = new Set<(error: Error) => void>();
  private connecting: Promise<void> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private disconnectedAt: number | null = null;

  connect(): Promise<void> {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.closed = false;
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const opening = (async () => {
      await this.resolveConnection();
      await this.openSocket();
    })();
    const connection = opening.finally(() => {
      this.connecting = null;
    });
    this.connecting = connection;
    return connection;
  }

  private async resolveConnection(): Promise<void> {
    // Dev-only browser path: vite dev server outside Tauri has no invoke bridge.
    if (!("__TAURI_INTERNALS__" in window) && import.meta.env.DEV) {
      const p = new URLSearchParams(location.hash.split("?")[1] ?? location.hash.slice(1));
      this.connection = { port: Number(p.get("port")), token: p.get("token") ?? "" };
    } else {
      this.connection = await invoke<DaemonConnection>("daemon_connection");
    }
  }

  onReconnect(cb: () => void): () => void {
    this.reconnectCbs.add(cb);
    return () => this.reconnectCbs.delete(cb);
  }

  onFailure(cb: (error: Error) => void): () => void {
    this.failureCbs.add(cb);
    return () => this.failureCbs.delete(cb);
  }

  private openSocket(retry = false): Promise<void> {
    const { port, token } = this.connection!;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
      this.ws = ws;
      ws.onopen = () => {
        const wasReconnect = this.everConnected;
        const attempt = this.reconnectAttempt;
        const downMs = this.disconnectedAt === null ? undefined : Date.now() - this.disconnectedAt;
        this.reconnectAttempt = 0;
        this.disconnectedAt = null;
        this.reconnectDelay = 500;
        if (wasReconnect) {
          logInfo("daemon.socket_reconnected", { attempt, downMs });
        }
        if (this.everConnected || retry) {
          for (const cb of this.reconnectCbs) cb();
        }
        this.everConnected = true;
        resolve();
      };
      ws.onerror = () => {
        reject(new Error(DAEMON_SOCKET_ERROR));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if ("event" in msg) {
          const set = this.handlers.get(msg.event as string);
          if (set) for (const h of set) h(msg.data as never);
        } else if ("id" in msg) {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            if ("error" in msg) {
              p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
            } else {
              p.resolve(msg.result);
            }
          }
        }
      };
      ws.onclose = (ev) => {
        this.ws = null;
        for (const [, p] of this.pending) p.reject(new Error(DAEMON_SOCKET_CLOSED));
        this.pending.clear();
        if (!this.closed) {
          const attempt = ++this.reconnectAttempt;
          const nextDelayMs = this.reconnectDelay;
          this.disconnectedAt ??= Date.now();
          logWarn("daemon.socket_closed", {
            code: ev.code,
            wasClean: ev.wasClean,
            attempt,
            nextDelayMs,
          });
          setTimeout(() => {
            if (this.closed) return;
            void this.resolveConnection()
              .then(
                () => {
                  if (!this.closed) return this.openSocket(true);
                },
                (e: unknown) => {
                  if (this.closed) return;
                  logWarn("daemon.reconnect_failed", { attempt, ...errorFields(e) });
                  const err = e instanceof Error ? e : new Error(String(e));
                  for (const cb of this.failureCbs) cb(err);
                },
              )
              .catch((e: unknown) =>
                logWarn("daemon.reconnect_failed", { attempt, ...errorFields(e) }),
              );
          }, nextDelayMs);
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5000);
        }
      };
    });
  }

  request<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(DAEMON_NOT_CONNECTED));
    }
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on<E extends keyof DaemonEventMap>(event: E, cb: EventHandler<E>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    const fn = cb as (data: never) => void;
    set.add(fn);
    return () => set?.delete(fn);
  }

  close() {
    this.closed = true;
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      if (this.closed) this.ws?.close();
    }, 0);
  }
}
