import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { useEffect, useId, useRef } from "react";
import { useLayerFocus } from "../../hooks/useLayerFocus";
import s from "./controls.module.css";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  small?: boolean;
  arrow?: boolean;
};

export function Button({
  variant = "secondary",
  small,
  arrow,
  className = "",
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      {...props}
      className={`${s.button} ${s[variant]} ${small ? s.small : ""} ${arrow ? s.arrow : ""} ${className}`}
    />
  );
}

export function IconButton({
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { "aria-label": string }) {
  return <button type="button" {...props} className={`${s.iconButton} ${className}`} />;
}

type FieldBase = { label: string; hint?: string; error?: string };
type FieldProps = FieldBase &
  (
    | ({ multiline?: false } & InputHTMLAttributes<HTMLInputElement>)
    | ({ multiline: true } & TextareaHTMLAttributes<HTMLTextAreaElement>)
  );

export function Field({ label, hint, error, ...props }: FieldProps) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  const description = error || hint;
  const shared = {
    id,
    className: `${s.input} ${props.className ?? ""}`,
    "aria-invalid": error ? true : props["aria-invalid"],
    "aria-describedby":
      [props["aria-describedby"], description ? `${id}-hint` : ""].filter(Boolean).join(" ") ||
      undefined,
  };
  let control: ReactNode;
  if (props.multiline) {
    const { multiline: _, ...inputProps } = props;
    control = <textarea {...inputProps} {...shared} />;
  } else {
    const { multiline: _, ...inputProps } = props;
    control = <input {...inputProps} {...shared} />;
  }
  return (
    <div className={s.field}>
      <label htmlFor={id}>{label}</label>
      {control}
      {description && (
        <span id={`${id}-hint`} className={s.hint}>
          {description}
        </span>
      )}
    </div>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  "aria-label": string;
}) {
  return (
    <button
      type="button"
      {...props}
      className={s.switch}
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
    >
      <span />
    </button>
  );
}

export type SegmentOption = { value: string; label: string; icon?: ReactNode; disabled?: boolean };
export function SegmentedControl({
  label,
  options,
  value,
  onValueChange,
  icons = false,
}: {
  label: string;
  options: SegmentOption[];
  value: string;
  onValueChange: (value: string) => void;
  icons?: boolean;
}) {
  return (
    <fieldset
      className={`${s.segmented} ${icons ? s.iconSegments : ""}`}
      aria-label={label}
      onKeyDown={(event) => {
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
        ];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const index =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : ["ArrowRight", "ArrowDown"].includes(event.key)
                ? (current + 1) % buttons.length
                : ["ArrowLeft", "ArrowUp"].includes(event.key)
                  ? (current + buttons.length - 1) % buttons.length
                  : -1;
        if (index >= 0) {
          event.preventDefault();
          buttons[index]?.focus();
          buttons[index]?.click();
        }
      }}
    >
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          disabled={option.disabled}
          tabIndex={
            value === option.value ||
            (!options.some((item) => item.value === value && !item.disabled) &&
              option === options.find((item) => !item.disabled))
              ? 0
              : -1
          }
          aria-label={icons ? option.label : undefined}
          aria-pressed={value === option.value}
          onClick={() => onValueChange(option.value)}
        >
          {icons ? option.icon : option.label}
        </button>
      ))}
    </fieldset>
  );
}

export const statusLabels = {
  run: "Em execução",
  wait: "Aguardando você",
  ok: "Concluído",
  err: "Erro",
} as const;
export type Status = keyof typeof statusLabels;
export function StatusPill({ status }: { status: Status }) {
  return (
    <span className={`${s.pill} ${s[status]}`}>
      <span aria-hidden="true" className={s.pillDot} />
      {statusLabels[status]}
    </span>
  );
}
export function StatusDot({ status }: { status: Status }) {
  return <span role="img" aria-label={statusLabels[status]} className={`${s.dot} ${s[status]}`} />;
}
export function Counter({ children, selected = false }: { children: number; selected?: boolean }) {
  return <span className={`${s.counter} ${selected ? s.counterSelected : ""}`}>{children}</span>;
}
export function ScopeTag({ children, ask = false }: { children: ReactNode; ask?: boolean }) {
  return <span className={`${s.scope} ${ask ? s.ask : ""}`}>{children}</span>;
}
export function Chip({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} className={`${s.chip} ${className}`} />;
}
export function KeyboardShortcut({ children }: { children: ReactNode }) {
  return <kbd className={s.kbd}>{children}</kbd>;
}

export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${s.select} ${className}`} />;
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className={s.tag}>{children}</span>;
}

export function Box({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`${s.box} ${className}`}>{children}</div>;
}

export function Toast({
  children,
  action,
  onAction,
}: {
  children: ReactNode;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className={s.toast} role="status" aria-live="polite">
      {children}
      {action && onAction && (
        <button type="button" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}

export function Dialog({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayerFocus(ref, open);
  useEffect(() => {
    if (open) ref.current?.querySelector<HTMLElement>("button, input, select, textarea")?.focus();
  }, [open]);
  if (!open) return null;
  return (
    <div className={s.dialogScrim}>
      <button
        type="button"
        className={s.dialogBackdrop}
        aria-label="Fechar diálogo"
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={s.dialog}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
