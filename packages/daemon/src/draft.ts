import type { AgentAvatar } from "@boto/protocol";

// Turns a free-form description ("an agent that reviews PRs for security issues")
// into a draft name, avatar and instructions. Deterministic; the user edits the result.

const EMOJI: [RegExp, string][] = [
  [/secur|vuln|audit/i, "🛡️"],
  [/test|qa\b|e2e/i, "🧪"],
  [/review|lint/i, "🔍"],
  [/doc|write|blog|copy/i, "📝"],
  [/design|ui\b|ux\b|css|front/i, "🎨"],
  [/data|sql|analy|metric/i, "📊"],
  [/deploy|devops|infra|ci\b|docker|k8s/i, "🚀"],
  [/bug|debug|fix/i, "🐛"],
  [/research|search|learn/i, "📚"],
  [/back|api|server/i, "⚙️"],
];
const COLORS = [
  "#0ea5e9",
  "#8b5cf6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#ec4899",
  "#14b8a6",
  "#6366f1",
];
const STOP = new Set(
  "a an the that who which and or to for of in on with my our me i you we is are be agent bot assistant create make build please can will should".split(
    " ",
  ),
);

export function avatarFor(text: string): AgentAvatar {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const emoji = EMOJI.find(([re]) => re.test(text))?.[1] ?? "🤖";
  return { emoji, color: COLORS[h % COLORS.length]! };
}

export function draftAgent(prompt: string): {
  name: string;
  instructions: string;
  avatar: AgentAvatar;
} {
  const p = prompt.trim();
  const named =
    /\b(?:named|called)\s+["“']?([\p{L}\p{N} _-]{2,40}?)["”']?(?:[,.;:!]|\s+(?:that|who|to)\b|$)/iu.exec(
      p,
    );
  let name = named?.[1]?.trim() ?? "";
  if (!name) {
    const words = p
      .split(/[^\p{L}\p{N}-]+/u)
      .filter((w) => w && !STOP.has(w.toLowerCase()))
      .slice(0, 2);
    name =
      words.map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join(" ") || "New Agent";
  }
  name = name.slice(0, 80);
  return { name, instructions: `You are ${name}. ${p}`, avatar: avatarFor(p || name) };
}
