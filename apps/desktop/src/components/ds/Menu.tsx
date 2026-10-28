import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { IconButton } from "./controls";
import s from "./Menu.module.css";

type Item = { label: string; onSelect: () => void; checked?: boolean; disabled?: boolean };

export function Menu({
  label,
  children,
  items,
}: {
  label: string;
  children: ReactNode;
  items: Item[];
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = () => {
    setOpen(false);
    root.current?.querySelector("button")?.focus();
  };
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div className={s.root} ref={root}>
      <IconButton
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {children}
      </IconButton>
      {open && (
        <div
          id={id}
          className={s.menu}
          role="menu"
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
            if (event.key === "Tab") {
              setOpen(false);
              return;
            }
            const buttons = [
              ...(root.current?.querySelectorAll<HTMLButtonElement>(
                '[role^="menuitem"]:not(:disabled)',
              ) ?? []),
            ];
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const index =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : event.key === "ArrowDown"
                    ? (current + 1) % buttons.length
                    : event.key === "ArrowUp"
                      ? (current + buttons.length - 1) % buttons.length
                      : -1;
            if (index >= 0) {
              event.preventDefault();
              buttons[index]?.focus();
            }
          }}
        >
          {items.map((item) => {
            const props = {
              type: "button" as const,
              disabled: item.disabled,
              onClick: () => {
                close();
                item.onSelect();
              },
            };
            return item.checked === undefined ? (
              <button key={item.label} role="menuitem" {...props}>
                {item.label}
              </button>
            ) : (
              <button
                key={item.label}
                role="menuitemcheckbox"
                aria-checked={item.checked}
                {...props}
              >
                {item.label}
                {item.checked && <span aria-hidden="true">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
