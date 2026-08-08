// The panel, opened somewhere other than the side panel.
//
// Why a detached popup window and not an action popup: the panel's port is the
// agent loop's lifeline — `port.onDisconnect` aborts the running task by design
// (see background/index.ts). An action popup closes on every focus loss, so the
// agent would abort itself the moment it clicked anything on the page. A popup
// window keeps focus independently, so the port — and the task — survive.
//
// Why not a content-script iframe: it would need the panel document in
// `web_accessible_resources` under `<all_urls>` (any site could then frame it),
// and content scripts don't run on chrome://, the Web Store or the PDF viewer —
// exactly the restricted pages #231 taught the loop to work on. The panel would
// vanish where it currently works.

import { buildFallbackPanelUrl, hostWindowIdFromPanelUrl, isOwnPanelUrl } from "@/lib/panel-host/panel-page";

/** Default geometry for the fallback panel window, in CSS px. */
const FALLBACK_PANEL_WIDTH = 460;
const FALLBACK_PANEL_MIN_HEIGHT = 600;

/**
 * Where to open the panel, as a hint rather than a requirement.
 *
 * Deliberately looser than `chrome.sidePanel.OpenOptions`, which demands at
 * least one of tabId/windowId: this path can always resolve a host window on
 * its own (last-focused normal window), so the manual escape hatch must be
 * callable with nothing at all.
 */
export type PanelTarget = { tabId?: number; windowId?: number };

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
  // Chrome-style popup windows in its UI model.
  //
  // Ordered best-UX-first. A popup window sits beside the page it drives; a
  // normal window at least floats free; a tab works everywhere but can't be
  // seen next to the page. All three keep the port — and any running task —
  // alive, which is the property that rules out an action popup entirely.
  const strategies: Array<{ name: string; run: () => Promise<unknown> }> = [
    {
      name: "popup window",
      run: () => chrome.windows.create({ url, type: "popup", focused: true, ...bounds }),
    },
    {
      name: "normal window",
      run: () => chrome.windows.create({ url, type: "normal", focused: true, ...bounds }),
    },
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
 * holding a live port and still resolving `queryActiveHostTab` against a window
 * id that no longer exists.
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
