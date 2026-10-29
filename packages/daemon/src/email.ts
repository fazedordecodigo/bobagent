import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { EmailAccount, EmailDraft, EmailProvider } from "@upbot/protocol";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { RpcError } from "./runtime/agent-runtime";
import { EMAIL_PREFIX, type Vault } from "./vault";

// Email over IMAP (search/read) + SMTP (send). Passwords (app passwords) live in the vault as
// email.<id>.password and never reach bots. Bots can only create drafts; a draft is sent only
// when the user clicks Send (email.drafts.send). UPBOT_EMAIL_FAKE_MAILBOX=<json file> replaces
// IMAP with a static mailbox (tests); UPBOT_EMAIL_PLAINTEXT=1 allows non-TLS SMTP (tests).

type Config = Omit<EmailAccount, "id" | "createdAt" | "hasPassword">;
type Broadcast = (event: string, data: unknown) => void;

export const EMAIL_PRESETS: Record<
  Exclude<EmailProvider, "custom">,
  Pick<Config, "imapHost" | "imapPort" | "smtpHost" | "smtpPort" | "smtpSecure">
> = {
  gmail: {
    imapHost: "imap.gmail.com",
    imapPort: 993,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    smtpSecure: true,
  },
  icloud: {
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    smtpSecure: false,
  },
  outlook: {
    imapHost: "outlook.office365.com",
    imapPort: 993,
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    smtpSecure: false,
  },
};

export type EmailSummary = {
  uid: number;
  from: string;
  to: string;
  subject: string;
  date: string | null;
  seen: boolean;
};
export type EmailMessage = EmailSummary & {
  cc: string;
  messageId: string | null;
  text: string;
  attachments: string[];
};
export type SearchQuery = {
  mailbox?: string;
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  since?: string;
  unseen?: boolean;
  limit?: number;
};

