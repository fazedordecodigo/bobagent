import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, GatewayKind, Turn } from "@upbot/protocol";
import type { AgentStore } from "../src/agents";
import type { ChatStore } from "../src/chat-store";
import { openDatabase } from "../src/db";
import { GatewayService } from "../src/gateways";
import type { Transport, TransportHooks } from "../src/gateways/common";
import type { RuntimeManager } from "../src/runtime/runtime-manager";
import type { Vault } from "../src/vault";

type FakeTransport = Transport & {
  hooks: TransportHooks;
  sent: { chatId: string; text: string; replyTo?: string }[];
  stopped: boolean;
  failWith?: unknown;
};

test("gateway notices stay bound to their source transport and send errors stay separate", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "upbot-gateway-service-"));
  const db = openDatabase(dataDir);
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});
  let stopTransports = () => {};
  try {
    const agent: Agent = {
      id: "agent",
      name: "Relay",
      instructions: "",
      provider: "devin",
      config: {},
      workspacePath: join(dataDir, "workspace"),
      avatar: null,
      createdAt: 1,
      updatedAt: 1,
    };
    db.query(
      "INSERT INTO agents (id, name, instructions, provider, workspace_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(agent.id, agent.name, agent.instructions, agent.provider, agent.workspacePath, 1, 1);

    const agents = {
      get: (id: string) => (id === agent.id ? agent : null),
      list: () => [agent],
    } as unknown as AgentStore;
    const chat = {
      itemsForTurn: () => [{ kind: "agent_message", text: "reply" }],
      turnReplyText: () => "reply",
    } as unknown as ChatStore;
    let runtimeFails = false;
    const runtimes = {
      sendFrom: () => {
        if (runtimeFails) throw new Error("runtime unavailable");
        return { queueId: "queue" };
      },
    } as unknown as RuntimeManager;
    const secrets = new Map<string, string>();
    const vault = {
      set: (name: string, value: string) => secrets.set(name, value),
      revealInternal: (name: string) => secrets.get(name) ?? "",
      delete: (name: string) => secrets.delete(name),
    } as unknown as Vault;
    const broadcasts: { event: string; data: unknown }[] = [];
    const transports: (FakeTransport & { kind: GatewayKind; tokens: Record<string, string> })[] =
      [];
    const createTransport = (
      kind: GatewayKind,
      tokens: Record<string, string>,
      hooks: TransportHooks,
    ): Transport => {
      const transport: FakeTransport & { kind: GatewayKind; tokens: Record<string, string> } = {
        kind,
        tokens,
        hooks,
        sent: [],
        stopped: false,
        start() {},
        stop() {
          transport.stopped = true;
        },
        async send(chatId, text, replyTo) {
          if (transport.failWith !== undefined) throw transport.failWith;
          transport.sent.push({ chatId, text, ...(replyTo ? { replyTo } : {}) });
        },
      };
      transports.push(transport);
      return transport;
    };
    const service = new GatewayService(
      db,
      agents,
      chat,
      () => runtimes,
      vault,
      (event, data) => broadcasts.push({ event, data }),
      createTransport,
    );
    stopTransports = () => service.stopAll();

    const gateway = service.create({
      kind: "telegram",
      name: "Relay",
      agentId: agent.id,
      tokens: { botToken: "bot-secret" },
      allowedUsers: ["1"],
    });
    const first = transports[0];
    if (!first) throw new Error("transport factory was not called");
    service.update({ id: gateway.id, tokens: { botToken: "bot-secret-2" } });
    const second = transports[1];
    if (!second) throw new Error("updated transport factory was not called");
    expect(first.stopped).toBe(true);

    first.hooks.onMessage({
      chatId: "chat",
      userId: "9",
      userName: "unknown",
      text: "hello",
    });
    await Bun.sleep(0);
    expect(first.sent[0]?.text).toContain("allow user id 9");
    expect(second.sent).toEqual([]);

    runtimeFails = true;
    first.hooks.onMessage({
      chatId: "chat",
      userId: "1",
      userName: "allowed",
      text: "hello",
    });
    await Bun.sleep(0);
    expect(first.sent[1]?.text).toContain("UpBot could not deliver this");
    expect(second.sent).toEqual([]);

    second.hooks.onStatus("connected");
    first.failWith = new Error("stale send failed");
    first.hooks.onMessage({
      chatId: "chat",
      userId: "9",
      userName: "unknown",
      text: "hello again",
    });
    await Bun.sleep(0);
    expect(service.get(gateway.id)).toMatchObject({ status: "connected", error: null });

    const turn = { id: "turn", status: "completed" } as Turn;
    const queueRow = {
      meta_json: JSON.stringify({
        gateway: {
          id: gateway.id,
          kind: "telegram",
          name: "Relay",
          chatId: "chat",
          userId: "1",
          userName: "unknown",
        },
      }),
    };
    const from = broadcasts.length;
    second.hooks.onStatus("error", "connect failed for bot-secret-2");
    expect(service.get(gateway.id).error).toBe("connect failed for [redacted]");
    expect(
      broadcasts
        .slice(from)
        .filter((event) => event.event === "gateway.updated")
        .every((event) => !JSON.stringify(event.data).includes("bot-secret-2")),
    ).toBe(true);
    second.hooks.onStatus("error", "x".repeat(600));
    expect(service.get(gateway.id).error).toHaveLength(500);
    second.hooks.onStatus("error", "poll broken");
    service.onTurnEnded(turn, queueRow);
    await Bun.sleep(0);
    expect(service.get(gateway.id)).toMatchObject({
      status: "error",
      error: "poll broken",
    });

    second.hooks.onStatus("connected");
    second.failWith = new Error("boom bot-secret-2");
    service.onTurnEnded(turn, queueRow);
    await Bun.sleep(0);
    expect(service.get(gateway.id)).toMatchObject({
      status: "connected",
      error: "boom [redacted]",
    });
    second.hooks.onStatus("connected");
    expect(service.get(gateway.id).error).toBe("boom [redacted]");

    const logged = String(errorSpy.mock.calls.at(-1)?.[0]);
    expect(logged).toContain(`gateway ${gateway.id} (telegram) send failed (Error)`);
    expect(logged).not.toContain("bot-secret");
    expect(logged).not.toContain("boom");

    second.failWith = undefined;
    service.onTurnEnded(turn, queueRow);
    await Bun.sleep(0);
    expect(service.get(gateway.id).error).toBeNull();
  } finally {
    stopTransports();
    errorSpy.mockRestore();
    db.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
