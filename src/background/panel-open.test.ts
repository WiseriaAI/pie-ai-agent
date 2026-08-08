// Side-panel capability probe + fallback window.
//
// The bug this exists for: Arc ships `chrome.sidePanel` and its `open()`
// returns a promise that NEVER SETTLES. Presence-checks say "supported" and
// `.catch()` never fires, so the old code sat there forever and the toolbar
// icon did nothing with no error anywhere. Only a timeout can detect it — that
// is what these tests pin down.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  __resetSidePanelVerdict,
  openFallbackPanelWindow,
  tryOpenSidePanel,
  SIDE_PANEL_PROBE_TIMEOUT_MS,
} from "./panel-open";
import { PANEL_PAGE_PATH } from "@/lib/panel-host/panel-page";

const PANEL_URL = `chrome-extension://test/${PANEL_PAGE_PATH}`;

type FakeTab = { id: number; url: string; windowId: number };

const g = globalThis as unknown as {
  chrome: {
    tabs: { query: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
    windows?: Record<string, ReturnType<typeof vi.fn>>;
    sidePanel?: Record<string, ReturnType<typeof vi.fn>>;
    storage: { session?: Record<string, ReturnType<typeof vi.fn>> };
  };
};

let saved: {
  query: unknown;
  get: unknown;
  windows: unknown;
  sidePanel: unknown;
  session: unknown;
};

function installTabs(tabs: FakeTab[]) {
  g.chrome.tabs.query = vi.fn(async (info: chrome.tabs.QueryInfo) =>
    typeof info.windowId === "number" ? tabs.filter((t) => t.windowId === info.windowId) : tabs,
  );
  g.chrome.tabs.get = vi.fn(async (id: number) => {
    const t = tabs.find((x) => x.id === id);
    if (!t) throw new Error("no tab");
    return t;
  });
}

beforeEach(() => {
  saved = {
    query: g.chrome.tabs.query,
    get: g.chrome.tabs.get,
    windows: g.chrome.windows,
    sidePanel: g.chrome.sidePanel,
    session: g.chrome.storage.session,
  };
  __resetSidePanelVerdict();
  installTabs([]);
  g.chrome.windows = {
    create: vi.fn(async () => ({ id: 999 })),
    update: vi.fn(async () => ({ id: 999 })),
    get: vi.fn(async () => ({ id: 200, left: 0, top: 0, width: 1200, height: 800 })),
    getLastFocused: vi.fn(async () => ({ id: 200 })),
    remove: vi.fn(async () => {}),
  };
  g.chrome.storage.session = {
    get: vi.fn(async () => ({})),
    set: vi.fn(async () => {}),
  };
});

afterEach(() => {
  vi.useRealTimers();
  g.chrome.tabs.query = saved.query as ReturnType<typeof vi.fn>;
  g.chrome.tabs.get = saved.get as ReturnType<typeof vi.fn>;
  g.chrome.windows = saved.windows as Record<string, ReturnType<typeof vi.fn>>;
  g.chrome.sidePanel = saved.sidePanel as Record<string, ReturnType<typeof vi.fn>>;
  g.chrome.storage.session = saved.session as Record<string, ReturnType<typeof vi.fn>>;
  __resetSidePanelVerdict();
});

describe("tryOpenSidePanel", () => {
  it("reports 'opened' on a browser that services side panels", async () => {
    g.chrome.sidePanel = {
      open: vi.fn(async () => {}),
      setPanelBehavior: vi.fn(async () => {}),
    };
    await expect(tryOpenSidePanel({ tabId: 1 })).resolves.toBe("opened");
  });

  it("reports 'unsupported' when the namespace is missing", async () => {
    delete g.chrome.sidePanel;
    await expect(tryOpenSidePanel({ tabId: 1 })).resolves.toBe("unsupported");
  });

  it("reports 'unsupported' when open() never settles (the Arc case)", async () => {
    vi.useFakeTimers();
    g.chrome.sidePanel = {
      // Never resolves, never rejects — exactly what Arc does.
      open: vi.fn(() => new Promise<void>(() => {})),
      setPanelBehavior: vi.fn(async () => {}),
    };

    const pending = tryOpenSidePanel({ tabId: 1 });
    await vi.advanceTimersByTimeAsync(SIDE_PANEL_PROBE_TIMEOUT_MS);
    await expect(pending).resolves.toBe("unsupported");
  });

  it("reports 'rejected' — NOT 'unsupported' — when the browser refuses one call", async () => {
    // Chrome rejects sidePanel.open outside a user gesture. That is a per-call
    // refusal, not a capability verdict: misfiling it would make Chrome open a
    // popup window every time a notification click lands.
    g.chrome.sidePanel = {
      open: vi.fn(async () => {
        throw new Error("must be called in response to a user gesture");
      }),
      setPanelBehavior: vi.fn(async () => {}),
    };
    await expect(tryOpenSidePanel({ windowId: 1 })).resolves.toBe("rejected");
  });

  it("memoizes an 'unsupported' verdict so later clicks don't re-pay the timeout", async () => {
    vi.useFakeTimers();
    const open = vi.fn(() => new Promise<void>(() => {}));
    g.chrome.sidePanel = { open, setPanelBehavior: vi.fn(async () => {}) };

    const first = tryOpenSidePanel({ tabId: 1 });
    await vi.advanceTimersByTimeAsync(SIDE_PANEL_PROBE_TIMEOUT_MS);
    await first;
    expect(open).toHaveBeenCalledTimes(1);

    // Second call must resolve immediately, without touching the API again.
    await expect(tryOpenSidePanel({ tabId: 2 })).resolves.toBe("unsupported");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("hands icon clicks back to the extension once it gives up on the side panel", async () => {
    // openPanelOnActionClick:true asks the browser to handle the click and
    // suppress action.onClicked. On a browser that can't open a panel that
    // swallows the click, leaving no way in — so it must be turned back off.
    vi.useFakeTimers();
    const setPanelBehavior = vi.fn(async () => {});
    g.chrome.sidePanel = { open: vi.fn(() => new Promise<void>(() => {})), setPanelBehavior };

    const pending = tryOpenSidePanel({ tabId: 1 });
    await vi.advanceTimersByTimeAsync(SIDE_PANEL_PROBE_TIMEOUT_MS);
    await pending;

    expect(setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: false });
  });

  it("stops racing once the browser has proven it works", async () => {
    // A slow-but-working browser must not be misdiagnosed on a later call.
    let resolveSecond: (() => void) | undefined;
    const open = vi
      .fn()
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(() => new Promise<void>((r) => (resolveSecond = r)));
    g.chrome.sidePanel = { open, setPanelBehavior: vi.fn(async () => {}) };

    await expect(tryOpenSidePanel({ tabId: 1 })).resolves.toBe("opened");

    vi.useFakeTimers();
    const pending = tryOpenSidePanel({ tabId: 2 });
    await vi.advanceTimersByTimeAsync(SIDE_PANEL_PROBE_TIMEOUT_MS * 4);
    resolveSecond?.();
    await expect(pending).resolves.toBe("opened");
  });
});

describe("openFallbackPanelWindow", () => {
  it("opens the panel document in a popup window tagged with its host window", async () => {
    installTabs([{ id: 1, url: "https://a.test/", windowId: 200 }]);
    await openFallbackPanelWindow({ tabId: 1 });

    const opts = g.chrome.windows!.create.mock.calls[0][0];
    expect(opts.type).toBe("popup");
    // The host window id must ride in the URL — it is how the panel learns
    // which window's tabs to report as "the page the user is on".
    expect(opts.url).toBe(`${PANEL_URL}?hostWindowId=200`);
  });

  it("docks against the right edge of the window it shadows", async () => {
    installTabs([{ id: 1, url: "https://a.test/", windowId: 200 }]);
    g.chrome.windows!.get = vi.fn(async () => ({
      id: 200,
      left: 40,
      top: 25,
      width: 1000,
      height: 900,
    }));

    await openFallbackPanelWindow({ windowId: 200 });
    const opts = g.chrome.windows!.create.mock.calls[0][0];
    expect(opts.left).toBe(1040);
    expect(opts.top).toBe(25);
    expect(opts.height).toBe(900);
  });

  it("re-focuses an existing panel instead of spawning a second one", async () => {
    installTabs([
      { id: 1, url: "https://a.test/", windowId: 200 },
      { id: 9, url: `${PANEL_URL}?hostWindowId=200`, windowId: 300 },
    ]);

    await openFallbackPanelWindow({ windowId: 200 });

    expect(g.chrome.windows!.create).not.toHaveBeenCalled();
    expect(g.chrome.windows!.update).toHaveBeenCalledWith(300, expect.objectContaining({ focused: true }));
  });

  it("opens a separate panel per browser window", async () => {
    // A panel shadowing window 200 must not be reused for window 201 — each
    // browser window gets its own, mirroring real side-panel behaviour.
    installTabs([
      { id: 1, url: "https://a.test/", windowId: 201 },
      { id: 9, url: `${PANEL_URL}?hostWindowId=200`, windowId: 300 },
    ]);

    await openFallbackPanelWindow({ windowId: 201 });
    expect(g.chrome.windows!.create).toHaveBeenCalledTimes(1);
  });

  it("never shadows a panel window with another panel window", async () => {
    // Reached when the trigger resolved its window from SW context while the
    // user had the panel focused (windows.getCurrent returns last-focused).
    // Window 300 holds only a panel document, so it must be rejected as a host
    // and resolution must fall through to the last-focused browsing window.
    installTabs([{ id: 9, url: PANEL_URL, windowId: 300 }]);
    g.chrome.windows!.getLastFocused = vi.fn(async () => ({ id: 200 }));

    await openFallbackPanelWindow({ windowId: 300 });

    const opts = g.chrome.windows!.create.mock.calls[0][0];
    expect(opts.url).toBe(`${PANEL_URL}?hostWindowId=200`);
  });
});
