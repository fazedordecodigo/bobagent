import { expect, test } from "bun:test";
import type { ApprovalRule } from "@boto/protocol";
import { nextApprovalRules } from "../src/lib/approval-rules";

const askRule: ApprovalRule = { id: "ask", pattern: "*", action: "ask", agentId: null };
const allowRule: ApprovalRule = {
  id: "allow-fs",
  pattern: "fs-*",
  action: "allow",
  agentId: "bot",
};

test("nextApprovalRules blocks mutations while the rule list is unknown", () => {
  // With rules unloaded (null), neither remove nor add may produce a list to
  // send to approvals.setRules — writing a partial list wipes unseen rules,
  // including "ask" protections.
  expect(nextApprovalRules(null, (rules) => rules.filter((r) => r.id !== askRule.id))).toBeNull();
  expect(
    nextApprovalRules(null, (rules) => [
      ...rules,
      { id: "new", pattern: "notas-*", action: "ask", agentId: null },
    ]),
  ).toBeNull();
});

test("nextApprovalRules applies the mutation on a known list", () => {
  const existing = [askRule, allowRule];
  expect(nextApprovalRules(existing, (rules) => rules.filter((r) => r.id !== askRule.id))).toEqual([
    allowRule,
  ]);
  expect(
    nextApprovalRules(existing, (rules) => [
      ...rules,
      { id: "new", pattern: "notas-*", action: "ask", agentId: null },
    ]),
  ).toHaveLength(3);
});
