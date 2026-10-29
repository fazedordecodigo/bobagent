import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Agent, Page } from "@upbot/protocol";
import { RpcError } from "./runtime/agent-runtime";

// Pages: self-contained HTML reports, dashboards and trackers that bots publish. Files live
// in <workspace>/Pages/<id>/index.html (previous versions in .history/). The daemon serves
// them at GET /pages/<id>?token=<viewToken> (token regenerated per daemon start) with a CSP
// that blocks all network access; the UI shows them in a sandboxed iframe.

type Broadcast = (event: string, data: unknown) => void;
type Row = {
  id: string;
  agent_id: string;
  title: string;
  description: string;
  version: number;
  created_at: number;
  updated_at: number;
};

export const MAX_PAGE_BYTES = 5 * 1024 * 1024;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 1000;
const PAGE_SIZE_ERROR = `pages are limited to ${MAX_PAGE_BYTES / (1024 * 1024)} MB`;
export const PAGE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'";

function clampText(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(max - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function inside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export class PageLibrary {
  readonly viewToken = randomBytes(24).toString("hex");
  port = 0;

  constructor(
    private db: Database,
    private workspaceRoot: string,
    private broadcast: Broadcast,
  ) {}

  private dir(id: string) {
    return join(this.workspaceRoot, "Pages", id);
  }

  private toPage(r: Row): Page {
    return {
      id: r.id,
      agentId: r.agent_id,
      title: r.title,
      description: r.description,
      version: r.version,
      path: join(this.dir(r.id), "index.html"),
      url: this.port ? `http://127.0.0.1:${this.port}/pages/${r.id}?token=${this.viewToken}` : "",
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  list(): Page[] {
    return (this.db.query("SELECT * FROM pages ORDER BY updated_at DESC").all() as Row[]).map((r) =>
      this.toPage(r),
    );
  }

  get(id: string): Page {
    const r = this.db.query("SELECT * FROM pages WHERE id = ?").get(id) as Row | null;
    if (!r) throw new RpcError("not_found", "page not found");
    return this.toPage(r);
  }

  html(id: string): string {
    return readFileSync(this.get(id).path, "utf8");
  }

  /** Reads `file` from the bot's workspace or the shared workspace. */
  private readSource(me: Agent, file: string): string {
    const roots = [me.workspacePath, this.workspaceRoot]
      .filter((r) => existsSync(r))
      .map((r) => realpathSync(r));
    let p: string;
    try {
      p = realpathSync(isAbsolute(file) ? file : resolve(me.workspacePath, file));
    } catch {
      throw new Error(`file not found: ${file}`);
    }
    if (!roots.some((r) => inside(r, p)))
      throw new Error("`file` must be inside your workspace or the shared workspace");
    if (!statSync(p).isFile()) throw new Error("`file` must be a regular file");
    if (statSync(p).size > MAX_PAGE_BYTES) throw new Error(PAGE_SIZE_ERROR);
    return readFileSync(p, "utf8");
  }

  publish(
    me: Agent,
    p: { id?: string; title?: string; description?: string; html?: string; file?: string },
  ): Page {
    const title = p.title === undefined ? undefined : clampText(p.title.trim(), MAX_TITLE);
    const description =
      p.description === undefined ? undefined : clampText(p.description, MAX_DESCRIPTION);
    const html = p.file ? this.readSource(me, p.file) : (p.html ?? "");
    if (!html.trim()) throw new Error("pass `html` or `file`");
    if (Buffer.byteLength(html) > MAX_PAGE_BYTES) throw new Error(PAGE_SIZE_ERROR);
    const now = Date.now();
    if (p.id) {
      const prev = this.get(p.id);
      const dir = this.dir(prev.id);
      mkdirSync(join(dir, ".history"), { recursive: true });
      if (existsSync(prev.path))
        writeFileSync(join(dir, ".history", `v${prev.version}.html`), readFileSync(prev.path));
      writeFileSync(prev.path, html);
      this.db
        .query(
          "UPDATE pages SET title = ?, description = ?, version = version + 1, updated_at = ? WHERE id = ?",
        )
        .run(
          title || clampText(prev.title, MAX_TITLE),
          description ?? clampText(prev.description, MAX_DESCRIPTION),
          now,
          prev.id,
        );
      this.broadcast("pages.changed", {});
      return this.get(prev.id);
    }
    if (!title) throw new Error("`title` is required for a new page");
    const id = crypto.randomUUID();
    mkdirSync(this.dir(id), { recursive: true });
    writeFileSync(join(this.dir(id), "index.html"), html);
    this.db
      .query(
        "INSERT INTO pages (id, agent_id, title, description, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
      )
      .run(id, me.id, title, description ?? "", now, now);
    this.broadcast("pages.changed", {});
    return this.get(id);
  }

  delete(id: string): void {
    this.get(id);
    this.db.query("DELETE FROM pages WHERE id = ?").run(id);
    rmSync(this.dir(id), { recursive: true, force: true });
    this.broadcast("pages.changed", {});
  }

  /** GET /pages/<id> */
  serve(id: string, token: string): Response {
    if (token.length !== this.viewToken.length || token !== this.viewToken)
      return new Response("unauthorized", { status: 401 });
    let html: string;
    try {
      html = this.html(id);
    } catch {
      return new Response("not found", { status: 404 });
    }
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": PAGE_CSP,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cache-control": "no-store",
      },
    });
  }
}
