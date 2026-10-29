import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { AgentStore } from "./agents";
import { ApprovalService } from "./approvals";
import { AppsService } from "./apps";
import { Bridge } from "./bridge";
import { BrowserService } from "./browser";
import { ChannelService } from "./channels";
import { ChatStore, QueueStore } from "./chat-store";
import { ComputerUse } from "./computer";
import { Connectors } from "./connectors";
import { openDatabase } from "./db";
import { EmailService } from "./email";
import { mergedPath } from "./env/login-path";
import { GatewayService } from "./gateways";
import { migrateLegacyHome } from "./legacy";
import { Marketplace } from "./marketplace";
import { runMcpBridge } from "./mcp-bridge";
import { MemoryStore } from "./memories";
import { MobileServer } from "./mobile";
import { PageLibrary } from "./pages";
import { seedDefaultBot, upbotContext } from "./persona";
import { VmCredentials } from "./remote/credentials";
import { HostStore } from "./remote/hosts";
import { RoutineService } from "./routines";
import { Rpc } from "./rpc";
import { RuntimeManager } from "./runtime/runtime-manager";
import { SkillLibrary } from "./skills";
import { SubagentService } from "./subagents";
import { TeamClient } from "./team";
import { Vault } from "./vault";
import { Voice } from "./voice";

const VERSION = "0.3.0";
const ORIGIN_ALLOWLIST = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "http://localhost:1420",
]);

function parseArgs(argv: string[]): { dataDir: string; agentsRoot: string } {
  let dataDir: string | undefined;
  let agentsRoot = join(homedir(), "UpBot", "agents");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--data-dir") {
      dataDir = argv[++i];
    } else if (arg === "--agents-root") {
      agentsRoot = argv[++i]!;
    }
  }
  if (!dataDir) {
    console.error("upbotd: --data-dir <path> is required");
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
  console.error("[upbotd]", ...args);
}

/** Emits at most one line per key per minute so rejected-auth loops can't spam stderr. */
const LOG_LIMIT_MS = 60_000;
const logLimitedLast = new Map<string, number>();
function logLimited(event: string, key: string, fields: Record<string, unknown>) {
  const now = Date.now();
  if (now - (logLimitedLast.get(key) ?? 0) < LOG_LIMIT_MS) return;
  logLimitedLast.set(key, now);
  log(event, fields);
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
      rl.on("close", () => shutdown(0, "stdin EOF"));
    });
    rl.once("close", () => finish(null));
    void timer;
  });
}

let shuttingDown = false;
let dbRef: { close(): void } | null = null;
let serverRef: { stop(): void } | null = null;
let runtimesRef: { closeAll(): Promise<void> } | null = null;

function shutdown(code: number, reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down", { reason, code });
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
  p.catch((e) => log("closeAll failed", e)).finally(() => setTimeout(done, 50));
  setTimeout(() => {
    log("forced exit after 4s");
    process.exit(code);
  }, 4000).unref();
}

