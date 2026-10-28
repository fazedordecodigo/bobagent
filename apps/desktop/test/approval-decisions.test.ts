import { expect, test } from "bun:test";
import type { Approval, ApprovalRule } from "@upbot/protocol";
import { approvalAction, decideApproval } from "../src/lib/approval-decisions";
import type { DaemonClient } from "../src/lib/daemon";

const approval: Approval = {
  id: "request",
  agentId: "bot",
  turnId: null,
  kind: "tool",
  title: "Run notas-create_note",
  detail: "{}",
  tool: "notas-create_note",
  secretName: null,
  background: false,
  status: "pending",
  createdAt: 0,
  expiresAt: 1,
};
const rule: ApprovalRule = {
  id: "new",
  pattern: "notas-create_note",
  action: "allow",
  agentId: "bot",
};
function client(
  request: (method: string, params: unknown) => Promise<unknown>,
): Pick<DaemonClient, "request"> {
  return { request: request as DaemonClient["request"] };
}

test("consequence labels are derived conservatively, including an empty tool", () => {
  expect(approvalAction("mail-send_message")).toBe("Aprovar e enviar");
  expect(approvalAction("notes-publish")).toBe("Aprovar e enviar");
  expect(approvalAction("notes-create_note")).toBe("Aprovar e executar");
  expect(approvalAction(null)).toBe("Aprovar e executar");
});

test("once, deny, secret and takeover decisions never expose undo", async () => {
  const c = client(async (method) => {
    expect(method).toBe("approvals.respond");
    return approval;
  });
  for (const decision of ["approve", "deny", "done"] as const)
    expect((await decideApproval(c, approval, decision)).undo).toBeUndefined();
  expect(
    (await decideApproval(c, { ...approval, kind: "secret" }, "approve", "test-value")).message,
  ).toBe("Segredo salvo no cofre.");
  expect((await decideApproval(c, { ...approval, kind: "takeover" }, "done")).message).toBe(
    "Etapa marcada como concluída.",
  );
});

test("always undo removes only its new rule and preserves existing and later changes", async () => {
  const existing = { ...rule, id: "existing" };
  const later = { ...rule, id: "later", pattern: "other-*" };
  let rules = [existing];
  const c = client(async (method, params) => {
    if (method === "approvals.rules") return [...rules];
    if (method === "approvals.respond") {
      rules.push(rule);
      return approval;
    }
    rules = (params as { rules: ApprovalRule[] }).rules;
    return rules;
  });
  const result = await decideApproval(c, approval, "always");
  rules.push(later);
  await result.undo?.();
  expect(rules).toEqual([existing, later]);
});

test("missing or ambiguous new rules never expose unsafe undo", async () => {
  for (const added of [[], [rule, { ...rule, id: "concurrent" }]] as ApprovalRule[][]) {
    let responded = false;
    const c = client(async (method) => {
      if (method === "approvals.respond") {
        responded = true;
        return approval;
      }
      return responded ? added : [];
    });
    expect((await decideApproval(c, approval, "always")).undo).toBeUndefined();
  }
});

test("RPC failures propagate, read-after-success failure does not misreport the approved action", async () => {
  const failing = client(async () => {
    throw new Error("unavailable");
  });
  await expect(decideApproval(failing, approval, "approve")).rejects.toThrow("unavailable");
  await expect(decideApproval(failing, approval, "always")).rejects.toThrow("unavailable");
  let responded = false;
  const c = client(async (method) => {
    if (method === "approvals.respond") {
      responded = true;
      return approval;
    }
    if (responded) throw new Error("unavailable");
    return [];
  });
  const result = await decideApproval(c, approval, "always");
  expect(result.message).toContain("Ação aprovada");
  expect(result.undo).toBeUndefined();
});

test("undo errors propagate without changing any unrelated rule", async () => {
  let responded = false;
  const c = client(async (method) => {
    if (method === "approvals.respond") {
      responded = true;
      return approval;
    }
    if (method === "approvals.setRules") throw new Error("save failed");
    return responded ? [rule] : [];
  });
  const result = await decideApproval(c, approval, "always");
  await expect(result.undo?.()).rejects.toThrow("save failed");
});
