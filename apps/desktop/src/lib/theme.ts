import { useSyncExternalStore } from "react";

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
  let pref: string | null = null;
  try {
    pref = localStorage.getItem("upbot.theme");
  } catch {}
  apply(pref);
  window.addEventListener("storage", (event) => {
    if (event.key === "upbot.theme" || event.key === null) {
      let next: string | null = null;
      try {
        next = localStorage.getItem("upbot.theme");
      } catch {}
      apply(next);
    }
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (document.documentElement.dataset.themePref === "auto") apply("auto");
  });
}

export function setThemePreference(pref: ThemePreference) {
  try {
    localStorage.setItem("upbot.theme", pref);
  } catch {}
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
