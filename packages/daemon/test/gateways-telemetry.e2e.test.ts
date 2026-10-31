import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Agent, Gateway } from "@boto/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  startDaemon,
  stopTestChildren,
  tmp,
} from "./helpers";

setDefaultTimeout(30000);

type Json = Record<string, unknown>;
type GatewayLog = { event: string; ctx: Record<string, unknown> };
type TelegramState = {
  updates: Json[];
  sent: Json[];
  failNextSend: boolean;
  sendError?: string;
  pollError?: string;
};

const SLACK_BOT_TOKEN = `xoxb-SECRET-${crypto.randomUUID()}`;
const SLACK_APP_TOKEN = `xapp-SECRET-${crypto.randomUUID()}`;

async function waitFor<T>(fn: () => T | undefined, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = fn();
    if (value !== undefined) return value;
    await Bun.sleep(50);
  }
  throw new Error("timed out");
}

describe("gateway telemetry e2e", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  let agent: Agent;
  let fake: ReturnType<typeof Bun.serve>;
  let daemonToken: string;
  let base: string;
  let slackAuthError: string | null = null;
  let stderr = "";
  const telegram = new Map<string, TelegramState>();
  const slackSockets = new Set<{ close(code?: number, reason?: string): void }>();
  let updateId = 1;

  function logs(): GatewayLog[] {
    return stderr.split(/\r?\n/).flatMap((line) => {
      const match = /^\[botod\] (gateway\.\S+) (\{.*\})$/.exec(line);
      if (!match) return [];
      try {
        return [{ event: match[1]!, ctx: JSON.parse(match[2]!) as Record<string, unknown> }];
      } catch {
        return [];
      }
    });
  }

  function gatewayLogs(id: string): GatewayLog[] {
    return logs().filter((event) => event.ctx.gatewayId === id);
  }

  async function status(id: string): Promise<Gateway> {
    return ((await c.request("gateways.list", {})) as Gateway[]).find((g) => g.id === id)!;
  }

  async function waitForStatus(id: string, target: Gateway["status"]): Promise<Gateway> {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const current = await status(id);
      if (current.status === target) return current;
      await Bun.sleep(50);
    }
    throw new Error("timed out");
  }

  async function createTelegram(name: string, allowedUsers: string[] = ["42"]) {
    const token = `123456:TGSECRET${crypto.randomUUID().replaceAll("-", "")}`;
    telegram.set(token, { updates: [], sent: [], failNextSend: false });
    const gateway = (await c.request("gateways.create", {
      kind: "telegram",
      name,
      agentId: agent.id,
      tokens: { botToken: token },
      allowedUsers,
    })) as Gateway;
    await waitForStatus(gateway.id, "connected");
    return { gateway, token, state: telegram.get(token)! };
  }

  function telegramUpdate(userId: string, chatId: number, text: string): Json {
    const id = updateId++;
    return {
      update_id: id,
      message: {
        message_id: id * 10,
        chat: { id: chatId },
        from: { id: userId, username: "test-user" },
        text,
      },
    };
  }

  async function deleteGateway(id: string) {
    await c.request("gateways.delete", { id });
  }

  beforeAll(async () => {
    fake = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/slack-ws") {
          return server.upgrade(req, { data: { kind: "slack" } })
            ? undefined
            : new Response("no", { status: 400 });
        }
        const match = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
        if (match) {
          const state = telegram.get(match[1]!);
          if (!state) return Response.json({ ok: false, description: "Unauthorized" });
          if (match[2] === "getMe")
            return Response.json({ ok: true, result: { id: 1, is_bot: true } });
          if (match[2] === "getUpdates") {
            if (state.pollError) {
              const description = state.pollError;
              delete state.pollError;
              return Response.json({ ok: false, description });
            }
            if (state.updates.length === 0) await Bun.sleep(50);
            return Response.json({ ok: true, result: state.updates.splice(0) });
          }
          if (match[2] === "sendMessage") {
            const body = (await req.json()) as Json;
            state.sent.push(body);
            if (state.failNextSend) {
              state.failNextSend = false;
              const description = state.sendError ?? "Bad Request: chat not found";
              delete state.sendError;
              return Response.json({
                ok: false,
                description,
              });
            }
            return Response.json({ ok: true, result: {} });
          }
        }
        if (url.pathname === "/slack/auth.test") {
          if (slackAuthError) {
            const error = slackAuthError;
            slackAuthError = null;
            return Response.json({ ok: false, error });
          }
          return Response.json({
            ok: req.headers.get("authorization") === `Bearer ${SLACK_BOT_TOKEN}`,
            user_id: "UBOT",
          });
        }
        if (url.pathname === "/slack/apps.connections.open") {
          return Response.json({
            ok: req.headers.get("authorization") === `Bearer ${SLACK_APP_TOKEN}`,
            url: `ws://127.0.0.1:${server.port}/slack-ws`,
          });
        }
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          slackSockets.add(ws);
          ws.send(JSON.stringify({ type: "hello" }));
        },
        close(ws) {
          slackSockets.delete(ws);
        },
        message() {},
      },
    });
    base = `http://127.0.0.1:${fake.port}`;
    dataDir = tmp("gw-telemetry-data-");
    agentsRoot = tmp("gw-telemetry-agents-");
    stateDir = tmp("gw-telemetry-fake-");
    daemonToken = crypto.randomUUID();
    daemon = await startDaemon(dataDir, agentsRoot, daemonToken, {
      BOTO_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      BOTO_VAULT_KEY: "cd".repeat(32),
      BOTO_TELEGRAM_API: base,
      BOTO_SLACK_API: `${base}/slack`,
    });
    const reader = (daemon.proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    void (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        stderr += decoder.decode(value, { stream: true });
      }
      stderr += decoder.decode();
    })();
    c = await DaemonClient.connect(daemon.port, daemonToken);
    agent = (await c.request("agents.create", {
      name: "Telemetry",
      provider: "devin",
      instructions: "",
    })) as Agent;
  });

  afterAll(async () => {
    c?.close();
    fake?.stop(true);
    try {
      daemon.proc.kill("SIGKILL");
    } catch {}
    await daemon.proc.exited;
    await stopTestChildren(stateDir);
    for (const dir of [dataDir, agentsRoot, stateDir])
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("a send failure clears after a later successful reply", async () => {
    const { gateway, state } = await createTelegram("Send recovery");
    state.failNextSend = true;
    state.updates.push(telegramUpdate("42", 1042, "echo:one"));
    await waitFor(() =>
      gatewayLogs(gateway.id).find((event) => event.event === "gateway.send_failed"),
    );
    const failed = await status(gateway.id);
    expect(failed.status).toBe("connected");
    expect(failed.error).toBe("Bad Request: chat not found");

    state.updates.push(telegramUpdate("42", 1042, "echo:two"));
    await waitFor(() => state.sent.find((message) => message.text === "two"));
    await waitFor(() =>
      gatewayLogs(gateway.id).find((event) => event.event === "gateway.send_recovered"),
    );
    const recovered = await status(gateway.id);
    expect(recovered.status).toBe("connected");
    expect(recovered.error).toBeNull();
    await deleteGateway(gateway.id);
  });

  test("a Telegram polling outage logs disconnect, error, and recovery", async () => {
    const { gateway, state } = await createTelegram("Polling recovery");
    const start = logs().length;
    state.pollError = "Conflict: terminated by other getUpdates request";
    const sequence = await waitFor(() => {
      const events = logs()
        .slice(start)
        .filter((event) => event.ctx.gatewayId === gateway.id);
      const names = events.map((event) => event.event);
      const disconnected = names.indexOf("gateway.disconnected");
      const error = names.indexOf("gateway.error", disconnected + 1);
      const connected = names.indexOf("gateway.connected", error + 1);
      return disconnected >= 0 && error > disconnected && connected > error
        ? [events[disconnected]!, events[error]!, events[connected]!]
        : undefined;
    });
    expect(sequence[2]!.ctx.downtimeMs).toBeGreaterThan(0);
    expect(sequence[2]!.ctx.errorAttempts).toBeGreaterThanOrEqual(1);
    await deleteGateway(gateway.id);
  });

  test("a clean Slack reconnect reports downtime without error attempts", async () => {
    const gateway = (await c.request("gateways.create", {
      kind: "slack",
      name: "Slack reconnect",
      agentId: agent.id,
      tokens: { botToken: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN },
      allowedUsers: ["U1"],
    })) as Gateway;
    await waitForStatus(gateway.id, "connected");
    const start = logs().length;
    const socket = await waitFor(() => [...slackSockets][0]);
    socket.close(1000, "test reconnect");
    const sequence = await waitFor(() => {
      const events = logs()
        .slice(start)
        .filter((event) => event.ctx.gatewayId === gateway.id);
      const names = events.map((event) => event.event);
      const disconnected = names.indexOf("gateway.disconnected");
      const connected = names.indexOf("gateway.connected", disconnected + 1);
      return disconnected >= 0 && connected > disconnected
        ? [events[disconnected]!, events[connected]!]
        : undefined;
    });
    expect(sequence[1]!.ctx.downtimeMs).toBeGreaterThanOrEqual(0);
    expect(sequence[1]!.ctx.errorAttempts).toBe(0);
    expect((await status(gateway.id)).status).toBe("connected");
    await deleteGateway(gateway.id);
  });

  test("transport error telemetry redacts Telegram and Slack credentials", async () => {
    const { gateway, token, state } = await createTelegram("Telegram token redaction");
    const tokenPart = token.split(":")[1]!;
    const start = logs().length;
    state.pollError = `API failure at ${base}/bot${token}/getUpdates; token=${token}`;
    const errorLog = await waitFor(() =>
      logs()
        .slice(start)
        .find((event) => event.event === "gateway.error" && event.ctx.gatewayId === gateway.id),
    );
    await waitForStatus(gateway.id, "error");
    expect(stderr).not.toContain(token);
    expect(stderr).not.toContain(tokenPart);
    expect((await status(gateway.id)).error).not.toContain(token);
    expect(errorLog.ctx.error).toContain("[redacted]");
    await waitForStatus(gateway.id, "connected");
    state.failNextSend = true;
    state.sendError = `send failed at ${base}/bot${token}/sendMessage ${token}`;
    state.updates.push(telegramUpdate("42", 1042, "echo:secret-send"));
    const sendErrorLog = await waitFor(() =>
      gatewayLogs(gateway.id).find((event) => event.event === "gateway.send_failed"),
    );
    expect(stderr).not.toContain(token);
    expect(stderr).not.toContain(tokenPart);
    const sendFailed = await status(gateway.id);
    expect(sendFailed.status).toBe("connected");
    expect(sendFailed.error).toContain("send failed");
    expect(sendFailed.error).not.toContain(token);
    expect(sendErrorLog.ctx.error).toContain("[redacted]");
    await deleteGateway(gateway.id);

    slackAuthError = `invalid credentials ${SLACK_BOT_TOKEN} ${SLACK_APP_TOKEN}`;
    const slack = (await c.request("gateways.create", {
      kind: "slack",
      name: "Slack token redaction",
      agentId: agent.id,
      tokens: { botToken: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN },
      allowedUsers: ["U1"],
    })) as Gateway;
    const slackErrorLog = await waitFor(() =>
      gatewayLogs(slack.id).find((event) => event.event === "gateway.error"),
    );
    await waitForStatus(slack.id, "error");
    expect(stderr).not.toContain(SLACK_BOT_TOKEN);
    expect(stderr).not.toContain(SLACK_APP_TOKEN);
    expect((await status(slack.id)).error).not.toContain(SLACK_BOT_TOKEN);
    expect((await status(slack.id)).error).not.toContain(SLACK_APP_TOKEN);
    expect(slackErrorLog.ctx.error).toContain("[redacted]");
    await deleteGateway(slack.id);
  });

  test("invalid external user ids are recorded without log injection", async () => {
    const { gateway, state } = await createTelegram("Invalid user id");
    const forged = '7\n[botod] gateway.connected {"gatewayId":"forged"}';
    state.updates.push(telegramUpdate(forged, 1999, "hello"));
    const unauthorized = await waitFor(() =>
      gatewayLogs(gateway.id).find((event) => event.event === "gateway.unauthorized_user"),
    );
    expect(unauthorized.ctx).toMatchObject({ userId: null, userIdInvalid: true });
    expect(
      stderr
        .split(/\r?\n/)
        .some((line) => line.startsWith('[botod] gateway.connected {"gatewayId":"forged"}')),
    ).toBe(false);
    await deleteGateway(gateway.id);
  });

  test("safeGatewayError redacts secrets, URL paths, controls, and long messages", async () => {
    const module = await import("../src/gateways/index");
    const safeGatewayError = (
      module as unknown as {
        safeGatewayError?: (message: string, secrets: readonly string[]) => string;
      }
    ).safeGatewayError;
    expect(safeGatewayError).toBeDefined();
    const safe = safeGatewayError!(
      `token=123456:Abcdefghijklmnopqrstuvwxyz123456 url=https://api.example.test/bot/path ${SLACK_BOT_TOKEN} ${SLACK_APP_TOKEN}\nnext`,
      [SLACK_BOT_TOKEN, SLACK_APP_TOKEN],
    );
    expect(safe).not.toContain("Abcdefghijklmnopqrstuvwxyz123456");
    expect(safe).not.toContain(SLACK_BOT_TOKEN);
    expect(safe).not.toContain(SLACK_APP_TOKEN);
    expect(safe).toContain("https://api.example.test/[redacted]");
    expect(safe).not.toContain("\n");
    expect(safeGatewayError!("x".repeat(301), [])).toBe(`${"x".repeat(300)}…`);
  });
});
