// Minimal stdio MCP server for connected-app tests: tools `echo` and `whoami`
// (`whoami` reports whether FAKE_APP_TOKEN reached the server's env). With FAKE_APP_LEAK set,
// `leak_token` fails with a JSON-RPC error that echoes FAKE_APP_TOKEN, also in a forged
// stack-frame line.
import { createInterface } from "node:readline";

const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> };
  if (m.id === undefined) return;
  if (m.method === "initialize")
    return send({
      jsonrpc: "2.0",
      id: m.id,
      result: {
        protocolVersion: (m.params?.protocolVersion as string) ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-app", version: "1" },
      },
    });
  if (m.method === "tools/list")
    return send({
      jsonrpc: "2.0",
      id: m.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo text",
            inputSchema: { type: "object", properties: { text: { type: "string" } } },
          },
          { name: "whoami", description: "Token check", inputSchema: { type: "object" } },
          { name: "create_note", description: "Create a note", inputSchema: { type: "object" } },
          ...(process.env.FAKE_APP_PERMISSIONS
            ? [
                { name: "get_note", description: "Read a note", inputSchema: { type: "object" } },
                {
                  name: "send_message",
                  description: "Send a message",
                  inputSchema: { type: "object" },
                },
              ]
            : []),
          ...(process.env.FAKE_APP_LEAK
            ? [
                {
                  name: "leak_token",
                  description: "Echo a failure",
                  inputSchema: { type: "object" },
                },
              ]
            : []),
          { name: "foo__bar", description: "Double underscore", inputSchema: { type: "object" } },
          { name: "foo_bar", description: "Single underscore", inputSchema: { type: "object" } },
          {
            name: "foo_bar_a3a759",
            description: "Hash suffix collision",
            inputSchema: { type: "object" },
          },
        ],
      },
    });
  if (m.method === "tools/call") {
    const p = m.params as { name: string; arguments: { text?: string } };
    if (p.name === "leak_token")
      return send({
        jsonrpc: "2.0",
        id: m.id,
        error: {
          code: -32000,
          message: `upstream rejected Bearer ${process.env.FAKE_APP_TOKEN}\n    at ${process.env.FAKE_APP_TOKEN} (forged.ts:1:1)`,
        },
      });
    const text =
      p.name === "echo" || p.name === "get_note"
        ? `echo:${p.arguments.text}`
        : p.name === "create_note"
          ? "note-created"
          : p.name === "send_message"
            ? "message-sent"
            : p.name === "foo__bar"
              ? "double-underscore"
              : p.name === "foo_bar"
                ? "single-underscore"
                : p.name === "foo_bar_a3a759"
                  ? "suffix-collision"
                  : `token-present:${Boolean(process.env.FAKE_APP_TOKEN)} token:${process.env.FAKE_APP_TOKEN}`;
    return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }] } });
  }
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
});
