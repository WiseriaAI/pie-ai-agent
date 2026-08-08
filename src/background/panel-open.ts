// Opening Pie's panel, on browsers that service `chrome.sidePanel` and on
// browsers that only pretend to.
//
// Arc ships the `chrome.sidePanel` API surface but never services the calls:
// `open()` returns a promise that neither resolves nor rejects. Every existing
// call site guarded itself with `.catch()`, which a promise that never settles
// walks straight past — so clicking Pie's toolbar icon did nothing at all, with
// no error anywhere. Vivaldi is a softer version of the same story (the API
// works but ignores `tabId`).
//
// So support cannot be feature-detected by presence, and failure cannot be
// detected by rejection. It has to be detected by TIMEOUT, which is what
// `tryOpenSidePanel` does. When the probe says the browser can't service a side
// panel, the same panel document is opened in a detached popup window instead
// (`host-window.ts` teaches the panel which window it is shadowing).
//
// Why a detached popup window and not an action popup: the panel's port is the
// agent loop's lifeline — `port.onDisconnect` aborts the running task by design
// (see index.ts). An action popup closes on every focus loss, so the agent
// would abort itself the moment it clicked anything on the page. A popup window
// keeps focus independently, so the port — and the task — survive.
//
// Why not a content-script iframe: it would need the panel document in
// `web_accessible_resources` under `<all_urls>` (any site could then frame it),
// and content scripts don't run on chrome://, the Web Store or the PDF viewer —
// exactly the restricted pages #231 taught the loop to work on. The panel would
// vanish where it currently works.

import {
  buildFallbackPanelUrl,
  hostWindowIdFromPanelUrl,
  isOwnPanelUrl,
} from "@/lib/panel-host/panel-page";

/**
 * How long to wait for `chrome.sidePanel.open()` before declaring the browser
 * incapable. Generous enough that a busy-but-working browser is never
 * misdiagnosed, short enough that a user on Arc doesn't sit staring at a dead
 * toolbar icon. Paid once per service-worker lifetime — the verdict is
 * memoized (and mirrored into session storage) after the first probe.
 */
export const SIDE_PANEL_PROBE_TIMEOUT_MS = 1500;

/** Default geometry for the fallback panel window, in CSS px. */
const FALLBACK_PANEL_WIDTH = 460;
const FALLBACK_PANEL_MIN_HEIGHT = 600;

const VERDICT_STORAGE_KEY = "sidepanel_support";

export type SidePanelOutcome =
  /** The browser opened the side panel. */
  | "opened"
  /** The browser refused this specific call (e.g. Chrome's user-gesture rule). */
  | "rejected"
  /** The browser cannot service side panels at all. */
  | "unsupported";

type Verdict = "unknown" | "supported" | "unsupported";

let verdict: Verdict = "unknown";

/**
 * Rehydrate the memoized verdict after an SW restart so returning users don't
 * re-pay the probe timeout on their first click. Fire-and-forget: a miss just
 * means one more probe.
 */
export function hydrateSidePanelVerdict(): void {
  try {
    void chrome.storage.session
      ?.get(VERDICT_STORAGE_KEY)
      .then((rec) => {
        const stored = rec?.[VERDICT_STORAGE_KEY];
        if (verdict === "unknown" && (stored === "supported" || stored === "unsupported")) {
          verdict = stored;
        }
      })
      .catch(() => {
        /* session storage unavailable — probe on demand instead */
      });
  } catch {
    /* ignore */
  }
}

function rememberVerdict(next: Exclude<Verdict, "unknown">): void {
  if (verdict === next) return;
  verdict = next;
  try {
    void chrome.storage.session?.set({ [VERDICT_STORAGE_KEY]: next }).catch(() => {});
  } catch {
    /* ignore */
  }
  if (next === "unsupported") {
    // `openPanelOnActionClick: true` tells the browser to handle icon clicks
    // itself and suppress `action.onClicked`. On a browser that can't open a
    // side panel that would swallow the click entirely, leaving no entry point
    // for the fallback. Hand the click back to us.
    try {
      void chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: false })?.catch(() => {});
    } catch {
      /* ignore */
    }
  }
}

/** Test seam — resets the memoized verdict. */
export function __resetSidePanelVerdict(): void {
  verdict = "unknown";
}

/**
 * Attempt a real side panel open, classifying the result.
 *
 * IMPORTANT: `chrome.sidePanel.open()` is invoked synchronously (before this
 * function's first `await`), because Chrome requires it to run inside the
 * trusted user-gesture chain. Callers reached from a gesture must therefore
 * call this without awaiting anything first — the existing quote-bubble and
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
 * Open Pie's panel for `target`, falling back to a detached popup window on
 * browsers that can't service side panels.
 *
 * Fire-and-forget by design: every caller is an event handler that must not
 * block on panel chrome. A `rejected` outcome is left alone — that is Chrome
 * telling us this particular call lacked a user gesture, and the historical
 * behaviour (warn, do nothing) is still correct.
 */
