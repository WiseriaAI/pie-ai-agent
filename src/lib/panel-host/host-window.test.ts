// "Which window is the user browsing in?" — resolution across the three
// contexts the panel document can run in.
//
// The regression these guard against: with a fallback panel window open, a bare
// `{active: true, currentWindow: true}` resolves to the panel's own popup, so
// pin capture pins Pie to itself and the pin bar shows the extension URL.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  __resetHostWindowIdCache,
  excludePanelTabs,
  getHostWindowId,
  queryActiveHostTab,
  queryHostWindowTabs,
} from "./host-window";
import { PANEL_PAGE_PATH } from "./panel-page";

const PANEL_URL = `chrome-extension://test/${PANEL_PAGE_PATH}`;

type Q = chrome.tabs.QueryInfo;
type FakeTab = { id: number; url: string; windowId: number; active?: boolean };

const g = globalThis as unknown as {
  chrome: {
    tabs: { query: ReturnType<typeof vi.fn> };
    windows?: { getLastFocused: ReturnType<typeof vi.fn> };
  };
};

let originalQuery: unknown;
let originalWindows: unknown;

/** Install a tabs.query that honours `windowId` / `active` / `currentWindow`. */
function installTabs(tabs: FakeTab[], currentWindowId: number) {
  g.chrome.tabs.query = vi.fn(async (info: Q) => {
    let out = tabs;
    if (typeof info.windowId === "number") {
      out = out.filter((t) => t.windowId === info.windowId);
    } else if (info.currentWindow) {
      out = out.filter((t) => t.windowId === currentWindowId);
    }
    if (info.active) out = out.filter((t) => t.active);
    return out;
  });
}

function installWindows(lastFocusedNormalId: number | undefined) {
  g.chrome.windows = {
    getLastFocused: vi.fn(async (opts?: chrome.windows.QueryOptions) => {
      // The production call always passes windowTypes:['normal'] — that filter
      // is precisely what keeps a focused panel popup from being returned.
      expect(opts?.windowTypes).toEqual(["normal"]);
      if (lastFocusedNormalId === undefined) throw new Error("no window");
      return { id: lastFocusedNormalId };
    }),
  };
}

beforeEach(() => {
  originalQuery = g.chrome.tabs.query;
  originalWindows = g.chrome.windows;
  __resetHostWindowIdCache();
  history.replaceState({}, "", "/");
});

afterEach(() => {
  g.chrome.tabs.query = originalQuery as ReturnType<typeof vi.fn>;
  g.chrome.windows = originalWindows as { getLastFocused: ReturnType<typeof vi.fn> };
  __resetHostWindowIdCache();
  history.replaceState({}, "", "/");
});

describe("getHostWindowId", () => {
  it("is null in a real side panel (no query string)", () => {
    expect(getHostWindowId()).toBeNull();
  });

  it("reads the id a fallback panel window was opened with", () => {
    history.replaceState({}, "", "/?hostWindowId=9");
    expect(getHostWindowId()).toBe(9);
  });

  it("degrades to null on a malformed id instead of yielding NaN", () => {
    history.replaceState({}, "", "/?hostWindowId=notanumber");
    expect(getHostWindowId()).toBeNull();
  });
});

describe("queryActiveHostTab", () => {
  it("uses currentWindow when there is no host window (side panel / SW)", async () => {
    installTabs(
      [
        { id: 1, url: "https://a.test/", windowId: 100, active: true },
        { id: 2, url: "https://b.test/", windowId: 200, active: true },
      ],
      100,
    );
    installWindows(undefined);
    expect((await queryActiveHostTab())?.id).toBe(1);
  });

  it("queries the host window explicitly when running in a fallback panel", async () => {
    // The panel popup (window 300) is the "current" window; the user is
    // actually browsing window 200.
    history.replaceState({}, "", "/?hostWindowId=200");
    installTabs(
      [
        { id: 2, url: "https://b.test/", windowId: 200, active: true },
        { id: 9, url: `${PANEL_URL}?hostWindowId=200`, windowId: 300, active: true },
      ],
      300,
    );
    installWindows(200);
    expect((await queryActiveHostTab())?.id).toBe(2);
  });

  it("skips a panel popup that currentWindow resolved to, falling back to the last-focused normal window", async () => {
    // This is the service-worker case: no host window in the URL, and the user
    // just clicked the fallback panel so it became the last-focused window.
    installTabs(
      [
        { id: 2, url: "https://b.test/", windowId: 200, active: true },
        { id: 9, url: `${PANEL_URL}?hostWindowId=200`, windowId: 300, active: true },
      ],
      300,
    );
    installWindows(200);

    const tab = await queryActiveHostTab();
    expect(tab?.id).toBe(2);
    expect(tab?.url).not.toContain(PANEL_PAGE_PATH);
  });

  it("returns undefined rather than throwing when nothing resolves", async () => {
    installTabs([], 100);
    installWindows(undefined);
    expect(await queryActiveHostTab()).toBeUndefined();
  });

  it("survives chrome.windows being absent entirely", async () => {
    installTabs([{ id: 9, url: PANEL_URL, windowId: 300, active: true }], 300);
    delete (g.chrome as { windows?: unknown }).windows;
    // Only a panel tab is reachable and there is no window API to escape to —
    // must degrade quietly, not throw into the loop's startup path.
    await expect(queryActiveHostTab()).resolves.toBeDefined();
  });
});

describe("queryHostWindowTabs", () => {
  it("lists the host window's tabs and never the panel itself", async () => {
    history.replaceState({}, "", "/?hostWindowId=200");
    installTabs(
      [
        { id: 2, url: "https://b.test/", windowId: 200, active: true },
        { id: 3, url: "https://c.test/", windowId: 200 },
        { id: 9, url: `${PANEL_URL}?hostWindowId=200`, windowId: 200 },
      ],
      200,
    );
    installWindows(200);

    const ids = (await queryHostWindowTabs()).map((t) => t.id);
    expect(ids).toEqual([2, 3]);
  });

  it("resolves past a panel-only current window", async () => {
    installTabs(
      [
        { id: 2, url: "https://b.test/", windowId: 200, active: true },
        { id: 9, url: `${PANEL_URL}?hostWindowId=200`, windowId: 300, active: true },
      ],
      300,
    );
    installWindows(200);

    expect((await queryHostWindowTabs()).map((t) => t.id)).toEqual([2]);
  });
});

describe("excludePanelTabs", () => {
  it("drops panel documents in both side-panel and fallback form", () => {
    const kept = excludePanelTabs([
      { url: "https://a.test/" },
      { url: PANEL_URL },
      { url: `${PANEL_URL}?hostWindowId=1` },
    ] as chrome.tabs.Tab[]);
    expect(kept.map((t) => t.url)).toEqual(["https://a.test/"]);
  });
});
