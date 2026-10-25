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
