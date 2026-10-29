import {
  closeDetail,
  INITIAL_BACKOFF_MS,
  nextBackoff,
  splitText,
  type Transport,
  type TransportHooks,
} from "./common";

// Discord Gateway v10: Hello -> Identify (+heartbeats) -> READY -> MESSAGE_CREATE.
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15); // GUILDS, GUILD_MESSAGES, DIRECT_MESSAGES, MESSAGE_CONTENT
// Close codes that reject the bot itself (bad token, sharding/intent misconfig):
// reconnecting with the same settings would loop forever.
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

type Frame = { op: number; t?: string | null; s?: number | null; d?: unknown };
type Message = {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  author: { id: string; username: string; bot?: boolean };
  mentions?: { id: string }[];
};

const api = () => process.env.UPBOT_DISCORD_API ?? "https://discord.com/api/v10";

export class DiscordTransport implements Transport {
  private ws: WebSocket | null = null;
  private running = false;
  private backoff = INITIAL_BACKOFF_MS;
  private seq: number | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private selfId = "";

  constructor(
    private token: string,
    private hooks: TransportHooks,
  ) {}

  private async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(api() + path, {
      method,
      headers: {
        authorization: `Bot ${this.token}`,
        "content-type": "application/json",
        "user-agent": "DiscordBot (https://github.com/fazedordecodigo/upbot, 0.1)",
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`discord ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  start() {
    this.running = true;
    void this.connect();
  }

  stop() {
    this.running = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
  }

  private async connect() {
    if (!this.running) return;
    try {
      const { url } = await this.rest<{ url: string }>("GET", "/gateway/bot");
      const ws = new WebSocket(`${url}?v=10&encoding=json`);
      this.ws = ws;
      ws.onmessage = (ev) => this.onFrame(ws, JSON.parse(String(ev.data)) as Frame);
      ws.onclose = (ev) => this.onClose(ws, ev);
    } catch (e) {
      this.hooks.onStatus("error", (e as Error).message);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    const delay = this.backoff;
    this.backoff = nextBackoff(this.backoff);
    setTimeout(() => void this.connect(), delay);
  }

  private onClose(ws: WebSocket, ev: CloseEvent) {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.ws !== ws || !this.running) return;
    if (FATAL_CLOSE_CODES.has(ev.code)) {
      this.hooks.onStatus("error", closeDetail(ev));
      return;
    }
    this.hooks.onStatus("connecting", closeDetail(ev));
    this.scheduleReconnect();
  }

  private onFrame(ws: WebSocket, f: Frame) {
    if (typeof f.s === "number") this.seq = f.s;
    if (f.op === 10) {
      const interval = (f.d as { heartbeat_interval: number }).heartbeat_interval;
      this.heartbeat = setInterval(() => ws.send(JSON.stringify({ op: 1, d: this.seq })), interval);
      ws.send(
        JSON.stringify({
          op: 2,
          d: {
            token: this.token,
            intents: INTENTS,
            properties: { os: "macos", browser: "upbot", device: "upbot" },
          },
        }),
      );
      return;
    }
    if (f.op === 1) {
      ws.send(JSON.stringify({ op: 1, d: this.seq }));
      return;
    }
    if (f.op === 7 || f.op === 9) {
      ws.close();
      return;
    }
    if (f.op !== 0) return;
    if (f.t === "READY") {
      this.selfId = (f.d as { user: { id: string } }).user.id;
      this.backoff = INITIAL_BACKOFF_MS;
      this.hooks.onStatus("connected");
      return;
    }
    if (f.t !== "MESSAGE_CREATE") return;
    const m = f.d as Message;
    if (m.author.bot || m.author.id === this.selfId) return;
    const mentioned = m.mentions?.some((u) => u.id === this.selfId) ?? false;
    if (m.guild_id && !mentioned) return; // in servers, only when mentioned; DMs always
    this.hooks.onMessage({
      chatId: m.channel_id,
      userId: m.author.id,
      userName: m.author.username,
      text: m.content.replace(new RegExp(`<@!?${this.selfId}>\\s*`, "g"), "").trim(),
      replyTo: m.id,
    });
  }

  async send(chatId: string, text: string, replyTo?: string) {
    for (const [i, part] of splitText(text, 1900).entries()) {
      await this.rest("POST", `/channels/${chatId}/messages`, {
        content: part,
        ...(i === 0 && replyTo
          ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } }
          : {}),
      });
    }
  }
}
