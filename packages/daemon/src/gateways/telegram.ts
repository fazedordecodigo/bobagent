import { envNumber } from "../env/vars";
import {
  INITIAL_BACKOFF_MS,
  nextBackoff,
  splitText,
  type Transport,
  type TransportHooks,
} from "./common";

type Update = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number; username?: string; first_name?: string; is_bot?: boolean };
    text?: string;
  };
};

export class TelegramTransport implements Transport {
  private running = false;
  private offset = 0;
  private abort: AbortController | null = null;
  // 0 keeps the short-poll behavior for whoever disables long-polling on purpose;
  // an invalid value falls back to 25 instead of serializing as `timeout: null`.
  private readonly pollSeconds = envNumber("BOTO_TELEGRAM_POLL_SECONDS", 25, { min: 0 });

  constructor(
    private token: string,
    private hooks: TransportHooks,
  ) {}

  private url(method: string) {
    return `${process.env.BOTO_TELEGRAM_API ?? "https://api.telegram.org"}/bot${this.token}/${method}`;
  }

  private async call<T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(this.url(method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) throw new Error(json.description ?? `telegram ${method} failed (${res.status})`);
    return json.result as T;
  }

  start() {
    this.running = true;
    void this.loop();
  }

  stop() {
    this.running = false;
    this.abort?.abort();
  }

  private async loop() {
    let backoff = INITIAL_BACKOFF_MS;
    let first = true;
    while (this.running) {
      try {
        if (first) {
          await this.call("getMe", {});
          this.hooks.onStatus("connected");
          first = false;
        }
        this.abort = new AbortController();
        const updates = await this.call<Update[]>(
          "getUpdates",
          { offset: this.offset, timeout: this.pollSeconds, allowed_updates: ["message"] },
          this.abort.signal,
        );
        backoff = INITIAL_BACKOFF_MS;
        for (const u of updates) {
          this.offset = u.update_id + 1;
          const m = u.message;
          if (!m?.text || !m.from || m.from.is_bot) continue;
          this.hooks.onMessage({
            chatId: String(m.chat.id),
            userId: String(m.from.id),
            userName: m.from.username ?? m.from.first_name ?? String(m.from.id),
            text: m.text,
            replyTo: String(m.message_id),
          });
        }
      } catch (e) {
        if (!this.running) return;
        first = true;
        this.hooks.onStatus("error", (e as Error).message);
        await Bun.sleep(backoff);
        backoff = nextBackoff(backoff);
      }
    }
  }

  async send(chatId: string, text: string, replyTo?: string) {
    for (const [i, part] of splitText(text, 4000).entries()) {
      await this.call("sendMessage", {
        chat_id: chatId,
        text: part,
        ...(i === 0 && replyTo
          ? { reply_parameters: { message_id: Number(replyTo), allow_sending_without_reply: true } }
          : {}),
      });
    }
  }
}
