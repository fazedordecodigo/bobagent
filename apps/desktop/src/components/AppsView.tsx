import type { Agent, AppCatalogEntry, ConnectedApp } from "@upbot/protocol";
import { useCallback, useEffect, useState } from "react";
import type { DaemonClient } from "../lib/daemon";
import { btnCls, inputCls } from "./AgentSettings";

const dot = (s: ConnectedApp["status"]) =>
  s === "ready"
    ? "bg-emerald-400"
    : s === "error"
      ? "bg-red-500"
      : s === "starting"
        ? "bg-amber-400"
        : "bg-zinc-600";

function BotAccess({
  agents,
  agentIds,
  onChange,
}: {
  agents: Agent[];
  agentIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const all = agentIds.length === 0;
  return (
    <div className="flex flex-wrap gap-2 text-xs text-zinc-400">
      <span>Bots:</span>
      {agents.map((b) => (
        <label key={b.id} className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={all || agentIds.includes(b.id)}
            onChange={(e) => {
              const cur = all ? agents.map((x) => x.id) : agentIds;
              const next = e.target.checked ? [...cur, b.id] : cur.filter((x) => x !== b.id);
              onChange(next.length === agents.length ? [] : next);
            }}
          />
          {b.name}
        </label>
      ))}
    </div>
  );
}

export function AppsView({ client, agents }: { client: DaemonClient; agents: Agent[] }) {
  const [catalog, setCatalog] = useState<AppCatalogEntry[]>([]);
  const [apps, setApps] = useState<ConnectedApp[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState({ name: "", command: "", url: "", key: "", value: "" });
  const [error, setError] = useState<string | null>(null);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const load = useCallback(() => {
    client
      .request("apps.list", {})
      .then(setApps)
      .catch(() => {});
  }, [client]);
  useEffect(() => {
    client
      .request("apps.catalog", {})
      .then(setCatalog)
      .catch(() => {});
    load();
    return client.on("apps.changed", load);
  }, [client, load]);
  const entry = catalog.find((e) => e.id === picked);
  const reset = () => {
    setPicked(null);
    setSecrets({});
    setCustom({ name: "", command: "", url: "", key: "", value: "" });
  };
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <h2 className="text-lg font-semibold">Connected apps</h2>
      <p className="text-xs text-zinc-500">
        Connect an app once and your bots can use its tools. UpBot runs each app's MCP server
        itself; tokens are encrypted in the vault and never shown to bots.
      </p>
      <ul className="space-y-2">
        {apps.map((a) => (
          <li key={a.id} className="space-y-2 rounded border border-zinc-800 p-3 text-sm">
            <div className="flex items-center gap-2">
              <span className={`inline-block h-2 w-2 rounded-full ${dot(a.status)}`} />
              <span className="font-medium">{a.name}</span>
              <span className="text-xs text-zinc-500">
                {a.status}
                {a.status === "ready" ? ` · ${a.tools.length} tools` : ""}
              </span>
              <label className="ml-auto flex items-center gap-1 text-xs text-zinc-400">
                <input
                  type="checkbox"
                  checked={a.enabled}
                  onChange={(e) =>
                    client
                      .request("apps.update", { id: a.id, enabled: e.target.checked })
                      .catch(fail)
                  }
                />
                on
              </label>
              <button
                type="button"
                className="text-xs text-sky-400 hover:text-sky-300"
                onClick={() => client.request("apps.refresh", { id: a.id }).catch(fail)}
              >
                Restart
              </button>
              <button
                type="button"
                className="text-xs text-zinc-500 hover:text-red-400"
                onClick={() => client.request("apps.delete", { id: a.id }).catch(fail)}
              >
                Remove
              </button>
            </div>
            {a.error && <div className="text-xs text-red-400">{a.error}</div>}
            {a.tools.length > 0 && (
              <div className="text-xs text-zinc-500" title={a.tools.map((t) => t.name).join(", ")}>
                {a.tools
                  .slice(0, 8)
                  .map((t) => t.name)
                  .join(", ")}
                {a.tools.length > 8 ? ` +${a.tools.length - 8}` : ""}
              </div>
            )}
            <BotAccess
              agents={agents}
              agentIds={a.agentIds}
              onChange={(agentIds) =>
                client.request("apps.update", { id: a.id, agentIds }).catch(fail)
              }
            />
          </li>
        ))}
        {apps.length === 0 && <li className="text-sm text-zinc-500">No apps connected yet.</li>}
      </ul>
      <h3 className="text-sm font-semibold text-zinc-300">Add an app</h3>
      <div className="grid grid-cols-2 gap-2">
        {[
          ...catalog,
          {
            id: "custom-stdio",
            name: "Custom MCP (command)",
            description: "Any stdio MCP server, e.g. npx -y <package>",
          },
          {
            id: "custom-http",
            name: "Custom MCP (URL)",
            description: "A remote streamable-HTTP MCP server",
          },
        ].map((e) => (
          <button
            key={e.id}
            type="button"
            onClick={() => {
              reset();
              setPicked(e.id);
            }}
            className={`rounded border p-2 text-left text-sm hover:bg-zinc-900 ${
              picked === e.id ? "border-sky-500" : "border-zinc-800"
            }`}
          >
            <div className="font-medium">{e.name}</div>
            <div className="text-xs text-zinc-500">{e.description}</div>
          </button>
        ))}
      </div>
      {picked && (
        <form
          className="space-y-2 rounded border border-zinc-800 p-3"
          onSubmit={(ev) => {
            ev.preventDefault();
            setError(null);
            const params = entry
              ? { catalogId: entry.id, secrets }
              : {
                  catalogId: picked,
                  name: custom.name,
                  secrets: custom.key ? { [custom.key]: custom.value } : {},
                  ...(picked === "custom-http"
                    ? {
                        url: custom.url,
                        ...(custom.key
                          ? { headers: { Authorization: `Bearer {${custom.key}}` } }
                          : {}),
                      }
                    : { command: custom.command.split(/\s+/).filter(Boolean) }),
                };
            client.request("apps.connect", params).then(reset).catch(fail);
          }}
        >
          {entry ? (
            <>
              <div className="text-sm font-medium">
                {entry.name}{" "}
                <a
                  className="text-xs text-sky-400"
                  href={entry.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  docs
                </a>
              </div>
              {entry.secrets.map((s) => (
                <div key={s.key} className="space-y-1">
                  <input
                    className={inputCls}
                    type="password"
                    autoComplete="off"
                    required
                    placeholder={s.label}
                    aria-label={s.label}
                    value={secrets[s.key] ?? ""}
                    onChange={(e) => setSecrets({ ...secrets, [s.key]: e.target.value })}
                  />
                  <div className="text-xs text-zinc-500">{s.hint}</div>
                </div>
              ))}
            </>
          ) : (
            <>
              <input
                className={inputCls}
                required
                placeholder="Name"
                value={custom.name}
                onChange={(e) => setCustom({ ...custom, name: e.target.value })}
              />
              {picked === "custom-http" ? (
                <input
                  className={inputCls}
                  required
                  placeholder="https://example.com/mcp"
                  value={custom.url}
                  onChange={(e) => setCustom({ ...custom, url: e.target.value })}
                />
              ) : (
                <input
                  className={`${inputCls} font-mono`}
                  required
                  placeholder="npx -y some-mcp-server"
                  value={custom.command}
                  onChange={(e) => setCustom({ ...custom, command: e.target.value })}
                />
              )}
              <div className="grid grid-cols-2 gap-2">
                <input
                  className={`${inputCls} font-mono`}
                  placeholder={
                    picked === "custom-http"
                      ? "Token name (Bearer header)"
                      : "Env var name (optional)"
                  }
                  value={custom.key}
                  onChange={(e) => setCustom({ ...custom, key: e.target.value })}
                />
                <input
                  className={inputCls}
                  type="password"
                  autoComplete="off"
                  placeholder="Secret value"
                  value={custom.value}
                  onChange={(e) => setCustom({ ...custom, value: e.target.value })}
                />
              </div>
            </>
          )}
          {error && <div className="text-xs text-red-400">{error}</div>}
          <div className="flex gap-2">
            <button type="submit" className={`${btnCls} bg-sky-600 hover:bg-sky-500`}>
              Connect
            </button>
            <button
              type="button"
              className={`${btnCls} bg-zinc-700 hover:bg-zinc-600`}
              onClick={reset}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
