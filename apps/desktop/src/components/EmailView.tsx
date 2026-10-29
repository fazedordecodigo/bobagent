import type { Agent, EmailAccount, EmailDraft, EmailProvider } from "@upbot/protocol";
import { useState } from "react";
import { daemonOn, useDaemonQuery } from "../hooks/useDaemonQuery";
import type { DaemonClient } from "../lib/daemon";
import { btnCls, inputCls } from "./AgentSettings";

const PROVIDER_HINTS: Record<EmailProvider, string> = {
  gmail:
    "Gmail: turn on 2-Step Verification, then create an app password at myaccount.google.com/apppasswords.",
  icloud: "iCloud: create an app-specific password at account.apple.com → Sign-In and Security.",
  outlook:
    "Outlook / Microsoft 365: use an app password if your account allows IMAP with passwords.",
  custom: "Any IMAP (TLS, usually 993) + SMTP server.",
};

const splitList = (s: string) =>
  s
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);

function useDrafts(client: DaemonClient, agentId?: string) {
  const [drafts] = useDaemonQuery(
    client,
    "email.drafts.list",
    agentId ? { agentId, pendingOnly: true } : {},
    [] as EmailDraft[],
    [daemonOn("email.draft.updated", (d) => !agentId || d.agentId === agentId)],
  );
  return drafts;
}

export function DraftCard({
  client,
  draft,
  accounts,
  botName,
}: {
  client: DaemonClient;
  draft: EmailDraft;
  accounts: EmailAccount[];
  botName?: string;
}) {
  const [to, setTo] = useState(draft.to.join(", "));
  const [cc, setCc] = useState(draft.cc.join(", "));
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [error, setError] = useState<string | null>(null);
  const editable = draft.status === "pending" || draft.status === "failed";
  const from = accounts.find((a) => a.id === draft.accountId)?.address ?? "unknown account";
  const save = () =>
    client.request("email.drafts.update", {
      id: draft.id,
      to: splitList(to),
      cc: splitList(cc),
      subject,
      body,
    });
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  return (
    <div
      className="space-y-2 rounded-lg border border-sky-800/60 bg-sky-950/20 p-3 text-sm"
      data-testid="email-draft"
    >
      <div className="flex items-center gap-2 text-xs text-zinc-400">
        <span className="font-semibold text-sky-300">Email draft</span>
        {botName && <span>by {botName}</span>}
        <span>from {from}</span>
        <span className="ml-auto rounded bg-zinc-800 px-1.5 py-0.5">{draft.status}</span>
      </div>
      <input
        className={inputCls}
        value={to}
        disabled={!editable}
        onChange={(e) => setTo(e.target.value)}
        placeholder="To"
        aria-label="To"
      />
      <input
        className={inputCls}
        value={cc}
        disabled={!editable}
        onChange={(e) => setCc(e.target.value)}
        placeholder="Cc"
        aria-label="Cc"
      />
      <input
        className={inputCls}
        value={subject}
        disabled={!editable}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="Subject"
        aria-label="Subject"
      />
      <textarea
        className={`${inputCls} min-h-28`}
        value={body}
        disabled={!editable}
        onChange={(e) => setBody(e.target.value)}
        aria-label="Body"
      />
      {(error || draft.error) && <div className="text-xs text-red-400">{error || draft.error}</div>}
      {editable && (
        <div className="flex gap-2">
          <button
            type="button"
            className={`${btnCls} bg-sky-600 hover:bg-sky-500`}
            onClick={() => {
              setError(null);
              save()
                .then(() => client.request("email.drafts.send", { id: draft.id }))
                .catch(fail);
            }}
          >
            Send
          </button>
          <button
            type="button"
            className={`${btnCls} bg-zinc-700 hover:bg-zinc-600`}
            onClick={() => {
              setError(null);
              save().catch(fail);
            }}
          >
            Save
          </button>
          <button
            type="button"
            className={`${btnCls} ml-auto bg-zinc-800 hover:bg-red-900`}
            onClick={() => client.request("email.drafts.discard", { id: draft.id }).catch(fail)}
          >
            Discard
          </button>
        </div>
      )}
    </div>
  );
}

function useAccounts(client: DaemonClient) {
  const [accounts] = useDaemonQuery(client, "email.accounts.list", {}, [] as EmailAccount[], [
    "email.accounts.changed",
  ]);
  return accounts;
}

/** Pending drafts of one bot, shown above the composer. */
export function DraftCards({ client, agentId }: { client: DaemonClient; agentId: string }) {
  const drafts = useDrafts(client, agentId);
  const accounts = useAccounts(client);
  if (!drafts.length) return null;
  return (
    <div className="max-h-[50vh] space-y-2 overflow-y-auto border-t border-zinc-800 px-4 py-2">
      {drafts.map((d) => (
        <DraftCard key={`${d.id}:${d.updatedAt}`} client={client} draft={d} accounts={accounts} />
      ))}
    </div>
  );
}

