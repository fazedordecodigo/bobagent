// `upbotd mcp-bridge`: a stdio MCP server spawned by provider CLIs. It forwards
// tools/list and tools/call to the daemon's /bridge endpoint.

import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2025-06-18";

type Msg = { jsonrpc?: string; id?: number | string; method?: string; params?: unknown };

export async function runMcpBridge(): Promise<void> {
  const url = process.env.UPBOT_BRIDGE_URL;
  const token = process.env.UPBOT_BRIDGE_TOKEN;
  if (!url || !token) {
    console.error("upbotd mcp-bridge: UPBOT_BRIDGE_URL / UPBOT_BRIDGE_TOKEN missing");
    process.exit(2);
  }
  const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const reply = (id: Msg["id"], result: unknown) => send({ jsonrpc: "2.0", id, result });
  const fail = (id: Msg["id"], code: number, message: string) =>
    send({ jsonrpc: "2.0", id, error: { code, message } });

  async function forward(method: string, params: unknown): Promise<unknown> {
    const res = await fetch(url as string, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ method, params }),
    });
    if (!res.ok) throw new Error(`daemon returned ${res.status}: ${await res.text()}`);
    return res.json();
  }

  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let m: Msg;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id === undefined) return; // notifications
    try {
      switch (m.method) {
        case "initialize": {
          const requested = (m.params as { protocolVersion?: string } | undefined)?.protocolVersion;
          reply(m.id, {
            protocolVersion: requested ?? PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "upbot", version: "0.3.0" },
          });
          return;
        }
        case "ping":
          reply(m.id, {});
          return;
        case "tools/list":
        case "tools/call":
          reply(m.id, await forward(m.method, m.params ?? {}));
          return;
        default:
          fail(m.id, -32601, `method not found: ${m.method}`);
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const status =
        /daemon returned (\d+)/.exec(err.message)?.[1] ??
        (err as NodeJS.ErrnoException).code ??
        "-";
      const tool =
        m.method === "tools/call"
          ? String((m.params as { name?: unknown } | undefined)?.name ?? "-")
          : "-";
      console.error(
        `upbotd mcp-bridge: method=${m.method ?? "-"} tool=${tool} status=${status} error=${err.message.replace(/\s+/g, " ")}`,
      );
      if (m.method === "tools/call") {
        reply(m.id, { content: [{ type: "text", text: err.message }], isError: true });
      } else {
        fail(m.id, -32603, err.message);
      }
    }
  });
  await new Promise<void>((r) => rl.on("close", () => r()));
}
