import type { Agent, Gateway, GatewayKind, MarketplaceItem, ProviderId } from "@upbot/protocol";
import { useEffect, useState } from "react";
import { useDaemonQuery } from "../hooks/useDaemonQuery";
import type { DaemonClient } from "../lib/daemon";
import { errorMessage } from "../lib/errors";
import { errorFields, type LogFields, logWarn } from "../lib/log";
import { btnCls, inputCls, PROVIDERS } from "./AgentSettings";
import { Markdown } from "./Markdown";

export function SkillsView({ client }: { client: DaemonClient }) {
  const [edit, setEdit] = useState<{ name: string; description: string; body: string } | null>(
    null,
  );
  const { data: skills = [], error: loadError } = useDaemonQuery(
    client,
    "skills.list",
    {},
    {
      events: { "skills.changed": true },
      onError: (e) => logWarn("skills.list_failed", errorFields(e)),
    },
  );
  const [error, setError] = useState<string | null>(null);
  const fail = (scope: string, fields?: LogFields) => (e: unknown) => {
    logWarn(scope, { ...fields, ...errorFields(e) });
    setError(errorMessage(e));
  };

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
            .catch(fail("skills.save_failed"));
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
            onClick={() => {
              setError(null);
              setEdit(null);
            }}
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
          onClick={() => {
            setError(null);
            setEdit({ name: "", description: "", body: "" });
          }}
        >
          New skill
        </button>
      </div>
      <p className="text-xs text-zinc-500">
        Shared by all bots. Bots can also create and revise skills themselves.
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
                onClick={() => {
                  setError(null);
                  setEdit({ name: s.name, description: s.description, body: s.body });
                }}
              >
                Edit
              </button>
              <button
                type="button"
                className="text-xs text-zinc-500 hover:text-red-400"
                onClick={() => {
                  setError(null);
                  client
                    .request("skills.delete", { name: s.name })
                    .catch(fail("skills.delete_failed"));
                }}
              >
                Delete
              </button>
            </div>
            <p className="text-sm text-zinc-400">{s.description}</p>
          </li>
        ))}
        {skills.length === 0 && <li className="text-sm text-zinc-500">No skills yet.</li>}
      </ul>
      {(error || loadError) && <p className="text-xs text-red-400">{error ?? loadError}</p>}
    </div>
  );
}

