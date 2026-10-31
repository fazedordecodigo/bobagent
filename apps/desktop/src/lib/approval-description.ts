import {
  type AppPermissionKind,
  type Approval,
  classifyToolVerb,
  isSensitivePermission,
  toolOperationTokens,
} from "@upbot/protocol";

export function requiresFullReview(approval: Approval) {
  return (
    approval.kind === "tool" &&
    (!approval.appId || !approval.permission || isSensitivePermission(approval.permission))
  );
}

export function fullApprovalArguments(detail: string) {
  if (!detail.trim()) return "Sem parâmetros.";
  try {
    const value: unknown = JSON.parse(detail);
    if (value && typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length)
      return "Sem parâmetros.";
    return JSON.stringify(value, null, 2);
  } catch {
    return detail;
  }
}

const consequences: Record<AppPermissionKind, string> = {
  read: "ler informações",
  write: "alterar conteúdo",
  send: "enviar conteúdo",
  pay: "pagar",
  book: "reservar",
  del: "apagar conteúdo",
};
// pt-BR labels for the operation verbs of the shared taxonomy (classifyToolVerb).
const verbLabels: Record<string, string> = {
  get: "ler",
  read: "ler",
  list: "listar",
  search: "buscar",
  fetch: "ler",
  create: "criar",
  add: "criar",
  update: "alterar",
  edit: "alterar",
  write: "alterar",
  send: "enviar",
  dispatch: "enviar",
  deliver: "enviar",
  publish: "publicar",
  post: "publicar",
  share: "compartilhar",
  reply: "responder",
  pay: "pagar",
  book: "reservar",
  reserve: "reservar",
  delete: "apagar",
  remove: "apagar",
  trash: "apagar",
};
const objects: Record<string, string> = {
  note: "uma nota",
  notes: "notas",
  message: "uma mensagem",
  messages: "mensagens",
  email: "um e-mail",
  emails: "e-mails",
  file: "um arquivo",
  files: "arquivos",
  document: "um documento",
  documents: "documentos",
  page: "uma página",
  pages: "páginas",
  comment: "um comentário",
  comments: "comentários",
  event: "um evento",
  events: "eventos",
  task: "uma tarefa",
  tasks: "tarefas",
  record: "um registro",
  records: "registros",
  invoice: "uma fatura",
  invoices: "faturas",
  room: "um quarto",
  rooms: "quartos",
};
const argumentLabels: Record<string, string> = {
  title: "título",
  subject: "assunto",
  body: "mensagem",
  content: "conteúdo",
  text: "texto",
  to: "para",
  recipient: "destinatário",
  name: "nome",
  id: "identificador",
};
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const shorten = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

function argumentValue(value: unknown): string {
  if (value === null) return "";
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? "item" : "itens"}`;
  if (typeof value === "object") {
    const count = Object.keys(value).length;
    return `${count} ${count === 1 ? "campo" : "campos"}`;
  }
  if (typeof value === "boolean") return value ? "sim" : "não";
  if (typeof value === "string" && /^[[{]/.test(value.trim())) return "conteúdo estruturado";
  return shorten(oneLine(String(value)).replace(/[{}[\]]/g, ""), 48);
}

export function approvalArguments(detail: string | null): string | null {
  if (!detail) return null;
  try {
    const args: unknown = JSON.parse(detail);
    if (!args || typeof args !== "object" || Array.isArray(args)) return null;
    const entries = Object.entries(args).flatMap(([key, value]) => {
      const text = argumentValue(value);
      const label = shorten(
        oneLine(
          Object.hasOwn(argumentLabels, key)
            ? (argumentLabels[key] ?? key)
            : key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " "),
        ).replace(/[{}[\]]/g, ""),
        28,
      );
      return text && label ? [`${label}: ${text}`] : [];
    });
    if (!entries.length) return null;
    return shorten(entries.slice(0, 3).join(" · ") + (entries.length > 3 ? " · …" : ""), 120);
  } catch {
    return "Não foi possível resumir os argumentos.";
  }
}

export function describeApproval(approval: Approval, botName = "O bot") {
  const { tool, permission, appName } = approval;
  const operation = toolOperationTokens(tool ?? "");
  const verbKey = operation[0] ?? "";
  const objectKey = operation[1] ?? "";
  const kind = classifyToolVerb(verbKey);
  const verb = Object.hasOwn(verbLabels, verbKey) ? verbLabels[verbKey] : undefined;
  const object = Object.hasOwn(objects, objectKey) ? objects[objectKey] : undefined;
  const consequence =
    operation.length === 2 && kind && verb && object && (!permission || kind === permission)
      ? `${verb} ${object}`
      : permission
        ? consequences[permission]
        : "executar uma ação";
  const description = `${botName} quer ${consequence}${appName ? ` em ${appName}` : ""}.`;
  const title = oneLine(approval.title);
  const context =
    !/[_{}[\]<>]|^(run|execute|call)\b/i.test(title) &&
    /\p{L}{2,}\s+\p{L}{2,}/u.test(title) &&
    !(tool && title.includes(tool)) &&
    title !== description
      ? shorten(title, 120)
      : null;
  return { description, context, arguments: approvalArguments(approval.detail) };
}
