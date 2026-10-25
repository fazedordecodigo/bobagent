import { createHash, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { AgentStore } from "./agents";
import { Bridge } from "./bridge";
import { ChannelService } from "./channels";
import { ChatStore, QueueStore } from "./chat-store";
import { openDatabase } from "./db";
import { mergedPath } from "./env/login-path";
import { runMcpBridge } from "./mcp-bridge";
import { MemoryStore } from "./memories";
import { Rpc } from "./rpc";
import { RuntimeManager } from "./runtime/runtime-manager";
import { SkillLibrary } from "./skills";

const VERSION = "0.1.0";
const ORIGIN_ALLOWLIST = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "http://localhost:1420",
]);

function parseArgs(argv: string[]): { dataDir: string; agentsRoot: string } {
  let dataDir: string | undefined;
  let agentsRoot = join(homedir(), "BobAgent", "agents");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--data-dir") {
      dataDir = argv[++i];
    } else if (arg === "--agents-root") {
      agentsRoot = argv[++i]!;
    }
  }
  if (!dataDir) {
    console.error("bobagentd: --data-dir <path> is required");
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
  console.error("[bobagentd]", ...args);
}

/** Reads the auth token from the first stdin line; refuses to start without one. */
function readTokenFromStdin(): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, terminal: false });
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), 10_000);
    rl.once("line", (line) => {
      clearTimeout(timer);
      finish(line.trim() || null);
      // keep watching stdin for EOF (parent death)
      rl.on("close", () => shutdown(0));
    });
    rl.once("close", () => finish(null));
    void timer;
  });
}

let shuttingDown = false;
let dbRef: { close(): void } | null = null;
let serverRef: { stop(): void } | null = null;
let runtimesRef: { closeAll(): Promise<void> } | null = null;

function shutdown(code: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  const done = () => {
    try {
      serverRef?.stop();
    } catch {}
    try {
      dbRef?.close();
    } catch {}
    process.exit(code);
  };
  const p = runtimesRef?.closeAll() ?? Promise.resolve();
  p.catch(() => {}).finally(() => setTimeout(done, 50));
  setTimeout(() => process.exit(code), 4000).unref();
}

async function main() {
  if (process.argv[2] === "mcp-bridge") {
    await runMcpBridge();
    process.exit(0);
  }
  const { dataDir, agentsRoot } = parseArgs(process.argv.slice(2));
  const token = await readTokenFromStdin();
  if (!token) {
    console.error("bobagentd: no auth token on stdin (first line required)");
    process.exit(2);
  }

  const db = openDatabase(dataDir);
  dbRef = db;
  const chat = new ChatStore(db);
  chat.interruptRunningTurns();
  const store = new AgentStore(db, agentsRoot);
  const queue = new QueueStore(db);
  const sockets = new Set<import("bun").ServerWebSocket<unknown>>();

  function broadcast(event: string, data: unknown) {
    const msg = JSON.stringify({ event, data });
    for (const ws of sockets) {
      try {
        ws.send(msg);
      } catch {}
    }
    if (event === "turn.ended") {
      const turn = data as import("@bobagent/protocol").Turn;
      queueMicrotask(() => {
        try {
          channels.onTurnEnded(turn, turn.queueId ? queue.row(turn.queueId) : null);
        } catch (e) {
          log("channel turn hook failed", e);
        }
      });
    }
  }

  const sharedRoot = process.env.BOBAGENT_SHARED_ROOT || join(dirname(agentsRoot), "Shared");
  const bridge = new Bridge(store, () => runtimes, sharedRoot);
  const memories = new MemoryStore(db);
  const skills = new SkillLibrary(sharedRoot);
  const runtimes = new RuntimeManager(
    store,
    chat,
    queue,
    broadcast,
    (id) => bridge.serversFor(id),
    (id) => memories.promptBlock(id) + skills.promptBlock(),
  );
  runtimesRef = runtimes;
  const channels = new ChannelService(db, store, chat, () => runtimes, broadcast);
  bridge.channels = channels;
  bridge.memories = memories;
  bridge.skills = skills;
  bridge.broadcast = broadcast;
  const rpc = new Rpc(store, chat, queue, runtimes, broadcast, channels, memories, skills);

  // warm the login-shell PATH cache so provider CLIs resolve like in a terminal
  const path = mergedPath();
  log(`PATH resolved (${path.split(":").length} entries)`);

  function checkOrigin(req: Request): Response | null {
    const origin = req.headers.get("origin");
    if (origin !== null && !ORIGIN_ALLOWLIST.has(origin)) {
      return new Response("forbidden origin", { status: 403 });
    }
    return null;
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const denied = checkOrigin(req);
        if (denied) return denied;
        const reqToken = url.searchParams.get("token") ?? "";
        if (!tokenEqual(reqToken, token)) {
          return new Response("unauthorized", { status: 401 });
        }
        if (srv.upgrade(req)) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/bridge") {
        // called only by our mcp-bridge child processes, never by a browser
        if (req.method !== "POST" || req.headers.get("origin") !== null) {
          return new Response("forbidden", { status: 403 });
        }
        const auth = req.headers.get("authorization") ?? "";
        const agentId = bridge.agentForToken(auth.startsWith("Bearer ") ? auth.slice(7) : "");
        if (!agentId) return new Response("unauthorized", { status: 401 });
        return req
          .json()
          .then((body) => bridge.handle(agentId, body as Record<string, unknown>))
          .then(
            (r) => Response.json(r),
            (e) => new Response((e as Error).message, { status: 400 }),
          );
      }
      if (url.pathname === "/health") {
        const denied = checkOrigin(req);
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
      async message(ws, msg) {
        const text = typeof msg === "string" ? msg : Buffer.from(msg).toString("utf8");
        try {
          ws.send(await rpc.handle(text));
        } catch (e) {
          log("rpc error", e);
        }
      },
    },
  });

  serverRef = server;
  bridge.port = server.port ?? 0;
  runtimes.resumeAllQueues();
  console.log(`BOBAGENT_READY {"port":${server.port}}`);
  log(`listening on 127.0.0.1:${server.port}, data dir ${dataDir}`);

  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
}

main().catch((e) => {
  console.error("[bobagentd] fatal", e);
  process.exit(1);
});
