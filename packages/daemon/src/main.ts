import { createHash, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { type MethodName, methodMap } from "@openagent/protocol";
import { AgentStore } from "./agents";
import { openDatabase } from "./db";

const VERSION = "0.1.0";
const ORIGIN_ALLOWLIST = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "http://localhost:1420",
]);

function parseArgs(argv: string[]): { dataDir: string; agentsRoot: string } {
  let dataDir: string | undefined;
  let agentsRoot = join(homedir(), "OpenAgent", "agents");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--data-dir") {
      dataDir = argv[++i];
    } else if (arg === "--agents-root") {
      agentsRoot = argv[++i]!;
    }
  }
  if (!dataDir) {
    console.error("openagentd: --data-dir <path> is required");
    process.exit(2);
  }
  return { dataDir, agentsRoot };
}

function tokenEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function log(...args: unknown[]) {
  console.error("[openagentd]", ...args);
}

async function main() {
  const { dataDir, agentsRoot } = parseArgs(process.argv.slice(2));
  const token = process.env.OPENAGENT_TOKEN;
  if (!token) {
    console.error("openagentd: OPENAGENT_TOKEN env var is required");
    process.exit(2);
  }

  const db = openDatabase(dataDir);
  const store = new AgentStore(db, agentsRoot);
  const sockets = new Set<import("bun").ServerWebSocket<unknown>>();

  function broadcast(event: string, data: unknown) {
    const msg = JSON.stringify({ event, data });
    for (const ws of sockets) {
      try {
        ws.send(msg);
      } catch {}
    }
  }

  function checkAuth(req: Request): Response | null {
    const origin = req.headers.get("origin");
    if (origin !== null && !ORIGIN_ALLOWLIST.has(origin)) {
      return new Response("forbidden origin", { status: 403 });
    }
    return null;
  }

  function handleMessage(raw: string): string {
    let parsed: { id?: unknown; method?: unknown; params?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return JSON.stringify({ id: "", error: { code: "bad_request", message: "invalid JSON" } });
    }
    const id = typeof parsed.id === "string" ? parsed.id : "";
    const method = parsed.method;
    if (typeof method !== "string" || !(method in methodMap)) {
      return JSON.stringify({
        id,
        error: { code: "bad_request", message: `unknown method: ${String(method)}` },
      });
    }
    const def = methodMap[method as MethodName];
    const paramsRes = def.params.safeParse(parsed.params ?? {});
    if (!paramsRes.success) {
      return JSON.stringify({
        id,
        error: {
          code: "bad_request",
          message: paramsRes.error.issues[0]?.message ?? "invalid params",
        },
      });
    }
    try {
      switch (method as MethodName) {
        case "agents.list": {
          const result = store.list();
          return JSON.stringify({ id, result });
        }
        case "agents.create": {
          const agent = store.create(paramsRes.data as Parameters<typeof store.create>[0]);
          queueMicrotask(() => broadcast("agent.created", agent));
          return JSON.stringify({ id, result: agent });
        }
        case "agents.update": {
          const agent = store.update(paramsRes.data as Parameters<typeof store.update>[0]);
          if (!agent) {
            return JSON.stringify({ id, error: { code: "not_found", message: "agent not found" } });
          }
          queueMicrotask(() => broadcast("agent.updated", agent));
          return JSON.stringify({ id, result: agent });
        }
        case "agents.delete": {
          const p = paramsRes.data as { id: string };
          const ok = store.softDelete(p.id);
          if (!ok) {
            return JSON.stringify({ id, error: { code: "not_found", message: "agent not found" } });
          }
          queueMicrotask(() => broadcast("agent.deleted", { id: p.id }));
          return JSON.stringify({ id, result: { ok: true } });
        }
      }
    } catch (e) {
      log("handler error", e);
      return JSON.stringify({ id, error: { code: "internal", message: "internal error" } });
    }
    return JSON.stringify({ id, error: { code: "bad_request", message: "unhandled method" } });
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const denied = checkAuth(req);
        if (denied) return denied;
        const reqToken = url.searchParams.get("token") ?? "";
        if (!tokenEqual(reqToken, token)) {
          return new Response("unauthorized", { status: 401 });
        }
        if (srv.upgrade(req)) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/health") {
        const denied = checkAuth(req);
        if (denied) return denied;
        const auth = req.headers.get("authorization") ?? "";
        const reqToken = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!tokenEqual(reqToken, token)) {
          return new Response("unauthorized", { status: 401 });
        }
        return Response.json({ ok: true, version: VERSION });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      message(ws, msg) {
        const text = typeof msg === "string" ? msg : Buffer.from(msg).toString("utf8");
        ws.send(handleMessage(text));
      },
    },
  });

  console.log(`OPENAGENT_READY {"port":${server.port}}`);
  log(`listening on 127.0.0.1:${server.port}, data dir ${dataDir}`);

  let shuttingDown = false;
  function shutdown(code: number) {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      server.stop();
    } catch {}
    try {
      db.close();
    } catch {}
    process.exit(code);
  }

  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
  process.stdin.resume();
  process.stdin.on("end", () => shutdown(0));
  process.stdin.on("close", () => shutdown(0));
}

main().catch((e) => {
  console.error("[openagentd] fatal", e);
  process.exit(1);
});
