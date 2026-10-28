import type { AppPermissionKind } from "@upbot/protocol";

const operations: [AppPermissionKind, RegExp][] = [
  ["del", /(^|[_-])(delete|remove|destroy|trash)/i],
  ["pay", /(^|[_-])(pay|charge|refund|transfer|payout|purchase)/i],
  ["book", /(^|[_-])(book|reserve)/i],
  ["send", /(^|[_-])(send|post|publish|invite|reply|forward|email|message)/i],
  [
    "write",
    /(^|[_-])(create|update|merge|write|edit|archive|cancel|move|rename|upload|patch|put|set|add|insert|close)/i,
  ],
];

export function classifyAppTool(tool: string): AppPermissionKind {
  const operation = tool.slice(tool.indexOf("-") + 1);
  return operations.find(([, pattern]) => pattern.test(operation))?.[0] ?? "read";
}
