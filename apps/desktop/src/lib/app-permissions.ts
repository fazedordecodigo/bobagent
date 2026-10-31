import type { AppPermissionKind } from "@upbot/protocol";

export const permissionLabels: Record<AppPermissionKind, string> = {
  read: "Ler",
  write: "Criar e editar",
  send: "Enviar",
  pay: "Pagar",
  book: "Reservar",
  del: "Excluir",
};
export const permissionActions: Record<AppPermissionKind, string> = {
  read: "Aprovar e ler",
  write: "Aprovar e executar",
  send: "Aprovar e enviar",
  pay: "Aprovar e pagar",
  book: "Aprovar e reservar",
  del: "Aprovar e excluir",
};
export const permissionDescriptions: Record<AppPermissionKind, string> = {
  read: "Consultar e pesquisar informações",
  write: "Criar e alterar conteúdo",
  send: "Enviar mensagens e publicar",
  pay: "Pagar, cobrar e transferir",
  book: "Fazer reservas",
  del: "Excluir e remover conteúdo",
};
