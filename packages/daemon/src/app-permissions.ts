import type { AppPermissionKind } from "@upbot/protocol";

const operations: [AppPermissionKind, RegExp][] = [
  ["del", /(^|[_-])(delete|remove|destroy|trash)/i],
  ["pay", /(^|[_-])(pay|charge|refund|transfer|payout|purchase)/i],
  ["book", /(^|[_-])(book|reserve)/i],
  [
    "send",
    /(^|[_-])(send|post|publish|invite|reply|forward|mail|email|message|dispatch|deliver|notify|broadcast|sms|text|chat|push|share|comment|dm|tweet)/i,
  ],
  [
    "write",
    /(^|[_-])(create|update|merge|write|edit|archive|cancel|move|rename|upload|patch|put|set|add|insert|close)/i,
  ],
];

export function classifyAppTool(tool: string): AppPermissionKind {
  const operation = tool.slice(tool.indexOf("-") + 1).replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  const kind = operations.find(([, pattern]) => pattern.test(operation))?.[0];
  if (kind) return kind;
  return /^(get|list|search|read|query|fetch|retrieve|find|describe|lookup|view|show|count|check|status)([_-]|$)/i.test(
    operation,
  )
    ? "read"
    : "write";
}