export function openPanel(target: chrome.sidePanel.OpenOptions, context: string): void {
  void tryOpenSidePanel(target)
    .then(async (outcome) => {
      if (outcome === "opened") return;
      if (outcome === "rejected") {
        console.warn(`[sw] sidePanel.open (${context}) was rejected by the browser`);
        return;
      }
      await openFallbackPanelWindow(target);
    })
    .catch((e) => {
      console.warn(`[sw] openPanel (${context}) failed:`, e);
    });
}

/**
 * Open (or re-focus) the fallback panel window shadowing `target`'s window.
 *
 * One panel window per browser window, mirroring the side panel it stands in
 * for. Re-focusing an existing one is what makes a second toolbar click feel
 * like a toggle instead of spawning a second panel.
 */
export async function openFallbackPanelWindow(
  target: chrome.sidePanel.OpenOptions,
): Promise<void> {
  const hostWindowId = await resolveHostWindowId(target);
  if (hostWindowId === null) return;

  const existing = await findFallbackPanelWindow(hostWindowId);
  if (existing !== null) {
    try {
      await chrome.windows.update(existing, { focused: true, drawAttention: true });
      return;
    } catch {
      // Window vanished between lookup and update — fall through and create.
    }
  }

  const bounds = await hostWindowBounds(hostWindowId);
  await chrome.windows.create({
    url: buildFallbackPanelUrl(hostWindowId),
    type: "popup",
    focused: true,
    ...bounds,
  });
}

/**
 * Which browser window is this open FOR? `sidePanel.open` accepts either a tab
 * or a window; the fallback always needs a window id.
 */
async function resolveHostWindowId(
  target: chrome.sidePanel.OpenOptions,
): Promise<number | null> {
  const candidate = await resolveTargetWindowId(target);
  // A panel window must never shadow another panel window. That happens when
  // the trigger resolved its window from SW context (`windows.getCurrent`
  // returns the last-focused window) while the user had a fallback panel
  // focused — without this check, clicking inside the panel would spawn a
  // panel-of-a-panel.
  if (candidate !== null && !(await isFallbackPanelWindow(candidate))) return candidate;
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    return typeof win?.id === "number" ? win.id : null;
  } catch {
    return candidate;
  }
}

async function resolveTargetWindowId(
  target: chrome.sidePanel.OpenOptions,
): Promise<number | null> {
  if (typeof target.windowId === "number") return target.windowId;
  if (typeof target.tabId === "number") {
    try {
      const tab = await chrome.tabs.get(target.tabId);
      if (typeof tab.windowId === "number") return tab.windowId;
    } catch {
      // Tab closed already — let the caller fall back.
    }
  }
  return null;
}

/** True when every tab in `windowId` is a Pie panel document. */
async function isFallbackPanelWindow(windowId: number): Promise<boolean> {
  try {
    const tabs = await chrome.tabs.query({ windowId });
    return tabs.length > 0 && tabs.every((t) => isOwnPanelUrl(t.url));
  } catch {
    return false;
  }
}

/**
 * Find an open fallback panel window for `hostWindowId`.
 *
 * Derived from live tab state rather than an in-memory registry so it survives
 * a service-worker restart — the panel window outlives the SW that spawned it.
 */
async function findFallbackPanelWindow(hostWindowId: number): Promise<number | null> {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!isOwnPanelUrl(tab.url)) continue;
      if (hostWindowIdFromPanelUrl(tab.url) !== hostWindowId) continue;
      if (typeof tab.windowId === "number" && tab.windowId >= 0) return tab.windowId;
    }
  } catch {
    /* fall through — worst case we open a second panel */
  }
  return null;
}

/**
 * Dock the panel window against the right edge of the window it shadows, so it
 * reads as that window's side panel rather than a stray popup. Falls back to
 * letting the browser place it when the host bounds can't be read.
 */
async function hostWindowBounds(
  hostWindowId: number,
): Promise<{ left?: number; top?: number; width?: number; height?: number }> {
  try {
    const host = await chrome.windows.get(hostWindowId);
    if (
      typeof host.left !== "number" ||
      typeof host.top !== "number" ||
      typeof host.width !== "number" ||
      typeof host.height !== "number"
    ) {
      return { width: FALLBACK_PANEL_WIDTH, height: FALLBACK_PANEL_MIN_HEIGHT };
    }
    return {
      left: host.left + host.width,
      top: host.top,
      width: FALLBACK_PANEL_WIDTH,
      height: Math.max(host.height, FALLBACK_PANEL_MIN_HEIGHT),
    };
  } catch {
    return { width: FALLBACK_PANEL_WIDTH, height: FALLBACK_PANEL_MIN_HEIGHT };
  }
}

/**
 * Close fallback panel windows whose host window is gone.
 *
 * Without this a closed browser window leaves an orphaned panel behind, still
 * holding a live port and still resolving `queryActiveHostTab` against a
 * window id that no longer exists.
 */
export async function closeOrphanedFallbackPanels(removedWindowId: number): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!isOwnPanelUrl(tab.url)) continue;
      if (hostWindowIdFromPanelUrl(tab.url) !== removedWindowId) continue;
      if (typeof tab.windowId !== "number" || tab.windowId < 0) continue;
      await chrome.windows.remove(tab.windowId).catch(() => {});
    }
  } catch {
    /* non-fatal */
  }
}
