import { useEffect, useRef } from "react";
import { Button } from "./ds/controls";

export function ConfirmDialog({
  title,
  body,
  confirmLabel = "Confirmar",
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="p-5">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-2 text-sm text-zinc-400">{body}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onCancel}>Cancelar</Button>
          <Button onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </dialog>
  );
}
