import { describe, expect, spyOn, test } from "bun:test";
import type { Agent } from "@boto/protocol";
import type { AgentStore } from "../src/agents";
import { type ApprovalService, GateRejection } from "../src/approvals";
import type { AppsService } from "../src/apps";
import { BRIDGE_TOOLS, Bridge, errorDiagnostics } from "../src/bridge";
import type { RuntimeManager } from "../src/runtime/runtime-manager";

function makeBridge(): Bridge {
  const agent = {
    id: "bot1",
    name: "Bot",
    provider: "devin",
    workspacePath: "/tmp/bot1",
  } as Agent;
  const agents = {
    get: (id: string) => (id === agent.id ? agent : null),
    list: () => [agent],
  } as unknown as AgentStore;
  return new Bridge(agents, () => ({}) as RuntimeManager, "/tmp/boto-shared");
}

test("failed tool calls log the tool, agent, duration and error", async () => {
  const bridge = makeBridge();
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    const res = await bridge.handle("bot1", {
      method: "tools/call",
      params: { name: "send_message", arguments: { to: "Nobody", text: "hi" } },
    });
    expect(res.isError).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const meta = spy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(spy.mock.calls[0]?.[0]).toBe("[botod] bridge tool failed");
    expect(meta).toMatchObject({
      agentId: "bot1",
      tool: "send_message",
      isApp: false,
      reason: "error",
    });
    expect(typeof meta.durationMs).toBe("number");
    expect(meta.errorType).toBe("Error");
    expect(meta).not.toHaveProperty("error");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("Nobody");
  } finally {
    spy.mockRestore();
  }
});

test("expected gate rejections are logged with their reason", async () => {
  const bridge = makeBridge();
  bridge.approvals = {
    gate: () => {
      throw new GateRejection("denied", "the user declined send_message; do not retry it");
    },
  } as unknown as ApprovalService;
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    const res = await bridge.handle("bot1", {
      method: "tools/call",
      params: { name: "send_message", arguments: { to: "x", text: "y" } },
    });
    expect(res.isError).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      "[botod] bridge tool failed",
      expect.objectContaining({ agentId: "bot1", tool: "send_message", reason: "denied" }),
    );
  } finally {
    spy.mockRestore();
  }
});

test("tools/list still answers and logs when app tools fail", async () => {
  const bridge = makeBridge();
  bridge.apps = {
    toolsFor: () => Promise.reject(new Error("mcp offline token=sk-live-secret")),
  } as unknown as AppsService;
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    const res = await bridge.handle("bot1", { method: "tools/list" });
    expect((res.tools as unknown[]).length).toBe(BRIDGE_TOOLS.length);
    expect(spy).toHaveBeenCalledWith(
      "[botod] bridge tools/list failed",
      expect.objectContaining({ agentId: "bot1", errorType: "Error" }),
    );
    expect(JSON.stringify(spy.mock.calls)).not.toContain("sk-live-secret");
  } finally {
    spy.mockRestore();
  }
});

test("app tool errors are logged without their message", async () => {
  const bridge = makeBridge();
  const secret = "ghp_echoedCredential123";
  bridge.apps = {
    isAppTool: () => true,
    hasAppTool: () => true,
    call: () => Promise.reject(new Error(`upstream rejected Bearer ${secret}`)),
  } as unknown as AppsService;
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    const res = await bridge.handle("bot1", {
      method: "tools/call",
      params: { name: "fake-create_note", arguments: {} },
    });
    expect(res.isError).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      "[botod] bridge tool failed",
      expect.objectContaining({ tool: "fake-create_note", isApp: true, errorType: "Error" }),
    );
    expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
  } finally {
    spy.mockRestore();
  }
});

test("unregistered tool names are never logged verbatim", async () => {
  const bridge = makeBridge();
  const secret = `unknown_tool_${crypto.randomUUID()}`;
  bridge.apps = { isAppTool: () => false } as unknown as AppsService;
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    const res = await bridge.handle("bot1", {
      method: "tools/call",
      params: { name: secret, arguments: {} },
    });
    expect(res.isError).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      "[botod] bridge tool failed",
      expect.objectContaining({ tool: "<unregistered>" }),
    );
    expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
  } finally {
    spy.mockRestore();
  }
});

describe("errorDiagnostics", () => {
  test("keeps the class and a checked code, never the message or stack", () => {
    const e = Object.assign(new TypeError("token=sk-secret\n    at sk-secret"), { code: "ENOENT" });
    expect(errorDiagnostics(e)).toEqual({ errorType: "TypeError", code: "ENOENT" });
  });

  test("forged frame lines in a message that was later shortened stay out", () => {
    const upstream = new Error("rejected\n    at ghp_forgedFrameSecret (x:1:1)");
    void upstream.stack;
    upstream.message = "rejected";
    const wrapper = new Error("rejected", { cause: upstream });
    wrapper.name = "AppToolError";
    expect(JSON.stringify(errorDiagnostics(upstream))).not.toContain("ghp_forgedFrameSecret");
    expect(JSON.stringify(errorDiagnostics(wrapper))).not.toContain("ghp_forgedFrameSecret");
  });

  test("drops untrusted names, codes and rewritten stacks", () => {
    const e = new Error("boom");
    e.name = "Bearer sk-secret";
    Object.assign(e, { code: "token sk-secret" });
    e.stack = "Error: other\n    at sk-secret";
    const d = errorDiagnostics(e);
    expect(d).toEqual({ errorType: "Error" });
    expect(errorDiagnostics("sk-secret")).toEqual({ errorType: "string" });
    expect(errorDiagnostics(Object.assign(new Error("x"), { code: -32000 })).code).toBe(-32000);
  });
});

test("errorDiagnostics keeps the upstream cause's type and code, never its message", () => {
  const upstream = Object.assign(new Error("MCP error -32000: Bearer ghp_upstreamSecret"), {
    name: "McpError",
    code: -32000,
  });
  const wrapper = new Error("Bearer [redacted]", { cause: upstream });
  wrapper.name = "AppToolError";
  const out = errorDiagnostics(wrapper);
  expect(out.errorType).toBe("AppToolError");
  expect(out.cause).toMatchObject({ errorType: "McpError", code: -32000 });
  expect(JSON.stringify(out)).not.toContain("ghp_upstreamSecret");
});

test("errorDiagnostics bounds the cause chain", () => {
  const loop = new Error("loop");
  (loop as { cause?: unknown }).cause = loop;
  expect(JSON.stringify(errorDiagnostics(loop)).match(/errorType/g)).toHaveLength(3);
});
