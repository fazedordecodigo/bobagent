import type { ApprovalResult } from "./approval-decisions";

export type MenuResult = ApprovalResult & { id: string; createdAt: number; expiresAt: number };
export const MENU_RESULT_TTL = 6000;
export const MENU_RESULT_LIMIT = 5;

export function expireMenuResults(items: MenuResult[], now = Date.now()) {
  return items.filter((item) => item.expiresAt > now);
}

export function addMenuResult(
  items: MenuResult[],
  result: Omit<MenuResult, "expiresAt">,
  now = Date.now(),
) {
  return [
    { ...result, expiresAt: now + MENU_RESULT_TTL },
    ...expireMenuResults(items, now).filter((item) => item.id !== result.id),
  ].slice(0, MENU_RESULT_LIMIT);
}
