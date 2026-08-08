// Opening Pie's panel, on browsers that service `chrome.sidePanel` and on
// browsers that only pretend to.
//
// Arc ships the `chrome.sidePanel` API surface and does not service it. The
// failure mode is worse than an error: measured on Arc, `open()` RESOLVES
// SUCCESSFULLY and no panel is ever shown. Vivaldi is a softer version of the
// same story (the API works but ignores `tabId`).
//
// That rules out all three of the obvious detection strategies:
//
//   - presence — the namespace and every method are there;
//   - rejection — nothing rejects, so `.catch()` guards never fire;
//   - timeout  — nothing hangs either, so a race also reports success.
//
// The API's own report is simply not evidence. So `tryOpenSidePanel` measures
// the OUTCOME instead: after `open()` resolves it asks
// `chrome.runtime.getContexts` whether a SIDE_PANEL document is actually
// running, and falls back to a liveness ping the panel answers on browsers
// without that API. The timeout race is kept too, since a browser that hangs
// is still a browser that can't open a panel.
//
// Even that was not enough. Measured on Arc, both outcome checks come back
// positive and the user still sees nothing — so a document is created and
// never shown, which no service-worker-side signal can distinguish from a
// working panel. Detection is therefore a DEFAULT, not an authority:
// `lib/panel-host/panel-mode.ts` holds a persisted user preference that
// overrides it outright, reachable from Settings and from the right-click
// entry point, and `forceFallbackPanel` writes it.
//
// When the fallback is used, the same panel document is opened in a detached
// popup window (`host-window.ts` teaches the panel which window it is
// shadowing), escalating to a normal window and then a tab if that produces
// nothing.
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
import { panelDocumentResponds } from "@/lib/panel-host/panel-ping";
import {
  getPanelMode,
  getPanelModeSync,
  PANEL_MODE_KEY,
  setPanelMode,
} from "@/lib/panel-host/panel-mode";
import { onStoreChange } from "@/lib/store-bus";

/**
 * How long to wait for `chrome.sidePanel.open()` itself to settle. Covers the
 * hang case; it is NOT sufficient on its own — see `sidePanelDocumentAppeared`.
 */
export const SIDE_PANEL_PROBE_TIMEOUT_MS = 1500;

/**
 * How long to wait for a side panel DOCUMENT to actually show up after a
 * successful `open()`.
 *
 * Needed because `open()` resolving proves nothing: on Arc it resolves happily
 * and no panel ever appears. The only trustworthy signal is whether a
 * SIDE_PANEL extension context exists afterwards — that is the panel document
 * itself, not a promise the browser chose to settle.
 *
 * Generous on purpose: a false "no panel" here costs a Chrome user a spurious
 * popup window, so the deadline is set well past any realistic panel boot.
 */
export const SIDE_PANEL_DOCUMENT_TIMEOUT_MS = 2500;
const SIDE_PANEL_DOCUMENT_POLL_MS = 100;

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

/**
 * Where to open the panel, as a hint rather than a requirement.
 *
 * Deliberately looser than `chrome.sidePanel.OpenOptions`, which demands at
 * least one of tabId/windowId: the fallback path can always resolve a host
 * window on its own (last-focused normal window), so the manual escape hatch
 * must be callable with nothing at all.
 */
type PanelTarget = { tabId?: number; windowId?: number };

let verdict: Verdict = "unknown";

/**
 * Wire up panel opening at service-worker startup.
 *
 * The ordering here is the whole fix, so it is worth stating plainly:
 *
 *   `openPanelOnActionClick: true` asks the BROWSER to handle toolbar clicks
 *   and, as a direct consequence, SUPPRESSES `chrome.action.onClicked`.
 *
 * Setting that flag unconditionally (as this file first did) deadlocks any
 * browser that stores the flag but can't actually show a panel — which is what
 * Arc does, because the flag is extension-pref plumbing that works fine while
 * the panel UI it refers to does not exist. Clicks get swallowed by a browser
 * that then does nothing, `onClicked` never fires, the capability probe never
 * runs, and the only code that could clear the flag sits behind the very click
 * that the flag is eating.
 *
 * So the flag is now EARNED, not assumed: it goes on only after a real
 * `sidePanel.open()` has been observed to succeed. Until then clicks route
 * through `action.onClicked` → `openPanel`, which works on every browser —
 * `action.onClicked` is a trusted user gesture for `sidePanel.open`, so Chrome
 * opens normally on that path too.
 *
 * The explicit `false` on startup also un-sticks installs that ran the earlier
 * build and had `true` persisted into their extension prefs.
 */
