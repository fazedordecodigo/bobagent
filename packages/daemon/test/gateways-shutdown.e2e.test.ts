import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(30000);

import { rmSync } from "node:fs";
import type { Gateway } from "@upbot/protocol";
import { DaemonClient, type DaemonHandle, startDaemon, tmp, waitForExit } from "./helpers";

const TOKEN = `gw-shutdown-${crypto.randomUUID()}`;

async function waitFor<T>(
  fn: () => Promise<T | undefined> | T | undefined,
  ms = 15000,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value !== undefined) return value;
    await Bun.sleep(50);
  }
  throw new Error("timed out");
}

describe("gateway transport cleanup on daemon shutdown", () => {
  let dataDir: string;
  let agentsRoot: string;
  let daemon: DaemonHandle | undefined;
  let client: DaemonClient | undefined;
  let fake: ReturnType<typeof Bun.serve> | undefined;
  let slackOpen = false;
  let discordOpen = false;
  let telegramInFlight = 0;
  let telegramAborted = 0;
  let telegramGetUpdatesCalls = 0;
  const telegramCallStartedAt: number[] = [];
  const closeCodes: { kind: "slack" | "discord"; code: number }[] = [];

  beforeAll(async () => {
    fake = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req, server) {
        const url = new URL(req.url);
        const port = server.port;

        if (url.pathname === "/slack-ws" || url.pathname === "/discord-ws") {
          const kind = url.pathname === "/slack-ws" ? "slack" : "discord";
          return server.upgrade(req, { data: { kind } })
            ? undefined
            : new Response("no", { status: 400 });
        }

        const telegram = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
        if (telegram) {
          if (telegram[1] !== "TG-TOKEN")
            return Response.json({ ok: false, description: "Unauthorized" }, { status: 401 });
          if (telegram[2] === "getMe")
            return Response.json({ ok: true, result: { id: 1, is_bot: true } });
          if (telegram[2] === "getUpdates") {
            telegramGetUpdatesCalls++;
            telegramCallStartedAt.push(Date.now());
            telegramInFlight++;
            return await new Promise<Response>((resolve) => {
              let finished = false;
              let timer: ReturnType<typeof setTimeout>;
              const finish = (aborted = false) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                req.signal.removeEventListener("abort", onAbort);
                telegramInFlight--;
                if (aborted) telegramAborted++;
                resolve(Response.json({ ok: true, result: [] }));
              };
              const onAbort = () => finish(true);
              timer = setTimeout(() => finish(), 25000);
              if (req.signal.aborted) finish(true);
              else req.signal.addEventListener("abort", onAbort, { once: true });
            });
          }
        }

        if (url.pathname === "/slack/auth.test") {
          return Response.json({
            ok: req.headers.get("authorization") === "Bearer xoxb-1",
            user_id: "UBOT",
          });
        }
        if (url.pathname === "/slack/apps.connections.open") {
          return Response.json({
            ok: req.headers.get("authorization") === "Bearer xapp-1",
            url: `ws://127.0.0.1:${port}/slack-ws`,
          });
        }
        if (url.pathname === "/discord/gateway/bot")
          return Response.json({ url: `ws://127.0.0.1:${port}/discord-ws` });
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          const kind = (ws.data as { kind: "slack" | "discord" }).kind;
          if (kind === "slack") {
            slackOpen = true;
            ws.send(JSON.stringify({ type: "hello" }));
          } else {
            discordOpen = true;
            ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }));
          }
        },
        message(ws, raw) {
          if ((ws.data as { kind: string }).kind !== "discord") return;
          const frame = JSON.parse(String(raw)) as { op?: number };
          if (frame.op === 2) {
            ws.send(
              JSON.stringify({
                op: 0,
                s: 1,
                t: "READY",
                d: { user: { id: "BOTID" } },
              }),
            );
          }
        },
        close(ws, code) {
          const kind = (ws.data as { kind: "slack" | "discord" }).kind;
          if (kind === "slack") slackOpen = false;
          else discordOpen = false;
          closeCodes.push({ kind, code });
        },
      },
    });

    const base = `http://127.0.0.1:${fake.port}`;
    dataDir = tmp("gateway-shutdown-data-");
    agentsRoot = tmp("gateway-shutdown-agents-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      UPBOT_VAULT_KEY: "cd".repeat(32),
      UPBOT_TELEGRAM_API: base,
      UPBOT_SLACK_API: `${base}/slack`,
      UPBOT_DISCORD_API: `${base}/discord`,
    });
    client = await DaemonClient.connect(daemon.port, TOKEN);
  });

  afterAll(async () => {
    client?.close();
    fake?.stop(true);
    if (daemon?.proc.exitCode === null) {
      try {
        daemon.proc.kill("SIGKILL");
      } catch {}
    }
    await daemon?.proc.exited;
    for (const dir of [dataDir, agentsRoot]) {
      if (dir)
        rmSync(dir, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
    }
  });

  test("stops Telegram polling and closes Slack and Discord websockets on stdin EOF", async () => {
    const c = client;
    const proc = daemon?.proc;
    if (!c || !proc) throw new Error("daemon did not start");
    const agent = (await c.request("agents.create", {
      name: "Gateway shutdown",
      provider: "devin",
      instructions: "",
    })) as { id: string };
    const gateways = await Promise.all([
      c.request("gateways.create", {
        kind: "telegram",
        name: "Telegram",
        agentId: agent.id,
        tokens: { botToken: "TG-TOKEN" },
      }),
      c.request("gateways.create", {
        kind: "slack",
        name: "Slack",
        agentId: agent.id,
        tokens: { botToken: "xoxb-1", appToken: "xapp-1" },
      }),
      c.request("gateways.create", {
        kind: "discord",
        name: "Discord",
        agentId: agent.id,
        tokens: { botToken: "DC-TOKEN" },
      }),
    ]);
    const gatewayIds = (gateways as Gateway[]).map((gateway) => gateway.id);

    await waitFor(async () => {
      const current = (await c.request("gateways.list", {})) as Gateway[];
      return current.every(
        (gateway) => gatewayIds.includes(gateway.id) && gateway.status === "connected",
      ) &&
        current.length === gatewayIds.length &&
        slackOpen &&
        discordOpen &&
        telegramInFlight > 0
        ? current
        : undefined;
    });

    c.close();
    const shutdownStartedAt = Date.now();
    (proc.stdin as { end(): void }).end();
    expect(await waitForExit(proc, 10000)).toBe(0);
    await waitFor(() =>
      closeCodes.some(({ kind }) => kind === "slack") &&
      closeCodes.some(({ kind }) => kind === "discord")
        ? closeCodes
        : undefined,
    );

    // 1006 means the transport was left open until process exit.
    expect({
      slack: closeCodes.filter(({ kind }) => kind === "slack").map(({ code }) => code),
      discord: closeCodes.filter(({ kind }) => kind === "discord").map(({ code }) => code),
    }).toEqual({ slack: [1005], discord: [1005] });
    expect(telegramAborted).toBe(1);
    expect(telegramGetUpdatesCalls).toBeGreaterThan(0);
    expect(telegramInFlight).toBe(0);
    expect(telegramCallStartedAt.every((startedAt) => startedAt <= shutdownStartedAt)).toBe(true);
  });
});
