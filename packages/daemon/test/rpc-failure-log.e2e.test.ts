import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { DaemonHandle } from "./helpers";
import { DaemonClient, startDaemon, tmp } from "./helpers";

const TOKEN = `rpc-log-test-${crypto.randomUUID()}`;
const SECRET = `mk-secret-${crypto.randomUUID()}`;

describe("RPC failure logs", () => {
  let dataDir: string;
  let agentsRoot: string;
  let daemon: DaemonHandle;
  let client: DaemonClient;
  let server: ReturnType<typeof Bun.serve>;
  let source: string;
  let stderr = "";
  let stderrPump: Promise<void>;

  const waitForStderr = async (
    pred: (buffer: string) => boolean,
    timeoutMs = 5000,
  ): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pred(stderr)) return stderr;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`stderr condition timed out; captured: ${stderr}`);
  };

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response("unavailable", { status: 500 });
      },
    });
    source = `http://127.0.0.1:${server.port}/index.json?token=${SECRET}`;
    dataDir = tmp("rpc-log-data-");
    agentsRoot = tmp("rpc-log-agents-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, { UPBOT_MARKETPLACE_URL: source });
    const reader = (daemon.proc.stderr as ReadableStream<Uint8Array>).getReader();
    stderrPump = (async () => {
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          stderr += decoder.decode();
          return;
        }
        stderr += decoder.decode(value, { stream: true });
      }
    })();
    client = await DaemonClient.connect(daemon.port, TOKEN);
  });

  afterAll(async () => {
    client?.close();
    server?.stop(true);
    try {
      daemon.proc.kill("SIGKILL");
    } catch {}
    await daemon.proc.exited;
    await stderrPump;
    for (const dir of [dataDir, agentsRoot])
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("logs bounded diagnostics for failed RPCs without logging ordinary not_found errors", async () => {
    await expect(client.request("memories.list", { agentId: "missing" })).rejects.toMatchObject({
      code: "not_found",
    });

    await expect(client.request("marketplace.install", { source, id: "x" })).rejects.toMatchObject({
      code: "bad_request",
    });

    const prefix = "[upbotd] rpc failed ";
    const captured = await waitForStderr((buffer) =>
      buffer.split(/\r?\n/).some((line) => line.startsWith(prefix)),
    );
    const line = captured.split(/\r?\n/).find((entry) => entry.startsWith(prefix));
    if (!line) throw new Error("RPC failure log line missing");
    const log = JSON.parse(line.slice(prefix.length)) as {
      method: string;
      code: string;
      durationMs: number;
      error: {
        type: string;
        code?: string;
        cause?: { type: string; code?: string; status?: number };
      };
    };

    expect(log.method).toBe("marketplace.install");
    expect(log.code).toBe("bad_request");
    expect(Number.isFinite(log.durationMs)).toBe(true);
    expect(log.durationMs).toBeGreaterThanOrEqual(0);
    expect(log.error).toMatchObject({
      type: "RpcError",
      code: "bad_request",
    });
    expect(log.error.cause).toEqual({
      type: "MarketplaceFetchError",
      code: "http_status",
      status: 500,
    });
    expect(log).not.toHaveProperty("message");
    expect(log).not.toHaveProperty("stack");
    expect(log.error).not.toHaveProperty("message");
    expect(log.error).not.toHaveProperty("stack");
    expect(log.error.cause).not.toHaveProperty("message");
    expect(log.error.cause).not.toHaveProperty("stack");
    expect(captured).not.toContain(SECRET);
    expect(
      captured
        .split(/\r?\n/)
        .filter((entry) => entry.startsWith(prefix))
        .some((entry) => entry.includes('"method":"memories.list"')),
    ).toBe(false);
  });
});
