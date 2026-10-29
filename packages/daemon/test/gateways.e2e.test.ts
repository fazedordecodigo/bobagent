import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(30000);

import { rmSync } from "node:fs";
import type { Agent, ChatItem, Gateway, VaultEntry } from "@upbot/protocol";
import {
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  ReconnectBackoff,
  STABLE_CONNECTION_MS,
  splitText,
} from "../src/gateways/common";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  startDaemon,
  stopTestChildren,
  tmp,
} from "./helpers";

const TOKEN = `gw-test-${crypto.randomUUID()}`;
type Json = Record<string, unknown>;

async function waitFor<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  ms = 15000,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v !== undefined) return v;
    await Bun.sleep(50);
  }
  throw new Error("timed out");
}

test("splitText keeps chunks under the limit", () => {
  const parts = splitText(`${"a".repeat(30)}\n${"b".repeat(30)}`, 40);
  expect(parts).toEqual(["a".repeat(30), "b".repeat(30)]);
  expect(splitText("x".repeat(95), 40).map((p) => p.length)).toEqual([40, 40, 15]);
});

test("ReconnectBackoff resets only after a connection stayed healthy", () => {
  let now = 0;
  const b = new ReconnectBackoff(() => now);
  expect([b.next(), b.next(), b.next()]).toEqual([1000, 2000, 4000]);
  b.markHealthy();
  now += STABLE_CONNECTION_MS - 1;
  expect(b.next()).toBe(8000);
  b.markHealthy();
  now += STABLE_CONNECTION_MS;
  expect(b.next()).toBe(INITIAL_BACKOFF_MS);
  for (let i = 0; i < 10; i++) b.next();
  expect(b.next()).toBe(MAX_BACKOFF_MS);
});

