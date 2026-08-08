// "Which window is the user actually browsing in?" — the one question that
// stops having an obvious answer once the panel can live outside the side
// panel.
//
// A Chrome side panel is bound to exactly one browser window, so
// `chrome.tabs.query({currentWindow: true})` from panel code resolves to the
// window the user is looking at. Two things break that assumption:
//
//   - Fallback panel (Arc): the document runs in its own popup window, so
//     `currentWindow` is that popup — whose only tab is the panel itself.
//     The window it shadows is threaded in via `?hostWindowId=`.
//
//   - Service worker: a SW has no window context at all, so `currentWindow`
//     resolves to the LAST FOCUSED window. Once a fallback panel exists the
//     user clicking it makes the panel popup last-focused, and pin capture
//     starts pinning the panel document to itself.
//
// Both are handled here so call sites stay one-liners. On plain Chrome with a
// real side panel every path collapses back to the original
// `{currentWindow: true}` query — this module is inert until a fallback panel
// is actually open.

import { HOST_WINDOW_PARAM, isOwnPanelUrl, parseHostWindowId } from "./panel-page";

// `undefined` = not yet read; `null` = read, and this context has no host
// window (real side panel, or the SW). The document URL never changes for the
// life of a document, so one read is enough.
let cachedHostWindowId: number | null | undefined;

/**
 * Host browser window id for this panel document, or null when there is none
 * (a real side panel, or any non-panel context such as the service worker).
 */
export function getHostWindowId(): number | null {
  if (cachedHostWindowId !== undefined) return cachedHostWindowId;
  cachedHostWindowId = readHostWindowId();
  return cachedHostWindowId;
}

function readHostWindowId(): number | null {
  try {
    // In a service worker `location` is the SW script URL and carries no
    // search string, so this correctly yields null without a context sniff.
    if (typeof location === "undefined" || !location.search) return null;
    return parseHostWindowId(new URLSearchParams(location.search).get(HOST_WINDOW_PARAM));
  } catch {
    return null;
  }
}

/** Test seam — clears the memoized host window id. */
export function __resetHostWindowIdCache(): void {
  cachedHostWindowId = undefined;
}

/**
 * The tab the user is looking at, resolved against the host window.
 *
 * Replaces bare `chrome.tabs.query({active: true, currentWindow: true})` at
 * every call site that means "the page the user is on" — pin capture, the pin
 * bar, the element picker, and the loop's startup-pin fallback.
 *
 * Resolution order:
 *   1. Fallback panel → query the host window explicitly.
 *   2. `currentWindow` → accepted unless it resolved to a panel document,
 *      which only happens in the SW once a fallback panel is focused.
 *   3. Last-focused *normal* window → excludes panel popups by window type.
 *
 * Never throws; returns undefined when no tab can be resolved (callers already
 * treat that as "no page", e.g. the loop's NO_PAGE_SENTINEL).
 */
export async function queryActiveHostTab(): Promise<chrome.tabs.Tab | undefined> {
  const hostWindowId = getHostWindowId();
  if (hostWindowId !== null) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, windowId: hostWindowId });
      return tab;
    } catch {
      // Host window closed out from under us — fall through to the generic
      // resolution below rather than reporting "no page".
    }
  }

  let currentWindowTab: chrome.tabs.Tab | undefined;
  try {
    [currentWindowTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    currentWindowTab = undefined;
  }
  if (currentWindowTab && !isOwnPanelUrl(currentWindowTab.url)) return currentWindowTab;

  // Either nothing came back, or `currentWindow` landed on a fallback panel
  // popup. Retry against the last-focused window that is a normal browsing
  // window — `windowTypes` filters popups out at the source.
  const normalWindowTab = await queryLastFocusedNormalWindow();
  return normalWindowTab ?? currentWindowTab;
}

/**
 * Tabs in the window the user is browsing in — the list-scoped counterpart of
 * `queryActiveHostTab`, used by the pin dropdown and `list_tabs`.
 *
 * Panel documents are always filtered out: Pie's own chrome is not a page the
 * user can pin, and it must never be offered to the LLM as a tab it may
 * close, group or move.
 */
export async function queryHostWindowTabs(): Promise<chrome.tabs.Tab[]> {
  const hostWindowId = getHostWindowId();
  if (hostWindowId !== null) {
    try {
      return excludePanelTabs(await chrome.tabs.query({ windowId: hostWindowId }));
    } catch {
      // Host window gone — fall through.
    }
  }

  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({ currentWindow: true });
  } catch {
    tabs = [];
  }
  // A window holding nothing but panel documents is a fallback panel popup,
  // not a browsing window — resolve against the last-focused normal window.
  const usable = excludePanelTabs(tabs);
  if (usable.length > 0) return usable;

  const normalWindowTab = await queryLastFocusedNormalWindow();
  if (typeof normalWindowTab?.windowId === "number") {
    try {
      return excludePanelTabs(await chrome.tabs.query({ windowId: normalWindowTab.windowId }));
    } catch {
      // fall through
    }
  }
  return usable;
}

/** Drop Pie's own panel documents from a tab list. */
export function excludePanelTabs(tabs: chrome.tabs.Tab[]): chrome.tabs.Tab[] {
  return tabs.filter((t) => !isOwnPanelUrl(t.url));
}

async function queryLastFocusedNormalWindow(): Promise<chrome.tabs.Tab | undefined> {
  try {
    // chrome.windows is absent in some test contexts; optional-chain rather
    // than assume the namespace exists.
    const win = await chrome.windows?.getLastFocused({ windowTypes: ["normal"] });
    if (typeof win?.id !== "number") return undefined;
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    return tab;
  } catch {
    return undefined;
  }
}