export function BrowserView({ client, agents }: { client: DaemonClient; agents: Agent[] }) {
  const { data: state, error: loadError } = useDaemonQuery(
    client,
    "browser.status",
    {},
    {
      events: { "browser.updated": true },
      onError: (e) => logWarn("browser.status_failed", errorFields(e)),
    },
  );
  const [error, setError] = useState<string | null>(null);
  const fail = (scope: string, fields?: LogFields) => (e: unknown) => {
    logWarn(scope, { ...fields, ...errorFields(e) });
    setError(errorMessage(e));
  };
  if (!state) {
    return loadError ? (
      <div className="mx-auto max-w-2xl p-6">
        <p className="text-xs text-red-400">{loadError}</p>
      </div>
    ) : null;
  }
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? "deleted bot";
  return (
    <div className="mx-auto max-w-2xl space-y-3 p-6">
      <div className="flex items-center">
        <h2 className="text-lg font-semibold">Bot browser</h2>
        {state.running && (
          <button
            type="button"
            className={`${btnCls} ml-auto bg-zinc-700 hover:bg-zinc-600`}
            onClick={() => {
              setError(null);
              client.request("browser.close", {}).catch(fail("browser.close_failed"));
            }}
          >
            Close browser
          </button>
        )}
      </div>
      <p className="text-xs text-zinc-500">
        {state.available
          ? "Bots drive a separate Chromium window (own profile) with the browser_* tools; each bot gets its own tab. You can watch and use that window directly."
          : "No Chromium-based browser found. Install Google Chrome or set UPBOT_BROWSER_PATH."}
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
              onClick={() => {
                setError(null);
                client
                  .request("browser.closeTab", { agentId: t.agentId })
                  .catch(fail("browser.closeTab_failed", { agentId: t.agentId }));
              }}
            >
              Close tab
            </button>
          </li>
        ))}
        {state.tabs.length === 0 && <li className="text-sm text-zinc-500">No open tabs.</li>}
      </ul>
      {error && <p className="text-xs text-red-400">{error}</p>}
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
  const { data: entries = [], error: loadError } = useDaemonQuery(
    client,
    "vault.list",
    {},
    {
      events: { "vault.changed": true },
      onError: (e) => logWarn("vault.list_failed", errorFields(e)),
    },
  );
  const [form, setForm] = useState({ name: "", value: "", agentIds: [] as string[] });
  const [error, setError] = useState<string | null>(null);
  const toggle = (ids: string[], id: string) =>
    ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
  const fail = (scope: string, fields?: LogFields) => (e: unknown) => {
    logWarn(scope, { ...fields, ...errorFields(e) });
    setError(errorMessage(e));
  };
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <h2 className="text-lg font-semibold">Vault</h2>
      <p className="text-xs text-zinc-500">
        Secrets are encrypted with a key kept in the system secure store (macOS Keychain, Windows
        DPAPI or Linux Secret Service). Bots only see the secrets you share with them (vault_get);
        connectors use their secret without revealing it.
      </p>
      <ul className="space-y-2">
        {entries.map((e) => (
          <li key={e.name} className="rounded border border-zinc-800 p-3 text-sm">
            <div className="flex items-center">
              <span className="font-mono">{e.name}</span>
              <button
                type="button"
                className="ml-auto text-xs text-zinc-500 hover:text-red-400"
                onClick={() =>
                  client
                    .request("vault.delete", { name: e.name })
                    .catch(fail("vault.delete_failed"))
                }
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
                        .catch(fail("vault.setAccess_failed"))
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
            .catch(fail("vault.set_failed"));
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
        {(error || loadError) && <p className="text-xs text-red-400">{error ?? loadError}</p>}
        <button type="submit" className={`${btnCls} bg-sky-600 hover:bg-sky-500`}>
          Save secret
        </button>
      </form>
    </div>
  );
}

const GATEWAY_HELP: Record<GatewayKind, { fields: [string, string][]; help: string }> = {
  telegram: {
    fields: [["botToken", "Bot token from @BotFather"]],
    help: "Message the bot directly. User ids are numeric; unknown users get their id in the reply.",
  },
  slack: {
    fields: [
      ["botToken", "Bot token (xoxb-…)"],
      ["appToken", "App-level token with connections:write (xapp-…)"],
    ],
    help: "Enable Socket Mode and subscribe to app_mention and message.im. Mention the app in a channel or DM it.",
  },
  discord: {
    fields: [["botToken", "Bot token"]],
    help: "Enable the Message Content intent. Mention the bot in a server or DM it. User ids are Discord snowflakes.",
  },
};

export function GatewaysView({ client, agents }: { client: DaemonClient; agents: Agent[] }) {
  const [kind, setKind] = useState<GatewayKind>("telegram");
  const [form, setForm] = useState({
    name: "",
    agentId: "",
    users: "",
    tokens: {} as Record<string, string>,
  });
  const { data: items = [], error: loadError } = useDaemonQuery(
    client,
    "gateways.list",
    {},
    {
      events: { "gateway.updated": true, "gateway.deleted": true },
      onError: (e) => logWarn("gateways.list_failed", errorFields(e)),
    },
  );
  const [error, setError] = useState<string | null>(null);
  const fail = (scope: string, fields?: LogFields) => (e: unknown) => {
    logWarn(scope, { ...fields, ...errorFields(e) });
    setError(errorMessage(e));
  };
  const users = (s: string) =>
    s
      .split(/[\s,]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  const dot = (s: Gateway["status"]) =>
    s === "connected"
      ? "bg-emerald-400"
      : s === "error"
        ? "bg-red-500"
        : s === "stopped"
          ? "bg-zinc-600"
          : "bg-amber-400";
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <h2 className="text-lg font-semibold">Gateways</h2>
      <p className="text-xs text-zinc-500">
        Talk to your bots from Telegram, Slack or Discord. Only allowlisted user ids get through;
        start a message with @BotName to reach another bot. Tokens are kept in the vault.
      </p>
      <ul className="space-y-2">
        {items.map((g) => (
          <li key={g.id} className="space-y-1 rounded border border-zinc-800 p-3 text-sm">
            <div className="flex items-center gap-2">
              <span className={`inline-block h-2 w-2 rounded-full ${dot(g.status)}`} />
              <span className="font-medium">{g.name}</span>
              <span className="text-xs text-zinc-500">
                {g.kind} · {g.status}
              </span>
              <select
                className="ml-auto rounded bg-zinc-900 px-1 text-xs"
                value={g.agentId}
                onChange={(e) =>
                  client
                    .request("gateways.update", { id: g.id, agentId: e.target.value })
                    .catch(fail("gateways.update_failed", { id: g.id }))
                }
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1 text-xs text-zinc-400">
                <input
                  type="checkbox"
                  checked={g.enabled}
                  onChange={(e) =>
                    client
                      .request("gateways.update", { id: g.id, enabled: e.target.checked })
                      .catch(fail("gateways.update_failed", { id: g.id }))
                  }
                />
                on
              </label>
              <button
                type="button"
                className="text-xs text-zinc-500 hover:text-red-400"
                onClick={() =>
                  client
                    .request("gateways.delete", { id: g.id })
                    .catch(fail("gateways.delete_failed", { id: g.id }))
                }
              >
                Delete
              </button>
            </div>
            {g.error && <div className="text-xs text-red-400">{g.error}</div>}
            <input
              className={`${inputCls} text-xs`}
              defaultValue={g.allowedUsers.join(", ")}
              placeholder="Allowed user ids (comma separated)"
              onBlur={(e) =>
                client
                  .request("gateways.update", { id: g.id, allowedUsers: users(e.target.value) })
                  .catch(fail("gateways.update_failed", { id: g.id }))
              }
            />
          </li>
        ))}
        {items.length === 0 && <li className="text-sm text-zinc-500">No gateways yet.</li>}
      </ul>
      {loadError && <p className="text-xs text-red-400">{loadError}</p>}
      <form
        className="space-y-2 rounded border border-zinc-800 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          client
            .request("gateways.create", {
              kind,
              name: form.name,
              agentId: form.agentId || agents[0]?.id || "",
              tokens: form.tokens,
              allowedUsers: users(form.users),
            })
            .then(() => setForm({ name: "", agentId: "", users: "", tokens: {} }))
            .catch(fail("gateways.create_failed"));
        }}
      >
        <h3 className="text-sm font-semibold text-zinc-300">New gateway</h3>
        <div className="flex gap-2">
          <select
            className={inputCls}
            value={kind}
            onChange={(e) => setKind(e.target.value as GatewayKind)}
          >
            <option value="telegram">Telegram</option>
            <option value="slack">Slack</option>
            <option value="discord">Discord</option>
          </select>
          <input
            className={inputCls}
            placeholder="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
          <select
            className={inputCls}
            value={form.agentId}
            onChange={(e) => setForm({ ...form, agentId: e.target.value })}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        {GATEWAY_HELP[kind].fields.map(([field, label]) => (
          <input
            key={field}
            className={inputCls}
            type="password"
            placeholder={label}
            value={form.tokens[field] ?? ""}
            onChange={(e) =>
              setForm({ ...form, tokens: { ...form.tokens, [field]: e.target.value } })
            }
            required
          />
        ))}
        <input
          className={inputCls}
          placeholder="Allowed user ids (comma separated)"
          value={form.users}
          onChange={(e) => setForm({ ...form, users: e.target.value })}
        />
        <p className="text-xs text-zinc-500">{GATEWAY_HELP[kind].help}</p>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button
          type="submit"
          className={`${btnCls} bg-sky-600 hover:bg-sky-500`}
          disabled={agents.length === 0}
        >
          Connect
        </button>
      </form>
    </div>
  );
}

