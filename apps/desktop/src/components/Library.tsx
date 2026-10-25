import type {
  Agent,
  AgentAvatar,
  BrowserState,
  Memory,
  Routine,
  Skill,
  VaultEntry,
} from "@bobagent/protocol";
import { useCallback, useEffect, useState } from "react";
import type { DaemonClient } from "../lib/daemon";
import { btnCls, inputCls } from "./AgentSettings";

export function AvatarBadge({
  agent,
  size = 20,
}: {
  agent: Pick<Agent, "name" | "avatar">;
  size?: number;
}) {
  const emoji = agent.avatar?.emoji ?? agent.name.slice(0, 1).toUpperCase();
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.6,
        background: agent.avatar?.color ?? "#3f3f46",
      }}
    >
      {emoji}
    </span>
  );
}

export function AvatarEditor({
  agent,
  onSave,
}: {
  agent: Agent;
  onSave: (avatar: AgentAvatar | null) => Promise<void>;
}) {
  const [emoji, setEmoji] = useState(agent.avatar?.emoji ?? "🤖");
  const [color, setColor] = useState(agent.avatar?.color ?? "#0ea5e9");
  return (
    <section className="mx-auto max-w-lg space-y-2 px-6 pb-4">
      <h3 className="text-sm font-semibold text-zinc-300">Avatar</h3>
      <div className="flex items-center gap-2">
        <AvatarBadge agent={{ name: agent.name, avatar: { emoji, color } }} size={32} />
        <input
          className={`${inputCls} w-20`}
          value={emoji}
          maxLength={16}
          onChange={(e) => setEmoji(e.target.value)}
        />
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        <button
          type="button"
          className={`${btnCls} bg-zinc-700 hover:bg-zinc-600`}
          disabled={!emoji.trim()}
          onClick={() => onSave({ emoji: emoji.trim(), color })}
        >
          Save avatar
        </button>
      </div>
    </section>
  );
}

export function MemoriesPanel({ client, agentId }: { client: DaemonClient; agentId: string }) {
  const [items, setItems] = useState<Memory[]>([]);
  const [text, setText] = useState("");
  const load = useCallback(() => {
    client
      .request("memories.list", { agentId })
      .then(setItems)
      .catch(() => {});
  }, [client, agentId]);
  useEffect(() => {
    load();
    return client.on("memories.changed", (d) => {
      if (d.agentId === agentId) load();
    });
  }, [client, agentId, load]);
  return (
    <section className="mx-auto max-w-lg space-y-2 px-6 pb-6">
      <h3 className="text-sm font-semibold text-zinc-300">Memories</h3>
      <p className="text-xs text-zinc-500">Shown to the agent at the start of every new session.</p>
      <ul className="space-y-1">
        {items.map((m) => (
          <li key={m.id} className="flex items-start gap-2 rounded bg-zinc-900 px-2 py-1 text-sm">
            <span className="flex-1 whitespace-pre-wrap">{m.text}</span>
            <button
              type="button"
              className="text-xs text-zinc-500 hover:text-red-400"
              onClick={() => client.request("memories.delete", { id: m.id }).catch(() => {})}
            >
              Delete
            </button>
          </li>
        ))}
        {items.length === 0 && <li className="text-xs text-zinc-600">No memories yet.</li>}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          client
            .request("memories.add", { agentId, text })
            .then(() => setText(""))
            .catch(() => {});
        }}
      >
        <input
          className={inputCls}
          placeholder="Add a memory"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className={`${btnCls} bg-zinc-700 hover:bg-zinc-600`}>
          Add
        </button>
      </form>
    </section>
  );
}

