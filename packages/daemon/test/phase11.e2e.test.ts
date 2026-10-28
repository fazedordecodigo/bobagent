import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Agent, ChatItem, Turn, VaultEntry } from "@upbot/protocol";
import { DaemonClient, type DaemonHandle, FAKE_AGENT, readPids, startDaemon, tmp } from "./helpers";

const TOKEN = `p11-test-${crypto.randomUUID()}`;

describe("vault, connectors, computer use, voice e2e", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let work: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  let a: Agent;
  let b: Agent;
  let gh: ReturnType<typeof Bun.serve>;

  async function tool(
    agent: Agent,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<string> {
    const { queueId } = (await c.request("chat.send", {
      agentId: agent.id,
      text: `mcp:${name} ${JSON.stringify(args)}`,
    })) as { queueId: string };
    const t = (await c.waitForEventWhere(
      "turn.ended",
      (d) => (d as Turn).queueId === queueId,
      20000,
    )) as Turn;
    const { items } = (await c.request("chat.history", { agentId: agent.id })) as {
      items: ChatItem[];
    };
    const msg = items.filter((i) => i.turnId === t.id && i.kind === "agent_message").pop();
    return msg && "text" in msg ? msg.text : "";
  }

  beforeAll(async () => {
    gh = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const u = new URL(req.url);
        return Response.json({
          path: u.pathname,
          method: req.method,
          auth: req.headers.get("authorization"),
          body: req.method === "GET" ? null : await req.json(),
        });
      },
    });
    dataDir = tmp("p11-data-");
    agentsRoot = tmp("p11-agents-");
    stateDir = tmp("p11-fake-");
    work = tmp("p11-work-");
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      UPBOT_VAULT_KEY: "ab".repeat(32),
      UPBOT_GITHUB_API: `http://127.0.0.1:${gh.port}`,
      UPBOT_OP_COMMAND: JSON.stringify([
        "sh",
        "-c",
        'printf "%s|%s|%s" "$1" "$2" "$OP_SERVICE_ACCOUNT_TOKEN"',
        "op",
      ]),
      UPBOT_BW_COMMAND: JSON.stringify([
        "sh",
        "-c",
        'printf "%s|%s|%s|%s" "$1" "$2" "$3" "$BW_SESSION"',
        "bw",
      ]),
      UPBOT_COMPUTER_DRYRUN: join(work, "computer.log"),
      UPBOT_TTS_COMMAND: JSON.stringify(["sh", "-c", `cat > ${join(work, "tts.txt")}`]),
      UPBOT_STT_COMMAND: JSON.stringify([
        "sh",
        "-c",
        'printf "heard %s bytes" "$(wc -c < "$0" | tr -d " ")"',
        "{file}",
      ]),
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
    a = (await c.request("agents.create", {
      name: "A",
      provider: "devin",
      instructions: "",
    })) as Agent;
    b = (await c.request("agents.create", {
      name: "B",
      provider: "devin",
      instructions: "",
    })) as Agent;
  });

  afterAll(() => {
    c?.close();
    gh?.stop(true);
    try {
      daemon.proc.kill("SIGKILL");
    } catch {}
    for (const pid of readPids(stateDir)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    for (const d of [dataDir, agentsRoot, stateDir, work])
      rmSync(d, { recursive: true, force: true });
  });

  test("vault encrypts secrets and enforces the per-agent allowlist", async () => {
    await c.request("vault.set", {
      name: "stripe.key",
      value: "sk_live_SECRET123",
      agentIds: [a.id],
    });
    const list = (await c.request("vault.list", {})) as VaultEntry[];
    expect(list).toMatchObject([{ name: "stripe.key", agentIds: [a.id] }]);
    expect(JSON.stringify(list)).not.toContain("SECRET123");
    const db = new Database(join(dataDir, "upbot.db"), { readonly: true });
    expect(JSON.stringify(db.query("SELECT * FROM vault").all())).not.toContain("SECRET123");
    db.close();
    expect(await tool(a, "vault_list")).toBe('tool-ok:["stripe.key"]');
    expect(await tool(a, "vault_get", { name: "stripe.key" })).toBe("tool-ok:sk_live_SECRET123");
    expect(await tool(b, "vault_get", { name: "stripe.key" })).toContain(
      "tool-error:no vault secret",
    );
    await c.request("vault.setAccess", { name: "stripe.key", agentIds: [b.id] });
    expect(await tool(b, "vault_get", { name: "stripe.key" })).toBe("tool-ok:sk_live_SECRET123");
    expect(await tool(a, "vault_list")).toBe("tool-ok:[]");
    await expect(c.request("vault.set", { name: "bad name", value: "x" })).rejects.toMatchObject({
      code: "bad_request",
    });
    await c.request("vault.delete", { name: "stripe.key" });
    expect(await c.request("vault.list", {})).toEqual([]);
  });

  test.skipIf(process.platform === "win32")(
    "connectors use shared secrets without exposing them",
    async () => {
      expect(await tool(a, "github_api", { path: "/user" })).toContain(
        "tool-error:no vault secret",
      );
      await c.request("vault.set", {
        name: "connector.github",
        value: "ghp_TOKEN",
        agentIds: [a.id],
      });
      const out = await tool(a, "github_api", {
        method: "POST",
        path: "/repos/o/r/issues",
        body: { title: "t" },
      });
      expect(out).toContain("HTTP 200");
      expect(out).toContain('"path":"/repos/o/r/issues"');
      expect(out).toContain('"auth":"Bearer [redacted]"');
      expect(out).not.toContain("ghp_TOKEN");
      expect(await tool(a, "github_api", { path: "https://evil.example/" })).toContain(
        "tool-error:`path` must start",
      );
      await c.request("vault.set", {
        name: "connector.1password",
        value: "ops_abc",
        agentIds: [a.id],
      });
      expect(await tool(a, "onepassword_read", { reference: "op://Dev/DB/password" })).toBe(
        "tool-ok:read|op://Dev/DB/password|ops_abc",
      );
      await c.request("vault.set", {
        name: "connector.bitwarden",
        value: "bwsess",
        agentIds: [a.id],
      });
      expect(await tool(a, "bitwarden_get", { item: "github.com", field: "username" })).toBe(
        "tool-ok:get|username|github.com|bwsess",
      );
      expect(await tool(a, "bitwarden_get", { item: "x", field: "everything" })).toContain(
        "tool-error:",
      );
    },
  );

  test.skipIf(process.platform === "win32")("computer use is opt-in per agent", async () => {
    expect(await tool(a, "computer_click", { x: 10, y: 20 })).toContain(
      "tool-error:Computer Use is not enabled",
    );
    await c.request("computer.setAccess", { agentIds: [a.id] });
    expect(await c.request("computer.access", {})).toEqual({ available: true, agentIds: [a.id] });
    expect(await tool(a, "computer_click", { x: 10.4, y: 20, double: true })).toBe(
      "tool-ok:double-clicked at 10,20",
    );
    expect(await tool(a, "computer_type", { text: 'say "hi"' })).toBe("tool-ok:typed 8 characters");
    expect(await tool(a, "computer_key", { key: "s", modifiers: ["command"] })).toBe(
      "tool-ok:pressed command+s",
    );
    expect(await tool(a, "computer_key", { key: "f13" })).toContain("tool-error:unsupported key");
    expect(
      await tool(a, "computer_key", { key: "a", modifiers: ['command"} & do shell script "x'] }),
    ).toContain("tool-error:modifiers");
    expect(await tool(a, "computer_screenshot")).toContain(join(a.workspacePath, "computer"));
    expect(await tool(b, "computer_screenshot")).toContain("tool-error:");
    const log = readFileSync(join(work, "computer.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(log.map((cmd: string[]) => cmd[0])).toEqual([
      "osascript",
      "osascript",
      "osascript",
      "screencapture",
    ]);
    expect(log[0].slice(-3)).toEqual(["10", "20", "2"]);
    expect(log[1].at(-1)).toBe('say "hi"');
    expect(log[2].at(-1)).toBe(
      'tell application "System Events" to keystroke "s" using {command down}',
    );
  });

  test.skipIf(process.platform === "win32")("voice: speak and transcribe", async () => {
    expect(await c.request("voice.status", {})).toEqual({ tts: true, stt: true });
    await c.request("voice.speak", { text: "Hello from UpBot" });
    await Bun.sleep(300);
    expect(readFileSync(join(work, "tts.txt"), "utf8")).toBe("Hello from UpBot");
    const r = (await c.request("voice.transcribe", {
      audioBase64: Buffer.from("0123456789").toString("base64"),
      mime: "audio/webm;codecs=opus",
    })) as { text: string };
    expect(r.text).toBe("heard 10 bytes");
  });
});
