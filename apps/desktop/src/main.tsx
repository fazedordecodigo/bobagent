import { StrictMode, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ApprovalFeedback } from "./components/ApprovalFeedback";
import Kit from "./components/ds/Kit";
import MenuBar from "./components/MenuBar";
import { migrateLegacyStorage } from "./lib/storage";
import { initializeTheme } from "./lib/theme";
import "./index.css";

migrateLegacyStorage();
initializeTheme();

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");

function subscribeToHash(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

function Root() {
  const hash = useSyncExternalStore(subscribeToHash, () => window.location.hash);
  const route = hash.split("?")[0];
  const kit = route === "#/kit";
  document.documentElement.toggleAttribute("data-ds-kit", kit);
  return route === "#/menubar" ? (
    <MenuBar />
  ) : kit ? (
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