export function SkillsView({ client }: { client: DaemonClient }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [edit, setEdit] = useState<{ name: string; description: string; body: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    client
      .request("skills.list", {})
      .then(setSkills)
      .catch(() => {});
  }, [client]);
  useEffect(() => {
    load();
    return client.on("skills.changed", load);
  }, [client, load]);

  if (edit) {
    return (
      <form
        className="mx-auto max-w-2xl space-y-3 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          client
            .request("skills.save", edit)
            .then(() => setEdit(null))
            .catch((err) => setError(err instanceof Error ? err.message : String(err)));
        }}
      >
        <h2 className="text-lg font-semibold">Skill</h2>
        <input
          className={inputCls}
          placeholder="name (kebab-case)"
          value={edit.name}
          onChange={(e) => setEdit({ ...edit, name: e.target.value })}
          required
        />
        <input
          className={inputCls}
          placeholder="When to use it"
          value={edit.description}
          onChange={(e) => setEdit({ ...edit, description: e.target.value })}
        />
        <textarea
          className={`${inputCls} min-h-64 font-mono`}
          value={edit.body}
          onChange={(e) => setEdit({ ...edit, body: e.target.value })}
          required
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex gap-2">
          <button type="submit" className={`${btnCls} bg-sky-600 hover:bg-sky-500`}>
            Save
          </button>
          <button
            type="button"
            className={`${btnCls} bg-zinc-700 hover:bg-zinc-600`}
            onClick={() => setEdit(null)}
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }
  return (
    <div className="mx-auto max-w-2xl space-y-3 p-6">
      <div className="flex items-center">
        <h2 className="text-lg font-semibold">Skills library</h2>
        <button
          type="button"
          className={`${btnCls} ml-auto bg-sky-600 hover:bg-sky-500`}
          onClick={() => setEdit({ name: "", description: "", body: "" })}
        >
          New skill
        </button>
      </div>
      <p className="text-xs text-zinc-500">
        Shared by all agents. Agents can also create and revise skills themselves.
      </p>
      <ul className="space-y-2">
        {skills.map((s) => (
          <li key={s.name} className="rounded border border-zinc-800 p-3">
            <div className="flex items-center gap-2">
              <span className="font-medium">{s.name}</span>
              {s.author && <span className="text-xs text-zinc-500">by {s.author}</span>}
              <button
                type="button"
                className="ml-auto text-xs text-sky-400 hover:text-sky-300"
                onClick={() => setEdit({ name: s.name, description: s.description, body: s.body })}
              >
                Edit
              </button>
              <button
                type="button"
                className="text-xs text-zinc-500 hover:text-red-400"
                onClick={() => client.request("skills.delete", { name: s.name }).catch(() => {})}
              >
                Delete
              </button>
            </div>
            <p className="text-sm text-zinc-400">{s.description}</p>
          </li>
        ))}
        {skills.length === 0 && <li className="text-sm text-zinc-500">No skills yet.</li>}
      </ul>
    </div>
  );
}

export function RoutinesPanel({ client, agentId }: { client: DaemonClient; agentId: string }) {
  const [items, setItems] = useState<Routine[]>([]);
  const [form, setForm] = useState({ name: "", prompt: "", schedule: "", webhook: false });
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    client
      .request("routines.list", { agentId })
      .then(setItems)
      .catch(() => {});
  }, [client, agentId]);
  useEffect(() => {
    load();
    const offU = client.on("routine.updated", (r) => {
      if (r.agentId === agentId) load();
    });
    const offD = client.on("routine.deleted", load);
    return () => {
      offU();
      offD();
    };
  }, [client, agentId, load]);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  return (
    <section className="mx-auto max-w-lg space-y-2 px-6 pb-6">
      <h3 className="text-sm font-semibold text-zinc-300">Routines</h3>
      <p className="text-xs text-zinc-500">
        Saved prompts sent on a schedule ("every 30m", "daily 09:00", "weekly mon 09:00"), by a
        local webhook, or on demand.
      </p>
      <ul className="space-y-1">
        {items.map((r) => (
          <li key={r.id} className="space-y-1 rounded bg-zinc-900 px-2 py-1.5 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">{r.name}</span>
              <span className="text-xs text-zinc-500">{r.schedule ?? "no schedule"}</span>
              <label className="ml-auto flex items-center gap-1 text-xs text-zinc-400">
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={(e) =>
                    client
                      .request("routines.update", { id: r.id, enabled: e.target.checked })
                      .catch(fail)
                  }
                />
                on
              </label>
              <button
                type="button"
                className="text-xs text-sky-400 hover:text-sky-300"
                onClick={() => client.request("routines.run", { id: r.id }).catch(fail)}
              >
                Run now
              </button>
              <button
                type="button"
                className="text-xs text-zinc-500 hover:text-red-400"
                onClick={() => client.request("routines.delete", { id: r.id }).catch(fail)}
              >
                Delete
              </button>
            </div>
            <div className="truncate text-xs text-zinc-400">{r.prompt}</div>
            {r.nextRunAt && (
              <div className="text-xs text-zinc-500">
                Next: {new Date(r.nextRunAt).toLocaleString()}
              </div>
            )}
            {r.webhookUrl && (
              <code className="block text-[10px] break-all text-zinc-500 select-all">
                curl -X POST -H "Authorization: Bearer {r.webhookToken}" {r.webhookUrl}
              </code>
            )}
          </li>
        ))}
      </ul>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          client
            .request("routines.create", {
              agentId,
              name: form.name,
              prompt: form.prompt,
              schedule: form.schedule.trim() || null,
              webhook: form.webhook,
            })
            .then(() => setForm({ name: "", prompt: "", schedule: "", webhook: false }))
            .catch(fail);
        }}
      >
        <div className="flex gap-2">
          <input
            className={inputCls}
            placeholder="Routine name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
          <input
            className={inputCls}
            placeholder="Schedule (optional)"
            value={form.schedule}
            onChange={(e) => setForm({ ...form, schedule: e.target.value })}
          />
        </div>
        <textarea
          className={inputCls}
          placeholder="Prompt"
          value={form.prompt}
          onChange={(e) => setForm({ ...form, prompt: e.target.value })}
          required
        />
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={form.webhook}
              onChange={(e) => setForm({ ...form, webhook: e.target.checked })}
            />
            Webhook trigger
          </label>
          <button type="submit" className={`${btnCls} ml-auto bg-zinc-700 hover:bg-zinc-600`}>
            Add routine
          </button>
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </form>
    </section>
  );
}

