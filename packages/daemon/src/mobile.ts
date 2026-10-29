import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import type { MobileDevice, MobileStatus } from "@upbot/protocol";
import { getSetting, setSetting } from "./db";
import { envNumber } from "./env/vars";
import { MOBILE_HTML } from "./mobile-app";
import { RpcError } from "./runtime/agent-runtime";

// Mobile companion: an opt-in LAN web app (phone browser / home-screen PWA) that pairs with a
// one-time 6-digit code shown on the desktop, then gets a device token. Devices may only call
// a small allowlist of chat methods and receive chat events over Server-Sent Events.

const ALLOWED_METHODS = new Set([
  "agents.list",
  "agents.statuses",
  "chat.history",
  "chat.send",
  "chat.cancel",
  "queue.get",
  "permissions.list",
  "permissions.respond",
  "approvals.list",
  "approvals.respond",
]);
const FORWARDED_EVENTS = new Set([
  "approval.updated",
  "agent.created",
  "agent.updated",
  "agent.deleted",
  "agent.status",
  "turn.started",
  "turn.ended",
  "item.created",
  "item.updated",
  "item.delta",
  "permission.requested",
  "permission.resolved",
  "queue.updated",
]);
const PAIR_TTL = 5 * 60_000;
const PAIR_ATTEMPTS = 5;