export function MarketplaceView({ client }: { client: DaemonClient }) {
  const {
    data,
    error: loadError,
    reload,
  } = useDaemonQuery(
    client,
    "marketplace.list",
    {},
    {
      onError: (e) => logWarn("marketplace.list_failed", errorFields(e)),
    },
  );
  const [sources, setSources] = useState("");
  const [provider, setProvider] = useState<ProviderId>("claude");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (data) setSources(data.sources.join("\n"));
  }, [data]);
  const install = (i: MarketplaceItem) => {
    setBusy(`${i.source}#${i.id}`);
    setError(null);
    client
      .request("marketplace.install", {
        source: i.source,
        id: i.id,
        ...(i.kind === "agent" ? { provider } : {}),
      })
      .then(reload)
      .catch((e) => {
        logWarn("marketplace.install_failed", { id: i.id, ...errorFields(e) });
        setError(errorMessage(e));
      })
      .finally(() => setBusy(null));
  };
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold">Marketplace</h2>
        <label className="ml-auto text-xs text-zinc-400">
          Provedor dos novos bots{" "}
          <select
            className="rounded bg-zinc-900 px-1"
            value={provider}
            onChange={(e) => setProvider(e.target.value as ProviderId)}
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </div>
      {(error || loadError) && <p className="text-sm text-red-400">{error ?? loadError}</p>}
      {data?.errors.map((e) => (
        <p key={e.source} className="text-xs text-amber-400">
          {e.source}: {e.error}
        </p>
      ))}
      <ul className="grid grid-cols-2 gap-2">
        {data?.items.map((i) => (
          <li
            key={`${i.source}#${i.id}`}
            className="flex flex-col rounded border border-zinc-800 p-3 text-sm"
          >
            <div className="flex items-center gap-2">
              <span className="font-medium">{i.name}</span>
              <span className="rounded bg-zinc-800 px-1 text-[10px] text-zinc-400 uppercase">
                {i.kind}
              </span>
            </div>
            <p className="mt-1 flex-1 text-xs text-zinc-400">{i.description}</p>
            <div className="mt-2 flex items-center text-[10px] text-zinc-500">
              {i.author} · v{i.version}
              <button
                type="button"
                className={`${btnCls} ml-auto bg-sky-600 py-0.5 text-xs hover:bg-sky-500`}
                disabled={busy !== null}
                onClick={() => install(i)}
              >
                {busy === `${i.source}#${i.id}`
                  ? "Installing…"
                  : i.installed
                    ? "Reinstall"
                    : "Install"}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          client
            .request("marketplace.setSources", {
              urls: sources
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
            })
            .then(reload)
            .catch((err) => {
              logWarn("marketplace.setSources_failed", errorFields(err));
              setError(errorMessage(err));
            });
        }}
      >
        <h3 className="text-sm font-semibold text-zinc-300">Registries</h3>
        <textarea
          className={`${inputCls} font-mono text-xs`}
          value={sources}
          onChange={(e) => setSources(e.target.value)}
        />
        <p className="text-xs text-zinc-500">
          One index.json URL per line (https or file). Files are checked against their sha256.
        </p>
        <button type="submit" className={`${btnCls} bg-zinc-700 hover:bg-zinc-600`}>
          Save registries
        </button>
      </form>
    </div>
  );
}

