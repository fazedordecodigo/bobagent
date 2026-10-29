import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Agent, ChatItem, ConnectedApp, Turn } from "@upbot/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  ROOT,
  startDaemon,
  stopTestChildren,
  tmp,
} from "./helpers";

const FIXTURE = join(ROOT, "packages/daemon/test/fixtures/fake-mcp-diagnostics.ts");
const SECRET = "fictional-alpha-credential-omega";

describe("credential-safe app diagnostics through the real daemon", () => {
  let daemon: DaemonHandle;
  let client: DaemonClient;
  let dirs: string[];
  let stderr = "";
  let pump: Promise<void>;
  let agent: Agent;

  beforeAll(async () => {
    dirs = [tmp("diagnostic-data-"), tmp("diagnostic-agents-"), tmp("diagnostic-acp-")];
    const auth = `diagnostic-${crypto.randomUUID()}`;
    daemon = await startDaemon(dirs[0]!, dirs[1]!, auth, {
      UPBOT_VAULT_KEY: "ef".repeat(32),
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: dirs[2]!,
    });
    pump = (async () => {
      const reader = (daemon.proc.stderr as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        stderr += decoder.decode(value, { stream: true });
      }
    })();
    client = await DaemonClient.connect(daemon.port, auth);
    agent = (await client.request("agents.create", {
      name: "Diagnostic bot",
      provider: "devin",
      instructions: "",
    })) as Agent;
  });

  afterAll(async () => {
    client?.close();
    daemon?.proc.kill();
    await daemon?.proc.exited;
    await pump;
    await stopTestChildren(dirs[2]);
    for (const dir of dirs)
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    expectNoFragments(stderr);
    expect(stderr.includes("xyz")).toBe(false);
  });

  async function connect(mode: string, secret = SECRET) {
    return (await client.request("apps.connect", {
      catalogId: "custom-stdio",
      name: `Diagnostic ${mode}`,
      command: ["bun", FIXTURE],
      secrets: { FAKE_DIAGNOSTIC_MODE: mode, FAKE_DIAGNOSTIC_TOKEN: secret },
    })) as ConnectedApp;
  }

  async function waitForStatus(id: string, status: ConnectedApp["status"]) {
    for (let i = 0; i < 100; i++) {
      const apps = (await client.request("apps.list", {})) as ConnectedApp[];
      const app = apps.find((a) => a.id === id)!;
      if (app.status === status) return app;
      await Bun.sleep(50);
    }
    throw new Error("app did not reach expected status");
  }

  function expectNoFragments(output: string, secret = SECRET) {
    for (const part of [secret, secret.slice(0, 12), secret.slice(12)])
      expect(output.includes(part)).toBe(false);
  }

  async function waitForLog(id: string) {
    for (let i = 0; i < 100; i++) {
      if (stderr.includes(id)) return;
      await Bun.sleep(50);
    }
    throw new Error("app diagnostic was not logged");
  }

  for (const mode of [
    "newline",
    "truncated",
    "prefix-line",
    "rpc-error",
    "multiline",
    "list-error",
  ]) {
    test(`suppresses untrusted ${mode} startup diagnostics in RPC and stderr`, async () => {
      const secret = mode === "multiline" ? "fictional-multiline\nxyz" : SECRET;
      const app = await connect(mode, secret);
      try {
        const failed = await waitForStatus(app.id, "error");
        await waitForLog(app.id);
        const listed = JSON.stringify(await client.request("apps.list", {}));
        expectNoFragments(failed.error ?? "", secret);
        expectNoFragments(listed, secret);
        expectNoFragments(stderr, secret);
        if (mode === "multiline") {
          expect(listed.includes("xyz")).toBe(false);
          expect(stderr.includes("xyz")).toBe(false);
        }
        expect((failed.error ?? "").length).toBeLessThanOrEqual(500);
        expect(
          failed.error?.includes(mode === "list-error" ? "tools/list" : "transport initialization"),
        ).toBe(true);
        expect(stderr.includes("[upbotd] app start failed")).toBe(true);
      } finally {
        await client.request("apps.delete", { id: app.id });
      }
    });
  }

  test("suppresses credential fragments in HTTP transport failure bodies", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(`credential=${SECRET.slice(0, 12)}\n${SECRET.slice(12)}`, { status: 403 }),
    });
    let app: ConnectedApp | undefined;
    try {
      app = (await client.request("apps.connect", {
        catalogId: "custom-http",
        name: "Diagnostic HTTP",
        url: `http://127.0.0.1:${server.port}/mcp`,
        secrets: { TOKEN: SECRET },
        headers: { Authorization: "Bearer {TOKEN}" },
      })) as ConnectedApp;
      const failed = await waitForStatus(app.id, "error");
      await waitForLog(app.id);
      expectNoFragments(JSON.stringify(failed));
      expectNoFragments(stderr);
      expect(failed.error?.includes("app MCP startup failed (transport initialization)")).toBe(
        true,
      );
    } finally {
      if (app) await client.request("apps.delete", { id: app.id });
      server.stop(true);
    }
  });

  async function tool(app: ConnectedApp, name: string) {
    const { queueId } = (await client.request("chat.send", {
      agentId: agent.id,
      text: `mcp:${app.slug}-${name} {}`,
    })) as { queueId: string };
    const turn = (await client.waitForEventWhere(
      "turn.ended",
      (data) => (data as Turn).queueId === queueId,
    )) as Turn;
    const { items } = (await client.request("chat.history", { agentId: agent.id })) as {
      items: ChatItem[];
    };
    return JSON.stringify(items.filter((item) => item.turnId === turn.id));
  }

  test("preserves safe successful and isError tool results but not thrown diagnostics", async () => {
    const app = await connect("tools");
    try {
      await waitForStatus(app.id, "ready");
      const ok = await tool(app, "get_safe");
      const error = await tool(app, "get_error");
      const exception = await tool(app, "get_exception");
      await waitForLog(app.id);
      expect(ok.includes("Found 3 records")).toBe(true);
      expect(error.includes("tool-error:No matching record")).toBe(true);
      expect(exception.includes("app MCP tool call failed")).toBe(true);
      expect(ok.includes("[redacted]")).toBe(true);
      expect(error.includes("[redacted]")).toBe(true);
      expectNoFragments(ok);
      expectNoFragments(error);
      expectNoFragments(exception);
      expectNoFragments(stderr);
    } finally {
      await client.request("apps.delete", { id: app.id });
    }
  });

  test("suppresses fragmented stderr on exit after a successful startup", async () => {
    const app = await connect("exit");
    try {
      await waitForStatus(app.id, "ready");
      const output = await tool(app, "get_exit");
      const failed = await waitForStatus(app.id, "error");
      await waitForLog(app.id);
      expectNoFragments(JSON.stringify(failed));
      expectNoFragments(output);
      expectNoFragments(stderr);
      expect(stderr.includes("[upbotd] app MCP server exited")).toBe(true);
    } finally {
      await client.request("apps.delete", { id: app.id });
    }
  });
});
