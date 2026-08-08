// Can this browser actually show an extension side panel?
//
// Arc ships the `chrome.sidePanel` API surface and does not service it. The
// failure mode is worse than an error: measured on a real install, `open()`
// RESOLVES SUCCESSFULLY and no panel is ever shown. Vivaldi is a softer version
// of the same story (the API works but ignores `tabId`).
//
// That rules out all three of the obvious detection strategies:
//
//   - presence — the namespace and every method are there;
//   - rejection — nothing rejects, so `.catch()` guards never fire;
//   - timeout  — nothing hangs either, so a race also reports success.
//
// The API's own report is simply not evidence. So `tryOpenSidePanel` measures
// the OUTCOME: after `open()` resolves it asks `chrome.runtime.getContexts`
// whether a SIDE_PANEL document is running, falling back to a liveness ping the
// panel answers on browsers without that API. The timeout race is kept too,
// since a browser that hangs still can't open a panel.
//
// Even that was not enough. On Arc both outcome checks come back positive and
// the user still sees nothing — a document is created and never shown, which no
// service-worker-side signal can distinguish from a working panel. So this
// module is a DEFAULT, not an authority: `lib/panel-host/panel-mode.ts` holds a
// persisted user preference that overrides everything here.

import { panelDocumentResponds } from "@/lib/panel-host/panel-ping";
import { getConfig, setConfig } from "@/lib/idb/config-store";

/**
 * How long to wait for `chrome.sidePanel.open()` itself to settle. Covers the
 * hang case; NOT sufficient alone — see `sidePanelDocumentAppeared`.
 */
export const SIDE_PANEL_PROBE_TIMEOUT_MS = 1500;

/**
 * How long to wait for a side panel DOCUMENT to appear after a successful
 * `open()`.
 *
 * Generous on purpose: a false "no panel" costs a healthy browser a spurious
 * popup window, so the deadline sits well past any realistic panel boot.
 */
export const SIDE_PANEL_DOCUMENT_TIMEOUT_MS = 2500;
const SIDE_PANEL_DOCUMENT_POLL_MS = 100;

const VERDICT_STORAGE_KEY = "sidepanel_support";

export type SidePanelOutcome =
  /** The browser opened the side panel. */
  | "opened"
  /** The browser refused this specific call (e.g. Chrome's user-gesture rule). */
  | "rejected"
  /** The browser cannot service side panels at all. */
  | "unsupported";

export type Verdict = "unknown" | "supported" | "unsupported";

let verdict: Verdict = "unknown";

export function getSidePanelVerdict(): Verdict {
  return verdict;
}

/** Test seam — resets the memoized verdict. */
export function __resetSidePanelVerdict(): void {
  verdict = "unknown";
}

/**
 * Adopt the verdict last measured, persisted across browser restarts.
 *
 * Kept in the config store rather than session storage: a browser's ability to
 * show a side panel is a property of the browser, not of one run of it. Storing
 * it per-session meant Chrome re-earned the click-behaviour flag after every
 * restart, and re-earning it costs the user click-to-toggle on that click.
 */
export async function loadStoredVerdict(): Promise<Verdict> {
  if (verdict !== "unknown") return verdict;
  try {
    const stored = await getConfig<string>(VERDICT_STORAGE_KEY);
    if (stored === "supported" || stored === "unsupported") verdict = stored;
  } catch {
    /* unreadable — probe on demand instead */
  }
  return verdict;
}

/**
 * Tell the browser whether to handle toolbar clicks itself.
 *
 * `openPanelOnActionClick: true` asks the BROWSER to handle toolbar clicks and,
 * as a direct consequence, SUPPRESSES `chrome.action.onClicked`. Setting it
 * unconditionally deadlocks any browser that stores the flag but can't show a
 * panel — the flag is extension-pref plumbing that works fine while the UI it
 * refers to does not exist. Clicks get swallowed by a browser that then does
 * nothing, `onClicked` never fires, and the only code that could clear the flag
 * sits behind the very click the flag is eating. So it must be EARNED.
 *
 * Fire-and-forget on purpose: on Arc this promise never settles, but the pref
 * write behind it still lands — exactly the asymmetry that created that
 * deadlock.
 */