export function MobileView({ client }: { client: DaemonClient }) {
  const {
    data: st,
    error: loadError,
    reload,
  } = useDaemonQuery(
    client,
    "mobile.status",
    {},
    {
      onError: (e) => logWarn("mobile.status_failed", errorFields(e)),
    },
  );
  const [pair, setPair] = useState<{ code: string; expiresAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [reload]);
  const fail = (scope: string, fields?: LogFields) => (e: unknown) => {
    logWarn(scope, { ...fields, ...errorFields(e) });
    setError(errorMessage(e));
  };
  if (!st) {
    return loadError ? (
      <div className="mx-auto max-w-lg p-6">
        <p className="text-xs text-red-400">{loadError}</p>
      </div>
    ) : null;
  }
  return (
    <div className="mx-auto max-w-lg space-y-4 p-6">
      <h2 className="text-lg font-semibold">Mobile</h2>
      <p className="text-xs text-zinc-500">
        Chat with your bots and answer permission requests from your phone on the same Wi-Fi. Open
        the address in Safari and use "Add to Home Screen". Traffic is plain HTTP on your local
        network; only paired devices get in.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={st.enabled}
          onChange={(e) => {
            setPair(null);
            client
              .request("mobile.enable", { enabled: e.target.checked })
              .then(reload)
              .catch(fail("mobile.enable_failed"));
          }}
        />
        Allow mobile access on this network
      </label>
      {st.enabled && (
        <>
          <ul className="space-y-1">
            {st.urls.map((u) => (
              <li key={u} className="font-mono text-sm text-sky-300 select-all">
                {u}
              </li>
            ))}
            {st.urls.length === 0 && (
              <li className="text-xs text-amber-400">No network address found.</li>
            )}
          </ul>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className={`${btnCls} bg-sky-600 hover:bg-sky-500`}
              onClick={() =>
                client.request("mobile.pair", {}).then(setPair).catch(fail("mobile.pair_failed"))
              }
            >
              Pair a device
            </button>
            {pair && (
              <span
                className="font-mono text-2xl tracking-[0.3em]"
                title={`expires ${new Date(pair.expiresAt).toLocaleTimeString()}`}
              >
                {pair.code}
              </span>
            )}
          </div>
        </>
      )}
      {(error || loadError) && <p className="text-xs text-red-400">{error ?? loadError}</p>}
      <h3 className="text-sm font-semibold text-zinc-300">Paired devices</h3>
      <ul className="space-y-1">
        {st.devices.map((d) => (
          <li key={d.id} className="flex items-center rounded bg-zinc-900 px-2 py-1 text-sm">
            <span>{d.name}</span>
            <span className="ml-2 text-xs text-zinc-500">
              {d.lastSeenAt ? `seen ${new Date(d.lastSeenAt).toLocaleString()}` : "never connected"}
            </span>
            <button
              type="button"
              className="ml-auto text-xs text-zinc-500 hover:text-red-400"
              onClick={() =>
                client
                  .request("mobile.revoke", { id: d.id })
                  .then(reload)
                  .catch(fail("mobile.revoke_failed", { id: d.id }))
              }
            >
              Revoke
            </button>
          </li>
        ))}
        {st.devices.length === 0 && <li className="text-xs text-zinc-600">None yet.</li>}
      </ul>
    </div>
  );
}