type DeviceRow = {
  id: string;
  name: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number | null;
};
type Stream = { deviceId: string; ctrl: ReadableStreamDefaultController<string> };

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export class MobileServer {
  rpc: ((raw: string) => Promise<string>) | null = null;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private pairing: { code: string; expiresAt: number; attempts: number } | null = null;
  private streams = new Set<Stream>();

  constructor(private db: Database) {}

  private setting(): { enabled: boolean; port: number } {
    return getSetting(this.db, "mobile", { enabled: false, port: 0 });
  }

  private devices(): DeviceRow[] {
    return this.db
      .query("SELECT * FROM mobile_devices WHERE revoked_at IS NULL ORDER BY created_at ASC")
      .all() as DeviceRow[];
  }

  status(): MobileStatus {
    const port = this.server?.port ?? null;
    const host = process.env.UPBOT_MOBILE_HOST ?? "0.0.0.0";
    const ips =
      host === "0.0.0.0"
        ? Object.values(networkInterfaces())
            .flat()
            .filter((i) => i && i.family === "IPv4" && !i.internal)
            .map((i) => i!.address)
        : [host];
    return {
      enabled: this.server !== null,
      urls: port ? ips.map((ip) => `http://${ip}:${port}/`) : [],
      devices: this.devices().map(
        (d): MobileDevice => ({
          id: d.id,
          name: d.name,
          createdAt: d.created_at,
          lastSeenAt: d.last_seen_at,
        }),
      ),
    };
  }

  start(): void {
    if (this.setting().enabled) this.listen();
  }

  setEnabled(enabled: boolean): MobileStatus {
    const s = this.setting();
    if (enabled) this.listen();
    else this.close();
    setSetting(this.db, "mobile", { enabled, port: this.server?.port ?? s.port });
    return this.status();
  }

  pair(): { code: string; expiresAt: number } {
    if (!this.server) throw new RpcError("bad_request", "enable mobile access first");
    this.pairing = {
      code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
      expiresAt: Date.now() + PAIR_TTL,
      attempts: 0,
    };
    return { code: this.pairing.code, expiresAt: this.pairing.expiresAt };
  }

  revoke(id: string): void {
    const r = this.db
      .query("UPDATE mobile_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(Date.now(), id);
    if (r.changes === 0) throw new RpcError("not_found", "device not found");
    for (const s of [...this.streams]) {
      if (s.deviceId === id) {
        try {
          s.ctrl.close();
        } catch {}
        this.streams.delete(s);
      }
    }
  }

  onEvent(event: string, data: unknown): void {
    if (!FORWARDED_EVENTS.has(event) || this.streams.size === 0) return;
    const frame = `data: ${JSON.stringify({ event, data })}\n\n`;
    for (const s of [...this.streams]) {
      try {
        s.ctrl.enqueue(frame);
      } catch {
        this.streams.delete(s);
      }
    }
  }

  private close() {
    for (const s of this.streams) {
      try {
        s.ctrl.close();
      } catch {}
    }
    this.streams.clear();
    this.server?.stop(true);
    this.server = null;
    this.pairing = null;
  }

  private device(req: Request, url: URL): DeviceRow | null {
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ")
      ? auth.slice(7)
      : (url.searchParams.get("token") ?? "");
    if (!token) return null;
    const h = Buffer.from(hash(token));
    const d = this.devices().find((x) => {
      const b = Buffer.from(x.token_hash);
      return b.length === h.length && timingSafeEqual(b, h);
    });
    if (d)
      this.db
        .query("UPDATE mobile_devices SET last_seen_at = ? WHERE id = ?")
        .run(Date.now(), d.id);
    return d ?? null;
  }

  private listen() {
    if (this.server) return;
    const port = envNumber("UPBOT_MOBILE_PORT", this.setting().port ?? 0, {
      min: 0,
      max: 65_535,
      integer: true,
    });
    const opts = {
      hostname: process.env.UPBOT_MOBILE_HOST ?? "0.0.0.0",
      idleTimeout: 0,
      fetch: (req: Request) => this.handle(req),
    };
    try {
      this.server = Bun.serve({ ...opts, port });
    } catch {
      this.server = Bun.serve({ ...opts, port: 0 });
    }
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get("origin");
    if (origin !== null && origin !== url.origin)
      return new Response("forbidden origin", { status: 403 });
    const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    if (req.method === "GET" && url.pathname === "/") {
      return new Response(MOBILE_HTML, {
        headers: {
          ...headers,
          "content-type": "text/html; charset=utf-8",
          "content-security-policy":
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'",
        },
      });
    }
    if (req.method === "GET" && url.pathname === "/manifest.webmanifest") {
      return Response.json(
        {
          name: "UpBot",
          short_name: "UpBot",
          start_url: "/",
          display: "standalone",
          background_color: "#09090b",
          theme_color: "#09090b",
        },
        { headers },
      );
    }
    if (req.method === "POST" && url.pathname === "/api/pair") {
      const body = (await req.json().catch(() => ({}))) as { code?: unknown; name?: unknown };
      const p = this.pairing;
      if (!p || Date.now() > p.expiresAt || p.attempts >= PAIR_ATTEMPTS) {
        return Response.json(
          { error: "no active pairing code; create one on the desktop" },
          { status: 401, headers },
        );
      }
      p.attempts++;
      if (String(body.code ?? "") !== p.code)
        return Response.json({ error: "wrong code" }, { status: 401, headers });
      this.pairing = null;
      const token = randomBytes(32).toString("hex");
      const id = crypto.randomUUID().slice(0, 8);
      const name = String(body.name ?? "Phone").slice(0, 60) || "Phone";
      this.db
        .query("INSERT INTO mobile_devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
        .run(id, name, hash(token), Date.now());
      return Response.json({ token, deviceId: id }, { headers });
    }
    const device = this.device(req, url);
    if (url.pathname.startsWith("/api/") && !device)
      return Response.json({ error: "unauthorized" }, { status: 401, headers });
    if (req.method === "GET" && url.pathname === "/api/events" && device) {
      let stream: Stream;
      const body = new ReadableStream<string>({
        start: (ctrl) => {
          stream = { deviceId: device.id, ctrl };
          this.streams.add(stream);
          ctrl.enqueue(": connected\n\n");
        },
        cancel: () => {
          this.streams.delete(stream);
        },
      });
      return new Response(body, { headers: { ...headers, "content-type": "text/event-stream" } });
    }
    if (req.method === "POST" && url.pathname === "/api/rpc" && device) {
      const body = (await req.json().catch(() => ({}))) as { method?: unknown; params?: unknown };
      const method = String(body.method ?? "");
      if (!ALLOWED_METHODS.has(method))
        return Response.json({ error: "method not allowed" }, { status: 403, headers });
      const params = (body.params ?? {}) as Record<string, unknown>;
      if (method === "chat.send" && "attachments" in params) {
        return Response.json(
          { error: "attachments are not supported from mobile" },
          { status: 400, headers },
        );
      }
      const res = JSON.parse(await this.rpc!(JSON.stringify({ id: "m", method, params }))) as {
        result?: unknown;
        error?: { code: string; message: string };
      };
      return Response.json(
        res.error ? { error: res.error.message, code: res.error.code } : { result: res.result },
        {
          status: res.error ? 400 : 200,
          headers,
        },
      );
    }
    return new Response("not found", { status: 404, headers });
  }
}
