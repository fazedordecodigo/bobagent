import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";
import { useId } from "react";
import s from "./controls.module.css";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
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
    <fieldset className={`${s.segmented} ${icons ? s.iconSegments : ""}`} aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          disabled={option.disabled}
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
