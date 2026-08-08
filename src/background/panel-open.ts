// Deciding WHERE Pie's panel opens, and wiring the entry points that ask.
//
// The mechanics live next door:
//   - `panel/sidepanel-probe.ts`  — can this browser show a side panel?
//   - `panel/fallback-window.ts`  — opening the panel outside the side panel
//   - `panel/context-menu.ts`     — the right-click entry point
//
// This module holds only the decision and the order it is made in, because that
// order is the substance of the Arc fix. Detection cannot be trusted: measured
// on Arc, `sidePanel.open()` resolves, the `openPanelOnActionClick` pref is
// stored, and both outcome checks report a live panel — while the user sees
// nothing. So the persisted user preference is consulted FIRST and outranks
// every probe; detection is what happens when the user hasn't said otherwise.

import {
  DEFAULT_PANEL_MODE,
  getPanelMode,
  getPanelModeSync,
  PANEL_MODE_KEY,
  setPanelMode,
} from "@/lib/panel-host/panel-mode";
import { onStoreChange } from "@/lib/store-bus";
import {
  applyActionClickBehavior,
  getSidePanelVerdict,
  loadStoredVerdict,
  rememberVerdict,
  tryOpenSidePanel,
} from "./panel/sidepanel-probe";
import { openFallbackPanelWindow, type PanelTarget } from "./panel/fallback-window";
import { FALLBACK_MENU_ID, installPanelContextMenu } from "./panel/context-menu";

/**
 * Wire up panel opening at service-worker startup.
 *
 * Reads the stored state BEFORE touching the click behaviour. An earlier cut
 * applied `openPanelOnActionClick: false` synchronously here and only restored
 * `true` once the read came back. Because a service worker restarts constantly,
 * that opened a window on every wake where Chrome briefly stopped handling
 * toolbar clicks natively — costing click-to-toggle for any click that landed
 * in it. Reading first means a healthy browser's flag is never disturbed; the
 * cost moves to the browser that actually has the problem, where at most the
 * first click after an upgrade is swallowed before the flag is cleared.
 */
export function initPanelOpening(): void {
  installPanelContextMenu();
  onStoreChange("config", (c) => {
    if (c.id === PANEL_MODE_KEY) void getPanelMode().catch(() => {});
  });

  void (async () => {
    const [mode, verdict] = await Promise.all([
      getPanelMode().catch(() => DEFAULT_PANEL_MODE),
      loadStoredVerdict(),
    ]);
    // Hand clicks to the browser only when it has previously proven it can
    // service a panel AND the user hasn't overridden the display mode.
    applyActionClickBehavior(mode === "auto" && verdict === "supported");
  })();
}

/** Handle a click on the context-menu entry. Returns false if it wasn't ours. */
export function handlePanelContextMenuClick(menuItemId: string, tab?: chrome.tabs.Tab): boolean {
  if (menuItemId !== FALLBACK_MENU_ID) return false;
  void forceFallbackPanel(
    typeof tab?.windowId === "number" ? { windowId: tab.windowId } : {},
  ).catch((e) => console.warn("[sw] context-menu panel open failed:", e));
  return true;
}

/**
 * Open Pie's panel for `target`, falling back to a separate window on browsers
 * that can't service side panels.
 *
 * Fire-and-forget by design: every caller is an event handler that must not
 * block on panel chrome. A `rejected` outcome is left alone — that is Chrome
 * telling us this particular call lacked a user gesture, and the historical
 * behaviour (warn, do nothing) is still correct.
 */
export function openPanel(target: chrome.sidePanel.OpenOptions, context: string): void {
  // The user's explicit choice outranks every probe. Checked first and read
  // synchronously so no detection latency is spent on a browser already known
  // — by the only observer that can actually tell — to have no usable panel.
  if (getPanelModeSync() === "window") {
    void openFallbackPanelWindow(target).catch((e) => {
      console.warn(`[sw] openPanel (${context}) fallback failed:`, e);
    });
    return;
  }

  void tryOpenSidePanel(target)
    .then(async (outcome) => {
      if (outcome === "opened") return;
      if (outcome === "rejected") {
        console.warn(`[sw] sidePanel.open (${context}) was rejected by the browser`);
        return;
      }
      console.info(`[sw] no usable side panel (${context}) — using the fallback window`);
      await openFallbackPanelWindow(target);
    })
    .catch((e) => {
      console.warn(`[sw] openPanel (${context}) failed:`, e);
    });
}

/**
 * Manual escape hatch: open the fallback window unconditionally and record that
 * this browser has no usable side panel.
 *
 * Detection measures the outcome rather than trusting the API, and a browser
 * that reports a live SIDE_PANEL context while rendering nothing still slips
 * through — there is no further signal left to check. So the user gets a
 * switch, and using it once is enough: the choice is persisted, so ordinary
 * toolbar clicks route here from then on, across browser restarts.
 */
export async function forceFallbackPanel(target: PanelTarget): Promise<void> {
  rememberVerdict("unsupported");
  await setPanelMode("window").catch((e) => {
    console.warn("[sw] could not persist the panel display mode:", e);
  });
  await openFallbackPanelWindow(target);
}

/** Current capability verdict — exposed for diagnostics and tests. */
export { getSidePanelVerdict };