async function main() {
  if (process.argv[2] === "mcp-bridge") {
    await runMcpBridge();
    process.exit(0);
  }
  const { dataDir, agentsRoot } = parseArgs(process.argv.slice(2));
  const token = await readTokenFromStdin();
  if (!token) {
    console.error("upbotd: no auth token on stdin (first line required)");
    process.exit(2);
  }

  let approvalsRef: ApprovalService | null = null;
  const db = openDatabase(dataDir);
  dbRef = db;
  const chat = new ChatStore(db);
  chat.interruptRunningTurns();
  migrateLegacyHome(db, agentsRoot, log);
  const store = new AgentStore(db, agentsRoot);
  seedDefaultBot(db, store);
  const workspaceRoot = process.env.UPBOT_WORKSPACE_ROOT || join(dirname(agentsRoot), "Workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  const queue = new QueueStore(db);
  const hosts = new HostStore(db);
  const sockets = new Set<import("bun").ServerWebSocket<unknown>>();

  function broadcast(event: string, data: unknown) {
    const msg = JSON.stringify({ event, data });
    for (const ws of sockets) {
      try {
        ws.send(msg);
      } catch {}
    }
    mobile.onEvent(event, data);
    if (event === "turn.ended") {
      const turn = data as import("@upbot/protocol").Turn;
      queueMicrotask(() => {
        void (async () => {
          approvalsRef?.onTurnEnded(turn.agentId, turn.id);
          const row = turn.queueId ? queue.row(turn.queueId) : null;
          channels.onTurnEnded(turn, row);
          gateways.onTurnEnded(turn, row);
          team.onTurnEnded(turn, row);
          await subagents.onTurnEnded(turn, row);
        })().catch((e) => log("turn-ended hook failed", e));
      });
    }
  }

  const sharedRoot = process.env.UPBOT_SHARED_ROOT || join(dirname(agentsRoot), "Shared");
  const bridge = new Bridge(store, () => runtimes, sharedRoot);
  const memories = new MemoryStore(db);
  const skills = new SkillLibrary(sharedRoot);
  const runtimes = new RuntimeManager(
    store,
    chat,
    queue,
    broadcast,
    (id) => bridge.serversFor(id),
    (id) => upbotContext(workspaceRoot) + memories.promptBlock(id) + skills.promptBlock(),
    (id) => hosts.launchFor(id, bridge.port),
    () => [workspaceRoot],
  );
  const subagents = new SubagentService(db, store, chat, queue, () => runtimes, hosts, broadcast);
  bridge.subagents = subagents;
  runtimesRef = runtimes;
  const channels = new ChannelService(db, store, chat, () => runtimes, broadcast);
  bridge.channels = channels;
  bridge.memories = memories;
  bridge.skills = skills;
  bridge.broadcast = broadcast;
  const routines = new RoutineService(db, store, () => runtimes, broadcast);
  const browser = new BrowserService(join(dataDir, "browser-profile"), broadcast);
  bridge.browser = browser;
  const vault = new Vault(db, dataDir);
  const vmCredentials = new VmCredentials(vault);
  hosts.credentialEnv = (provider) => vmCredentials.env(provider);
  const computer = new ComputerUse(db);
  const voice = new Voice(join(dataDir, "voice"), mergedPath);
  bridge.vault = vault;
  const email = new EmailService(db, vault, broadcast);
  bridge.email = email;
  const apps = new AppsService(db, vault, broadcast);
  bridge.apps = apps;
  const approvals = new ApprovalService(db, vault, () => runtimes, broadcast, apps);
  bridge.approvals = approvals;
  const pages = new PageLibrary(db, workspaceRoot, broadcast);
  bridge.pages = pages;
  approvalsRef = approvals;
  bridge.connectors = new Connectors(vault);
  bridge.computer = computer;
  const mobile = new MobileServer(db);
  const team = new TeamClient(db, store, chat, () => runtimes, vault, broadcast);
  const gateways = new GatewayService(db, store, chat, () => runtimes, vault, broadcast);
  const rpc = new Rpc(
    store,
    chat,
    queue,
    runtimes,
    broadcast,
    channels,
    memories,
    skills,
    routines,
    browser,
    {
      vault,
      vmCredentials,
      computer,
      voice,
      gateways,
      email,
      apps,
      approvals,
      pages,
      marketplace: new Marketplace(db, skills, store),
      mobile,
      team,
      hosts,
      subagents,
    },
  );

  // warm the login-shell PATH cache so provider CLIs resolve like in a terminal
  const path = mergedPath();
  log(`PATH resolved (${path.split(":").length} entries)`);

  function checkOrigin(req: Request, route: string): Response | null {
    const origin = req.headers.get("origin");
    if (origin !== null && !ORIGIN_ALLOWLIST.has(origin)) {
      logLimited("auth.rejected", `${route}:403`, { route, status: 403, reason: "origin" });
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
        const denied = checkOrigin(req, "/ws");
        if (denied) return denied;
        const reqToken = url.searchParams.get("token") ?? "";
        if (!tokenEqual(reqToken, token)) {
          logLimited("auth.rejected", "/ws:401", { route: "/ws", status: 401 });
          return new Response("unauthorized", { status: 401 });
        }
        if (srv.upgrade(req)) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/bridge") {
        // called only by our mcp-bridge child processes, never by a browser
        if (req.method !== "POST" || req.headers.get("origin") !== null) {
          logLimited("auth.rejected", "/bridge:403", {
            route: "/bridge",
            status: 403,
            reason: req.headers.get("origin") !== null ? "origin" : "method",
          });
          return new Response("forbidden", { status: 403 });
        }
        const auth = req.headers.get("authorization") ?? "";
        const agentId = bridge.agentForToken(auth.startsWith("Bearer ") ? auth.slice(7) : "");
        if (!agentId) {
          logLimited("auth.rejected", "/bridge:401", { route: "/bridge", status: 401 });
          return new Response("unauthorized", { status: 401 });
        }
        return req
          .json()
          .then((body) => bridge.handle(agentId, body as Record<string, unknown>))
          .then(
            (r) => Response.json(r),
            (e) => {
              const message = (e as Error).message;
              logLimited("bridge.error", `/bridge:error:${agentId}`, { agentId, message });
              return new Response(message, { status: 400 });
            },
          );
      }
      const hook = /^\/hooks\/([\w-]+)$/.exec(url.pathname);
      if (hook) {
        // local webhook trigger for a routine (curl, scripts); never from a browser page
        if (req.method !== "POST" || req.headers.get("origin") !== null) {
          logLimited("auth.rejected", "/hooks/:id:403", {
            route: "/hooks/:id",
            status: 403,
            reason: req.headers.get("origin") !== null ? "origin" : "method",
            routineId: hook[1],
          });
          return new Response("forbidden", { status: 403 });
        }
        const auth = req.headers.get("authorization") ?? "";
        const id = routines.webhookRoutine(
          hook[1]!,
          auth.startsWith("Bearer ") ? auth.slice(7) : "",
        );
        if (!id) {
          logLimited("auth.rejected", "/hooks/:id:401", {
            route: "/hooks/:id",
            status: 401,
            routineId: hook[1],
          });
          return new Response("unauthorized", { status: 401 });
        }
        return req.text().then(
          (payload) => {
            const run = routines.run(id, "webhook", payload);
            return Response.json(run, { status: run.error ? 409 : 202 });
          },
          () => new Response("bad request", { status: 400 }),
        );
      }
      const pageMatch = /^\/pages\/([\w-]+)$/.exec(url.pathname);
      if (pageMatch && req.method === "GET") {
        return pages.serve(pageMatch[1]!, url.searchParams.get("token") ?? "");
      }
      if (url.pathname === "/health") {
        const denied = checkOrigin(req, "/health");
        if (denied) return denied;
        const auth = req.headers.get("authorization") ?? "";
        const reqToken = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!tokenEqual(reqToken, token)) {
          logLimited("auth.rejected", "/health:401", { route: "/health", status: 401 });
          return new Response("unauthorized", { status: 401 });
        }
        return Response.json({ ok: true, version: VERSION });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      maxPayloadLength: 48 * 1024 * 1024,
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
  pages.port = server.port ?? 0;
  runtimes.resumeAllQueues();
  routines.baseUrl = `http://127.0.0.1:${server.port}`;
  routines.start();
  gateways.startAll();
  mobile.rpc = (raw) => rpc.handle(raw);
  mobile.start();
  team.start();
  console.log(`UPBOT_READY {"port":${server.port}}`);
  log(`listening on 127.0.0.1:${server.port}, data dir ${dataDir}`);

  process.on("SIGTERM", () => shutdown(0, "SIGTERM"));
  process.on("SIGINT", () => shutdown(0, "SIGINT"));
}

main().catch((e) => {
  console.error("[upbotd] fatal", e);
  process.exit(1);
});