export function BrowserView({ client, agents }: { client: DaemonClient; agents: Agent[] }) {
  const [state, setState] = useState<BrowserState | null>(null);
  const load = useCallback(() => {
    client
      .request("browser.status", {})
      .then(setState)
      .catch(() => {});
  }, [client]);
  useEffect(() => {
    load();
    return client.on("browser.updated", load);
  }, [client, load]);
  if (!state) return null;
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? "deleted agent";
  return (
    <div className="mx-auto max-w-2xl space-y-3 p-6">
      <div className="flex items-center">
        <h2 className="text-lg font-semibold">Agent browser</h2>
        {state.running && (
          <button
            type="button"
            className={`${btnCls} ml-auto bg-zinc-700 hover:bg-zinc-600`}
            onClick={() => client.request("browser.close", {}).catch(() => {})}
          >
            Close browser
          </button>
        )}
      </div>
      <p className="text-xs text-zinc-500">
        {state.available
          ? "Agents drive a separate Chromium window (own profile) with the browser_* tools; each agent gets its own tab. You can watch and use that window directly."
          : "No Chromium-based browser found. Install Google Chrome or set BOBAGENT_BROWSER_PATH."}
      </p>
      <ul className="space-y-2">
        {state.tabs.map((t) => (
          <li
            key={t.agentId}
            className="flex items-center gap-2 rounded border border-zinc-800 p-3 text-sm"
          >
            <div className="min-w-0 flex-1">
              <div className="font-medium">{nameOf(t.agentId)}</div>
              <div className="truncate text-xs text-zinc-400">{t.title || t.url}</div>
              <div className="truncate text-xs text-zinc-500">{t.url}</div>
            </div>
            <button
              type="button"
              className="text-xs text-zinc-500 hover:text-red-400"
              onClick={() =>
                client.request("browser.closeTab", { agentId: t.agentId }).catch(() => {})
              }
            >
              Close tab
            </button>
          </li>
        ))}
        {state.tabs.length === 0 && <li className="text-sm text-zinc-500">No open tabs.</li>}
      </ul>
    </div>
  );
}

const CONNECTORS = [
  ["connector.github", "GitHub personal access token (github_api tool)"],
  [
    "connector.1password",
    "1Password service account token, or 'desktop' for the op app integration",
  ],
  ["connector.bitwarden", "Bitwarden BW_SESSION from `bw unlock --raw`"],
] as const;

