import { useEffect, useState } from "react";
import { queryActiveHostTab } from "@/lib/panel-host/host-window";

/**
 * Pin-display subsystem, extracted verbatim from Chat.tsx so the pin sub-row in
 * the contextual TopBar and the (removed) Chat pin bar share one source of
 * truth. Owns the live-preview + locked-title chrome.tabs listeners and derives
 * the human-readable display label.
 *
 * Contract (unchanged from Chat's inline version):
 *   - 'auto' (or null pinMode) + not streaming → live-track the currently-active
 *     tab; the label follows the user's tab-switching.
 *   - 'task' / 'user' mode, or streaming → frozen to the persisted pin (first
 *     entry of pinnedTabs[]), title fetched from chrome.tabs.get.
 */
export interface UsePinDisplayArgs {
  pinnedTabs: ReadonlyArray<{ tabId: number; origin: string }> | null;
  pinMode: "auto" | "task" | "user" | null;
  streaming: boolean;
}

export interface UsePinDisplayResult {
  displayPinnedOrigin: string | null;
  isLocked: boolean;
}

const PIN_LABEL_MAX_LEN = 60;

function truncate(s: string): string {
  return s.length > PIN_LABEL_MAX_LEN ? s.slice(0, PIN_LABEL_MAX_LEN - 1) + "…" : s;
}

export function extractOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.host) return null;
    const path = u.pathname.length > 1 ? u.pathname : "";
    return `${u.host}${path}`;
  } catch {
    return null;
  }
}

/**
 * Strip the scheme from a URL.origin string (e.g. "https://docs.google.com")
 * to host-only, matching the format extractOrigin returns for the live
 * preview. Returns null when the input does not parse cleanly; the caller
 * falls back to the raw string.
 */
export function extractHost(originUrl: string): string | null {
  try {
    const u = new URL(originUrl);
    if (!u.host) return null;
    return u.host;
  } catch {
    return null;
  }
}

export function usePinDisplay({
  pinnedTabs,
  pinMode,
  streaming,
}: UsePinDisplayArgs): UsePinDisplayResult {
  // Primary pin is the first entry (oldest / chat-start anchor).
  const sessionPinnedOrigin = pinnedTabs?.[0]?.origin ?? null;
  const sessionPinnedTabId = pinnedTabs?.[0]?.tabId ?? null;

  // Live preview of the user's currently-active tab origin + title (auto mode).
  const [livePinnedOrigin, setLivePinnedOrigin] = useState<string | null>(null);
  const [livePinnedTitle, setLivePinnedTitle] = useState<string | null>(null);
  // Locked pin's title (task / user mode), read from chrome.tabs.get.
  const [lockedPinnedTitle, setLockedPinnedTitle] = useState<string | null>(null);

  // Streaming forces locked regardless of mode (defensive — there's always a
  // task pin while streaming, and we don't want the UI to re-render mid-task as
  // the user tab-switches).
  const isLocked = streaming || (pinMode !== null && pinMode !== "auto");

  useEffect(() => {
    if (isLocked) {
      // No live tracking when locked — the displayed pin comes from
      // sessionPinnedOrigin (session meta). Skip the chrome.tabs listeners.
      return;
    }
    async function refreshLive() {
      try {
        const tab = await queryActiveHostTab();
        setLivePinnedOrigin(tab?.url ? extractOrigin(tab.url) : null);
        setLivePinnedTitle(tab?.title ? tab.title : null);
      } catch {
        // non-fatal — keep prior value
      }
    }

    void refreshLive();

    const onActivated = () => {
      void refreshLive();
    };
    const onUpdated = (
      _tabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (tab.active && (changeInfo.url || changeInfo.title)) {
        void refreshLive();
      }
    };
    const onFocusChanged = (winId: number) => {
      if (winId === chrome.windows.WINDOW_ID_NONE) return;
      void refreshLive();
    };

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.windows.onFocusChanged.addListener(onFocusChanged);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.windows.onFocusChanged.removeListener(onFocusChanged);
    };
  }, [isLocked]);

  // Locked-mode title fetcher — reads the pinned tab's current title and
  // refreshes on the pinned tab's title/url change.
  useEffect(() => {
    if (!isLocked) {
      setLockedPinnedTitle(null);
      return;
    }
    if (sessionPinnedTabId === null) {
      setLockedPinnedTitle(null);
      return;
    }
    const targetTabId = sessionPinnedTabId;
    let cancelled = false;
    async function fetchTitle() {
      try {
        const tab = await chrome.tabs.get(targetTabId);
        if (cancelled) return;
        setLockedPinnedTitle(tab.title ?? null);
      } catch {
        if (cancelled) return;
        setLockedPinnedTitle(null);
      }
    }
    void fetchTitle();
    const onUpdated = (
      tabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (tabId !== targetTabId) return;
      if (changeInfo.title || changeInfo.url) {
        setLockedPinnedTitle(tab.title ?? null);
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      cancelled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [isLocked, sessionPinnedTabId]);

  // Display label — prefer tab title for human readability; fall back to host
  // (extracted from origin) when title is unavailable. Locked vs free state
  // pick from different sources but same fallback chain.
  const displayPinnedOrigin = (() => {
    if (isLocked) {
      if (lockedPinnedTitle) return truncate(lockedPinnedTitle);
      if (sessionPinnedOrigin)
        return extractHost(sessionPinnedOrigin) ?? sessionPinnedOrigin;
      // #231 — restricted-page pin (empty origin) whose title is unavailable
      // (tab closed / inaccessible). Keep the row mounted.
      if (sessionPinnedTabId !== null) return `#${sessionPinnedTabId}`;
      return null;
    }
    if (livePinnedTitle) return truncate(livePinnedTitle);
    if (livePinnedOrigin) return extractHost(livePinnedOrigin) ?? livePinnedOrigin;
    return null;
  })();

  return { displayPinnedOrigin, isLocked };
}
