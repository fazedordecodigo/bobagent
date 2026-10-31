import { expect, test } from "bun:test";
import type { AppPermissionKind, Approval } from "@boto/protocol";
import {
  approvalArguments,
  describeApproval,
  fullApprovalArguments,
  requiresFullReview,
} from "../src/lib/approval-description";

test("full review preserves every parameter, list entry and long value, including malformed data", () => {
  const args = {
    to: ["Ana", "Bia", "Caio", "Dani"],
    body: "Texto".repeat(1500),
    total: 20,
    currency: "BRL",
    attachment: { names: ["a.pdf", "b.pdf"] },
  };
  expect(JSON.parse(fullApprovalArguments(JSON.stringify(args)))).toEqual(args);
  for (const detail of ["", "{}", "  "])
    expect(fullApprovalArguments(detail)).toBe("Sem parâmetros.");
  expect(fullApprovalArguments('{"broken":')).toBe('{"broken":');
  for (const permission of ["send", "pay", "book", "del"] as const)
    expect(requiresFullReview({ ...approval, permission })).toBe(true);
  expect(requiresFullReview(approval)).toBe(false);
  for (const tool of ["send_email", "pay_invoice", "delete_file", "unknown"])
    expect(requiresFullReview({ ...approval, appId: undefined, permission: undefined, tool })).toBe(
      true,
    );
});

const approval: Approval = {
  id: "approval",
  agentId: "bot",
  turnId: "turn",
  kind: "tool",
  title: "Run notas-create_note",
  detail: "{}",
  tool: "notas-create_note",
  appId: "notes",
  appName: "Notas",
  permission: "write",
  secretName: null,
  background: false,
  status: "pending",
  createdAt: 0,
  expiresAt: 1,
};

test("app consequences use clean Portuguese operations, not raw tool requests", () => {
  for (const [tool, permission, consequence] of [
    ["notas-create_note", "write", "criar uma nota"],
    ["notas-createNote", "write", "criar uma nota"],
    ["notas-create-note", "write", "criar uma nota"],
    ["notas-send_message", "send", "enviar uma mensagem"],
    ["notas-read_file", "read", "ler um arquivo"],
    ["notas-delete_note", "del", "apagar uma nota"],
    ["hotel-book_room", "book", "reservar um quarto"],
    ["contas-pay_invoice", "pay", "pagar uma fatura"],
  ] as const) {
    const result = describeApproval(
      { ...approval, tool, permission, title: `Run ${tool}` },
      "Boto",
    );
    expect(result).toEqual({
      description: `Boto quer ${consequence} em Notas.`,
      context: null,
      arguments: null,
    });
  }
});

test("unknown objects and compound actions fall back to the permission, without guessing English nouns", () => {
  const fallback: Record<AppPermissionKind, string> = {
    read: "ler informações",
    write: "alterar conteúdo",
    send: "enviar conteúdo",
    pay: "pagar",
    book: "reservar",
    del: "apagar conteúdo",
  };
  for (const permission of Object.keys(fallback) as AppPermissionKind[]) {
    expect(
      describeApproval({ ...approval, tool: "notas-mystery_widget", permission }, "Boto")
        .description,
    ).toBe(`Boto quer ${fallback[permission]} em Notas.`);
  }
  expect(describeApproval({ ...approval, tool: "notas-create_widget" }).description).toBe(
    "O bot quer alterar conteúdo em Notas.",
  );
  expect(
    describeApproval({ ...approval, tool: "notas-get_and_delete", permission: "del" }).description,
  ).toBe("O bot quer apagar conteúdo em Notas.");
  expect(
    describeApproval({ ...approval, tool: "notas-read_note", permission: "del" }).description,
  ).toBe("O bot quer apagar conteúdo em Notas.");
  const { appName, permission, ...nonApp } = approval;
  expect(describeApproval({ ...nonApp, tool: null }).description).toBe(
    "O bot quer executar uma ação.",
  );
});

test("only natural titles survive as secondary context", () => {
  expect(describeApproval({ ...approval, title: "Relatório semanal" }).context).toBe(
    "Relatório semanal",
  );
  for (const title of [
    "Run notas-create_note {}",
    "notas-create_note",
    "create_note",
    '{"title":"Relatório"}',
    "",
    "Execute notas-create_note",
  ]) {
    expect(describeApproval({ ...approval, title }).context).toBeNull();
  }
});

test("arguments become bounded single-line metadata, never raw JSON", () => {
  expect(approvalArguments('{"title":"Revisão\\nda semana","count":2,"notify":true}')).toBe(
    "título: Revisão da semana · count: 2 · notify: sim",
  );
  expect(approvalArguments('{"filters":{"folder":"notes"},"ids":[1,2]}')).toBe(
    "filters: 1 campo · ids: 2 itens",
  );
  expect(approvalArguments('{"body":"{\\"nested\\":true}"}')).toBe(
    "mensagem: conteúdo estruturado",
  );
  const summary = approvalArguments(
    JSON.stringify({ body: "x".repeat(200), to: "y".repeat(200), title: "z".repeat(200), id: 4 }),
  );
  expect(summary?.length).toBeLessThanOrEqual(120);
  expect(summary).toEndWith("…");
  expect(summary).not.toMatch(/[\n{}[\]]/);
});

test("empty, absent and primitive arguments render no metadata; malformed data has a safe fallback", () => {
  for (const detail of [null, "", "{}", "[]", "null", "42", '"text"', '{"body":"", "id":null}']) {
    expect(approvalArguments(detail)).toBeNull();
  }
  for (const detail of ['{"truncated":', "tool failed"])
    expect(approvalArguments(detail)).toBe("Não foi possível resumir os argumentos.");
});
