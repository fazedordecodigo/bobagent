import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, EmailAccount } from "@upbot/protocol";
import { SMTPServer } from "smtp-server";
import {
  DaemonClient,
  type DaemonHandle,
  FAKE_AGENT,
  startDaemon,
  stopDaemon,
  tmp,
  toolCall,
} from "./helpers";

const TOKEN = `email-test-${crypto.randomUUID()}`;
const APP_PASSWORD = "app-pass-secret-123";

describe("email connector e2e", () => {
  let dataDir: string;
  let agentsRoot: string;
  let stateDir: string;
  let work: string;
  let daemon: DaemonHandle;
  let c: DaemonClient;
  let a: Agent;
  let b: Agent;
  let smtp: SMTPServer;
  let smtpPort: number;
  const received: { from: string; to: string[]; data: string; user: string; pass: string }[] = [];

  const tool = async (agent: Agent, name: string, args: Record<string, unknown> = {}) =>
    (await toolCall(c, agent, name, args, 20000)).replace(/^tool-ok:/, "");

  beforeAll(async () => {
    let session = { user: "", pass: "" };
    smtp = new SMTPServer({
      authOptional: false,
      disabledCommands: ["STARTTLS"],
      allowInsecureAuth: true,
      onAuth(auth, _s, cb) {
        session = { user: auth.username ?? "", pass: auth.password ?? "" };
        if (auth.password !== APP_PASSWORD) return cb(new Error("bad password"));
        cb(null, { user: auth.username });
      },
      onData(stream, s, cb) {
        let data = "";
        stream.on("data", (d: Buffer) => {
          data += d.toString();
        });
        stream.on("end", () => {
          received.push({
            from: String(s.envelope.mailFrom && s.envelope.mailFrom.address),
            to: s.envelope.rcptTo.map((r) => r.address),
            data,
            ...session,
          });
          cb();
        });
      },
    });
    await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", () => r()));
    smtpPort = (smtp.server.address() as { port: number }).port;
    dataDir = tmp("email-data-");
    agentsRoot = tmp("email-agents-");
    stateDir = tmp("email-fake-");
    work = tmp("email-work-");
    const mailbox = join(work, "mailbox.json");
    writeFileSync(
      mailbox,
      JSON.stringify([
        {
          uid: 7,
          from: "Ana <ana@example.com>",
          to: "me@example.com",
          cc: "",
          subject: "Quarterly report",
          date: "2026-10-20T10:00:00.000Z",
          messageId: "<q3@example.com>",
          text: "Can you send me the Q3 numbers?",
          attachments: [],
        },
        {
          uid: 8,
          from: "News <news@example.org>",
          to: "me@example.com",
          cc: "",
          subject: "Weekly digest",
          date: "2026-10-21T10:00:00.000Z",
          messageId: "<d@example.org>",
          text: "Top stories",
          attachments: [],
          seen: true,
        },
      ]),
    );
    daemon = await startDaemon(dataDir, agentsRoot, TOKEN, {
      UPBOT_ACP_COMMAND_DEVIN: JSON.stringify(["bun", FAKE_AGENT]),
      FAKE_ACP_STATE_DIR: stateDir,
      UPBOT_VAULT_KEY: "cd".repeat(32),
      UPBOT_EMAIL_FAKE_MAILBOX: mailbox,
      UPBOT_EMAIL_PLAINTEXT: "1",
    });
    c = await DaemonClient.connect(daemon.port, TOKEN);
    a = await c.request("agents.create", {
      name: "A",
      provider: "devin",
      instructions: "",
    });
    b = await c.request("agents.create", {
      name: "B",
      provider: "devin",
      instructions: "",
    });
  });

  afterAll(async () => {
    smtp?.close();
    await stopDaemon(daemon, c, stateDir);
    for (const d of [dataDir, agentsRoot, stateDir, work])
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  let account: EmailAccount;

  test("accounts: presets, password kept in the vault and hidden", async () => {
    const gmail = await c.request("email.accounts.save", {
      provider: "gmail",
      address: "me@gmail.com",
      password: "x-secret-x",
    });
    expect(gmail).toMatchObject({ imapHost: "imap.gmail.com", smtpPort: 465, hasPassword: true });
    expect(JSON.stringify(gmail)).not.toContain("x-secret-x");
    await c.request("email.accounts.delete", { id: gmail.id });
    account = await c.request("email.accounts.save", {
      provider: "custom",
      label: "Work",
      address: "me@example.com",
      password: APP_PASSWORD,
      imapHost: "127.0.0.1",
      imapPort: 993,
      smtpHost: "127.0.0.1",
      smtpPort,
      smtpSecure: false,
      agentIds: [a.id],
    });
    const list = await c.request("email.accounts.list", {});
    expect(list.map((x) => x.label)).toEqual(["Work"]);
    const vault = await c.request("vault.list", {});
    expect(vault.some((v) => v.name.startsWith("email."))).toBe(false);
    const t = await c.request("email.accounts.test", { id: account.id });
    expect(t.smtp).toBe("ok");
  });

  test("bots search and read mail; only allowed bots see the account", async () => {
    expect(JSON.parse(await tool(a, "email_accounts"))).toEqual([
      { id: account.id, label: "Work", address: "me@example.com", provider: "custom" },
    ]);
    const hits = JSON.parse(await tool(a, "email_search", { unseen: true }));
    expect(hits.map((h: { uid: number }) => h.uid)).toEqual([7]);
    const msg = JSON.parse(await tool(a, "email_read", { uid: 7 }));
    expect(msg.text).toContain("Q3 numbers");
    expect(await tool(b, "email_search", {})).toContain("no email account is connected");
    expect(await tool(b, "email_accounts")).toBe("[]");
  });

  test("a draft is never sent by the bot; the user edits and sends it", async () => {
    const reply = await tool(a, "email_draft", {
      to: ["ana@example.com"],
      subject: "",
      body: "Here are the numbers.",
      replyToUid: 7,
    });
    expect(reply).toContain("NOT sent");
    expect(
      await tool(a, "email_draft", { to: ["not-an-address"], subject: "x", body: "y" }),
    ).toContain("not an email address");
    const [draft] = await c.request("email.drafts.list", {
      agentId: a.id,
      pendingOnly: true,
    });
    expect(draft).toMatchObject({
      status: "pending",
      subject: "Re: Quarterly report",
      inReplyTo: "<q3@example.com>",
    });
    expect(received).toHaveLength(0);
    await c.request("email.drafts.update", { id: draft!.id, body: "Here are the Q3 numbers: 42." });
    const sent = await c.request("email.drafts.send", { id: draft!.id });
    expect(sent.status).toBe("sent");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      from: "me@example.com",
      to: ["ana@example.com"],
      user: "me@example.com",
      pass: APP_PASSWORD,
    });
    expect(received[0]!.data).toContain("Q3 numbers: 42.");
    expect(received[0]!.data).toContain("In-Reply-To: <q3@example.com>");
    await expect(c.request("email.drafts.send", { id: draft!.id })).rejects.toThrow(/already sent/);
    expect(JSON.parse(await tool(a, "email_draft_status", { id: draft!.id }))[0].status).toBe(
      "sent",
    );
  });

  test("discard, and the app password never reaches the bot or logs", async () => {
    await tool(a, "email_draft", { to: ["x@example.com"], subject: "s", body: "b" });
    const [d] = await c.request("email.drafts.list", {
      agentId: a.id,
      pendingOnly: true,
    });
    expect((await c.request("email.drafts.discard", { id: d!.id })).status).toBe("discarded");
    expect(received).toHaveLength(1);
    const log = readFileSync(join(stateDir, "log.jsonl"), "utf8");
    expect(log).not.toContain(APP_PASSWORD);
  });

  test("delete is atomic when vault cleanup fails", async () => {
    const doomed = (await c.request("email.accounts.save", {
      provider: "custom",
      label: "Doomed",
      address: "doomed@example.com",
      password: "doomed-secret",
      imapHost: "127.0.0.1",
      imapPort: 993,
      smtpHost: "127.0.0.1",
      smtpPort,
      smtpSecure: false,
    })) as EmailAccount;
    const db = new Database(join(dataDir, "upbot.db"));
    try {
      db.exec("PRAGMA busy_timeout=5000");
      db.exec(
        `CREATE TRIGGER fail_email_vault_delete BEFORE DELETE ON vault WHEN old.name = 'email.${doomed.id}.password' BEGIN SELECT RAISE(ABORT, 'vault locked'); END;`,
      );

      const eventIndex = c.events.length;
      await expect(c.request("email.accounts.delete", { id: doomed.id })).rejects.toMatchObject({
        code: "internal",
      });
      expect((await c.request("email.accounts.list", {})) as EmailAccount[]).toContainEqual(
        expect.objectContaining({ id: doomed.id, hasPassword: true }),
      );
      expect(
        c.events.slice(eventIndex).some((event) => event.event === "email.accounts.changed"),
      ).toBe(false);

      db.exec("DROP TRIGGER fail_email_vault_delete");
      const previousEvents = new Set(
        c.events
          .filter((event) => event.event === "email.accounts.changed")
          .map((event) => event.data),
      );
      const changed = c.waitForEventWhere(
        "email.accounts.changed",
        (data) => !previousEvents.has(data),
      );
      await c.request("email.accounts.delete", { id: doomed.id });
      await changed;

      expect((await c.request("email.accounts.list", {})) as EmailAccount[]).not.toContainEqual(
        expect.objectContaining({ id: doomed.id }),
      );
      const row = db
        .query("SELECT count(*) AS n FROM vault WHERE name = ?")
        .get(`email.${doomed.id}.password`) as { n: number };
      expect(row.n).toBe(0);
    } finally {
      db.close();
    }
  });
});
