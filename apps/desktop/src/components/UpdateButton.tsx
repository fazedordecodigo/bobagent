import { check, type Update } from "@tauri-apps/plugin-updater";
import { useState } from "react";

export function UpdateButton() {
  const [state, setState] = useState<
    "idle" | "checking" | "none" | "available" | "installing" | "done" | "error"
  >("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!("__TAURI_INTERNALS__" in window)) return null;
  const run = async () => {
    setError(null);
    try {
      if (state === "available" && update) {
        setState("installing");
        await update.downloadAndInstall();
        setState("done");
        return;
      }
      setState("checking");
      const u = await check();
      setUpdate(u);
      setState(u ? "available" : "none");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  };
  const label = {
    idle: "Check for updates",
    checking: "Checking…",
    none: "Up to date",
    available: `Install ${update?.version ?? "update"}`,
    installing: "Installing…",
    done: "Restart UpBot to finish",
    error: "Update check failed",
  }[state];
  return (
    <button
      type="button"
      title={error ?? undefined}
      className="w-full px-4 py-2 text-left text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
      disabled={state === "checking" || state === "installing" || state === "done"}
      onClick={() => void run()}
    >
      {label}
    </button>
  );
}
