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
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-96 rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-2 text-sm text-zinc-400">{body}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