const TEXT_LIMIT = 50_000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…[truncated]` : s);

type FakeMessage = Omit<EmailMessage, "seen"> & { mailbox?: string; seen?: boolean };

function fakeMailbox(): FakeMessage[] | null {
  const f = process.env.UPBOT_EMAIL_FAKE_MAILBOX;
  return f ? (JSON.parse(readFileSync(f, "utf8")) as FakeMessage[]) : null;
}

function matches(m: FakeMessage, q: SearchQuery): boolean {
  const has = (field: string, needle?: string) =>
    !needle || field.toLowerCase().includes(needle.toLowerCase());
  return (
    (m.mailbox ?? "INBOX") === (q.mailbox ?? "INBOX") &&
    has(`${m.subject}\n${m.text}\n${m.from}`, q.text) &&
    has(m.from, q.from) &&
    has(m.to, q.to) &&
    has(m.subject, q.subject) &&
    (!q.since || (m.date ?? "") >= q.since) &&
    (!q.unseen || !m.seen)
  );
}

function addr(list: unknown): string {
  const arr = Array.isArray(list) ? list : list ? [list] : [];
  return arr
    .map((a: { name?: string; address?: string }) =>
      a.name ? `${a.name} <${a.address ?? ""}>` : (a.address ?? ""),
    )
    .join(", ");
}

export class EmailService {
  constructor(
    private db: Database,
    private vault: Vault,
    private broadcast: Broadcast,
  ) {}

  // ---- accounts ----

  private passwordName(id: string) {
    return `${EMAIL_PREFIX}${id}.password`;
  }

  private rowToAccount(r: { id: string; config_json: string; created_at: number }): EmailAccount {
    const c = JSON.parse(r.config_json) as Config;
    let hasPassword = true;
    try {
      this.vault.revealInternal(this.passwordName(r.id));
    } catch {
      hasPassword = false;
    }
    return { ...c, id: r.id, createdAt: r.created_at, hasPassword };
  }

  listAccounts(): EmailAccount[] {
    const rows = this.db.query("SELECT * FROM email_accounts ORDER BY created_at ASC").all() as {
      id: string;
      config_json: string;
      created_at: number;
    }[];
    return rows.map((r) => this.rowToAccount(r));
  }

  account(id: string): EmailAccount {
    const r = this.db.query("SELECT * FROM email_accounts WHERE id = ?").get(id) as {
      id: string;
      config_json: string;
      created_at: number;
    } | null;
    if (!r) throw new RpcError("not_found", "email account not found");
    return this.rowToAccount(r);
  }

  saveAccount(
    p: Partial<Config> & {
      id?: string;
      provider: EmailProvider;
      address: string;
      password?: string;
    },
  ): EmailAccount {
    const prev = p.id ? this.account(p.id) : null;
    const preset = p.provider === "custom" ? null : EMAIL_PRESETS[p.provider];
    const pick = <K extends keyof Config>(k: K, fallback: Config[K]): Config[K] =>
      (p[k] ?? (preset as Partial<Config> | null)?.[k] ?? prev?.[k] ?? fallback) as Config[K];
    const config: Config = {
      label: p.label || prev?.label || p.address,
      provider: p.provider,
      address: p.address,
      username: p.username || prev?.username || p.address,
      imapHost: pick("imapHost", ""),
      imapPort: pick("imapPort", 993),
      smtpHost: pick("smtpHost", ""),
      smtpPort: pick("smtpPort", 465),
      smtpSecure: pick("smtpSecure", true),
      agentIds: p.agentIds ?? prev?.agentIds ?? [],
    };
    if (!config.imapHost || !config.smtpHost)
      throw new RpcError("bad_request", "IMAP and SMTP hosts are required for a custom account");
    if (!prev && !p.password) throw new RpcError("bad_request", "an app password is required");
    const id = prev?.id ?? crypto.randomUUID();
    this.db
      .query(
        "INSERT INTO email_accounts (id, config_json, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET config_json = ?2",
      )
      .run(id, JSON.stringify(config), prev?.createdAt ?? Date.now());
    if (p.password) this.vault.set(this.passwordName(id), p.password, []);
    this.broadcast("email.accounts.changed", {});
    return this.account(id);
  }

  deleteAccount(id: string): void {
    this.account(id);
    this.db.transaction(() => {
      this.db.query("DELETE FROM email_accounts WHERE id = ?").run(id);
      this.vault.delete(this.passwordName(id));
    })();
    this.broadcast("email.accounts.changed", {});
  }

  /** Accounts a bot may use. */
  accountsFor(agentId: string): EmailAccount[] {
    return this.listAccounts().filter(
      (a) => a.agentIds.length === 0 || a.agentIds.includes(agentId),
    );
  }

  resolve(agentId: string, key: unknown): EmailAccount {
    const mine = this.accountsFor(agentId);
    const k = typeof key === "string" ? key.trim().toLowerCase() : "";
    if (!k) {
      if (mine.length === 1) return mine[0]!;
      throw new Error(
        mine.length
          ? "several email accounts are connected; pass `account`"
          : "no email account is connected for you; ask the user to add one in Settings → Email",
      );
    }
    const a = mine.find(
      (m) => m.id === k || m.address.toLowerCase() === k || m.label.toLowerCase() === k,
    );
    if (!a) throw new Error(`no email account "${key}" is available to you (use email_accounts)`);
    return a;
  }

  private password(a: EmailAccount): string {
    return this.vault.revealInternal(this.passwordName(a.id));
  }

  // ---- IMAP ----

  private async withImap<T>(a: EmailAccount, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow({
      host: a.imapHost,
      port: a.imapPort,
      secure: true,
      auth: { user: a.username, pass: this.password(a) },
      logger: false,
    });
    try {
      await client.connect();
    } catch (e) {
      throw new Error(`IMAP sign-in to ${a.imapHost} failed: ${(e as Error).message}`);
    }
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async search(a: EmailAccount, q: SearchQuery): Promise<EmailSummary[]> {
    const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 100);
    const fake = fakeMailbox();
    if (fake)
      return fake
        .filter((m) => matches(m, q))
        .slice(-limit)
        .reverse()
        .map(({ uid, from, to, subject, date, seen }) => ({
          uid,
          from,
          to,
          subject,
          date,
          seen: !!seen,
        }));
    return this.withImap(a, async (c) => {
      const lock = await c.getMailboxLock(q.mailbox || "INBOX");
      try {
        const crit: Record<string, unknown> = {};
        if (q.text) crit.text = q.text;
        if (q.from) crit.from = q.from;
        if (q.to) crit.to = q.to;
        if (q.subject) crit.subject = q.subject;
        if (q.since) crit.since = new Date(q.since);
        if (q.unseen) crit.seen = false;
        const found = await c.search(Object.keys(crit).length ? crit : { all: true }, {
          uid: true,
        });
        const uids = (found || []).slice(-limit);
        if (!uids.length) return [];
        const out: EmailSummary[] = [];
        for await (const m of c.fetch(uids, { envelope: true, flags: true }, { uid: true })) {
          out.push({
            uid: m.uid,
            from: addr(m.envelope?.from),
            to: addr(m.envelope?.to),
            subject: m.envelope?.subject ?? "",
            date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : null,
            seen: m.flags?.has("\\Seen") ?? false,
          });
        }
        return out.reverse();
      } finally {
        lock.release();
      }
    });
  }

  async read(a: EmailAccount, uid: number, mailbox = "INBOX"): Promise<EmailMessage> {
    const fake = fakeMailbox();
    if (fake) {
      const m = fake.find((x) => x.uid === uid && (x.mailbox ?? "INBOX") === mailbox);
      if (!m) throw new Error(`no message ${uid} in ${mailbox}`);
      return { ...m, seen: true, text: clip(m.text, TEXT_LIMIT) };
    }
    return this.withImap(a, async (c) => {
      const lock = await c.getMailboxLock(mailbox);
      try {
        const m = await c.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
        if (!m || !m.source) throw new Error(`no message ${uid} in ${mailbox}`);
        const p = await simpleParser(m.source);
        return {
          uid,
          from: p.from?.text ?? "",
          to: Array.isArray(p.to) ? p.to.map((t) => t.text).join(", ") : (p.to?.text ?? ""),
          cc: Array.isArray(p.cc) ? p.cc.map((t) => t.text).join(", ") : (p.cc?.text ?? ""),
          subject: p.subject ?? "",
          date: p.date ? p.date.toISOString() : null,
          seen: m.flags?.has("\\Seen") ?? false,
          messageId: p.messageId ?? null,
          text: clip(p.text ?? "", TEXT_LIMIT),
          attachments: p.attachments.map((x) => x.filename ?? x.contentType),
        };
      } finally {
        lock.release();
      }
    });
  }

  async testAccount(id: string): Promise<{ ok: boolean; imap: string; smtp: string }> {
    const a = this.account(id);
    let imap = "ok";
    let smtp = "ok";
    try {
      if (!fakeMailbox()) await this.withImap(a, async () => {});
    } catch (e) {
      imap = (e as Error).message;
    }
    try {
      await this.transport(a).verify();
    } catch (e) {
      smtp = `SMTP sign-in to ${a.smtpHost} failed: ${(e as Error).message}`;
    }
    return { ok: imap === "ok" && smtp === "ok", imap, smtp };
  }

  // ---- drafts ----

  private rowToDraft(r: Record<string, unknown>): EmailDraft {
    const d = JSON.parse(String(r.data_json)) as Pick<
      EmailDraft,
      "to" | "cc" | "subject" | "body" | "inReplyTo"
    >;
    return {
      id: String(r.id),
      agentId: String(r.agent_id),
      accountId: String(r.account_id),
      ...d,
      status: r.status as EmailDraft["status"],
      error: (r.error as string | null) ?? null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  draft(id: string): EmailDraft {
    const r = this.db.query("SELECT * FROM email_drafts WHERE id = ?").get(id) as Record<
      string,
      unknown
    > | null;
    if (!r) throw new RpcError("not_found", "draft not found");
    return this.rowToDraft(r);
  }

  listDrafts(p: { agentId?: string; pendingOnly?: boolean }): EmailDraft[] {
    const rows = this.db
      .query(
        `SELECT * FROM email_drafts WHERE (?1 IS NULL OR agent_id = ?1) AND (?2 = 0 OR status IN ('pending','sending','failed')) ORDER BY created_at DESC LIMIT 200`,
      )
      .all(p.agentId ?? null, p.pendingOnly ? 1 : 0) as Record<string, unknown>[];
    return rows.map((r) => this.rowToDraft(r));
  }

  createDraft(
    agentId: string,
    a: EmailAccount,
    d: Pick<EmailDraft, "to" | "cc" | "subject" | "body" | "inReplyTo">,
  ): EmailDraft {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .query(
        "INSERT INTO email_drafts (id, agent_id, account_id, data_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
      )
      .run(id, agentId, a.id, JSON.stringify(d), now, now);
    const draft = this.draft(id);
    this.broadcast("email.draft.updated", draft);
    return draft;
  }

  private write(d: EmailDraft): EmailDraft {
    const { to, cc, subject, body, inReplyTo } = d;
    this.db
      .query(
        "UPDATE email_drafts SET data_json = ?, status = ?, error = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        JSON.stringify({ to, cc, subject, body, inReplyTo }),
        d.status,
        d.error,
        Date.now(),
        d.id,
      );
    const out = this.draft(d.id);
    this.broadcast("email.draft.updated", out);
    return out;
  }

  private editable(id: string): EmailDraft {
    const d = this.draft(id);
    if (d.status !== "pending" && d.status !== "failed")
      throw new RpcError("conflict", `draft is already ${d.status}`);
    return d;
  }

  updateDraft(p: {
    id: string;
    to?: string[];
    cc?: string[];
    subject?: string;
    body?: string;
  }): EmailDraft {
    const d = this.editable(p.id);
    return this.write({
      ...d,
      to: p.to ?? d.to,
      cc: p.cc ?? d.cc,
      subject: p.subject ?? d.subject,
      body: p.body ?? d.body,
    });
  }

  discardDraft(id: string): EmailDraft {
    return this.write({ ...this.editable(id), status: "discarded", error: null });
  }

  private transport(a: EmailAccount) {
    const plaintext = process.env.UPBOT_EMAIL_PLAINTEXT === "1";
    return nodemailer.createTransport({
      host: a.smtpHost,
      port: a.smtpPort,
      secure: a.smtpSecure && !plaintext,
      requireTLS: !a.smtpSecure && !plaintext,
      ignoreTLS: plaintext,
      auth: { user: a.username, pass: this.password(a) },
    });
  }

  /** User-approved send. */
  async sendDraft(id: string): Promise<EmailDraft> {
    const d = this.write({ ...this.editable(id), status: "sending", error: null });
    const a = this.account(d.accountId);
    try {
      await this.transport(a).sendMail({
        from: a.address,
        to: d.to,
        ...(d.cc.length ? { cc: d.cc } : {}),
        subject: d.subject,
        text: d.body,
        ...(d.inReplyTo ? { inReplyTo: d.inReplyTo, references: d.inReplyTo } : {}),
      });
      return this.write({ ...d, status: "sent" });
    } catch (e) {
      return this.write({ ...d, status: "failed", error: (e as Error).message.slice(0, 500) });
    }
  }
}
