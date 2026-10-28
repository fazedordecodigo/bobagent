import type { AppPermissionKind } from "@upbot/protocol";

const operations: [AppPermissionKind, RegExp][] = [
  ["del", /^(delete|remove|destroy|trash)$/],
  ["pay", /^(pay|charge|refund|transfer|payout|purchase)$/],
  ["book", /^(book|reserve)$/],
  [
    "send",
    /^(send|post|publish|invite|reply|forward|mail|email|message|dispatch|deliver|notify|broadcast|sms|text|chat|push|share|comment|dm|tweet)$/,
  ],
  [
    "write",
    /^(create|update|merge|write|edit|archive|cancel|move|rename|upload|patch|put|set|add|insert|close)$/,
  ],
  [
    "read",
    /^(get|list|search|read|query|fetch|retrieve|find|describe|lookup|view|show|count|check|status)$/,
  ],
];

export function classifyAppTool(tool: string): AppPermissionKind {
  const tokens = tool
    .slice(tool.indexOf("-") + 1)
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_-]+/)
    .filter(Boolean);
  const primary = tokens[0] ?? "";
  const knownPrimary = operations.some(([, pattern]) => pattern.test(primary));
  const verbs = knownPrimary
    ? tokens.filter((_, index) => index === 0 || /^(and|or|then)$/.test(tokens[index - 1] ?? ""))
    : tokens;
  return operations.find(([, pattern]) => verbs.some((verb) => pattern.test(verb)))?.[0] ?? "write";
}
