// Issue #231 follow-up — shared active-tab pin capture (panel + SW).
//
// Single source of truth for "what pin does a chat-start capture from the
// active tab", mirroring the loop's resolveStartupPin contract (loop.ts):
//
//   - Operable tab (real id, non-restricted, resolvable origin)
//       → { tabId, origin }
//   - file://*.pdf → { tabId, origin: full URL } (sealed PDF viewer: the URL
//     itself is the pin identity, mirrors isFilePdfUrl handling elsewhere)
//   - Restricted / unresolvable-origin tab that still has a real id
//     (chrome://, new-tab page, settings, …)
//       → { tabId, origin: "" } — a LEGITIMATE pin. #231 removed the loop's
//         start-time hard stop for these pages; this capture must persist the
//         pin too, or the pin bar has nothing to show while streaming and R7
//         cross-session locking never sees the tab. interpretPinnedTabUrl
//         checks isRestrictedUrl before comparing origins, so the empty
//         origin is never consulted on the restricted branch.
//   - No active tab at all (or query throws) → null (loop falls back to
//     NO_PAGE_SENTINEL internally; nothing to persist).
//
// Replaces the two near-identical private copies that drifted after #231
// (panel useSession captureActivePinned + SW captureSwActivePinned — both
// still returned null for restricted URLs).

import { isRestrictedUrl } from "@/lib/url/restricted";
import { isFilePdfUrl } from "@/lib/pdf/detect";

export async function captureActivePinnedTab(): Promise<{
  tabId: number;
  origin: string;
} | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) return null;
    // Chrome can return tab.id === -1 for session-restore / detached tabs;
    // chrome.tabs.get(-1) throws synchronously downstream. Only pin real,
    // addressable tabs.
    if (!Number.isInteger(tab.id) || tab.id < 0) return null;
    if (isFilePdfUrl(tab.url)) {
      return { tabId: tab.id, origin: tab.url };
    }
    if (isRestrictedUrl(tab.url)) {
      return { tabId: tab.id, origin: "" };
    }
    let origin: string;
    try {
      origin = new URL(tab.url).origin;
    } catch {
      return { tabId: tab.id, origin: "" };
    }
    if (!origin || origin === "null") return { tabId: tab.id, origin: "" };
    return { tabId: tab.id, origin };
  } catch {
    return null;
  }
}
