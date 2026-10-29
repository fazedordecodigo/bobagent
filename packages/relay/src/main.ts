// UpBot team relay: a small self-hostable Bun server that lets the daemons of a team share
// agents. Members connect outbound over WebSocket with their member token; the relay keeps
// the roster (who is online, which agents they share) and forwards messages and replies.
// It stores no chat content and never logs member-supplied identifiers.
//
//   bun packages/relay/src/main.ts --data ./relay-data [--port 8787] [--host 0.0.0.0]
// The admin token is read from RELAY_ADMIN_TOKEN or generated into <data>/admin-token.
// Invite a member:  curl -X POST -H "Authorization: Bearer <admin>" -d '{"name":"Ana"}' http://host:8787/members
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Member = {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: number;
  removedAt?: number;
};
type SharedAgent = { id: string; name: string; provider: string; avatar: unknown };
type Conn = { memberId: string };
type Socket = import("bun").ServerWebSocket<Conn>;

const MAX_TEXT = 100_000;
export const AUDIT_WINDOW_MS = 60_000;
export const AUDIT_LIMIT = 20;
export const AUDIT_MAX_KEYS = 1000;

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const eq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

export function startRelay(opts: {
  dataDir: string;
  port?: number;
  host?: string;
  adminToken?: string;
  auditWindowMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}) {
  mkdirSync(opts.dataDir, { recursive: true });
  const teamFile = join(opts.dataDir, "team.json");
  const adminFile = join(opts.dataDir, "admin-token");
  const admin =
    opts.adminToken ??
    (existsSync(adminFile)
      ? readFileSync(adminFile, "utf8").trim()
      : (() => {
          const t = randomBytes(24).toString("hex");
          writeFileSync(adminFile, t, { mode: 0o600 });
          return t;
        })());
  const members: Member[] = existsSync(teamFile)
    ? (JSON.parse(readFileSync(teamFile, "utf8")) as Member[])
    : [];
  const save = () => writeFileSync(teamFile, JSON.stringify(members, null, 2), { mode: 0o600 });
  const sockets = new Map<string, Socket>();
  const shared = new Map<string, SharedAgent[]>();
  // Audit logs use known member IDs, fixed route labels, and socket IPs only.
  const writeLog = opts.log ?? ((line: string) => console.error(line));
  const now = opts.now ?? Date.now;
  const auditWindowMs = opts.auditWindowMs ?? AUDIT_WINDOW_MS;
  type AuditState = {
    windowStart: number;
    count: number;
    suppressed: number;
    events: Record<string, number>;
  };
  const auditLimits = new Map<string, AuditState>();
  const emit = (event: string, fields: Record<string, unknown> = {}) =>
    writeLog(JSON.stringify({ event, ts: now(), ...fields }));
  const summarizeSuppressed = (actor: string, state: AuditState) => {
    if (state.suppressed > 0) {
      emit("relay.audit_suppressed", {
        actor,
        suppressed: state.suppressed,
        events: state.events,
      });
    }
  };
  const sweepAuditState = (flushAll: boolean, timestamp = now()) => {
    for (const [actor, state] of auditLimits) {
      if (flushAll || timestamp - state.windowStart >= auditWindowMs) {
        summarizeSuppressed(actor, state);
        auditLimits.delete(actor);
      }
    }
  };
  const sweepAudit = () => sweepAuditState(false);
  const log = (event: string, fields: Record<string, unknown> = {}, actor?: string) => {
    if (actor === undefined) {
      emit(event, fields);
      return;
    }

    const timestamp = now();
    let key = actor;
    let state = auditLimits.get(key);
    if (!state && auditLimits.size >= AUDIT_MAX_KEYS) {
      sweepAuditState(false, timestamp);
      state = auditLimits.get(key);
      if (!state && auditLimits.size >= AUDIT_MAX_KEYS) {
        key = "*";
        state = auditLimits.get(key);
        if (!state && auditLimits.size >= AUDIT_MAX_KEYS) {
          const oldestKey = auditLimits.keys().next().value as string | undefined;
          if (oldestKey !== undefined) {
            const oldest = auditLimits.get(oldestKey);
            if (oldest) summarizeSuppressed(oldestKey, oldest);
            auditLimits.delete(oldestKey);
          }
        }
      }
    }
    if (!state) {
      state = { windowStart: timestamp, count: 0, suppressed: 0, events: {} };
      auditLimits.set(key, state);
    } else if (timestamp - state.windowStart >= auditWindowMs) {
      summarizeSuppressed(key, state);
      state.windowStart = timestamp;
      state.count = 0;
      state.suppressed = 0;
      state.events = {};
    }
    if (state.count >= AUDIT_LIMIT) {
      state.suppressed++;
      state.events[event] = (state.events[event] ?? 0) + 1;
      return;
    }
    state.count++;
    emit(event, fields);
  };

  const active = () => members.filter((m) => !m.removedAt);
  const activeMemberId = (id: string) => (active().some((m) => m.id === id) ? id : null);
  const roster = () => ({
    type: "roster",
    members: active().map((m) => ({
      id: m.id,
      name: m.name,
      online: sockets.has(m.id),
      agents: sockets.has(m.id) ? (shared.get(m.id) ?? []) : [],
    })),
  });
  const send = (ws: Socket | undefined, msg: unknown) => {
    try {
      ws?.send(JSON.stringify(msg));
    } catch (e) {
      log(
        "relay.send_error",
        { memberId: ws?.data?.memberId, error: e instanceof Error ? e.name : "unknown" },
        ws?.data?.memberId,
      );
    }
  };
  const broadcastRoster = () => {
    const r = roster();
    for (const ws of sockets.values()) send(ws, r);
  };
  const isAdmin = (req: Request) => {
    const a = req.headers.get("authorization") ?? "";
    return a.startsWith("Bearer ") && eq(a.slice(7), admin);
  };

  const server = Bun.serve<Conn>({
    hostname: opts.host ?? "0.0.0.0",
    port: opts.port ?? 8787,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const token = url.searchParams.get("token") ?? "";
        const h = hash(token);
        const m = active().find((x) => eq(x.tokenHash, h));
        if (!m) {
          const ip = srv.requestIP(req)?.address;
          log(
            "relay.auth_rejected",
            { route: "/ws", reason: "member_token", ip },
            `ip:${ip ?? "unknown"}`,
          );
          return new Response("unauthorized", { status: 401 });
        }
        return srv.upgrade(req, { data: { memberId: m.id } })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/health") return Response.json({ ok: true, members: active().length });
      if (url.pathname === "/members") {
        if (!isAdmin(req)) {
          const ip = srv.requestIP(req)?.address;
          log(
            "relay.auth_rejected",
            { route: "/members", reason: "admin_token", ip },
            `ip:${ip ?? "unknown"}`,
          );
          return new Response("unauthorized", { status: 401 });
        }
        if (req.method === "GET") return Response.json(roster().members);
        if (req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as { name?: unknown };
          const name = String(body.name ?? "")
            .trim()
            .slice(0, 60);
          if (!name) return Response.json({ error: "name is required" }, { status: 400 });
          const token = randomBytes(32).toString("hex");
          const m: Member = {
            id: crypto.randomUUID().slice(0, 8),
            name,
            tokenHash: hash(token),
            createdAt: Date.now(),
          };
          members.push(m);
          save();
          log("relay.member_invited", { memberId: m.id, name });
          return Response.json({ id: m.id, name, token });
        }
      }
      const del = /^\/members\/([\w-]+)$/.exec(url.pathname);
      if (del && req.method === "DELETE") {
        if (!isAdmin(req)) {
          const ip = srv.requestIP(req)?.address;
          log(
            "relay.auth_rejected",
            { route: "/members/:id", reason: "admin_token", ip },
            `ip:${ip ?? "unknown"}`,
          );
          return new Response("unauthorized", { status: 401 });
        }
        const m = active().find((x) => x.id === del[1]);
        if (!m) return new Response("not found", { status: 404 });
        m.removedAt = Date.now();
        save();
        log("relay.member_removed", { memberId: m.id });
        sockets.get(m.id)?.close(4001, "removed from team");
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      maxPayloadLength: 1024 * 1024,
      open(ws) {
        const prev = sockets.get(ws.data.memberId);
        const replaced = !!prev && prev !== ws;
        if (replaced) prev.close(4000, "connected elsewhere");
        sockets.set(ws.data.memberId, ws);
        log("relay.connected", { memberId: ws.data.memberId, replaced }, ws.data.memberId);
        const me = active().find((m) => m.id === ws.data.memberId)!;
        send(ws, { type: "welcome", member: { id: me.id, name: me.name } });
        broadcastRoster();
      },
      close(ws) {
        if (sockets.get(ws.data.memberId) === ws) {
          sockets.delete(ws.data.memberId);
          shared.delete(ws.data.memberId);
          log("relay.disconnected", { memberId: ws.data.memberId }, ws.data.memberId);
          broadcastRoster();
        }
      },
      message(ws, raw) {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          log("relay.bad_message", { memberId: ws.data.memberId }, ws.data.memberId);
          return;
        }
        const me = active().find((m) => m.id === ws.data.memberId);
        if (!me) return;
        if (msg.type === "share" && Array.isArray(msg.agents)) {
          shared.set(
            me.id,
            (msg.agents as SharedAgent[]).slice(0, 100).map((a) => ({
              id: String(a.id),
              name: String(a.name).slice(0, 80),
              provider: String(a.provider),
              avatar: a.avatar ?? null,
            })),
          );
          broadcastRoster();
          return;
        }
        const requestId = String(msg.requestId ?? "");
        const text = typeof msg.text === "string" ? msg.text.slice(0, MAX_TEXT) : "";
        if (msg.type === "send") {
          const to = (msg.to ?? {}) as { memberId?: string; agentId?: string };
          const toMemberId = String(to.memberId);
          const target = sockets.get(toMemberId);
          const agent = (shared.get(toMemberId) ?? []).find((a) => a.id === to.agentId);
          if (!target || !agent) {
            log(
              "relay.route_failed",
              {
                fromMemberId: me.id,
                toMemberId: activeMemberId(toMemberId),
                reason: target ? "not_shared" : "offline",
              },
              me.id,
            );
            send(ws, {
              type: "reply",
              requestId,
              status: "failed",
              text: "that agent is not shared or its owner is offline",
            });
            return;
          }
          send(target, {
            type: "incoming",
            requestId,
            from: { memberId: me.id, name: me.name },
            agentId: agent.id,
            text,
          });
          return;
        }
        if (msg.type === "reply") {
          const toMemberId = String(msg.toMemberId);
          const dst = sockets.get(toMemberId);
          if (!dst) {
            log(
              "relay.reply_dropped",
              {
                fromMemberId: me.id,
                toMemberId: activeMemberId(toMemberId),
              },
              me.id,
            );
          }
          send(dst, {
            type: "reply",
            requestId,
            status: msg.status === "failed" ? "failed" : "completed",
            text,
            from: { memberId: me.id, name: me.name },
          });
        }
      },
    },
  });
  const auditInterval = setInterval(sweepAudit, auditWindowMs);
  auditInterval.unref();
  const close = async () => {
    clearInterval(auditInterval);
    await server.stop(true);
    sweepAuditState(true);
  };
  return { server, adminToken: admin, close, sweepAudit };
}

if (import.meta.main) {
  const dataDir = arg("data", "./relay-data")!;
  const configuredWindow = Number(process.env.RELAY_AUDIT_WINDOW_MS);
  const { server, close } = startRelay({
    dataDir,
    port: Number(arg("port", "8787")),
    host: arg("host", "0.0.0.0")!,
    ...(Number.isInteger(configuredWindow) && configuredWindow > 0
      ? { auditWindowMs: configuredWindow }
      : {}),
    ...(process.env.RELAY_ADMIN_TOKEN ? { adminToken: process.env.RELAY_ADMIN_TOKEN } : {}),
  });
  console.log(
    `UpBot relay listening on ${server.hostname}:${server.port} (admin token in ${join(dataDir, "admin-token")} or RELAY_ADMIN_TOKEN)`,
  );
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