/** Context-menu id for the manual "pop Pie out" entry. */
const FALLBACK_MENU_ID = "pie-open-panel-window";

/**
 * Register the right-click entry point.
 *
 * The keyboard command that does the same thing needs a hotkey bound at
 * chrome://extensions/shortcuts — a page a browser with its own custom UI may
 * not even expose, which makes it useless as a rescue path on exactly the
 * browsers that need rescuing. A context-menu item needs no setup and no
 * toolbar, so it works even if the panel can't be opened to reach a setting.
 *
 * Offered everywhere rather than only when the side panel is known broken:
 * gating it on the capability verdict would hide it in precisely the case
 * where detection is wrong, which is the case it exists for. On a healthy
 * browser it is simply a way to pop the panel out into its own window.
 */
export function installPanelContextMenu(): void {
  try {
    chrome.contextMenus?.removeAll(() => {
      // Swallow "duplicate id" if two startup paths race.
      void chrome.runtime.lastError;
      chrome.contextMenus.create(
        {
          id: FALLBACK_MENU_ID,
          title: "Open Pie in a separate window",
          contexts: ["all"],
        },
        () => void chrome.runtime.lastError,
      );
    });
  } catch {
    /* contextMenus unavailable — the toolbar and command paths remain */
  }
}

/** Handle a click on the context-menu entry. Returns false if it wasn't ours. */
export function handlePanelContextMenuClick(menuItemId: string, tab?: chrome.tabs.Tab): boolean {
  if (menuItemId !== FALLBACK_MENU_ID) return false;
  void forceFallbackPanel(
    typeof tab?.windowId === "number" ? { windowId: tab.windowId } : {},
  ).catch((e) => console.warn("[sw] context-menu panel open failed:", e));
  return true;
}

export function initPanelOpening(): void {
  applyActionClickBehavior(false);
  installPanelContextMenu();
  // Prime the panel-mode cache so the click path can read it synchronously.
  void getPanelMode().catch(() => {
    /* keep the auto default */
  });
  onStoreChange("config", (c) => {
    if (c.id === PANEL_MODE_KEY) void getPanelMode().catch(() => {});
  });
  try {
    void chrome.storage.session
      ?.get(VERDICT_STORAGE_KEY)
      .then((rec) => {
        const stored = rec?.[VERDICT_STORAGE_KEY];
        if (verdict !== "unknown") return;
        if (stored === "supported") {
          verdict = "supported";
          // Proven working earlier this browser session — restore the browser's
          // native click handling (which also restores click-to-toggle).
          applyActionClickBehavior(true);
        } else if (stored === "unsupported") {
          verdict = "unsupported";
        }
      })
      .catch(() => {
        /* session storage unavailable — probe on demand instead */
      });
  } catch {
    /* ignore */
  }
}

/**
 * Tell the browser whether to handle toolbar clicks itself.
 *
 * Fire-and-forget on purpose: on Arc this promise never settles, but the pref
 * write behind it still lands — which is exactly the asymmetry that created the
 * deadlock this function exists to avoid.
 */
function applyActionClickBehavior(browserHandlesClick: boolean): void {
  try {
    void chrome.sidePanel
      ?.setPanelBehavior({ openPanelOnActionClick: browserHandlesClick })
      ?.catch(() => {});
  } catch {
    /* no sidePanel namespace — clicks reach action.onClicked by default */
  }
}

