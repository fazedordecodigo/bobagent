import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  AppCatalogEntry,
  AppPermissionKind,
  AppPermissionLevel,
  ConnectedApp,
} from "@upbot/protocol";
import { AppPermissions, defaultAppPermissions } from "@upbot/protocol";
import { RpcError } from "./runtime/agent-runtime";
import { APP_PREFIX, type Vault } from "./vault";
import { VERSION } from "./version";

// Connected apps: MCP servers the daemon runs (stdio) or talks to (streamable HTTP) on behalf
// of the bots. Secrets live in the vault as app.<id>.<KEY> and only reach the server process
// (env) or its HTTP headers; bots see the app's tools through the upbot bridge as
// `<slug>-<tool>` and never the credentials. Account-wide: agentIds empty = every bot.

type Broadcast = (event: string, data: unknown) => void;
type Tool = { name: string; description?: string; inputSchema?: unknown };
/** zod .partial() output: each level may be present-but-undefined. */
type AppPermissionsPatch = { [K in keyof AppPermissions]?: AppPermissions[K] | undefined };

const secretName = (id: string, key: string) => `${APP_PREFIX}${id}.${key}`;

export const APP_CATALOG: AppCatalogEntry[] = [
  {
    id: "notion",
    name: "Notion",
    description: "Search, read and edit pages and databases.",
    transport: "stdio",
    command: ["npx", "-y", "@notionhq/notion-mcp-server@2.5.2"],
    url: null,
    secrets: [
      {
        key: "NOTION_TOKEN",
        label: "Integration token",
        hint: "notion.so/profile/integrations → new internal integration; share pages with it",
        header: null,
      },
    ],
    docsUrl: "https://github.com/makenotion/notion-mcp-server",
  },
  {
    id: "github",
    name: "GitHub",
    description: "Repositories, issues, pull requests and Actions.",
    transport: "http",
    command: null,
    url: "https://api.githubcopilot.com/mcp/",
    secrets: [
      {
        key: "GITHUB_TOKEN",
        label: "Personal access token",
        hint: "github.com/settings/personal-access-tokens",
        header: "Authorization: Bearer {value}",
      },
    ],
    docsUrl: "https://github.com/github/github-mcp-server",
  },
  {
    id: "brave-search",
    name: "Brave Search",
    description: "Web, news, image and local search.",
    transport: "stdio",
    command: ["npx", "-y", "@brave/brave-search-mcp-server@2.1.4"],
    url: null,
    secrets: [
      { key: "BRAVE_API_KEY", label: "API key", hint: "brave.com/search/api", header: null },
    ],
    docsUrl: "https://github.com/brave/brave-search-mcp-server",
  },
  {
    id: "airtable",
    name: "Airtable",
    description: "Read and write bases, tables and records.",
    transport: "stdio",
    command: ["npx", "-y", "airtable-mcp-server@1.14.0"],
    url: null,
    secrets: [
      {
        key: "AIRTABLE_API_KEY",
        label: "Personal access token",
        hint: "airtable.com/create/tokens",
        header: null,
      },
    ],
    docsUrl: "https://github.com/domdomegg/airtable-mcp-server",
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "Customers, payments, invoices and products.",
    transport: "stdio",
    command: ["npx", "-y", "@stripe/mcp@0.3.3", "--tools=all"],
    url: null,
    secrets: [
      {
        key: "STRIPE_SECRET_KEY",
        label: "Secret or restricted key",
        hint: "dashboard.stripe.com/apikeys (prefer a restricted key)",
        header: null,
      },
    ],
    docsUrl: "https://github.com/stripe/agent-toolkit",
  },
];

type Row = {
  permissions_json: string;
  id: string;
  catalog_id: string;
  config_json: string;
  enabled: number;
  created_at: number;
};
type Config = {
  name: string;
  transport: "stdio" | "http";
  command: string[] | null;
  url: string | null;
  secretKeys: string[];
  headers: Record<string, string>;
  agentIds: string[];
};

