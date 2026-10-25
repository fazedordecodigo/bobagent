// Regenerates marketplace/index.json from marketplace/skills/*.md and marketplace/agents/*.json.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "marketplace");
const prev = JSON.parse(readFileSync(join(root, "index.json"), "utf8")) as {
  items: { id: string; kind: string; version: string; sha256: string }[];
};
const items = [];
for (const [kind, folder] of [
  ["skill", "skills"],
  ["agent", "agents"],
] as const) {
  for (const f of readdirSync(join(root, folder)).sort()) {
    const url = `${folder}/${f}`;
    const raw = readFileSync(join(root, url));
    const text = raw.toString("utf8");
    const id = f.replace(/\.[^.]+$/, "");
    let name: string;
    let description: string;
    if (kind === "skill") {
      const meta = Object.fromEntries(
        (/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "").split("\n").map((l) => {
          const i = l.indexOf(":");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        }),
      );
      name = meta.name ?? id;
      description = meta.description ?? "";
    } else {
      const j = JSON.parse(text) as { name: string; instructions: string };
      name = j.name;
      description = `${j.instructions.split(". ")[0]}.`;
    }
    const sha256 = createHash("sha256").update(raw).digest("hex");
    const old = prev.items.find((x) => x.id === id && x.kind === kind);
    const version = old && old.sha256 !== sha256 ? bump(old.version) : (old?.version ?? "1.0.0");
    items.push({ id, kind, name, description, author: "UpBot", version, url, sha256 });
  }
}
writeFileSync(
  join(root, "index.json"),
  `${JSON.stringify({ version: 1, name: "UpBot", items }, null, 2)}\n`,
);
console.log(`wrote ${items.length} items`);

function bump(v: string): string {
  const [a = 1, b = 0, c = 0] = v.split(".").map(Number);
  return `${a}.${b}.${c + 1}`;
}