function rememberVerdict(next: Exclude<Verdict, "unknown">): void {
  if (verdict === next) return;
  verdict = next;
  console.info(`[sw] side panel support: ${next}`);
  try {
    void chrome.storage.session?.set({ [VERDICT_STORAGE_KEY]: next }).catch(() => {});
  } catch {
    /* ignore */
  }
  // Hand click handling to the browser only now that it has proven it can
  // service a panel; keep it ours otherwise.
  applyActionClickBehavior(next === "supported");
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
    // `open()` resolved — which, on its own, proves nothing. Arc resolves it
    // and shows no panel. Confirm against the one thing that can't be faked:
    // whether a side panel document is actually running.
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
 * SIDE_PANEL entry is the panel document itself — ground truth, as opposed to
 * `open()`'s return value which a browser can resolve without rendering
 * anything (Arc does exactly that).
 *
 * Returns true when the capability can't be measured at all (no getContexts,
 * or it throws): unverifiable is not the same as broken, and guessing "broken"
 * would punish a working browser with a stray popup window.
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
      // Nothing left to measure with. Unverifiable is not the same as broken,
      // and guessing "broken" would saddle a perfectly good browser with a
      // stray popup window on every click.
      if (!canPing) return true;
      // Second signal, for browsers without getContexts at all. Coarser (it
      // can't tell a side panel from an already-open fallback window) but it
      // works everywhere, and "some panel is on screen" is the question that
      // actually matters here.
      if (await panelDocumentResponds()) return true;
    }

    if (waited >= SIDE_PANEL_DOCUMENT_TIMEOUT_MS) return false;
    await new Promise((r) => setTimeout(r, SIDE_PANEL_DOCUMENT_POLL_MS));
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
 * Manual escape hatch: open the fallback window unconditionally and record
 * that this browser has no usable side panel.
 *
 * Auto-detection measures the outcome rather than trusting the API, but a
 * browser that reports a live SIDE_PANEL context while rendering nothing would
 * still slip through — and there is no further signal left to check. So the
 * user gets a switch. Because it also pins the verdict to "unsupported", one
 * use is enough: ordinary toolbar clicks route to the fallback from then on.
 */
export async function forceFallbackPanel(target: PanelTarget): Promise<void> {
  rememberVerdict("unsupported");
  // Persist the choice. The session-scoped verdict above dies with the browser
  // session, and a browser that can't show a side panel today can't show one
  // tomorrow either — making the user re-discover the workaround after every
  // restart would be the actual bug.
  await setPanelMode("window").catch((e) => {
    console.warn("[sw] could not persist the panel display mode:", e);
  });
  await openFallbackPanelWindow(target);
}

/**
 * Open (or re-focus) the fallback panel window shadowing `target`'s window.
 *
 * One panel window per browser window, mirroring the side panel it stands in
 * for. Re-focusing an existing one is what makes a second toolbar click feel
 * like a toggle instead of spawning a second panel.
 */
export async function openFallbackPanelWindow(target: PanelTarget): Promise<void> {
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

  const url = buildFallbackPanelUrl(hostWindowId);
  const bounds = await hostWindowBounds(hostWindowId);

  // Escalating strategies, each verified by looking for the panel tab
  // afterwards rather than by trusting the call that created it — the same
  // lesson the side-panel probe had to learn. A browser that resolves
  // windows.create without surfacing a window is not hypothetical: Arc has no
  // Chrome-style popup windows in its UI model, so `type: "popup"` is a prime
  // suspect for being accepted and quietly dropped.
  //
  // Ordered best-UX-first. A popup window sits beside the page it drives; a
  // normal window at least floats free; a tab works everywhere but can't be
  // seen next to the page. All three keep the port — and any running task —
  // alive, which is the property that rules out an action popup entirely.
  const strategies: Array<{ name: string; run: () => Promise<unknown> }> = [
    { name: "popup window", run: () => chrome.windows.create({ url, type: "popup", focused: true, ...bounds }) },
    { name: "normal window", run: () => chrome.windows.create({ url, type: "normal", focused: true, ...bounds }) },
    { name: "tab", run: () => chrome.tabs.create({ url }) },
  ];

  for (const { name, run } of strategies) {
    try {
      await run();
    } catch (e) {
      console.warn(`[sw] fallback panel via ${name} threw:`, e);
      continue;
    }
    if (await panelTabExists(url)) {
      console.info(`[sw] opened fallback panel via ${name} for host window ${hostWindowId}`);
      return;
    }
    console.warn(`[sw] fallback panel via ${name} reported success but no panel tab appeared`);
  }
  console.error("[sw] every fallback panel strategy failed — the panel could not be opened");
}

/**
 * Did the panel document actually land somewhere reachable?
 *
 * Looks for a real tab carrying the panel URL. A tab is browser-side state the
 * create call can't fabricate, so this catches the "resolved but nothing
 * appeared" failure that plain error handling walks straight past.
 */
async function panelTabExists(url: string): Promise<boolean> {
  try {
    const tabs = await chrome.tabs.query({});
    return tabs.some((t) => t.url === url || t.pendingUrl === url);
  } catch {
    // Can't tell — assume it worked rather than spawning duplicates.
    return true;
  }
}

/**
 * Which browser window is this open FOR? `sidePanel.open` accepts either a tab
 * or a window; the fallback always needs a window id.
 */
async function resolveHostWindowId(target: PanelTarget): Promise<number | null> {
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

async function resolveTargetWindowId(target: PanelTarget): Promise<number | null> {
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
