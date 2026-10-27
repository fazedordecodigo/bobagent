import type { Agent, Approval, ApprovalRule } from "@upbot/protocol";
import { useCallback, useEffect, useState } from "react";
import type { DaemonClient } from "../lib/daemon";
import { btnCls, inputCls } from "./AgentSettings";

function useApprovals(client: DaemonClient, agentId?: string) {
  const [items, setItems] = useState<Approval[]>([]);
  const load = useCallback(() => {
    client
      .request("approvals.list", agentId ? { agentId } : {})
      .then(setItems)
      .catch(() => {});
  }, [client, agentId]);
  useEffect(() => {
    load();
    return client.on("approval.updated", (a) => {
      if (!agentId || a.agentId === agentId) load();
    });
  }, [client, agentId, load]);
  return items;
}

function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((until - now) / 1000));
  return (
    <span>
      expires in {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </span>
  );
}

export function ApprovalCard({
  client,
  approval: a,
  botName,
}: {
  client: DaemonClient;
  approval: Approval;
  botName?: string;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const respond = (decision: "approve" | "always" | "deny" | "done", v?: string) =>
    client
      .request("approvals.respond", { id: a.id, decision, ...(v ? { value: v } : {}) })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  const label =
    a.kind === "secret"
      ? "Secret requested"
      : a.kind === "takeover"
        ? "Your turn"
        : "Approval needed";
  return (
    <div
      className="space-y-2 rounded-lg border border-amber-700/60 bg-amber-950/20 p-3 text-sm"
      data-testid="approval"
    >
      <div className="flex items-center gap-2 text-xs text-zinc-400">
        <span className="font-semibold text-amber-300">{label}</span>
        {botName && <span>{botName}</span>}
        {a.background && <span className="rounded bg-zinc-800 px-1">background</span>}
        <span className="ml-auto">
          {a.status === "pending" ? <Countdown until={a.expiresAt} /> : a.status}
        </span>
      </div>
      <div className="font-medium">{a.title}</div>
      {a.kind === "tool" ? (
        <pre className="max-h-40 overflow-auto rounded bg-zinc-900 p-2 text-xs">{a.detail}</pre>
      ) : (
        a.detail && <div className="text-xs text-zinc-300">{a.detail}</div>
      )}
      {a.kind === "takeover" && a.status === "pending" && (
        <div className="text-xs text-zinc-400">
          Use the UpBot browser window to sign in, enter a 2FA code or solve the check, then click
          Done. The bot does not see what you type.
        </div>
      )}
      {error && <div className="text-xs text-red-400">{error}</div>}
      {a.status === "pending" && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (a.kind === "secret") void respond("approve", value);
          }}
        >
          {a.kind === "secret" && (
            <input
              className={`${inputCls} flex-1`}
              type="password"
              autoComplete="off"
              placeholder={`Value for ${a.secretName}`}
              aria-label="Secret value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
          {a.kind === "tool" && (
            <>
              <button
                type="button"
                className={`${btnCls} bg-sky-600 hover:bg-sky-500`}
                onClick={() => respond("approve")}
              >
                Approve once
              </button>
              <button
                type="button"
                className={`${btnCls} bg-zinc-700 hover:bg-zinc-600`}
                onClick={() => respond("always")}
              >
                Always allow
              </button>
            </>
          )}
          {a.kind === "secret" && (
            <button type="submit" className={`${btnCls} bg-sky-600 hover:bg-sky-500`}>
              Save to vault
            </button>
          )}
          {a.kind === "takeover" && (
            <button
              type="button"
              className={`${btnCls} bg-sky-600 hover:bg-sky-500`}
              onClick={() => respond("done")}
            >
              Done
            </button>
          )}
          <button
            type="button"
            className={`${btnCls} ml-auto bg-zinc-800 hover:bg-red-900`}
            onClick={() => respond("deny")}
          >
            {a.kind === "tool" ? "Deny" : "Cancel"}
          </button>
        </form>
      )}
    </div>
  );
}

