import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import type { Agent, Turn } from "@upbot/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  readLog,
  startDaemon,
  stopTestChildren,
  tmp,
} from "./helpers";

const TOKEN = `bridge-failure-${crypto.randomUUID()}`;
const SECRET = "SECRET-VALUE-123";

type McpSpec = {
  command: string;
  args: string[];
  env: { name: string; value: string }[];
};

async function runMcpBridge(
  spec: McpSpec,
  envOverrides: Record<string, string>,
  requests: unknown[],
): Promise<{ replies: Record<string, unknown>[]; stdout: string; stderr: string }> {
  const env = Object.fromEntries(spec.env.map(({ name, value }) => [name, value]));
  const child = spawn(spec.command, spec.args, {
    env: { ...process.env, ...env, ...envOverrides },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let buffered = "";
  const lines: string[] = [];
  const waiters: {
    resolve: (line: string) => void;
    reject: (error: Error) => void;
  }[] = [];
  let exitError: Error | undefined;
  const rejectWaiters = (error: Error) => {
    if (exitError) return;
    exitError = error;
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(line);
      else lines.push(line);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.on("error", () => {});
  const nextLine = () => {
    const line = lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (exitError) return Promise.reject(exitError);
    return new Promise<string>((resolve, reject) => waiters.push({ resolve, reject }));
  };
  const replies: Record<string, unknown>[] = [];
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", (error) => {
      rejectWaiters(
        new Error(
          `mcp-bridge exited (code ${child.exitCode}, signal ${child.signalCode}) before replying`,
        ),
      );
      reject(error);
    });
    child.once("close", (code, signal) => {
      rejectWaiters(
        new Error(`mcp-bridge exited (code ${code}, signal ${signal}) before replying`),
      );
      code === 0 ? resolve() : reject(new Error(`exit ${code}`));
    });
  });
  void closed.catch(() => {});
  try {
    for (const request of requests) {
      const response = nextLine();
      child.stdin.write(`${JSON.stringify(request)}\n`);
      replies.push(JSON.parse(await response) as Record<string, unknown>);
    }
    child.stdin.end();
    await closed;
    return { replies, stdout, stderr };
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for daemon stderr");
    await Bun.sleep(25);
  }
}

function readMcpSpec(stateDir: string): McpSpec {
  const session = readLog(stateDir)
    .filter((entry) => entry.method === "session/new")
    .at(-1);
  const params = session?.params as { mcpServers?: { name: string }[] } | undefined;
  const spec = params?.mcpServers?.find((server) => server.name === "upbot") as McpSpec | undefined;
  if (!spec) throw new Error("upbot MCP server spec missing from session/new");
  return spec;
}

describe("bridge failure diagnostics", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let daemon: DaemonHandle;
  let daemonStderr = "";
  let stderrPump: Promise<void>;
  let c: DaemonClient;
  let agent: Agent;

  beforeAll(async () => {
    dataDir = tmp("bridge-failure-data-");
    agentsRoot = tmp("bridge-failure-agents-");
    stateDir = tmp("bridge-failure-fake-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
    });
    const reader = (daemon.proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    stderrPump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        daemonStderr += decoder.decode(value);
      }
    })();
    c = await DaemonClient.connect(daemon.port, TOKEN);
    agent = (await c.request("agents.create", {
      name: "Bridge diagnostics",
      provider: "devin",
      instructions: "",
    })) as Agent;
    const { queueId } = (await c.request("chat.send", {
      agentId: agent.id,
      text: "mcp:list_agents {}",
    })) as { queueId: string };
    const turn = (await c.waitForEventWhere(
      "turn.ended",
      (data) => (data as Turn).queueId === queueId,
      20000,
    )) as Turn;
    expect(turn.status).toBe("completed");
  });

  afterAll(async () => {
    c?.close();
    try {
      daemon.proc.kill("SIGKILL");
    } catch {}
    await daemon.proc.exited;
    await stderrPump;
    await stopTestChildren(stateDir);
    for (const dir of [dataDir, agentsRoot, stateDir]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test("reject and failed bridge requests log only allowlisted diagnostics", async () => {
    const spec = readMcpSpec(stateDir);
    const wrongToken = `wrong-SENTINEL-${crypto.randomUUID()}`;
    const rejected = await runMcpBridge(spec, { UPBOT_BRIDGE_TOKEN: wrongToken }, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "sk-live-SENTINEL", arguments: {} },
      },
    ]);
    expect(rejected.replies[0]?.result).toMatchObject({ isError: true });
    expect(rejected.stderr).toContain(
      "upbotd mcp-bridge: method=tools/call tool=unlisted status=401",
    );
    expect(rejected.stderr).not.toContain(wrongToken);
    expect(rejected.stderr).not.toContain("sk-live-SENTINEL");

    const fingerprint = createHash("sha256").update(wrongToken).digest("hex").slice(0, 8);
    const rejectionLog = `bridge: rejected /bridge request (unauthorized; token fp ${fingerprint})`;
    await waitFor(() => daemonStderr.includes(rejectionLog));
    expect(daemonStderr).not.toContain(wrongToken);

    const realFailure = await runMcpBridge(spec, {}, [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "send_message", arguments: { to: SECRET, text: "hi" } },
      },
    ]);
    expect(realFailure.replies[0]?.result).toMatchObject({
      tools: expect.arrayContaining([expect.objectContaining({ name: "send_message" })]),
    });
    const toolResult = realFailure.replies[1]?.result as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content[0]?.text).toContain(`no agent named "${SECRET}"`);
    expect(realFailure.stderr).not.toContain(SECRET);

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { method: string };
        if (body.method === "tools/list")
          return Response.json({ tools: [{ name: "send_message" }] });
        return new Response(`no agent named "${SECRET}"`, { status: 400 });
      },
    });
    try {
      const failedForward = await runMcpBridge(
        spec,
        { UPBOT_BRIDGE_URL: `http://127.0.0.1:${server.port}/bridge` },
        [
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "send_message", arguments: { to: SECRET, text: "hi" } },
          },
        ],
      );
      expect(failedForward.replies[1]?.result).toMatchObject({ isError: true });
      const failedResult = failedForward.replies[1]?.result as {
        content: { text: string }[];
      };
      expect(failedResult.content[0]?.text).toContain(`no agent named "${SECRET}"`);
      expect(failedForward.stderr).toContain(
        "upbotd mcp-bridge: method=tools/call tool=send_message status=400",
      );
      expect(failedForward.stderr).not.toContain(SECRET);
    } finally {
      await server.stop(true);
    }
  });

  test("mcp-bridge exits before replying without hanging the harness", async () => {
    const spec = readMcpSpec(stateDir);
    const startedAt = Date.now();
    await expect(
      runMcpBridge(spec, { UPBOT_BRIDGE_TOKEN: "" }, [
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
      ]),
    ).rejects.toThrow(/mcp-bridge exited/);
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });
});
