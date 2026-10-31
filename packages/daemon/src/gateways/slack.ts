import {
  closeDetail,
  ReconnectBackoff,
  splitText,
  type Transport,
  type TransportHooks,
} from "./common";

type Envelope = {
  envelope_id?: string;
  type: string;
  payload?: {
    event?: {
      type: string;
      user?: string;
      bot_id?: string;
      subtype?: string;
      text?: string;
      channel?: string;
      ts?: string;
      thread_ts?: string;
      channel_type?: string;
    };
  };
};

const api = () => process.env.BOTO_SLACK_API ?? "https://slack.com/api";

export class SlackTransport implements Transport {
  private ws: WebSocket | null = null;
  private running = false;
  private backoff = new ReconnectBackoff();
  private botUserId = "";

  constructor(
    private botToken: string,
    private appToken: string,
    private hooks: TransportHooks,
  ) {}

  private async call<T>(
    method: string,
    token: string,
    body: Record<string, unknown> = {},
  ): Promise<T> {
    const res = await fetch(`${api()}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!json.ok) throw new Error(`slack ${method}: ${json.error ?? res.status}`);
    return json;
  }

  start() {
    this.running = true;
    void this.connect();
  }

  stop() {
    this.running = false;
    this.ws?.close();
  }

  private async connect() {
    if (!this.running) return;
    try {
      const auth = await this.call<{ user_id: string }>("auth.test", this.botToken);
      this.botUserId = auth.user_id;
      const { url } = await this.call<{ url: string }>("apps.connections.open", this.appToken);
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        this.backoff.markHealthy();
        this.hooks.onStatus("connected");
      };
      ws.onmessage = (ev) => this.onFrame(ws, String(ev.data));
      ws.onclose = (ev) => this.onClose(ws, ev);
    } catch (e) {
      this.hooks.onStatus("error", (e as Error).message);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    setTimeout(() => void this.connect(), this.backoff.next());
  }

  private onClose(ws: WebSocket, ev: CloseEvent) {
    if (this.ws !== ws || !this.running) return;
    this.hooks.onStatus("connecting", closeDetail(ev));
    this.scheduleReconnect();
  }

  private onFrame(ws: WebSocket, raw: string) {
    let env: Envelope;
    try {
      env = JSON.parse(raw) as Envelope;
    } catch {
      return;
    }
    if (env.envelope_id) ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
    if (env.type === "disconnect") {
      ws.close();
      return;
    }
    const e = env.payload?.event;
    if (
      env.type !== "events_api" ||
      !e ||
      !e.user ||
      e.bot_id ||
      e.subtype ||
      !e.text ||
      !e.channel
    )
      return;
    const isDm = e.channel_type === "im";
    if (e.type === "message" && !isDm) return; // in channels, only app_mention events
    if (e.type !== "message" && e.type !== "app_mention") return;
    const text = e.text.replace(new RegExp(`<@${this.botUserId}>\\s*`, "g"), "").trim();
    this.hooks.onMessage({
      chatId: e.channel,
      userId: e.user,
      userName: e.user,
      text,
      ...(isDm ? {} : { replyTo: e.thread_ts ?? e.ts ?? "" }),
    });
  }

  async send(chatId: string, text: string, replyTo?: string) {
    for (const part of splitText(text, 3500)) {
      await this.call("chat.postMessage", this.botToken, {
        channel: chatId,
        text: part,
        ...(replyTo ? { thread_ts: replyTo } : {}),
      });
    }
  }
}