describe("messaging gateways e2e (fake Telegram, Slack, Discord)", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  let a: Agent;
  let bee: Agent;
  let fake: ReturnType<typeof Bun.serve>;
  const tgUpdates: Json[] = [];
  const tgSent: Json[] = [];
  const tg2Updates: Json[] = [];
  const tg2Sent: Json[] = [];
  const slackPosted: Json[] = [];
  const slackAcks: string[] = [];
  const slackEnvelopes: Json[] = [];
  const discordSent: { channel: string; body: Json }[] = [];
  let discordIdentify: Json | null = null;
  let badIdentifies = 0;
  const slackFlapOpens: number[] = [];
  const discordFlapIdentifies: number[] = [];
  let updateId = 1;
  let tg2FailSend = false;
  let tg2FailPoll = false;

  beforeAll(async () => {
    fake = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req, server) {
        const u = new URL(req.url);
        const port = server.port;
        if (u.pathname === "/slack-ws" || u.pathname === "/discord-ws") {
          const flap = u.searchParams.has("flap");
          return server.upgrade(req, { data: { kind: u.pathname, flap } })
            ? undefined
            : new Response("no", { status: 400 });
        }
        const tg = /^\/bot([^/]+)\/(\w+)$/.exec(u.pathname);
        if (tg) {
          if (tg[1] !== "TG-TOKEN" && tg[1] !== "TG-2")
            return Response.json({ ok: false, description: "Unauthorized" }, { status: 401 });
          const body = (await req.json().catch(() => ({}))) as Json;
          const isSecondTelegram = tg[1] === "TG-2";
          if (isSecondTelegram && tg2FailPoll && (tg[2] === "getMe" || tg[2] === "getUpdates"))
            return Response.json(
              { ok: false, description: "Conflict: polling broken for bot TG-2" },
              { status: 409 },
            );
          if (tg[2] === "getMe")
            return Response.json({ ok: true, result: { id: 1, is_bot: true } });
          if (tg[2] === "getUpdates") {
            const updates = isSecondTelegram ? tg2Updates : tgUpdates;
            if (updates.length === 0) await Bun.sleep(100);
            return Response.json({ ok: true, result: updates.splice(0) });
          }
          if (tg[2] === "sendMessage") {
            if (isSecondTelegram) {
              if (tg2FailSend)
                return Response.json(
                  { ok: false, description: "Bad Request: chat not found" },
                  { status: 400 },
                );
              tg2Sent.push(body);
            } else tgSent.push(body);
            return Response.json({ ok: true, result: {} });
          }
        }
        if (u.pathname.startsWith("/slack/")) {
          const method = u.pathname.slice(7);
          const auth = req.headers.get("authorization");
          if (method === "auth.test")
            return Response.json({ ok: auth === "Bearer xoxb-1", user_id: "UBOT" });
          if (method === "apps.connections.open") {
            const flap = auth === "Bearer xapp-flap";
            return Response.json({
              ok: auth === "Bearer xapp-1" || flap,
              url: `ws://127.0.0.1:${port}/slack-ws${flap ? "?flap=1" : ""}`,
            });
          }
          if (method === "chat.postMessage") {
            slackPosted.push((await req.json()) as Json);
            return Response.json({ ok: true });
          }
        }
        if (u.pathname === "/discord/gateway/bot")
          return Response.json({ url: `ws://127.0.0.1:${port}/discord-ws` });
        const dm = /^\/discord\/channels\/(\w+)\/messages$/.exec(u.pathname);
        if (dm && req.headers.get("authorization") === "Bot DC-TOKEN") {
          discordSent.push({ channel: dm[1]!, body: (await req.json()) as Json });
          return Response.json({ id: "m" });
        }
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          const { kind, flap } = ws.data as { kind: string; flap: boolean };
          if (kind === "/slack-ws" && flap) {
            slackFlapOpens.push(Date.now());
            ws.send(JSON.stringify({ type: "hello" }));
            ws.close(1011, "flap");
          } else if (kind === "/slack-ws") {
            ws.send(JSON.stringify({ type: "hello" }));
            for (const e of slackEnvelopes.splice(0)) ws.send(JSON.stringify(e));
          } else {
            ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }));
          }
        },
        message(ws, raw) {
          const msg = JSON.parse(String(raw)) as Json;
          if ((ws.data as { kind: string }).kind === "/slack-ws") {
            if (typeof msg.envelope_id === "string") slackAcks.push(msg.envelope_id);
            return;
          }
          if (msg.op !== 2) return;
          const d = msg.d as Json;
          if (d.token === "DC-BAD") {
            badIdentifies++;
            ws.close(4004, "Authentication failed");
            return;
          }
          const dispatch = (s: number, t: string, d: Json) =>
            ws.send(JSON.stringify({ op: 0, s, t, d }));
          if (d.token === "DC-FLAP") {
            discordFlapIdentifies.push(Date.now());
            dispatch(1, "READY", { user: { id: "FLAPBOT" } });
            ws.close(4000, "flap");
            return;
          }
          discordIdentify = d;
          dispatch(1, "READY", { user: { id: "BOTID" } });
          const author = { id: "D1", username: "dana" };
          dispatch(2, "MESSAGE_CREATE", {
            id: "x1",
            channel_id: "G1",
            guild_id: "S",
            content: "echo:ignored",
            author,
            mentions: [],
          });
          dispatch(3, "MESSAGE_CREATE", {
            id: "x2",
            channel_id: "G1",
            guild_id: "S",
            content: "<@BOTID> echo:hi discord",
            author,
            mentions: [{ id: "BOTID" }],
          });
        },
      },
    });
    const base = `http://127.0.0.1:${fake.port}`;
    dataDir = tmp("gw-data-");
    agentsRoot = tmp("gw-agents-");
    stateDir = tmp("gw-fake-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      UPBOT_VAULT_KEY: "cd".repeat(32),
      UPBOT_TELEGRAM_API: base,
      UPBOT_SLACK_API: `${base}/slack`,
      UPBOT_DISCORD_API: `${base}/discord`,
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
    a = (await c.request("agents.create", {
      name: "Main",
      provider: "devin",
      instructions: "",
    })) as Agent;
    bee = (await c.request("agents.create", {
      name: "Bee",
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
    for (const d of [dataDir, agentsRoot, stateDir])
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const tgMsg = (userId: number, text: string) => ({
    update_id: updateId++,
    message: {
      message_id: updateId * 10,
      chat: { id: userId + 1000 },
      from: { id: userId, username: `u${userId}` },
      text,
    },
  });
  test("create validates tokens; tokens are stored in the vault but hidden", async () => {
    await expect(
      c.request("gateways.create", {
        kind: "slack",
        name: "S",
        agentId: a.id,
        tokens: { botToken: "xoxb-1" },
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    const g = (await c.request("gateways.create", {
      kind: "telegram",
      name: "TG",
      agentId: a.id,
      tokens: { botToken: "TG-TOKEN" },
      allowedUsers: ["42"],
    })) as Gateway;
    expect(g).toMatchObject({ kind: "telegram", status: "connecting", allowedUsers: ["42"] });
    expect(JSON.stringify(g)).not.toContain("TG-TOKEN");
    expect((await c.request("vault.list", {})) as VaultEntry[]).toEqual([]);
    let status = "";
    for (let i = 0; i < 100 && status !== "connected"; i++) {
      status = ((await c.request("gateways.list", {})) as Gateway[]).find(
        (x) => x.id === g.id,
      )!.status;
      await Bun.sleep(50);
    }
    expect(status).toBe("connected");
  });

  test("telegram: allowlisted users reach the agent and get the reply; others are refused", async () => {
    tgUpdates.push(tgMsg(42, "echo:hello telegram"), tgMsg(7, "hi"));
    const reply = await waitFor(() => tgSent.find((m) => m.chat_id === "1042"));
    expect(reply.text).toBe("hello telegram");
    const refused = await waitFor(() => tgSent.find((m) => m.chat_id === "1007"));
    expect(String(refused.text)).toContain("allow user id 7");
    const { items } = (await c.request("chat.history", { agentId: a.id })) as { items: ChatItem[] };
    const u = items.find((i) => i.kind === "user_message") as Extract<
      ChatItem,
      { kind: "user_message" }
    >;
    expect(u.text).toBe("echo:hello telegram");
    expect(u.gateway).toMatchObject({
      kind: "telegram",
      chatId: "1042",
      userId: "42",
      userName: "u42",
    });
  });

  test("telegram: @Agent prefix routes to another agent", async () => {
    tgUpdates.push(tgMsg(42, "@bee echo:routed"));
    await waitFor(() => tgSent.find((m) => m.text === "routed"));
    const { items } = (await c.request("chat.history", { agentId: bee.id })) as {
      items: ChatItem[];
    };
    expect(items.some((i) => i.kind === "user_message" && i.text === "echo:routed")).toBe(true);
  });

  test("slack socket mode: acks envelopes and replies in thread to mentions", async () => {
    slackEnvelopes.push(
      {
        envelope_id: "env-1",
        type: "events_api",
        payload: {
          event: {
            type: "app_mention",
            user: "U1",
            text: "<@UBOT> echo:hi slack",
            channel: "C1",
            ts: "111.1",
          },
        },
      },
      {
        envelope_id: "env-2",
        type: "events_api",
        payload: {
          event: {
            type: "message",
            user: "U1",
            text: "echo:not for me",
            channel: "C1",
            ts: "111.2",
          },
        },
      },
    );
    await c.request("gateways.create", {
      kind: "slack",
      name: "Slack",
      agentId: a.id,
      tokens: { botToken: "xoxb-1", appToken: "xapp-1" },
      allowedUsers: ["U1"],
    });
    const post = await waitFor(() => slackPosted.find((p) => p.text === "hi slack"));
    expect(post).toMatchObject({ channel: "C1", thread_ts: "111.1" });
    expect(slackAcks).toEqual(["env-1", "env-2"]);
    await Bun.sleep(300);
    expect(slackPosted.some((p) => p.text === "not for me")).toBe(false);
  });

  test("discord gateway: identifies with intents and replies to mentions only", async () => {
    const g = (await c.request("gateways.create", {
      kind: "discord",
      name: "Discord",
      agentId: a.id,
      tokens: { botToken: "DC-TOKEN" },
      allowedUsers: ["D1"],
    })) as Gateway;
    const sent = await waitFor(() => discordSent.find((m) => m.body.content === "hi discord"));
    expect(sent.channel).toBe("G1");
    expect(sent.body.message_reference).toMatchObject({ message_id: "x2" });
    expect(discordIdentify).toMatchObject({ token: "DC-TOKEN" });
    expect(Number(discordIdentify!.intents) & (1 << 15)).toBe(1 << 15);
    expect(discordSent.some((m) => m.body.content === "ignored")).toBe(false);
    const off = (await c.request("gateways.update", { id: g.id, enabled: false })) as Gateway;
    expect(off.status).toBe("stopped");
    await c.request("gateways.delete", { id: g.id });
    expect(((await c.request("gateways.list", {})) as Gateway[]).map((x) => x.kind)).toEqual([
      "telegram",
      "slack",
    ]);
  });

  test("telegram send errors stay separate from connection status", async () => {
    const relay = (await c.request("agents.create", {
      name: "Relay",
      provider: "devin",
      instructions: "",
    })) as Agent;
    let gatewayId: string | undefined;
    const waitGateway = (predicate: (gateway: Gateway) => boolean) =>
      waitFor(async () => {
        const current = ((await c.request("gateways.list", {})) as Gateway[]).find(
          (gateway) => gateway.id === gatewayId,
        );
        return current && predicate(current) ? current : undefined;
      });
    try {
      const gateway = (await c.request("gateways.create", {
        kind: "telegram",
        name: "Relay Telegram",
        agentId: relay.id,
        tokens: { botToken: "TG-2" },
        allowedUsers: ["43"],
      })) as Gateway;
      gatewayId = gateway.id;
      await waitGateway((current) => current.status === "connected");

      tg2FailSend = true;
      tg2Updates.push(tgMsg(43, "echo:lost reply"));
      const failedSend = await waitGateway(
        (current) => current.error?.includes("chat not found") === true,
      );
      expect(failedSend.status).toBe("connected");
      expect(tg2Sent.some((message) => message.text === "lost reply")).toBe(false);
      expect(failedSend.error).not.toContain("TG-2");

      tg2FailPoll = true;
      const pollError = await waitGateway(
        (current) =>
          current.status === "error" && current.error?.includes("polling broken") === true,
      );
      expect(pollError.status).toBe("error");
      expect(pollError.error ?? "").toContain("[redacted]");
      expect(pollError.error ?? "").not.toContain("TG-2");
      tg2FailPoll = false;
      const recovered = await waitGateway((current) => current.status === "connected");
      expect(recovered.error ?? "").toContain("chat not found");

      tg2FailSend = false;
      tg2Updates.push(tgMsg(43, "echo:delivered"));
      await waitFor(() => tg2Sent.find((message) => message.text === "delivered"));
      await waitGateway((current) => current.error === null);

      tg2Updates.push(tgMsg(43, "slow"));
      await waitFor(async () => {
        const { items, turns } = (await c.request("chat.history", {
          agentId: relay.id,
        })) as { items: ChatItem[]; turns: { id: string; status: string }[] };
        const userMessage = items.find(
          (item) => item.kind === "user_message" && item.text === "slow",
        );
        return userMessage &&
          turns.some((turn) => turn.id === userMessage.turnId && turn.status === "running")
          ? true
          : undefined;
      });
      tg2FailPoll = true;
      const slowPollError = await waitGateway(
        (current) =>
          current.status === "error" && current.error?.includes("polling broken") === true,
      );
      expect(slowPollError.status).toBe("error");
      const from = c.events.length;
      await c.request("chat.cancel", { agentId: relay.id });
      await waitFor(() =>
        tg2Sent.find((message) => message.text === "The agent stopped before replying."),
      );
      const sentAt = c.events.length;
      const updatedAt = await waitFor(() => {
        const index = c.events.findIndex(
          (event, i) =>
            i >= sentAt &&
            event.event === "gateway.updated" &&
            (event.data as Gateway).id === gatewayId,
        );
        return index >= sentAt ? index : undefined;
      });
      const updates = c.events
        .slice(from, updatedAt + 1)
        .filter(
          (event) => event.event === "gateway.updated" && (event.data as Gateway).id === gatewayId,
        )
        .map((event) => event.data as Gateway);
      expect(updates.length).toBeGreaterThan(0);
      for (const update of updates) {
        expect(update.status).toBe("error");
        expect(update.error ?? "").toContain("polling broken");
      }
      tg2FailPoll = false;
      await waitGateway((current) => current.status === "connected" && current.error === null);
      expect(
        c.events
          .filter(
            (event) =>
              event.event === "gateway.updated" && (event.data as Gateway).id === gatewayId,
          )
          .every((event) => !JSON.stringify(event.data).includes("TG-2")),
      ).toBe(true);
    } finally {
      tg2FailSend = false;
      tg2FailPoll = false;
      if (gatewayId) await c.request("gateways.delete", { id: gatewayId }).catch(() => {});
    }
  });

  test("discord: a fatal close code reports error and stops reconnecting", async () => {
    const g = (await c.request("gateways.create", {
      kind: "discord",
      name: "DiscordBad",
      agentId: a.id,
      tokens: { botToken: "DC-BAD" },
    })) as Gateway;
    let gw: Gateway | undefined;
    for (let i = 0; i < 100 && gw?.status !== "error"; i++) {
      gw = ((await c.request("gateways.list", {})) as Gateway[]).find((x) => x.id === g.id);
      await Bun.sleep(50);
    }
    expect(gw?.status).toBe("error");
    expect(gw?.error).toContain("4004");
    await Bun.sleep(1500);
    expect(badIdentifies).toBe(1);
    await c.request("gateways.delete", { id: g.id });
  });

  // Sockets that open (Slack) or reach READY (Discord) and then close right away must keep
  // backing off: 1 s, 2 s, 4 s between reconnects instead of a fixed 1 s loop.
  const expectBackoffGaps = (times: number[]) => {
    const gaps = times.slice(1).map((t, i) => t - (times[i] ?? t));
    expect(gaps[0]).toBeGreaterThanOrEqual(900);
    expect(gaps[1]).toBeGreaterThanOrEqual(1800);
    expect(gaps[2]).toBeGreaterThanOrEqual(3600);
  };

  test("slack: sockets that open and promptly close reconnect with exponential backoff", async () => {
    const g = (await c.request("gateways.create", {
      kind: "slack",
      name: "SlackFlap",
      agentId: a.id,
      tokens: { botToken: "xoxb-1", appToken: "xapp-flap" },
    })) as Gateway;
    await waitFor(() => (slackFlapOpens.length >= 4 ? true : undefined), 20000);
    await c.request("gateways.delete", { id: g.id });
    expectBackoffGaps(slackFlapOpens);
    const gw = ((await c.request("gateways.list", {})) as Gateway[]).find((x) => x.id === g.id);
    expect(gw).toBeUndefined();
  });

  test("discord: nonfatal closes right after READY reconnect with exponential backoff", async () => {
    const g = (await c.request("gateways.create", {
      kind: "discord",
      name: "DiscordFlap",
      agentId: a.id,
      tokens: { botToken: "DC-FLAP" },
    })) as Gateway;
    await waitFor(() => (discordFlapIdentifies.length >= 2 ? true : undefined), 20000);
    const gw = ((await c.request("gateways.list", {})) as Gateway[]).find((x) => x.id === g.id);
    expect(gw?.status).not.toBe("error");
    await waitFor(() => (discordFlapIdentifies.length >= 4 ? true : undefined), 20000);
    await c.request("gateways.delete", { id: g.id });
    expectBackoffGaps(discordFlapIdentifies);
  });
});
