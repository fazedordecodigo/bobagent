import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Agent, AgentAvatar, type MarketplaceItem, ProviderId } from "@upbot/protocol";
import type { AgentStore } from "./agents";
import { getSetting, setSetting } from "./db";
import { RpcError } from "./runtime/agent-runtime";
import type { SkillLibrary } from "./skills";

// Marketplace: JSON registries (http(s) or file URLs) listing skills and agent templates.
// Every file is verified against the sha256 in the index before it is installed.

export const DEFAULT_REGISTRY =
  "https://raw.githubusercontent.com/fazedordecodigo/upbot/main/marketplace/index.json";
const LEGACY_REGISTRY =
  "https://raw.githubusercontent.com/fazedordecodigo/bobagent/main/marketplace/index.json";
const MAX_BYTES = 1024 * 1024;

export class MarketplaceFetchError extends Error {
  constructor(
    readonly code: "unsupported_url" | "http_status" | "too_large" | "invalid_index",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "MarketplaceFetchError";
  }
}

type IndexItem = Omit<MarketplaceItem, "source" | "installed">;
type Template = {
  name: string;
  instructions: string;
  avatar?: unknown;
  provider?: string;
  skills?: string[];
};

async function fetchBytes(url: string): Promise<Buffer> {
  const u = new URL(url);
  if (u.protocol === "file:") return readFileSync(fileURLToPath(u));
  if (u.protocol !== "https:" && u.protocol !== "http:")
    throw new MarketplaceFetchError("unsupported_url", `unsupported URL ${url}`);
  const res = await fetch(u, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok)
    throw new MarketplaceFetchError("http_status", `${url}: HTTP ${res.status}`, res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES)
    throw new MarketplaceFetchError("too_large", `${url} is larger than 1 MB`);
  return buf;
}

export class Marketplace {
  constructor(
    private db: Database,
    private skills: SkillLibrary,
    private agents: AgentStore,
  ) {}

  sources(): string[] {
    const saved = getSetting<string[] | null>(this.db, "marketplace_sources", null);
    if (!saved) return [process.env.UPBOT_MARKETPLACE_URL ?? DEFAULT_REGISTRY];
    // sources saved before the repo moved to fazedordecodigo/upbot
    return saved.map((u) => (u === LEGACY_REGISTRY ? DEFAULT_REGISTRY : u));
  }

  setSources(urls: string[]): void {
    for (const u of urls) {
      let p: string;
      try {
        p = new URL(u).protocol;
      } catch {
        throw new RpcError("bad_request", `invalid URL: ${u}`);
      }
      if (!["https:", "http:", "file:"].includes(p))
        throw new RpcError("bad_request", `unsupported URL: ${u}`);
    }
    setSetting(this.db, "marketplace_sources", [...new Set(urls)]);
  }

  private async index(source: string): Promise<IndexItem[]> {
    const raw = JSON.parse((await fetchBytes(source)).toString("utf8")) as { items?: IndexItem[] };
    if (!Array.isArray(raw.items))
      throw new MarketplaceFetchError("invalid_index", `${source} is not a marketplace index`);
    return raw.items.filter(
      (i) =>
        typeof i.id === "string" &&
        (i.kind === "skill" || i.kind === "agent") &&
        typeof i.url === "string" &&
        /^[0-9a-f]{64}$/.test(String(i.sha256)),
    );
  }

  private installed(item: IndexItem): boolean {
    if (item.kind === "skill") return this.skills.get(item.name) !== null;
    return this.agents.list().some((a) => a.name === item.name);
  }

  async list(): Promise<{ items: MarketplaceItem[]; errors: { source: string; error: string }[] }> {
    const items: MarketplaceItem[] = [];
    const errors: { source: string; error: string }[] = [];
    for (const source of this.sources()) {
      try {
        for (const i of await this.index(source)) {
          items.push({
            id: i.id,
            kind: i.kind,
            name: String(i.name ?? i.id),
            description: String(i.description ?? ""),
            author: String(i.author ?? ""),
            version: String(i.version ?? ""),
            url: i.url,
            sha256: i.sha256,
            source,
            installed: this.installed(i),
          });
        }
      } catch (e) {
        errors.push({ source, error: (e as Error).message });
      }
    }
    return { items, errors };
  }

  private async download(source: string, item: IndexItem): Promise<string> {
    const buf = await fetchBytes(new URL(item.url, source).href);
    const sha = createHash("sha256").update(buf).digest("hex");
    if (sha !== item.sha256)
      throw new RpcError("bad_request", `checksum mismatch for ${item.id}; not installed`);
    return buf.toString("utf8");
  }

  private async installSkill(source: string, item: IndexItem) {
    const text = await this.download(source, item);
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
    const meta: Record<string, string> = {};
    for (const line of (m?.[1] ?? "").split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return this.skills.save(
      {
        name: meta.name ?? item.name,
        description: meta.description ?? item.description ?? "",
        body: m ? (m[2] ?? "") : text,
        author: `marketplace:${item.author || "unknown"}`,
      },
      "upsert",
    );
  }

  async install(
    source: string,
    id: string,
    provider?: string,
  ): Promise<{ skills: string[]; agent: Agent | null }> {
    if (!this.sources().includes(source))
      throw new RpcError("bad_request", "unknown marketplace source");
    const all = await this.index(source);
    const item = all.find((i) => i.id === id);
    if (!item) throw new RpcError("not_found", `no item "${id}" in ${source}`);
    if (item.kind === "skill")
      return { skills: [(await this.installSkill(source, item)).name], agent: null };
    const t = JSON.parse(await this.download(source, item)) as Template;
    if (typeof t.name !== "string" || typeof t.instructions !== "string") {
      throw new RpcError("bad_request", "invalid agent template");
    }
    const prov = ProviderId.safeParse(provider ?? t.provider ?? "claude");
    if (!prov.success) throw new RpcError("bad_request", "unknown provider");
    const skills: string[] = [];
    for (const sid of t.skills ?? []) {
      const s = all.find((i) => i.id === sid && i.kind === "skill");
      if (s) skills.push((await this.installSkill(source, s)).name);
    }
    const avatar = AgentAvatar.safeParse(t.avatar);
    const agent = this.agents.create({
      name: t.name.slice(0, 80),
      instructions: t.instructions,
      provider: prov.data,
      avatar: avatar.success ? avatar.data : null,
    });
    return { skills, agent };
  }
}
