import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Agent, TeamMessage, TeamStatus, VaultEntry } from "@upbot/protocol";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  startDaemon,
  stopTestChildren,
  tmp,
} from "./helpers";

setDefaultTimeout(30000);

async function until<T>(fn: () => Promise<T | undefined>, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v !== undefined) return v;
    await Bun.sleep(100);
  }
  throw new Error("timed out");
}

describe("teams via relay e2e", () => {
  const dirs: string[] = [];
  const daemons: DaemonHandle[] = [];
  const clients: DaemonClient[] = [];
  let relay: { proc: ReturnType<typeof Bun.spawn>; adminToken: string };
  let relayUrl: string;
  let ana: DaemonClient;
  let bob: DaemonClient;
  let anaAgent: Agent;
  let anaPrivate: Agent;

  const invite = async (name: string) => {
    const r = await fetch(`${relayUrl}/members`, {
      method: "POST",
      headers: { authorization: `Bearer ${relay.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return (await r.json()) as { id: string; token: string };
  };

  async function daemon(
    env: Record<string, string> = {},
    log?: { text: string },
  ): Promise<DaemonClient> {
    const [d, a, s] = [tmp("tm-data-"), tmp("tm-agents-"), tmp("tm-fake-")];
    dirs.push(d, a, s);
    const token = `tm-${crypto.randomUUID()}`;
    const h = await startDaemon(d, a, token, {
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: s,
      UPBOT_VAULT_KEY: "ef".repeat(32),
      ...env,
    });
    daemons.push(h);
    if (log) {
      const decoder = new TextDecoder();
      void (async () => {
        for await (const chunk of h.proc.stderr as ReadableStream<Uint8Array>)
          log.text += decoder.decode(chunk);
      })().catch(() => {});
    }
    const c = await DaemonClient.connect(h.port, token);
    clients.push(c);
    return c;
  }

  beforeAll(async () => {
    const rd = tmp("tm-relay-");
    dirs.push(rd);
    const proc = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "..", "..", "relay", "src", "main.ts"),
        "--data",
        rd,
        "--port",
        "0",
        "--host",
        "127.0.0.1",
      ],
      {
        env: { ...process.env, RELAY_ADMIN_TOKEN: "admin-secret" },
        stdout: "pipe",
        stderr: "inherit",
      },
    );
    relay = { proc, adminToken: "admin-secret" };
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    let out = "";
    while (!/:(\d+) /.test(out)) {
      const { value, done } = await reader.read();
      if (done) throw new Error("relay exited");
      out += new TextDecoder().decode(value);
    }
    relayUrl = `http://127.0.0.1:${/:(\d+) /.exec(out)![1]}`;
    ana = await daemon();
    bob = await daemon();
    anaAgent = (await ana.request("agents.create", {
      name: "Helper",
      provider: "devin",
      instructions: "",
    })) as Agent;
    anaPrivate = (await ana.request("agents.create", {
      name: "Private",
      provider: "devin",
      instructions: "",
    })) as Agent;
  });

  afterAll(async () => {
    for (const c of clients) c.close();
    relay?.proc.kill();
    if (relay) await relay.proc.exited;
    for (const h of daemons) {
      try {
        h.proc.kill("SIGKILL");
      } catch {}
    }
    await Promise.all(daemons.map((h) => h.proc.exited));
    await stopTestChildren(dirs);
    for (const d of dirs)
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("relay admin API requires the admin token", async () => {
    expect((await fetch(`${relayUrl}/members`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(`${relayUrl}/ws?token=bogus`)).status).toBe(401);
  });

  test("members join, share agents, and see each other's roster", async () => {
    const a = await invite("Ana");
    const b = await invite("Bob");
    await ana.request("team.connect", { url: relayUrl, token: a.token });
    await bob.request("team.connect", { url: relayUrl, token: b.token });
    expect((await ana.request("vault.list", {})) as VaultEntry[]).toEqual([]);
    await ana.request("team.share", { agentIds: [anaAgent.id] });
    const seen = await until(async () => {
      const s = (await bob.request("team.status", {})) as TeamStatus;
      const m = s.members.find((x) => x.name === "Ana");
      return m?.agents.length ? s : undefined;
    });
    expect(seen.connected).toBe(true);
    expect(seen.me?.name).toBe("Bob");
    expect(seen.members.find((x) => x.name === "Ana")!.agents.map((x) => x.name)).toEqual([
      "Helper",
    ]);
  });

  test("a teammate's message runs on the shared agent and the reply comes back", async () => {
    const s = (await bob.request("team.status", {})) as TeamStatus;
    const anaMember = s.members.find((x) => x.name === "Ana")!;
    const sent = (await bob.request("team.send", {
      memberId: anaMember.id,
      agentId: anaAgent.id,
      text: "echo:hello from bob",
    })) as TeamMessage;
    expect(sent.status).toBe("pending");
    const done = await until(async () => {
      const list = (await bob.request("team.messages", {})) as TeamMessage[];
      const m = list.find((x) => x.requestId === sent.requestId);
      return m?.status === "completed" ? m : undefined;
    });
    expect(done.reply).toBe("hello from bob");
    const inbox = (await ana.request("team.messages", {})) as TeamMessage[];
    expect(inbox.find((x) => x.direction === "in")).toMatchObject({
      memberName: "Bob",
      status: "completed",
    });
    const { items } = (await ana.request("chat.history", { agentId: anaAgent.id })) as {
      items: { kind: string; team?: { memberName: string } }[];
    };
    expect(items.find((i) => i.kind === "user_message")?.team?.memberName).toBe("Bob");
  });

  test("unshared agents cannot be reached", async () => {
    const s = (await bob.request("team.status", {})) as TeamStatus;
    const anaMember = s.members.find((x) => x.name === "Ana")!;
    await expect(
      bob.request("team.send", {
        memberId: anaMember.id,
        agentId: anaPrivate.id,
        text: "echo:sneaky",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  describe("a third member with a slow and a broken shared agent", () => {
    const caraLog = { text: "" };
    let cara: DaemonClient;
    let caraSlow: Agent;
    let caraBroken: Agent;
    let caraMemberId: string;
    let dan: DaemonClient;
    let danMemberId: string;

    const caraIn = async (requestId: string) =>
      ((await cara.request("team.messages", {})) as TeamMessage[]).find(
        (x) => x.requestId === requestId && x.direction === "in",
      );
    const bobOut = async (requestId: string) =>
      ((await bob.request("team.messages", {})) as TeamMessage[]).find(
        (x) => x.requestId === requestId && x.direction === "out",
      );
    const danOut = async (requestId: string) =>
      ((await dan.request("team.messages", {})) as TeamMessage[]).find(
        (x) => x.requestId === requestId && x.direction === "out",
      );

    beforeAll(async () => {
      cara = await daemon(
        { UPBOT_ACP_COMMAND_CURSOR: JSON.stringify(["upbot-missing-provider-cli"]) },
        caraLog,
      );
      caraSlow = (await cara.request("agents.create", {
        name: "Slow",
        provider: "devin",
        instructions: "",
      })) as Agent;
      caraBroken = (await cara.request("agents.create", {
        name: "Broken",
        provider: "cursor",
        instructions: "",
      })) as Agent;
      const c = await invite("Cara");
      caraMemberId = c.id;
      await cara.request("team.connect", { url: relayUrl, token: c.token });
      await until(async () =>
        ((await cara.request("team.status", {})) as TeamStatus).connected ? true : undefined,
      );
      await cara.request("team.share", { agentIds: [caraSlow.id, caraBroken.id] });
      await until(async () => {
        const s = (await bob.request("team.status", {})) as TeamStatus;
        return s.members.find((x) => x.id === caraMemberId)?.agents.length === 2 ? true : undefined;
      });
      // A requester whose unanswered requests expire after 1 s instead of 30 min.
      dan = await daemon({ UPBOT_TEAM_REPLY_TTL_MS: "1000" });
      const d = await invite("Dan");
      danMemberId = d.id;
      await dan.request("team.connect", { url: relayUrl, token: d.token });
      await until(async () => {
        const s = (await dan.request("team.status", {})) as TeamStatus;
        return s.members.find((x) => x.id === caraMemberId)?.agents.length === 2 ? true : undefined;
      });
    });

    test("a request the shared agent cannot start fails on both sides", async () => {
      const sent = (await bob.request("team.send", {
        memberId: caraMemberId,
        agentId: caraBroken.id,
        text: "echo:never runs",
      })) as TeamMessage;
      const failed = await until(async () => {
        const m = await bobOut(sent.requestId);
        return m?.status === "failed" ? m : undefined;
      });
      expect(failed.reply).toContain("upbot-missing-provider-cli");
      const inbound = await until(async () => {
        const m = await caraIn(sent.requestId);
        return m?.status === "failed" ? m : undefined;
      });
      expect(inbound.reply).toBe(failed.reply);
      await until(async () => (caraLog.text.includes("team request rejected") ? true : undefined));
      const line = caraLog.text.split("\n").find((l) => l.includes("team request rejected"));
      expect(line).toBe(
        `[upbotd] team request rejected requestId=${sent.requestId} agentId=${caraBroken.id} reason=provider_unavailable`,
      );
    });

    test("relay-supplied ids are not logged verbatim", async () => {
      const eve = await invite("Eve");
      const ws = new WebSocket(`${relayUrl.replace(/^http/, "ws")}/ws?token=${eve.token}`);
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
      });
      const reply = new Promise<Record<string, unknown>>((resolve) => {
        ws.onmessage = (ev) => {
          const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
          if (m.type === "reply") resolve(m);
        };
      });
      const requestId = "forged\n[upbotd] fake line";
      ws.send(
        JSON.stringify({
          type: "send",
          requestId,
          to: { memberId: caraMemberId, agentId: caraBroken.id },
          text: "echo:x",
        }),
      );
      expect((await reply).status).toBe("failed");
      ws.close();
      await until(async () => (caraLog.text.includes("requestId=invalid") ? true : undefined));
      expect(caraLog.text).not.toContain("[upbotd] fake line");
      expect(caraLog.text).not.toContain("forged");
    });

    test("an unanswered request fails after the TTL and a late reply still completes it", async () => {
      const sent = (await dan.request("team.send", {
        memberId: caraMemberId,
        agentId: caraSlow.id,
        text: "watchdog-delay:4000",
      })) as TeamMessage;
      expect(sent.status).toBe("pending");
      const expired = await until(async () => {
        const m = await danOut(sent.requestId);
        return m?.status === "failed" ? m : undefined;
      });
      expect(expired.reply).toBe(
        "No reply from the teammate in time; the relay may have dropped it.",
      );
      expect((await caraIn(sent.requestId))?.status).toBe("pending");
      const late = await until(async () => {
        const m = await danOut(sent.requestId);
        return m?.status === "completed" ? m : undefined;
      });
      expect(late.reply).toBe("(no reply)");
    });

    test("a reply finished after the relay drops the member is recorded as not delivered", async () => {
      const sent = (await dan.request("team.send", {
        memberId: caraMemberId,
        agentId: caraSlow.id,
        text: "watchdog-delay:2500",
      })) as TeamMessage;
      expect((await until(() => caraIn(sent.requestId))).status).toBe("pending");
      await fetch(`${relayUrl}/members/${caraMemberId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${relay.adminToken}` },
      });
      await until(async () =>
        ((await cara.request("team.status", {})) as TeamStatus).connected ? undefined : true,
      );
      const inbound = await until(async () => {
        const m = await caraIn(sent.requestId);
        return m?.status === "pending" ? undefined : m;
      });
      expect(inbound).toMatchObject({ status: "failed", reply: "(no reply)" });
      await until(async () =>
        caraLog.text.includes("team reply not delivered") ? true : undefined,
      );
      const line = caraLog.text.split("\n").find((l) => l.includes("team reply not delivered"));
      expect(line).toBe(
        `[upbotd] team reply not delivered requestId=${sent.requestId} agentId=${caraSlow.id} memberId=${danMemberId} status=completed`,
      );
      expect(caraLog.text).not.toContain("watchdog-delay");
      expect(caraLog.text).not.toContain("token=");
      // The relay has no delivery ack and dropped the reply: the requester's TTL fails it.
      const out = await until(async () => {
        const m = await danOut(sent.requestId);
        return m?.status === "pending" ? undefined : m;
      });
      expect(out).toMatchObject({
        status: "failed",
        reply: "No reply from the teammate in time; the relay may have dropped it.",
      });
    });
  });

  test("removed members are disconnected", async () => {
    const st = (await ana.request("team.status", {})) as TeamStatus;
    const members = (await (
      await fetch(`${relayUrl}/members`, {
        headers: { authorization: `Bearer ${relay.adminToken}` },
      })
    ).json()) as { id: string; name: string }[];
    const bobId = members.find((m) => m.name === "Bob")!.id;
    await fetch(`${relayUrl}/members/${bobId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${relay.adminToken}` },
    });
    const s = await until(async () => {
      const x = (await bob.request("team.status", {})) as TeamStatus;
      return x.connected ? undefined : x;
    });
    expect(s.error).toBe("you were removed from the team");
    expect(st.connected).toBe(true);
    await bob.request("team.disconnect", {});
    expect(((await bob.request("team.status", {})) as TeamStatus).configured).toBe(false);
  });
});
