import {
  AppPermissionKind,
  type AppPermissions,
  type ConnectedApp,
  isSensitivePermission,
} from "@upbot/protocol";
import { useEffect, useRef, useState } from "react";
import { permissionDescriptions, permissionLabels } from "../lib/app-permissions";
import type { DaemonClient } from "../lib/daemon";
import s from "./AppPermissionsDialog.module.css";
import { ConfirmDialog } from "./ConfirmDialog";
import { Button, IconButton, SegmentedControl } from "./ds/controls";

export function AppPermissionsDialog({
  app,
  client,
  onClose,
}: {
  app: ConnectedApp;
  client: DaemonClient;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [disconnect, setDisconnect] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function change(permissions: Partial<AppPermissions>) {
    setBusy(true);
    setError(null);
    try {
      await client.request("apps.update", { id: app.id, permissions });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <dialog
        ref={dialog}
        className={s.dialog}
        aria-label={`Permissões de ${app.name}`}
        onCancel={(event) => {
          event.preventDefault();
          onClose();
        }}
      >
        <header className={s.header}>
          <div>
            <h2>{app.name}</h2>
            <p>Permissões do app</p>
          </div>
          <IconButton aria-label="Fechar permissões" onClick={onClose}>
            ×
          </IconButton>
        </header>
        <div className={s.body}>
          <p>Escolha o que este app pode fazer. Regras que pedem revisão continuam valendo.</p>
          {AppPermissionKind.options.map((kind) => (
            <div className={s.row} key={kind}>
              <div>
                <b>{permissionLabels[kind]}</b>
                <p className={s.description}>{permissionDescriptions[kind]}</p>
              </div>
              <SegmentedControl
                label={permissionLabels[kind]}
                value={app.permissions[kind]}
                options={[
                  { value: "off", label: "Não", disabled: busy },
                  { value: "ask", label: "Perguntar", disabled: busy },
                  {
                    value: "allow",
                    label: "Sempre",
                    disabled: busy || isSensitivePermission(kind),
                  },
                ]}
                onValueChange={(level) => {
                  void change({ [kind]: level } as Partial<AppPermissions>);
                }}
              />
            </div>
          ))}
          <p className={s.lock}>
            Enviar, pagar, reservar e excluir sempre pedem aprovação. “Sempre” não está disponível
            para essas ações.
          </p>
          {error && <p role="alert">{error}</p>}
        </div>
        <footer className={s.footer}>
          <Button disabled={busy} onClick={() => setDisconnect(true)}>
            Desconectar
          </Button>
          <Button onClick={onClose}>Concluir</Button>
        </footer>
      </dialog>
      {disconnect && (
        <ConfirmDialog
          title={`Desconectar ${app.name}?`}
          body="A conexão e os segredos salvos deste app serão removidos. Esta ação não pode ser desfeita. Para pausar sem remover os segredos, desative o app na lista."
          confirmLabel="Desconectar"
          onCancel={() => setDisconnect(false)}
          onConfirm={() => {
            setDisconnect(false);
            setBusy(true);
            void client
              .request("apps.delete", { id: app.id })
              .then(onClose)
              .catch((e) => {
                setError(e instanceof Error ? e.message : String(e));
              })
              .finally(() => setBusy(false));
          }}
        />
      )}
    </>
  );
}