export function EmailView({ client, agents }: { client: DaemonClient; agents: Agent[] }) {
  const accounts = useAccounts(client);
  const drafts = useDrafts(client);
  const [provider, setProvider] = useState<EmailProvider>("gmail");
  const [form, setForm] = useState({
    address: "",
    password: "",
    label: "",
    imapHost: "",
    imapPort: "993",
    smtpHost: "",
    smtpPort: "465",
  });
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? "deleted bot";
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <h2 className="text-lg font-semibold">Email</h2>
      <p className="text-xs text-zinc-500">
        Bots can search and read connected mailboxes and prepare drafts. Nothing is sent until you
        review a draft and click Send. App passwords are encrypted in the vault and never shown to
        bots.
      </p>
      <ul className="space-y-2">
        {accounts.map((a) => (
          <li key={a.id} className="space-y-2 rounded border border-zinc-800 p-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">{a.label}</span>
              <span className="text-xs text-zinc-500">
                {a.address} · {a.provider}
              </span>
              <button
                type="button"
                className="ml-auto text-xs text-sky-400 hover:text-sky-300"
                onClick={() => {
                  setTests((t) => ({ ...t, [a.id]: "Testing…" }));
                  client
                    .request("email.accounts.test", { id: a.id })
                    .then((r) =>
                      setTests((t) => ({
                        ...t,
                        [a.id]: r.ok
                          ? "Connected"
                          : [r.imap, r.smtp].filter((x) => x !== "ok").join(" · "),
                      })),
                    )
                    .catch(fail);
                }}
              >
                Test
              </button>
              <button
                type="button"
                className="text-xs text-zinc-500 hover:text-red-400"
                onClick={() => client.request("email.accounts.delete", { id: a.id }).catch(fail)}
              >
                Remove
              </button>
            </div>
            {tests[a.id] && <div className="text-xs text-zinc-400">{tests[a.id]}</div>}
            <div className="flex flex-wrap gap-2 text-xs text-zinc-400">
              <span>Bots:</span>
              {agents.map((b) => {
                const all = a.agentIds.length === 0;
                const on = all || a.agentIds.includes(b.id);
                return (
                  <label key={b.id} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => {
                        const cur = all ? agents.map((x) => x.id) : a.agentIds;
                        const next = e.target.checked
                          ? [...cur, b.id]
                          : cur.filter((x) => x !== b.id);
                        const agentIds = next.length === agents.length ? [] : next;
                        client
                          .request("email.accounts.save", {
                            id: a.id,
                            provider: a.provider,
                            address: a.address,
                            agentIds,
                          })
                          .catch(fail);
                      }}
                    />
                    {b.name}
                  </label>
                );
              })}
            </div>
          </li>
        ))}
        {accounts.length === 0 && <li className="text-sm text-zinc-500">No email accounts yet.</li>}
      </ul>
      <form
        className="space-y-2 rounded border border-zinc-800 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          const custom = provider === "custom";
          client
            .request("email.accounts.save", {
              provider,
              address: form.address,
              password: form.password,
              ...(form.label ? { label: form.label } : {}),
              ...(custom
                ? {
                    imapHost: form.imapHost,
                    imapPort: Number(form.imapPort),
                    smtpHost: form.smtpHost,
                    smtpPort: Number(form.smtpPort),
                    smtpSecure: Number(form.smtpPort) === 465,
                  }
                : {}),
            })
            .then(() => setForm({ ...form, address: "", password: "", label: "" }))
            .catch(fail);
        }}
      >
        <h3 className="text-sm font-semibold text-zinc-300">Connect an account</h3>
        <div className="flex gap-2">
          <select
            className={inputCls}
            value={provider}
            onChange={(e) => setProvider(e.target.value as EmailProvider)}
            aria-label="Provider"
          >
            <option value="gmail">Gmail</option>
            <option value="icloud">iCloud Mail</option>
            <option value="outlook">Outlook</option>
            <option value="custom">Other (IMAP/SMTP)</option>
          </select>
          <input
            className={inputCls}
            placeholder="Label (optional)"
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
          />
        </div>
        <input
          className={inputCls}
          type="email"
          required
          placeholder="Email address"
          value={form.address}
          onChange={(e) => setForm({ ...form, address: e.target.value })}
        />
        <input
          className={inputCls}
          type="password"
          required
          autoComplete="off"
          placeholder="App password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
        {provider === "custom" && (
          <div className="grid grid-cols-[1fr_6rem] gap-2">
            <input
              className={inputCls}
              required
              placeholder="IMAP host"
              value={form.imapHost}
              onChange={(e) => setForm({ ...form, imapHost: e.target.value })}
            />
            <input
              className={inputCls}
              placeholder="993"
              value={form.imapPort}
              onChange={(e) => setForm({ ...form, imapPort: e.target.value })}
            />
            <input
              className={inputCls}
              required
              placeholder="SMTP host"
              value={form.smtpHost}
              onChange={(e) => setForm({ ...form, smtpHost: e.target.value })}
            />
            <input
              className={inputCls}
              placeholder="465 or 587"
              value={form.smtpPort}
              onChange={(e) => setForm({ ...form, smtpPort: e.target.value })}
            />
          </div>
        )}
        <p className="text-xs text-zinc-500">{PROVIDER_HINTS[provider]}</p>
        {error && <div className="text-xs text-red-400">{error}</div>}
        <button type="submit" className={`${btnCls} bg-sky-600 hover:bg-sky-500`}>
          Connect
        </button>
      </form>
      <h3 className="text-sm font-semibold text-zinc-300">Drafts</h3>
      <div className="space-y-2">
        {drafts.map((d) => (
          <DraftCard
            key={`${d.id}:${d.updatedAt}`}
            client={client}
            draft={d}
            accounts={accounts}
            botName={nameOf(d.agentId)}
          />
        ))}
        {drafts.length === 0 && <p className="text-sm text-zinc-500">No drafts yet.</p>}
      </div>
    </div>
  );
}