type Live = {
  client: Client | null;
  transport: Transport | null;
  starting: Promise<void> | null;
  status: ConnectedApp["status"];
  error: string | null;
  tools: Tool[];
  secretValues: string[];
};

export function slugFor(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 20) || "app"
  );
}

export function appToolName(slug: string, tool: string): string {
  return `${slug}-${tool}`
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/_{2,}/g, "_")
    .slice(0, 64);
}

export function appToolNames(slug: string, tools: Tool[]): Map<string, Tool> {
  const counts = new Map<string, number>();
  const entries = tools.map((tool) => {
    const base = appToolName(slug, tool.name);
    counts.set(base, (counts.get(base) ?? 0) + 1);
    return { base, tool };
  });
  const named = entries
    .map(({ base, tool }) => {
      if (base === `${slug}-${tool.name}` || counts.get(base) === 1) return [base, tool] as const;
      const prefix = base.slice(0, 64 - 7).replace(/_+$/, "");
      const hash = createHash("sha256").update(tool.name).digest("hex").slice(0, 6);
      return [`${prefix}_${hash}`, tool] as const;
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return new Map(named);
}

function secretNeedles(values: Iterable<string>): Set<string> {
  const needles = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    needles.add(value);
    if (/[\r\n]/.test(value)) {
      for (const part of value.split(/[\r\n]/)) {
        const trimmed = part.trim();
        if (trimmed.length >= 4) needles.add(trimmed);
      }
    }
  }
  return needles;
}

export function redactValues(text: string, values: Iterable<string>): string {
  return [...secretNeedles(values)]
    .sort((a, b) => b.length - a.length)
    .reduce((result, value) => result.split(value).join("[redacted]"), text);
}

export function appStderrDiagnostics(): {
  push(chunk: Buffer | string): void;
  summary(): string;
} {
  const maxBytes = 1_000_000;
  let bytes = 0;
  // stderr may contain arbitrary credential fragments, so never retain its text.
  return {
    push(chunk) {
      bytes = Math.min(maxBytes, bytes + Buffer.byteLength(chunk));
    },
    summary() {
      return bytes
        ? `stderr output suppressed (${bytes}${bytes === maxBytes ? "+" : ""} bytes)`
        : "";
    },
  };
}

export class AppsService {
  private live = new Map<string, Live>();

  constructor(
    private db: Database,
    private vault: Vault,
    private broadcast: Broadcast,
  ) {}

  catalog(): AppCatalogEntry[] {
    return APP_CATALOG;
  }

  private rows(): Row[] {
    return this.db.query("SELECT * FROM connected_apps ORDER BY created_at ASC").all() as Row[];
  }

  private row(id: string): Row {
    const r = this.db.query("SELECT * FROM connected_apps WHERE id = ?").get(id) as Row | null;
    if (!r) throw new RpcError("not_found", "app not found");
    return r;
  }

  private config(r: Row): Config {
    return JSON.parse(r.config_json) as Config;
  }

  private toApp(r: Row): ConnectedApp {
    const c = this.config(r);
    const l = this.live.get(r.id);
    return {
      permissions: AppPermissions.parse(JSON.parse(r.permissions_json)),
      id: r.id,
      catalogId: r.catalog_id,
      name: c.name,
      slug: slugFor(c.name),
      transport: c.transport,
      command: c.command,
      url: c.url,
      secretKeys: c.secretKeys,
      agentIds: c.agentIds,
      enabled: r.enabled === 1,
      status: r.enabled ? (l?.status ?? "stopped") : "stopped",
      error: l?.error ?? null,
      tools: (l?.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? "" })),
      createdAt: r.created_at,
    };
  }

  list(): ConnectedApp[] {
    return this.rows().map((r) => this.toApp(r));
  }

  get(id: string): ConnectedApp {
    return this.toApp(this.row(id));
  }

  private changed() {
    this.broadcast("apps.changed", {});
  }

  connect(p: {
    permissions?: AppPermissionsPatch | undefined;
    catalogId: string;
    name?: string | undefined;
    secrets: Record<string, string>;
    command?: string[] | undefined;
    url?: string | undefined;
    headers?: Record<string, string> | undefined;
    agentIds?: string[] | undefined;
  }): ConnectedApp {
    const permissions = AppPermissions.parse({ ...defaultAppPermissions, ...p.permissions });
    const entry = APP_CATALOG.find((e) => e.id === p.catalogId);
    let config: Config;
    if (entry) {
      const missing = entry.secrets.find((s) => !p.secrets[s.key]);
      if (missing) throw new RpcError("bad_request", `${missing.label} is required`);
      config = {
        name: p.name || entry.name,
        transport: entry.transport,
        command: entry.command,
        url: entry.url,
        secretKeys: entry.secrets.map((s) => s.key),
        headers: Object.fromEntries(
          entry.secrets
            .filter((s) => s.header)
            .map((s) => {
              const [h, v] = s.header!.split(/:\s*/, 2) as [string, string];
              return [h, v.replace("{value}", `{${s.key}}`)];
            }),
        ),
        agentIds: p.agentIds ?? [],
      };
    } else if (p.catalogId === "custom-stdio" || p.catalogId === "custom-http") {
      if (!p.name) throw new RpcError("bad_request", "name is required");
      const http = p.catalogId === "custom-http";
      if (http ? !p.url : !p.command?.length)
        throw new RpcError("bad_request", http ? "url is required" : "command is required");
      if (http && !/^https?:\/\//.test(p.url!))
        throw new RpcError("bad_request", "url must be http(s)");
      config = {
        name: p.name,
        transport: http ? "http" : "stdio",
        command: http ? null : p.command!,
        url: http ? p.url! : null,
        secretKeys: Object.keys(p.secrets),
        headers: p.headers ?? {},
        agentIds: p.agentIds ?? [],
      };
    } else {
      throw new RpcError("bad_request", `unknown app ${p.catalogId}`);
    }
    for (const k of config.secretKeys) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k))
        throw new RpcError("bad_request", `invalid secret name ${k}`);
    }
    const slug = slugFor(config.name);
    if (this.list().some((a) => a.slug === slug))
      throw new RpcError("conflict", `an app named "${config.name}" is already connected`);
    const id = crypto.randomUUID();
    for (const [k, v] of Object.entries(p.secrets)) this.vault.set(secretName(id, k), v, []);
    this.db
      .query(
        "INSERT INTO connected_apps (id, catalog_id, config_json, permissions_json, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)",
      )
      .run(id, p.catalogId, JSON.stringify(config), JSON.stringify(permissions), Date.now());
    this.changed();
    void this.ensure(id).catch(() => {});
    return this.get(id);
  }

  async update(p: {
    permissions?: AppPermissionsPatch | undefined;
    id: string;
    enabled?: boolean | undefined;
    agentIds?: string[] | undefined;
    secrets?: Record<string, string> | undefined;
  }): Promise<ConnectedApp> {
    const r = this.row(p.id);
    const permissions = AppPermissions.parse({ ...this.toApp(r).permissions, ...p.permissions });
    const c = this.config(r);
    if (p.agentIds) c.agentIds = p.agentIds;
    if (p.secrets) {
      for (const [k, v] of Object.entries(p.secrets)) {
        if (!c.secretKeys.includes(k)) throw new RpcError("bad_request", `unknown secret ${k}`);
        if (v) this.vault.set(secretName(p.id, k), v, []);
      }
    }
    const enabled = p.enabled ?? r.enabled === 1;
    this.db
      .query(
        "UPDATE connected_apps SET config_json = ?, permissions_json = ?, enabled = ? WHERE id = ?",
      )
      .run(JSON.stringify(c), JSON.stringify(permissions), enabled ? 1 : 0, p.id);
    if (p.secrets || !enabled) await this.stop(p.id);
    this.changed();
    if (enabled) void this.ensure(p.id).catch(() => {});
    return this.get(p.id);
  }

  restorePermission(id: string, kind: AppPermissionKind, previousLevel: AppPermissionLevel): void {
    const permissions = this.get(id).permissions;
    if (permissions[kind] !== "allow" || previousLevel === "allow") return;
    const restored = AppPermissions.parse({ ...permissions, [kind]: previousLevel });
    this.db
      .query("UPDATE connected_apps SET permissions_json = ? WHERE id = ?")
      .run(JSON.stringify(restored), id);
    this.changed();
  }

  async delete(id: string): Promise<void> {
    const c = this.config(this.row(id));
    await this.stop(id);
    this.db.query("DELETE FROM connected_apps WHERE id = ?").run(id);
    for (const k of c.secretKeys) this.vault.delete(secretName(id, k));
    this.live.delete(id);
    this.changed();
  }

  async refresh(id: string): Promise<ConnectedApp> {
    await this.stop(id);
    await this.ensure(id).catch(() => {});
    return this.get(id);
  }

  private async stop(id: string): Promise<void> {
    const l = this.live.get(id);
    if (!l) return;
    this.live.delete(id);
    if (l.client) await l.client.close().catch(() => {});
    else await l.transport?.close().catch(() => {});
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.stop(id)));
  }

  private secrets(id: string, c: Config): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of c.secretKeys) out[k] = this.vault.revealInternal(secretName(id, k));
    return out;
  }

  /** Starts (or reuses) the app's MCP client and loads its tool list. */
  private ensure(id: string): Promise<void> {
    const existing = this.live.get(id);
    if (existing?.client && existing.status === "ready") return Promise.resolve();
    if (existing?.starting) return existing.starting;
    const l: Live = {
      client: null,
      transport: null,
      starting: null,
      status: "starting",
      error: null,
      tools: [],
      secretValues: [],
    };
    this.live.set(id, l);
    this.changed();
    const startedAt = Date.now();
    const stderr = appStderrDiagnostics();
    let phase = "configuration";
    let timeout: AbortSignal | null = null;
    let ctx: { catalogId: string; transport: Config["transport"] } | null = null;
    l.starting = (async () => {
      const r = this.row(id);
      const c = this.config(r);
      ctx = { catalogId: r.catalog_id, transport: c.transport };
      const secrets = this.secrets(id, c);
      l.secretValues = Object.values(secrets);
      const fill = (s: string) => s.replace(/\{([A-Za-z0-9_]+)\}/g, (_, k) => secrets[k] ?? "");
      const transport =
        c.transport === "http"
          ? new StreamableHTTPClientTransport(new URL(c.url!), {
              requestInit: {
                headers: Object.fromEntries(
                  Object.entries(c.headers).map(([h, v]) => [h, fill(v)]),
                ),
              },
            })
          : new StdioClientTransport({
              command: c.command![0]!,
              args: c.command!.slice(1),
              env: {
                ...getDefaultEnvironment(),
                PATH: process.env.PATH ?? "",
                ...secrets,
              },
              stderr: "pipe",
            });
      l.transport = transport as Transport;
      if (transport instanceof StdioClientTransport) {
        transport.stderr?.on("data", (d: Buffer) => stderr.push(d));
      }
      const client = new Client({ name: "upbot", version: VERSION });
      timeout = AbortSignal.timeout(Number(process.env.UPBOT_APP_START_TIMEOUT_MS) || 60_000);
      phase = "transport initialization";
      await client.connect(transport as Transport, { signal: timeout });
      phase = "tools/list";
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, { signal: timeout });
        tools.push(...(page.tools as Tool[]));
        cursor = page.nextCursor;
      } while (cursor && tools.length < 500);
      client.onclose = () => {
        if (this.live.get(id) === l) {
          const wasReady = l.status === "ready";
          l.status = "error";
          const diagnostic = stderr.summary();
          l.error = ["the app's MCP server exited", diagnostic].filter(Boolean).join("\n");
          l.client = null;
          l.transport = null;
          if (wasReady) {
            console.error("[upbotd] app MCP server exited", {
              appId: id,
              catalogId: r.catalog_id,
              transport: c.transport,
              ...(diagnostic ? { stderr: diagnostic } : {}),
            });
          }
          this.changed();
        }
      };
      l.client = client;
      l.tools = tools;
      l.status = "ready";
    })()
      .catch(() => {
        l.status = "error";
        l.error = [
          `app MCP startup ${timeout?.aborted ? "timed out" : "failed"} (${phase})`,
          stderr.summary(),
        ]
          .filter(Boolean)
          .join("\n");
        console.error("[upbotd] app start failed", {
          appId: id,
          catalogId: ctx?.catalogId ?? null,
          transport: ctx?.transport ?? null,
          durationMs: Date.now() - startedAt,
          error: l.error,
        });
        throw new Error(l.error);
      })
      .finally(() => {
        l.starting = null;
        this.changed();
      });
    return l.starting;
  }

  private currentSecretValues(id: string): string[] {
    try {
      const c = this.config(this.row(id));
      return Object.values(this.secrets(id, c));
    } catch {
      return [];
    }
  }

  private redact(id: string, text: string, extra: readonly string[] = []): string {
    return redactValues(text, [...extra, ...this.currentSecretValues(id)]);
  }

  private appsFor(agentId: string): Row[] {
    return this.rows().filter((r) => {
      if (!r.enabled) return false;
      const ids = this.config(r).agentIds;
      return ids.length === 0 || ids.includes(agentId);
    });
  }

  /** Bridge tool definitions for a bot (starting the apps it may use). */
  async toolsFor(agentId: string): Promise<Tool[]> {
    const rows = this.appsFor(agentId);
    await Promise.all(rows.map((r) => this.ensure(r.id).catch(() => {})));
    const out: Tool[] = [];
    for (const r of rows) {
      const l = this.live.get(r.id);
      if (l?.status !== "ready") continue;
      const c = this.config(r);
      const slug = slugFor(c.name);
      for (const [name, t] of appToolNames(slug, l.tools)) {
        out.push({
          name,
          description: `[${c.name}] ${t.description ?? ""}`.trim(),
          inputSchema: t.inputSchema ?? { type: "object" },
        });
      }
    }
    return out;
  }

  isAppTool(name: string): boolean {
    const i = name.indexOf("-");
    if (i <= 0) return false;
    const slug = name.slice(0, i);
    return this.rows().some((x) => slugFor(this.config(x).name) === slug);
  }

  appForTool(name: string): ConnectedApp | undefined {
    return this.list().find((app) => name.startsWith(`${app.slug}-`));
  }

  /** Runs `<slug>-<tool>`; null when the name is not an app tool. */
  async call(
    agentId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean } | null> {
    const i = name.indexOf("-");
    if (i <= 0) return null;
    const slug = name.slice(0, i);
    const r = this.rows().find((x) => slugFor(this.config(x).name) === slug);
    if (!r) return null;
    if (!this.appsFor(agentId).some((x) => x.id === r.id))
      throw new Error(`the ${this.config(r).name} app is not available to you`);
    await this.ensure(r.id);
    const l = this.live.get(r.id)!;
    const tool = appToolNames(slug, l.tools).get(name);
    if (!tool) throw new Error(`unknown tool ${name}`);
    const callStart = Date.now();
    const logCallFailure = () =>
      console.error("[upbotd] app tool call failed", {
        appId: r.id,
        tool: name,
        durationMs: Date.now() - callStart,
      });
    let res: Awaited<ReturnType<Client["callTool"]>>;
    try {
      res = await l.client!.callTool({ name: tool.name, arguments: args });
    } catch {
      logCallFailure();
      throw new Error("app MCP tool call failed");
    }
    if (res.isError === true) logCallFailure();
    const content = (res.content ?? []) as { type: string; text?: string }[];
    const text = content
      .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type} content]`))
      .join("\n");
    return {
      text: this.redact(r.id, text, l.secretValues).slice(0, 100_000),
      isError: res.isError === true,
    };
  }
}
