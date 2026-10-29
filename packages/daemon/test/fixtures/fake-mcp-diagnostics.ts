import { createInterface } from "node:readline";

const mode = process.env.FAKE_DIAGNOSTIC_MODE;
const token = process.env.FAKE_DIAGNOSTIC_TOKEN ?? "";
const prefix = token.slice(0, 12);
const suffix = token.slice(12);
const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize") {
    if (mode === "newline") process.stderr.write(`credential=${prefix}\n${suffix}\n`);
    if (mode === "truncated") process.stderr.write(`${"x".repeat(8193)}${prefix}\n${suffix}\n`);
    if (mode === "multiline") process.stderr.write(`${token.split("\n").at(-1)}\n`);
    if (mode === "prefix-line") process.stderr.write(`credential=${prefix}\n`);
    if (mode !== "tools" && mode !== "exit" && mode !== "list-error")
      return send({
        jsonrpc: "2.0",
        id: m.id,
        error: {
          code: -32000,
          message: mode === "rpc-error" ? `credential=${prefix}\n${suffix}` : "fixture failure",
        },
      });
    return send({
      jsonrpc: "2.0",
      id: m.id,
      result: {
        protocolVersion: m.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "diagnostics-fixture", version: "1" },
      },
    });
  }
  if (m.method === "tools/list" && mode === "list-error")
    return send({
      jsonrpc: "2.0",
      id: m.id,
      error: { code: -32000, message: `credential=${prefix}\n${suffix}` },
    });
  if (m.method === "tools/list")
    return send({
      jsonrpc: "2.0",
      id: m.id,
      result: {
        tools: ["get_safe", "get_error", "get_exception", "get_exit"].map((name) => ({
          name,
          inputSchema: { type: "object" },
        })),
      },
    });
  if (m.method === "tools/call") {
    if (m.params.name === "get_exit") {
      process.stderr.write(`credential=${prefix}\n${suffix}\n`, () => process.exit(1));
      return;
    }
    if (m.params.name === "get_exception")
      return send({
        jsonrpc: "2.0",
        id: m.id,
        error: { code: -32000, message: `credential=${prefix}\n${suffix}` },
      });
    const isError = m.params.name === "get_error";
    return send({
      jsonrpc: "2.0",
      id: m.id,
      result: {
        isError,
        content: [
          {
            type: "text",
            text: `${isError ? "No matching record" : "Found 3 records"}; credential=${token}`,
          },
        ],
      },
    });
  }
});