export function VaultView({ client, agents }: { client: DaemonClient; agents: Agent[] }) {
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [form, setForm] = useState({ name: "", value: "", agentIds: [] as string[] });
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    client
      .request("vault.list", {})
      .then(setEntries)
      .catch(() => {});
  }, [client]);
  useEffect(() => {
    load();
    return client.on("vault.changed", load);
  }, [client, load]);
  const toggle = (ids: string[], id: string) =>
    ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <h2 className="text-lg font-semibold">Vault</h2>
      <p className="text-xs text-zinc-500">
        Secrets are encrypted with a key kept in the macOS Keychain. Agents only see the secrets you
        share with them (vault_get); connectors use their secret without revealing it.
      </p>
      <ul className="space-y-2">
        {entries.map((e) => (
          <li key={e.name} className="rounded border border-zinc-800 p-3 text-sm">
            <div className="flex items-center">
              <span className="font-mono">{e.name}</span>
              <button
                type="button"
                className="ml-auto text-xs text-zinc-500 hover:text-red-400"
                onClick={() => client.request("vault.delete", { name: e.name }).catch(fail)}
              >
                Delete
              </button>
            </div>
            <div className="mt-1 flex flex-wrap gap-3">
              {agents.map((a) => (
                <label key={a.id} className="flex items-center gap-1 text-xs text-zinc-400">
                  <input
                    type="checkbox"
                    checked={e.agentIds.includes(a.id)}
                    onChange={() =>
                      client
                        .request("vault.setAccess", {
                          name: e.name,
                          agentIds: toggle(e.agentIds, a.id),
                        })
                        .catch(fail)
                    }
                  />
                  {a.name}
                </label>
              ))}
            </div>
          </li>
        ))}
        {entries.length === 0 && <li className="text-sm text-zinc-500">No secrets yet.</li>}
      </ul>
      <form
        className="space-y-2 rounded border border-zinc-800 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          client
            .request("vault.set", form)
            .then(() => setForm({ name: "", value: "", agentIds: [] }))
            .catch(fail);
        }}
      >
        <h3 className="text-sm font-semibold text-zinc-300">Add or replace a secret</h3>
        <div className="flex gap-2">
          <input
            className={inputCls}
            placeholder="name"
            value={form.name}
            list="vault-connectors"
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
          <input
            className={inputCls}
            type="password"
            placeholder="value"
            value={form.value}
            onChange={(e) => setForm({ ...form, value: e.target.value })}
            required
          />
        </div>
        <datalist id="vault-connectors">
          {CONNECTORS.map(([n, d]) => (
            <option key={n} value={n}>
              {d}
            </option>
          ))}
        </datalist>
        <div className="flex flex-wrap gap-3">
          {agents.map((a) => (
            <label key={a.id} className="flex items-center gap-1 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={form.agentIds.includes(a.id)}
                onChange={() => setForm({ ...form, agentIds: toggle(form.agentIds, a.id) })}
              />
              {a.name}
            </label>
          ))}
        </div>
        <ul className="text-xs text-zinc-500">
          {CONNECTORS.map(([n, d]) => (
            <li key={n}>
              <span className="font-mono">{n}</span>: {d}
            </li>
          ))}
        </ul>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button type="submit" className={`${btnCls} bg-sky-600 hover:bg-sky-500`}>
          Save secret
        </button>
      </form>
    </div>
  );
}

export function ComputerUsePanel({ client, agentId }: { client: DaemonClient; agentId: string }) {
  const [state, setState] = useState<{ available: boolean; agentIds: string[] } | null>(null);
  const load = useCallback(() => {
    client
      .request("computer.access", {})
      .then(setState)
      .catch(() => {});
  }, [client]);
  useEffect(() => {
    load();
    return client.on("computer.changed", load);
  }, [client, load]);
  if (!state?.available) return null;
  const on = state.agentIds.includes(agentId);
  return (
    <section className="mx-auto max-w-lg space-y-1 px-6 pb-6">
      <h3 className="text-sm font-semibold text-zinc-300">Computer Use</h3>
      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input
          type="checkbox"
          checked={on}
          onChange={() =>
            client
              .request("computer.setAccess", {
                agentIds: on
                  ? state.agentIds.filter((x) => x !== agentId)
                  : [...state.agentIds, agentId],
              })
              .catch(() => {})
          }
        />
        Let this agent see the screen and control the mouse and keyboard
      </label>
      <p className="text-xs text-zinc-500">
        macOS asks for Screen Recording and Accessibility permission the first time.
      </p>
    </section>
  );
}
