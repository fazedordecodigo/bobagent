import { useEffect, useMemo, useRef, useState } from "react";

export type PaletteItem = {
  id: string;
  group: string;
  label: string;
  hint?: string;
  run: () => void;
};

/** Cmd/Ctrl+K search palette over agents, group chats, pages, settings and actions. */
export function CommandPalette({
  items,
  initialGroup,
  onClose,
}: {
  items: PaletteItem[];
  initialGroup?: string;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items
      .filter((i) => !initialGroup || i.group === initialGroup)
      .filter(
        (i) =>
          !needle ||
          i.label.toLowerCase().includes(needle) ||
          (i.hint ?? "").toLowerCase().includes(needle) ||
          i.group.toLowerCase().includes(needle),
      )
      .slice(0, 50);
  }, [items, q, initialGroup]);
  const pick = (i: PaletteItem | undefined) => {
    if (!i) return;
    onClose();
    i.run();
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking the backdrop closes the dialog
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-24"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        className="w-[32rem] overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Search"
      >
        <input
          ref={inputRef}
          className="w-full border-b border-zinc-800 bg-transparent px-4 py-3 text-sm outline-none"
          placeholder={
            initialGroup
              ? `Buscar ${initialGroup.toLowerCase()}…`
              : "Buscar agentes, conversas, páginas, configurações…"
          }
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, shown.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(shown[index]);
            }
          }}
        />
        <ul className="max-h-80 overflow-y-auto py-1">
          {shown.map((i, k) => (
            <li key={i.id}>
              <button
                type="button"
                onMouseEnter={() => setIndex(k)}
                onClick={() => pick(i)}
                className={`flex w-full items-center gap-2 px-4 py-2 text-left text-sm ${
                  k === index ? "bg-zinc-800" : ""
                }`}
              >
                <span className="w-20 shrink-0 text-xs text-zinc-500">{i.group}</span>
                <span className="truncate">{i.label}</span>
                {i.hint && <span className="ml-auto truncate text-xs text-zinc-500">{i.hint}</span>}
              </button>
            </li>
          ))}
          {shown.length === 0 && (
            <li className="px-4 py-3 text-sm text-zinc-500">Nenhum resultado.</li>
          )}
        </ul>
        <div className="border-t border-zinc-800 px-4 py-2 text-[11px] text-zinc-500">
          ⌘K buscar · ⌘⇧F agentes · ⌘N novo agente · ⌘1–9 trocar agente · ⌘, configurações · ⌘P
          páginas
        </div>
      </div>
    </div>
  );
}
