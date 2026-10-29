import type { ApprovalRule } from "@upbot/protocol";

/**
 * Builds the next rules list for a mutation, or `null` when the current list
 * is unknown (still loading or failed to load). `approvals.setRules` replaces
 * the whole list server-side, so a `null` result must never be written — a
 * partial list would delete rules the client never saw, including "ask"
 * protections created by other clients or bots.
 */
export function nextApprovalRules(
  current: ApprovalRule[] | null,
  mutate: (rules: ApprovalRule[]) => ApprovalRule[],
): ApprovalRule[] | null {
  return current === null ? null : mutate(current);
}
