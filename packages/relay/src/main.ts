// BobAgent team relay: a small self-hostable Bun server that lets the daemons of a team share
// agents. Members connect outbound over WebSocket with their member token; the relay keeps
// the roster (who is online, which agents they share) and forwards messages and replies.
// It stores no chat content.
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

  const active = () => members.filter((m) => !m.removedAt);
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
    } catch {}
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
        if (!m) return new Response("unauthorized", { status: 401 });
        return srv.upgrade(req, { data: { memberId: m.id } })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/health") return Response.json({ ok: true, members: active().length });
      if (url.pathname === "/members") {
        if (!isAdmin(req)) return new Response("unauthorized", { status: 401 });
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
          return Response.json({ id: m.id, name, token });
        }
      }
      const del = /^\/members\/([\w-]+)$/.exec(url.pathname);
      if (del && req.method === "DELETE") {
        if (!isAdmin(req)) return new Response("unauthorized", { status: 401 });
        const m = active().find((x) => x.id === del[1]);
        if (!m) return new Response("not found", { status: 404 });
        m.removedAt = Date.now();
        save();
        sockets.get(m.id)?.close(4001, "removed from team");
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      maxPayloadLength: 1024 * 1024,
      open(ws) {
        const prev = sockets.get(ws.data.memberId);
        if (prev && prev !== ws) prev.close(4000, "connected elsewhere");
        sockets.set(ws.data.memberId, ws);
        const me = active().find((m) => m.id === ws.data.memberId)!;
        send(ws, { type: "welcome", member: { id: me.id, name: me.name } });
        broadcastRoster();
      },
      close(ws) {
        if (sockets.get(ws.data.memberId) === ws) {
          sockets.delete(ws.data.memberId);
          shared.delete(ws.data.memberId);
          broadcastRoster();
        }
      },
      message(ws, raw) {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
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
          const target = sockets.get(String(to.memberId));
          const agent = (shared.get(String(to.memberId)) ?? []).find((a) => a.id === to.agentId);
          if (!target || !agent) {
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
          send(sockets.get(String(msg.toMemberId)), {
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
  return { server, adminToken: admin };
}

if (import.meta.main) {
  const dataDir = arg("data", "./relay-data")!;
  const { server } = startRelay({
    dataDir,
    port: Number(arg("port", "8787")),
    host: arg("host", "0.0.0.0")!,
    ...(process.env.RELAY_ADMIN_TOKEN ? { adminToken: process.env.RELAY_ADMIN_TOKEN } : {}),
  });
  console.log(
    `BobAgent relay listening on ${server.hostname}:${server.port} (admin token in ${join(dataDir, "admin-token")} or RELAY_ADMIN_TOKEN)`,
  );
}