export function TeamView({ client, agents }: { client: DaemonClient; agents: Agent[] }) {
  const {
    data: st,
    error: statusError,
    reload: reloadStatus,
  } = useDaemonQuery(
    client,
    "team.status",
    {},
    {
      events: { "team.updated": true },
      onError: (e) => logWarn("team.status_failed", errorFields(e)),
    },
  );
  const { data: msgs = [], error: msgsError } = useDaemonQuery(
    client,
    "team.messages",
    {},
    {
      events: { "team.message": true },
      onError: (e) => logWarn("team.messages_failed", errorFields(e)),
    },
  );
  const [join, setJoin] = useState({ url: "", token: "" });
  const [target, setTarget] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fail = (scope: string, fields?: LogFields) => (e: unknown) => {
    logWarn(scope, { ...fields, ...errorFields(e) });
    setError(errorMessage(e));
  };
  const shownError = error ?? statusError ?? msgsError;
  if (!st) {
    return shownError ? (
      <div className="mx-auto max-w-lg p-6">
        <p className="text-xs text-red-400">{shownError}</p>
      </div>
    ) : null;
  }
  if (!st.configured) {
    return (
      <form
        className="mx-auto max-w-lg space-y-3 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          client
            .request("team.connect", join)
            .then(reloadStatus)
            .catch(fail("team.connect_failed"));
        }}
      >
        <h2 className="text-lg font-semibold">Team</h2>
        <p className="text-xs text-zinc-500">
          Join a UpBot team relay to share bots with teammates and message theirs. Host one with{" "}
          <code>bun run relay -- --data ./relay-data</code> and invite members with its admin token.
        </p>
        <input
          className={inputCls}
          placeholder="Relay URL (https://relay.example.com)"
          value={join.url}
          onChange={(e) => setJoin({ ...join, url: e.target.value })}
          required
        />
        <input
          className={inputCls}
          type="password"
          placeholder="Member token"
          value={join.token}
          onChange={(e) => setJoin({ ...join, token: e.target.value })}
          required
        />
        {shownError && <p className="text-xs text-red-400">{shownError}</p>}
        <button type="submit" className={`${btnCls} bg-sky-600 hover:bg-sky-500`}>
          Join team
        </button>
      </form>
    );
  }
  const options = st.members.flatMap((m) =>
    m.agents.map((a) => ({ key: `${m.id}:${a.id}`, label: `${a.name} (${m.name})` })),
  );
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold">Team</h2>
        <span className={`text-xs ${st.connected ? "text-emerald-400" : "text-amber-400"}`}>
          {st.connected ? `connected as ${st.me?.name ?? ""}` : (st.error ?? "connecting…")}
        </span>
        <button
          type="button"
          className="ml-auto text-xs text-zinc-500 hover:text-red-400"
          onClick={() =>
            client
              .request("team.disconnect", {})
              .then(reloadStatus)
              .catch(fail("team.disconnect_failed"))
          }
        >
          Leave
        </button>
      </div>
      <section className="space-y-1">
        <h3 className="text-sm font-semibold text-zinc-300">Bots you share</h3>
        <div className="flex flex-wrap gap-3">
          {agents.map((a) => (
            <label key={a.id} className="flex items-center gap-1 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={st.sharedAgentIds.includes(a.id)}
                onChange={() =>
                  client
                    .request("team.share", {
                      agentIds: st.sharedAgentIds.includes(a.id)
                        ? st.sharedAgentIds.filter((x) => x !== a.id)
                        : [...st.sharedAgentIds, a.id],
                    })
                    .then(reloadStatus)
                    .catch(fail("team.share_failed"))
                }
              />
              {a.name}
            </label>
          ))}
        </div>
      </section>
      <section className="space-y-1">
        <h3 className="text-sm font-semibold text-zinc-300">Teammates</h3>
        <ul className="space-y-1 text-sm">
          {st.members.map((m) => (
            <li key={m.id}>
              <span className={m.online ? "text-zinc-200" : "text-zinc-600"}>{m.name}</span>
              <span className="ml-2 text-xs text-zinc-500">
                {m.online ? m.agents.map((a) => a.name).join(", ") || "no shared bots" : "offline"}
              </span>
            </li>
          ))}
          {st.members.length === 0 && <li className="text-xs text-zinc-600">No teammates yet.</li>}
        </ul>
      </section>
      <ul className="space-y-2">
        {msgs.map((m) => (
          <li key={m.id} className="rounded border border-zinc-800 p-2 text-sm">
            <div className="text-xs text-zinc-500">
              {m.direction === "out"
                ? `You → ${m.agentName} (${m.memberName})`
                : `${m.memberName} → your ${m.agentName}`}{" "}
              · {m.status}
            </div>
            <div className="whitespace-pre-wrap">{m.text}</div>
            {m.reply && (
              <div className="mt-1 flex items-start gap-1 text-zinc-300">
                <span>↳</span>
                <Markdown text={m.reply} />
              </div>
            )}
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const [memberId, agentId] = (target || options[0]?.key || "").split(":");
          if (!memberId || !agentId || !text.trim()) return;
          setError(null);
          client
            .request("team.send", { memberId, agentId, text })
            .then(() => setText(""))
            .catch(fail("team.send_failed"));
        }}
      >
        <select
          className={`${inputCls} w-48`}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          {options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          className={inputCls}
          placeholder="Message a teammate's bot"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="submit"
          className={`${btnCls} bg-sky-600 hover:bg-sky-500`}
          disabled={options.length === 0}
        >
          Send
        </button>
      </form>
      {shownError && <p className="text-xs text-red-400">{shownError}</p>}
    </div>
  );
}
