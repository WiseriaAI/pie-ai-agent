// Theme bootstrap — runs before React mounts (and before first paint, since
// this module is deferred). Mirrors the ThemeMode contract in
// TopBarThemeButton.tsx (light | dark | system); "system" leaves data-theme
// unset so the prefers-color-scheme @media fallback in index.css applies.
//
// Inline <script> in index.html is blocked by MV3's default CSP
// (script-src 'self'), so this lives in the sidepanel's main module instead.
try {
  const m = localStorage.getItem("theme-mode");
  if (m === "light" || m === "dark") {
    document.documentElement.dataset.theme = m;
  }
} catch {
  // localStorage unavailable — fall through to the system fallback.
}

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
