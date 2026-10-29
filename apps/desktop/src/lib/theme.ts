import { useSyncExternalStore } from "react";
import { readStorage, writeStorage } from "./storage";

type ThemePreference = "light" | "dark" | "auto";
const changed = "upbot:theme-changed";

function apply(preference: string | null) {
  const pref = preference === "light" || preference === "dark" ? preference : "auto";
  document.documentElement.dataset.themePref = pref;
  document.documentElement.dataset.theme =
    pref === "auto"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : pref;
  window.dispatchEvent(new Event(changed));
}

export function initializeTheme() {
  apply(readStorage("upbot.theme"));
  window.addEventListener("storage", (event) => {
    if (event.key === "upbot.theme" || event.key === null) {
      apply(readStorage("upbot.theme"));
    }
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (document.documentElement.dataset.themePref === "auto") apply("auto");
  });
}

export function setThemePreference(pref: ThemePreference) {
  writeStorage("upbot.theme", pref);
  apply(pref);
}

function subscribe(callback: () => void) {
  window.addEventListener(changed, callback);
  return () => window.removeEventListener(changed, callback);
}

export function useThemePref() {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => `${document.documentElement.dataset.themePref}:${document.documentElement.dataset.theme}`,
  );
  return [snapshot.split(":")[0] as ThemePreference, setThemePreference] as const;
}