export function applyActionClickBehavior(browserHandlesClick: boolean): void {
  try {
    void chrome.sidePanel
      ?.setPanelBehavior({ openPanelOnActionClick: browserHandlesClick })
      ?.catch(() => {});
  } catch {
    /* no sidePanel namespace — clicks reach action.onClicked by default */
  }
}

export function rememberVerdict(next: Exclude<Verdict, "unknown">): void {
  if (verdict === next) return;
  verdict = next;
  console.info(`[sw] side panel support: ${next}`);
  void setConfig(VERDICT_STORAGE_KEY, next).catch(() => {
    /* unwritable — re-probed next session, which is merely slower */
  });
  // Hand click handling to the browser only now that it has proven it can
  // service a panel; keep it ours otherwise.
  applyActionClickBehavior(next === "supported");
}

/**
 * Attempt a real side panel open, classifying the result.
 *
 * IMPORTANT: `chrome.sidePanel.open()` is invoked synchronously (before this
 * function's first `await`), because Chrome requires it to run inside the
 * trusted user-gesture chain. Callers reached from a gesture must therefore
 * call this without awaiting anything first — the quote-bubble and
 * subscribe-CTA handlers already follow that rule.
 */
export async function tryOpenSidePanel(
  target: chrome.sidePanel.OpenOptions,
): Promise<SidePanelOutcome> {
  if (verdict === "unsupported") return "unsupported";
  if (typeof chrome.sidePanel?.open !== "function") {
    rememberVerdict("unsupported");
    return "unsupported";
  }

  let attempt: Promise<void>;
  try {
    attempt = chrome.sidePanel.open(target);
  } catch {
    // Threw synchronously — a malformed target or a stub implementation.
    return "rejected";
  }

  // Once the browser has proven it services side panels, stop racing: a slow
  // machine shouldn't be able to misclassify a working browser.
  if (verdict === "supported") {
    try {
      await attempt;
      return "opened";
    } catch {
      return "rejected";
    }
  }

  const TIMED_OUT = Symbol("timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      attempt.then(() => "opened" as const),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), SIDE_PANEL_PROBE_TIMEOUT_MS);
      }),
    ]);
    if (result === TIMED_OUT) {
      rememberVerdict("unsupported");
      return "unsupported";
    }
    // `open()` resolved — which, on its own, proves nothing. Confirm against
    // the one thing that can't be faked: a running panel document.
    if (!(await sidePanelDocumentAppeared())) {
      rememberVerdict("unsupported");
      return "unsupported";
    }
    rememberVerdict("supported");
    return "opened";
  } catch {
    // A genuine rejection proves the API is wired up — it just refused THIS
    // call (Chrome's user-gesture rule is the common case). Not a browser
    // capability verdict, so leave `verdict` alone.
    return "rejected";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Did a side panel document actually come up?
 *
 * `chrome.runtime.getContexts` enumerates live extension contexts, so a
 * SIDE_PANEL entry is the panel document itself — ground truth, unlike
 * `open()`'s return value which a browser can resolve without rendering
 * anything.
 *
 * Returns true when the capability can't be measured at all: unverifiable is
 * not the same as broken, and guessing "broken" would punish a working browser
 * with a stray popup window on every click.
 */
async function sidePanelDocumentAppeared(): Promise<boolean> {
  let useContexts = typeof chrome.runtime?.getContexts === "function";
  const canPing = typeof chrome.runtime?.sendMessage === "function";

  for (let waited = 0; ; waited += SIDE_PANEL_DOCUMENT_POLL_MS) {
    if (useContexts) {
      try {
        const contexts = await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] });
        if (contexts.length > 0) return true;
      } catch {
        // Declared but not implemented — drop to the ping for the rest of the
        // poll rather than giving up on measuring altogether.
        useContexts = false;
      }
    }
    if (!useContexts) {
      if (!canPing) return true;
      // Second signal, for browsers without getContexts. Coarser (it can't tell
      // a side panel from an already-open fallback window) but it works
      // everywhere, and "some panel is on screen" is the question that matters.
      if (await panelDocumentResponds()) return true;
    }

    if (waited >= SIDE_PANEL_DOCUMENT_TIMEOUT_MS) return false;
    await new Promise((r) => setTimeout(r, SIDE_PANEL_DOCUMENT_POLL_MS));
  }
}
