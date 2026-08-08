// Panel-document identity helpers — shared by the SW, the agent tools and the
// panel itself.
//
// Pie's UI normally lives in Chrome's side panel. On browsers that ship the
// `chrome.sidePanel` API surface but never actually service it (Arc is the
// motivating case — its calls hang rather than reject), the SW opens the SAME
// document in a detached popup window instead. That fallback introduces two
// new facts the rest of the codebase has to reason about:
//
//   1. The panel document now occupies a real tab in a real window, so it can
//      show up in chrome.tabs.query results and be mistaken for "the page the
//      user is looking at" (pin capture) or offered to the LLM as a tab it may
//      close/group (tab tools). Both are wrong — the panel is chrome, not
//      content. `isOwnPanelUrl` is the single predicate that filters it out.
//
//   2. That window is NOT the window the user is browsing in, so the panel
//      needs to be told which window it is shadowing. The id is threaded
//      through the document URL (see `buildFallbackPanelUrl`) and read back by
//      `host-window.ts`.
//
// Keeping both concerns keyed off one path constant means a rename of the
// panel entry point can't silently desync the predicate from the real URL.

/** Panel document path — must match manifest.json `side_panel.default_path`. */
export const PANEL_PAGE_PATH = "src/sidepanel/index.html";

/** Query param carrying the host browser window id into a fallback panel. */
export const HOST_WINDOW_PARAM = "hostWindowId";

/** Absolute `chrome-extension://<id>/…` URL of the panel document. */
export function panelPageBaseUrl(): string {
  return chrome.runtime.getURL(PANEL_PAGE_PATH);
}

/**
 * URL for a fallback panel window shadowing `hostWindowId`.
 *
 * The id lives in the URL rather than in storage because the panel document
 * needs it during its first render (before any async read could land) and
 * because it must survive an SW restart without a handshake.
 */
export function buildFallbackPanelUrl(hostWindowId: number): string {
  return `${panelPageBaseUrl()}?${HOST_WINDOW_PARAM}=${hostWindowId}`;
}

/**
 * True when `url` is Pie's own panel document (side panel or fallback window).
 *
 * Prefix match, not equality: the fallback form carries a `?hostWindowId=`
 * query string.
 */
export function isOwnPanelUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return url.startsWith(panelPageBaseUrl());
  } catch {
    // chrome.runtime unavailable (non-extension context) — nothing to match.
    return false;
  }
}

/**
 * Host window id encoded in a fallback panel URL, or null when `url` is not a
 * fallback panel (a real side panel carries no query string).
 */
export function hostWindowIdFromPanelUrl(url: string | null | undefined): number | null {
  if (!isOwnPanelUrl(url)) return null;
  try {
    return parseHostWindowId(new URL(url as string).searchParams.get(HOST_WINDOW_PARAM));
  } catch {
    return null;
  }
}

/**
 * Parse a host-window-id query value. Rejects anything that isn't a
 * non-negative integer so a malformed URL degrades to "no host window"
 * (= current-window semantics) instead of poisoning every tabs.query with
 * `windowId: NaN`.
 */
export function parseHostWindowId(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}
