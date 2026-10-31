import { expect, test } from "bun:test";
import { type Approval, type ApprovalRule, defaultAppPermissions } from "@boto/protocol";
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

const appApproval: Approval = {
  ...approval,
  appId: "notes",
  appName: "Notas",
  permission: "write",
  turnId: "turn",
};

test("app always restores the exact previous level without touching tool rules", async () => {
  const calls: [string, unknown][] = [];
  const c = client(async (method, params) => {
    calls.push([method, params]);
    if (method === "approvals.respond")
      return { ...appApproval, status: "approved", previousLevel: "ask" };
    if (method === "apps.list")
      return [{ id: "notes", permissions: { ...defaultAppPermissions, write: "allow" } }];
    if (method === "apps.update") return {};
    throw new Error(`Unexpected ${method}`);
  });
  const result = await decideApproval(c, appApproval, "always");
  expect(result.message).toContain("Preferência de permissão");
  expect(result.undo).toBeDefined();
  await result.undo!();
  expect(calls).toEqual([
    ["approvals.respond", { id: approval.id, decision: "always" }],
    ["apps.list", {}],
    ["apps.update", { id: "notes", permissions: { write: "ask" } }],
  ]);
});

test("app task, deny, sensitive always and missing previous level expose no undo", async () => {
  for (const decision of ["task", "deny", "always"] as const) {
    const c = client(async () => ({
      ...appApproval,
      status: decision === "deny" ? "denied" : "approved",
    }));
    expect((await decideApproval(c, appApproval, decision)).undo).toBeUndefined();
    expect(
      (await decideApproval(c, { ...appApproval, permission: "send" }, decision)).undo,
    ).toBeUndefined();
  }
  const c = client(async () => ({ ...appApproval, status: "denied" }));
  expect((await decideApproval(c, appApproval, "always")).message).toBe("Pedido recusado.");
});

test("app undo refuses missing or changed apps and surfaces RPC failures", async () => {
  for (const apps of [
    [],
    [{ id: "notes", permissions: { ...defaultAppPermissions, write: "off" } }],
  ]) {
    const c = client(async (method) => {
      if (method === "approvals.respond") return { ...appApproval, previousLevel: "ask" };
      if (method === "apps.list") return apps;
      throw new Error("must not update a changed app");
    });
    const result = await decideApproval(c, appApproval, "always");
    await expect(result.undo!()).rejects.toThrow("permissão já mudou");
  }
  const c = client(async () => {
    throw new Error("offline");
  });
  await expect(decideApproval(c, appApproval, "always")).rejects.toThrow("offline");
  const failingUndo = client(async (method) => {
    if (method === "approvals.respond") return { ...appApproval, previousLevel: "ask" };
    if (method === "apps.list")
      return [{ id: "notes", permissions: { ...defaultAppPermissions, write: "allow" } }];
    throw new Error("update failed");
  });
  await expect((await decideApproval(failingUndo, appApproval, "always")).undo!()).rejects.toThrow(
    "update failed",
  );
});

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
