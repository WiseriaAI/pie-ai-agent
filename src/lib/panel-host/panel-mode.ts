// Where Pie's panel should open — a user preference, because auto-detection
// lost.
//
// Three rounds of increasingly careful capability probing were defeated by the
// same browser: `sidePanel.open()` resolves, `setPanelBehavior` stores its flag,
// and the outcome checks (`getContexts`, the liveness ping) still come back
// positive — while nothing is ever shown to the user. Whatever Arc does behind
// the scenes, from the service worker's side an opened-and-invisible panel is
// indistinguishable from an opened-and-visible one.
//
// There is no fourth signal worth inventing. The person looking at the screen
// already knows the answer, so the honest design is to let them state it and to
// treat detection as nothing more than a default.
//
// Persisted (not session-scoped, as the capability verdict is) because a
// browser's inability to show a side panel does not expire when it restarts.

import { getConfig, setConfig } from "@/lib/idb/config-store";
import { publishChange } from "@/lib/store-bus";

export const PANEL_MODE_KEY = "panel_display_mode";

export type PanelMode =
  /** Use the side panel, falling back to a window if detection says it's broken. */
  | "auto"
  /** Always use a separate window — the user's override. */
  | "window";

export const DEFAULT_PANEL_MODE: PanelMode = "auto";

/**
 * Cached copy for the click path.
 *
 * `openPanel` runs inside a user gesture and must call `sidePanel.open()`
 * before its first `await`, so it cannot wait on an IDB read. The cache is
 * primed at service-worker startup and refreshed on change; an unprimed cache
 * simply means auto behaviour for that one click.
 */
let cached: PanelMode = DEFAULT_PANEL_MODE;

/** Synchronous read for gesture-bound callers. */
export function getPanelModeSync(): PanelMode {
  return cached;
}

export async function getPanelMode(): Promise<PanelMode> {
  try {
    const stored = await getConfig<PanelMode>(PANEL_MODE_KEY);
    cached = stored === "window" ? "window" : DEFAULT_PANEL_MODE;
  } catch {
    // Config store unavailable — keep whatever we had.
  }
  return cached;
}

export async function setPanelMode(mode: PanelMode): Promise<void> {
  cached = mode;
  await setConfig(PANEL_MODE_KEY, mode);
  // Cross-context notify so an open panel's settings UI and the service worker
  // converge without a reload.
  try {
    publishChange("config", "put", PANEL_MODE_KEY);
  } catch {
    /* bus unavailable (tests) — the local cache is already correct */
  }
}

/** Test seam. */
export function __setCachedPanelMode(mode: PanelMode): void {
  cached = mode;
}