/** Pending approvals of one bot, shown above the composer. */
export function ApprovalCards({ client, agentId }: { client: DaemonClient; agentId: string }) {
  const pending = useApprovals(client, agentId).filter((a) => a.status === "pending");
  if (!pending.length) return null;
  return (
    <div className="max-h-[50vh] space-y-2 overflow-y-auto border-t border-zinc-800 px-4 py-2">
      {pending.map((a) => (
        <ApprovalCard key={a.id} client={client} approval={a} />
      ))}
    </div>
  );
}

export function ApprovalsView({ client, agents }: { client: DaemonClient; agents: Agent[] }) {
  const items = useApprovals(client);
  const [rules, setRules] = useState<ApprovalRule[]>([]);
  const [form, setForm] = useState({ pattern: "", action: "ask" as "ask" | "allow", agentId: "" });
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    client
      .request("approvals.rules", {})
      .then(setRules)
      .catch(() => {});
  }, [client]);
  useEffect(() => {
    load();
    return client.on("approvals.rulesChanged", load);
  }, [client, load]);
  const save = (next: ApprovalRule[]) =>
    client
      .request("approvals.setRules", { rules: next })
      .then(setRules)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  const nameOf = (id: string | null) =>
    id ? (agents.find((a) => a.id === id)?.name ?? "deleted bot") : "every bot";
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <h2 className="text-lg font-semibold">Approvals</h2>
      <p className="text-xs text-zinc-500">
        Rules match tool names (use * as a wildcard, e.g. github-* or notion-create_*). "Ask first"
        always wins over "Allow automatically". Without a rule, connected-app actions that change
        data ask first. Requests from background work expire after 10 minutes.
      </p>
      <ul className="space-y-1">
        {rules.map((r) => (
          <li
            key={r.id}
            className="flex items-center gap-2 rounded border border-zinc-800 px-3 py-2 text-sm"
          >
            <span className={r.action === "ask" ? "text-amber-300" : "text-emerald-300"}>
              {r.action === "ask" ? "Ask first" : "Allow automatically"}
            </span>
            <code className="text-xs">{r.pattern}</code>
            <span className="text-xs text-zinc-500">{nameOf(r.agentId)}</span>
            <button
              type="button"
              className="ml-auto text-xs text-zinc-500 hover:text-red-400"
              onClick={() => save(rules.filter((x) => x.id !== r.id))}
            >
              Remove
            </button>
          </li>
        ))}
        {rules.length === 0 && <li className="text-sm text-zinc-500">No rules yet.</li>}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          void save([
            ...rules,
            {
              id: crypto.randomUUID(),
              pattern: form.pattern.trim(),
              action: form.action,
              agentId: form.agentId || null,
            },
          ]).then(() => setForm({ ...form, pattern: "" }));
        }}
      >
        <select
          className={inputCls}
          value={form.action}
          aria-label="Rule action"
          onChange={(e) => setForm({ ...form, action: e.target.value as "ask" | "allow" })}
        >
          <option value="ask">Ask first</option>
          <option value="allow">Allow automatically</option>
        </select>
        <input
          className={`${inputCls} font-mono`}
          required
          placeholder="tool name or pattern"
          value={form.pattern}
          onChange={(e) => setForm({ ...form, pattern: e.target.value })}
        />
        <select
          className={inputCls}
          value={form.agentId}
          aria-label="Rule bot"
          onChange={(e) => setForm({ ...form, agentId: e.target.value })}
        >
          <option value="">Every bot</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <button type="submit" className={`${btnCls} bg-zinc-700 hover:bg-zinc-600`}>
          Add
        </button>
      </form>
      {error && <div className="text-xs text-red-400">{error}</div>}
      <h3 className="text-sm font-semibold text-zinc-300">Requests</h3>
      <div className="space-y-2">
        {items.map((a) => (
          <ApprovalCard
            key={`${a.id}:${a.status}`}
            client={client}
            approval={a}
            botName={nameOf(a.agentId)}
          />
        ))}
        {items.length === 0 && <p className="text-sm text-zinc-500">No requests yet.</p>}
      </div>
    </div>
  );
}
