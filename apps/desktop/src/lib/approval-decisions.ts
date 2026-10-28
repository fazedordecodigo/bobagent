import type { Approval, ApprovalDecision } from "@upbot/protocol";
import type { DaemonClient } from "./daemon";

export type ApprovalResult = { message: string; undo?: () => Promise<void> };

export function approvalAction(tool: string | null) {
  return /(^|[_-])(send|post|publish)/i.test(tool ?? "")
    ? "Aprovar e enviar"
    : "Aprovar e executar";
}

export async function decideApproval(
  client: Pick<DaemonClient, "request">,
  approval: Approval,
  decision: ApprovalDecision,
  value?: string,
): Promise<ApprovalResult> {
  const before = decision === "always" ? await client.request("approvals.rules", {}) : [];
  await client.request("approvals.respond", {
    id: approval.id,
    decision,
    ...(value ? { value } : {}),
  });
  if (decision !== "always")
    return {
      message:
        decision === "deny"
          ? "Pedido recusado."
          : approval.kind === "secret"
            ? "Segredo salvo no cofre."
            : approval.kind === "takeover"
              ? "Etapa marcada como concluída."
              : "Ação aprovada para execução uma vez.",
    };
  const after = await client.request("approvals.rules", {}).catch(() => null);
  const added =
    after?.filter(
      (rule) =>
        !before.some((old) => old.id === rule.id) &&
        rule.pattern === approval.tool &&
        rule.agentId === approval.agentId &&
        rule.action === "allow",
    ) ?? [];
  const rule = added.length === 1 ? added[0] : undefined;
  return {
    message: "Ação aprovada. Regra de permissão permanente salva para este bot.",
    ...(rule
      ? {
          undo: async () => {
            const current = await client.request("approvals.rules", {});
            await client.request("approvals.setRules", {
              rules: current.filter((item) => item.id !== rule.id),
            });
          },
        }
      : {}),
  };
}
