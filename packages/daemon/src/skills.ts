import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Skill } from "@upbot/protocol";

// Local skills library shared by all agents: <shared>/Skills/<name>/SKILL.md with a
// `name`/`description`/`author` frontmatter. Revisions keep the previous file in .history/.

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function skillSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function parse(name: string, raw: string, updatedAt: number): Skill {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  const meta: Record<string, string> = {};
  for (const line of (m?.[1] ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return {
    name,
    description: meta.description ?? "",
    author: meta.author || null,
    body: (m ? m[2] : raw) ?? "",
    updatedAt,
  };
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export class SkillLibrary {
  readonly root: string;
  constructor(sharedRoot: string) {
    this.root = join(sharedRoot, "Skills");
  }

  private file(name: string) {
    return join(this.root, name, "SKILL.md");
  }

  list(): Skill[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .filter((n) => NAME_RE.test(n) && existsSync(this.file(n)))
      .sort()
      .map((n) => this.get(n)!)
      .filter(Boolean);
  }

  get(name: string): Skill | null {
    const slug = skillSlug(name);
    if (!NAME_RE.test(slug)) return null;
    const f = this.file(slug);
    if (!existsSync(f)) return null;
    return parse(slug, readFileSync(f, "utf8"), statSync(f).mtimeMs);
  }

  save(
    p: { name: string; description: string; body: string; author?: string | null },
    mode: "create" | "revise" | "upsert",
  ): Skill {
    const slug = skillSlug(p.name);
    if (!NAME_RE.test(slug)) throw new Error("skill name must contain letters or digits");
    const f = this.file(slug);
    const exists = existsSync(f);
    if (mode === "create" && exists)
      throw new Error(`skill "${slug}" already exists; use revise_skill`);
    if (mode === "revise" && !exists) throw new Error(`no skill named "${slug}"`);
    if (!p.body.trim()) throw new Error("skill body is empty");
    mkdirSync(join(this.root, slug), { recursive: true });
    if (exists) {
      const hist = join(this.root, slug, ".history");
      mkdirSync(hist, { recursive: true });
      copyFileSync(f, join(hist, `${Date.now()}.md`));
    }
    const author = p.author ? `\nauthor: ${oneLine(p.author)}` : "";
    writeFileSync(
      f,
      `---\nname: ${slug}\ndescription: ${oneLine(p.description)}${author}\n---\n${p.body.trimEnd()}\n`,
    );
    return this.get(slug)!;
  }

  delete(name: string): boolean {
    const slug = skillSlug(name);
    if (!NAME_RE.test(slug) || !existsSync(this.file(slug))) return false;
    rmSync(join(this.root, slug), { recursive: true, force: true });
    return true;
  }

  promptBlock(): string {
    const skills = this.list();
    if (skills.length === 0) return "";
    const lines = skills.slice(0, 100).map((s) => `- ${s.name}: ${s.description}`);
    return `<skills_library>\nReusable skills shared by all UpBot agents. Load one with the upbot read_skill tool when it fits the task; create_skill/revise_skill to save what you learn.\n${lines.join("\n")}\n</skills_library>\n\n`;
  }
}
