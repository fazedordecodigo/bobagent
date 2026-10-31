import type { KeyboardEvent } from "react";

export function moveControlFocus(event: KeyboardEvent<HTMLElement>) {
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
  if (index < 0) return;
  event.preventDefault();
  buttons[index]?.focus();
  buttons[index]?.click();
}
