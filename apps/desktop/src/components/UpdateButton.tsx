import { check, type Update } from "@tauri-apps/plugin-updater";
import { useState } from "react";
import { errorMessage } from "../lib/log";
import { pendingUpdate, runUpdater, type UpdaterPhase } from "../lib/updater";

export function UpdateButton() {
  const [state, setState] = useState<
    "idle" | "checking" | "none" | "available" | "installing" | "done" | "error"
  >("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failedPhase, setFailedPhase] = useState<UpdaterPhase | null>(null);
  if (!("__TAURI_INTERNALS__" in window)) return null;
  const run = async () => {
    setError(null);
    setFailedPhase(null);
    const pending = pendingUpdate(state, update);
    setState(pending ? "installing" : "checking");
    const outcome = await runUpdater(pending, () => check());
    if (outcome.kind === "installed") {
      setState("done");
      return;
    }
    if (outcome.kind === "checked") {
      setUpdate(outcome.update);
      setState(outcome.update ? "available" : "none");
      return;
    }
    setUpdate(outcome.update);
    setFailedPhase(outcome.phase);
    setError(errorMessage(outcome.error));
    setState("error");
  };
  const label = {
    idle: "Check for updates",
    checking: "Checking…",
    none: "Up to date",
    available: `Install ${update?.version ?? "update"}`,
    installing: "Installing…",
    done: "Restart UpBot to finish",
    error: failedPhase === "install" ? "Update install failed" : "Update check failed",
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
