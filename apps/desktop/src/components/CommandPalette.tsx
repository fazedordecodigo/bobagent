import { useEffect, useId, useMemo, useRef, useState } from "react";
import { isMac, mod } from "../lib/platform";
import s from "./CommandPalette.module.css";

export type PaletteItem = {
  id: string;
  group: string;
  label: string;
  hint?: string;
  searchTerms?: string[];
  run: () => void;
};

/** Cmd/Ctrl+K search palette over bots, group chats, pages, settings and actions. */
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
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => previous?.focus();
  }, []);
  const shown = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase("pt-BR");
    return items
      .filter((i) => !initialGroup || i.group === initialGroup)
      .filter(
        (i) =>
          !needle ||
          [i.label, i.hint ?? "", i.group, ...(i.searchTerms ?? [])].some((text) =>
            text.toLocaleLowerCase("pt-BR").includes(needle),
          ),
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
    <div className={s.backdrop} onMouseDown={onClose} role="presentation">
      <div
        className={s.palette}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Buscar"
      >
        <input
          ref={inputRef}
          aria-label="Buscar comandos"
          aria-controls={id}
          aria-activedescendant={shown[index] ? `${id}-${index}` : undefined}
          aria-autocomplete="list"
          className={s.search}
          placeholder={
            initialGroup
              ? `Buscar ${initialGroup.toLowerCase()}…`
              : "Buscar bots, conversas, páginas, configurações…"
          }
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "Tab") {
              e.preventDefault();
              inputRef.current?.focus();
            } else if (e.key === "ArrowDown") {
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
        <div className={s.results} id={id} role="listbox" aria-label="Comandos">
          {shown.map((i, k) => {
            const needle = q.trim().toLocaleLowerCase("pt-BR");
            const hint =
              (needle &&
                i.searchTerms?.find((text) => text.toLocaleLowerCase("pt-BR").includes(needle))) ||
              i.hint;
            return (
              <div key={i.id} role="presentation">
                <button
                  type="button"
                  role="option"
                  id={`${id}-${k}`}
                  aria-selected={k === index}
                  tabIndex={-1}
                  onMouseEnter={() => setIndex(k)}
                  onClick={() => pick(i)}
                  className={s.result}
                  aria-current={k === index ? "true" : undefined}
                >
                  <span className={s.group}>{i.group}</span>
                  <span className="truncate">{i.label}</span>
                  {hint && (
                    <span className={s.hint} title={hint}>
                      {hint}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
          {shown.length === 0 && <p className={s.empty}>Nenhum resultado.</p>}
        </div>
        <div className={s.footer}>
          {mod}K buscar · {mod}
          {isMac ? "⇧" : "Shift+"}F bots · {mod}N novo bot · {mod}1–9 trocar de bot · {mod},
          configurações · {mod}P páginas
        </div>
      </div>
    </div>
  );
}
