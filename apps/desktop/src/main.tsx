import { StrictMode, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ApprovalFeedback } from "./components/ApprovalFeedback";
import Kit from "./components/ds/Kit";
import "./index.css";

(() => {
  var p: string | null = null;
  try {
    p = localStorage.getItem("upbot.theme");
  } catch {}
  if (p !== "light" && p !== "dark") p = "auto";
  document.documentElement.dataset.themePref = p;
  const apply = () => {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const preference = document.documentElement.dataset.themePref;
    document.documentElement.dataset.theme =
      preference === "auto" ? (dark ? "dark" : "light") : preference === "dark" ? "dark" : "light";
  };
  apply();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (document.documentElement.dataset.themePref === "auto") apply();
  });
})();

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");

function subscribeToHash(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

function Root() {
  const hash = useSyncExternalStore(subscribeToHash, () => window.location.hash);
  const kit = hash === "#/kit";
  document.documentElement.toggleAttribute("data-ds-kit", kit);
  return kit ? (
    <Kit />
  ) : (
    <ApprovalFeedback>
      <App />
    </ApprovalFeedback>
  );
}

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
