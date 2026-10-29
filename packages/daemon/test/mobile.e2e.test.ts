import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Agent, MobileStatus } from "@upbot/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  startDaemon,
  stopTestChildren,
  tmp,
} from "./helpers";

setDefaultTimeout(30000);
const TOKEN = `mob-test-${crypto.randomUUID()}`;

describe("mobile companion e2e", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  let a: Agent;
  let base: string;
  let device = "";

  const api = (
    path: string,
    body?: unknown,
    token = device,
    headers: Record<string, string> = {},
  ) =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
  const rpc = async (method: string, params: unknown) => api("/api/rpc", { method, params });

  beforeAll(async () => {
    dataDir = tmp("mob-data-");
    agentsRoot = tmp("mob-agents-");
    stateDir = tmp("mob-fake-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      UPBOT_MOBILE_HOST: "127.0.0.1",
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
    a = (await c.request("agents.create", {
      name: "Pocket",
      provider: "devin",
      instructions: "",
    })) as Agent;
  });

  afterAll(async () => {
    c?.close();
    try {
      daemon.proc.kill("SIGKILL");
    } catch {}
    await daemon.proc.exited;
    await stopTestChildren(stateDir);
    for (const d of [dataDir, agentsRoot, stateDir])
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("disabled by default; pairing needs it enabled", async () => {
    expect(await c.request("mobile.status", {})).toEqual({ enabled: false, urls: [], devices: [] });
    await expect(c.request("mobile.pair", {})).rejects.toMatchObject({ code: "bad_request" });
    const s = (await c.request("mobile.enable", { enabled: true })) as MobileStatus;
    expect(s.enabled).toBe(true);
    expect(s.urls).toHaveLength(1);
    base = s.urls[0]!.replace(/\/$/, "");
    const page = await fetch(`${base}/`);
    expect(page.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(await page.text()).toContain("Pair with UpBot");
  });

  test("pairing: wrong codes count toward a limit, the right code yields a device token once", async () => {
    expect((await api("/api/pair", { code: "000000" }, "")).status).toBe(401);
    const { code } = (await c.request("mobile.pair", {})) as { code: string };
    expect(code).toMatch(/^\d{6}$/);
    const wrong = code === "123456" ? "654321" : "123456";
    expect((await api("/api/pair", { code: wrong }, "")).status).toBe(401);
    const ok = await api("/api/pair", { code, name: "iPhone" }, "");
    expect(ok.status).toBe(200);
    device = ((await ok.json()) as { token: string }).token;
    expect(device).toMatch(/^[0-9a-f]{64}$/);
    expect((await api("/api/pair", { code, name: "again" }, "")).status).toBe(401);
    const { code: c2 } = (await c.request("mobile.pair", {})) as { code: string };
    for (let i = 0; i < 5; i++)
      await api("/api/pair", { code: c2 === "111111" ? "222222" : "111111" }, "");
    expect((await api("/api/pair", { code: c2 }, "")).status).toBe(401);
    const st = (await c.request("mobile.status", {})) as MobileStatus;
    expect(st.devices.map((d) => d.name)).toEqual(["iPhone"]);
  });

  test("devices chat through an allowlist of methods and get live events", async () => {
    expect((await api("/api/rpc", { method: "agents.list", params: {} }, "nope")).status).toBe(401);
    expect((await rpc("vault.list", {})).status).toBe(403);
    expect((await rpc("agents.create", { name: "x", provider: "devin" })).status).toBe(403);
    expect(
      (
        await api("/api/rpc", { method: "agents.list", params: {} }, device, {
          origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
    const agents = ((await (await rpc("agents.list", {})).json()) as { result: Agent[] }).result;
    expect(agents.map((x) => x.name)).toEqual(["Pocket"]);

    const ctrl = new AbortController();
    const events = await fetch(`${base}/api/events?token=${device}`, { signal: ctrl.signal });
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    const reader = events.body!.getReader();
    const seen: string[] = [];
    const reading = (async () => {
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        seen.push(dec.decode(value));
        if (seen.join("").includes('"turn.ended"')) return;
      }
    })();
    const sent = await rpc("chat.send", { agentId: a.id, text: "echo:from phone" });
    expect(sent.status).toBe(200);
    await reading;
    ctrl.abort();
    const all = seen.join("");
    expect(all).toContain('"event":"item.created"');
    expect(all).toContain("from phone");
    expect(all).not.toContain("agent.usage");
    const hist = (await (await rpc("chat.history", { agentId: a.id })).json()) as {
      result: { items: { kind: string; text?: string }[] };
    };
    expect(
      hist.result.items.some((i) => i.kind === "agent_message" && i.text === "from phone"),
    ).toBe(true);
    expect((await rpc("chat.send", { agentId: a.id, text: "x", attachments: [] })).status).toBe(
      400,
    );
  });

  test("revoke and disable cut access", async () => {
    const st = (await c.request("mobile.status", {})) as MobileStatus;
    await c.request("mobile.revoke", { id: st.devices[0]!.id });
    expect((await rpc("agents.list", {})).status).toBe(401);
    await c.request("mobile.enable", { enabled: false });
    await expect(fetch(`${base}/`)).rejects.toThrow();
  });

  test("a busy configured port falls back to a random port and is not overwritten", async () => {
    // Mobile is disabled but keeps its persisted port; re-enable to learn it.
    let st = (await c.request("mobile.enable", { enabled: true })) as MobileStatus;
    const configured = new URL(st.urls[0]!).port;
    await c.request("mobile.enable", { enabled: false });

    // Occupy the configured port so the daemon must fall back to a random one.
    const squatter = Bun.serve({
      hostname: "127.0.0.1",
      port: Number(configured),
      fetch: () => new Response("squat"),
    });
    const stderr = (async () => {
      const reader = (daemon.proc.stderr as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      let s = "";
      while (!s.includes("unavailable")) {
        const { value, done } = await reader.read();
        if (done) break;
        s += dec.decode(value);
      }
      reader.releaseLock();
      return s;
    })();
    st = (await c.request("mobile.enable", { enabled: true })) as MobileStatus;
    const fallback = new URL(st.urls[0]!).port;
    expect(fallback).not.toBe(configured);
    expect(await stderr).toContain(`mobile port ${configured} unavailable, falling back`);

    // The ephemeral fallback port must not replace the configured one.
    await c.request("mobile.enable", { enabled: false });
    squatter.stop(true);
    st = (await c.request("mobile.enable", { enabled: true })) as MobileStatus;
    expect(new URL(st.urls[0]!).port).toBe(configured);
    await c.request("mobile.enable", { enabled: false });
  });
});
