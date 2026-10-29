import type { GatewayStatus } from "@upbot/protocol";

export type Inbound = {
  chatId: string;
  userId: string;
  userName: string;
  text: string;
  replyTo?: string;
};
export type Transport = {
  start(): void;
  stop(): void;
  send(chatId: string, text: string, replyTo?: string): Promise<void>;
};
export type TransportHooks = {
  onMessage: (m: Inbound) => void;
  onStatus: (status: GatewayStatus, error?: string | null) => void;
};

export const INITIAL_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 30_000;
export const nextBackoff = (ms: number) => Math.min(ms * 2, MAX_BACKOFF_MS);
export const STABLE_CONNECTION_MS = 30_000;

// Reconnect delays for socket transports. Opening a socket (or a handshake) does not reset the
// delay: only a connection that stayed healthy for STABLE_CONNECTION_MS does, so a server that
// accepts and promptly closes keeps backing off instead of being retried every second.
export class ReconnectBackoff {
  private delay = INITIAL_BACKOFF_MS;
  private healthySince: number | null = null;

  constructor(private now: () => number = Date.now) {}

  markHealthy() {
    this.healthySince = this.now();
  }

  next(): number {
    if (this.healthySince !== null && this.now() - this.healthySince >= STABLE_CONNECTION_MS)
      this.delay = INITIAL_BACKOFF_MS;
    this.healthySince = null;
    const delay = this.delay;
    this.delay = nextBackoff(delay);
    return delay;
  }
}
export const closeDetail = (ev: { code: number; reason: string }) =>
  `closed ${ev.code}${ev.reason ? ` ${ev.reason}` : ""}`;

export function splitText(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}
