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
import { I18nProvider } from "@/lib/i18n";
import { runStartupMigrations } from "@/lib/startup-migrations";
import { MotionProvider } from "./components/ui/motion";

async function boot() {
  // Run the full startup-migration pipeline (shared with the service worker)
  // BEFORE mounting App. App's first render reads IDB stores (session index,
  // instances, config); the V2→V3 sweep inside this pipeline is what moves that
  // data out of chrome.storage.local into IDB, so mounting before it completes
  // would render an empty IDB. The pipeline is idempotent and a cross-context
  // singleton, so whichever of {SW, panel} reaches it first runs it and the
  // other no-ops via schema_version===3.
  await runStartupMigrations().catch((e) => {
    console.warn("[panel] startup migrations failed (mounting anyway):", e);
  });
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <I18nProvider>
        <MotionProvider>
          <App />
        </MotionProvider>
      </I18nProvider>
    </StrictMode>,
  );
}

void boot();
