import { expect, spyOn, test } from "bun:test";
import type { Agent } from "@upbot/protocol";
import type { AgentStore } from "../src/agents";
import { type ApprovalService, GateRejection } from "../src/approvals";
import type { AppsService } from "../src/apps";
import { BRIDGE_TOOLS, Bridge } from "../src/bridge";
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
  return new Bridge(agents, () => ({}) as RuntimeManager, "/tmp/upbot-shared");
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
    expect(spy.mock.calls[0]?.[0]).toBe("[upbotd] bridge tool failed");
    expect(meta).toMatchObject({
      agentId: "bot1",
      tool: "send_message",
      isApp: false,
      reason: "error",
    });
    expect(typeof meta.durationMs).toBe("number");
    expect(meta.error).toBeInstanceOf(Error);
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
      "[upbotd] bridge tool failed",
      expect.objectContaining({ agentId: "bot1", tool: "send_message", reason: "denied" }),
    );
  } finally {
    spy.mockRestore();
  }
});

test("tools/list still answers and logs when app tools fail", async () => {
  const bridge = makeBridge();
  bridge.apps = {
    toolsFor: () => Promise.reject(new Error("mcp offline")),
  } as unknown as AppsService;
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    const res = await bridge.handle("bot1", { method: "tools/list" });
    expect((res.tools as unknown[]).length).toBe(BRIDGE_TOOLS.length);
    expect(spy).toHaveBeenCalledWith(
      "[upbotd] bridge tools/list failed",
      expect.objectContaining({ agentId: "bot1" }),
    );
  } finally {
    spy.mockRestore();
  }
});
