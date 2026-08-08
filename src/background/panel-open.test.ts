// Side-panel capability probe + fallback window.
//
// Measured on a real Arc install, in this order: `open()` resolves; the
// `openPanelOnActionClick` pref is stored (suppressing action.onClicked);
// `getContexts` and the liveness ping both come back positive — and the user
// still sees no panel. Each of those cost a round to discover.
//
// These tests pin down every detection layer built along the way, and the
// conclusion they arrive at: detection is a default, and the user's explicit
// choice overrides all of it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  __resetSidePanelVerdict,
  forceFallbackPanel,
  initPanelOpening,
  openFallbackPanelWindow,
  openPanel,
  tryOpenSidePanel,
  SIDE_PANEL_DOCUMENT_TIMEOUT_MS,
  SIDE_PANEL_PROBE_TIMEOUT_MS,
} from "./panel-open";
import { PANEL_PAGE_PATH } from "@/lib/panel-host/panel-page";
import {
  DEFAULT_PANEL_MODE,
  PANEL_MODE_KEY,
  __setCachedPanelMode,
} from "@/lib/panel-host/panel-mode";
import { getConfig } from "@/lib/idb/config-store";

const PANEL_URL = `chrome-extension://test/${PANEL_PAGE_PATH}`;

type FakeTab = { id: number; url: string; windowId: number };

const g = globalThis as unknown as {
  chrome: {
    tabs: { query: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
    runtime: {
      getContexts?: ReturnType<typeof vi.fn>;
      sendMessage?: ReturnType<typeof vi.fn>;
    };
    windows?: Record<string, ReturnType<typeof vi.fn>>;
    sidePanel?: Record<string, ReturnType<typeof vi.fn>>;
    storage: { session?: Record<string, ReturnType<typeof vi.fn>> };
  };
};

/** Stub the ground-truth check: does a SIDE_PANEL document exist? */
function installSidePanelContexts(present: boolean) {
  g.chrome.runtime.getContexts = vi.fn(async () => (present ? [{ contextId: "sp" }] : []));
}

let saved: {
  query: unknown;
  get: unknown;
  create: unknown;
  getContexts: unknown;
  sendMessage: unknown;
  windows: unknown;
  sidePanel: unknown;
  session: unknown;
};

/**
 * Mutable tab world. Fallback strategies are verified by looking for the panel
 * tab afterwards, so a fixture that "creates" a window without producing a tab
 * models a BROKEN browser — which is a thing tests must opt into deliberately,
 * not the default.
 */
let worldTabs: FakeTab[] = [];

function installTabs(tabs: FakeTab[]) {
  worldTabs = [...tabs];
  g.chrome.tabs.query = vi.fn(async (info: chrome.tabs.QueryInfo) =>
    typeof info.windowId === "number"
      ? worldTabs.filter((t) => t.windowId === info.windowId)
      : worldTabs,
  );
  g.chrome.tabs.get = vi.fn(async (id: number) => {
    const t = worldTabs.find((x) => x.id === id);
    if (!t) throw new Error("no tab");
    return t;
  });
}

beforeEach(() => {
  saved = {
    query: g.chrome.tabs.query,
    get: g.chrome.tabs.get,
    create: (g.chrome.tabs as unknown as { create?: unknown }).create,
    getContexts: g.chrome.runtime.getContexts,
    sendMessage: g.chrome.runtime.sendMessage,
    windows: g.chrome.windows,
    sidePanel: g.chrome.sidePanel,
    session: g.chrome.storage.session,
  };
  __resetSidePanelVerdict();
  __setCachedPanelMode(DEFAULT_PANEL_MODE);
  installTabs([]);
  let nextWindowId = 900;
  g.chrome.windows = {
    // A working browser: creating a window actually produces a tab in it.
    create: vi.fn(async (opts: { url: string }) => {
      const id = nextWindowId++;
      worldTabs.push({ id: id * 10, url: opts.url, windowId: id });
      return { id };
    }),
    update: vi.fn(async () => ({ id: 999 })),
    get: vi.fn(async () => ({ id: 200, left: 0, top: 0, width: 1200, height: 800 })),
    getLastFocused: vi.fn(async () => ({ id: 200 })),
    remove: vi.fn(async () => {}),
  };
  g.chrome.storage.session = {
    get: vi.fn(async () => ({})),
    set: vi.fn(async () => {}),
  };
  // Default = healthy browser: a panel document is alive and answers the
  // liveness ping. Tests that model a browser which opens nothing override this.
  g.chrome.runtime.sendMessage = vi.fn(async () => ({ pong: true }));
});

afterEach(() => {
  vi.useRealTimers();
  g.chrome.tabs.query = saved.query as ReturnType<typeof vi.fn>;
  g.chrome.tabs.get = saved.get as ReturnType<typeof vi.fn>;
  (g.chrome.tabs as unknown as { create?: unknown }).create = saved.create;
  g.chrome.runtime.getContexts = saved.getContexts as ReturnType<typeof vi.fn>;
  g.chrome.runtime.sendMessage = saved.sendMessage as ReturnType<typeof vi.fn>;
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

  it("reports 'unsupported' when open() resolves but NO panel document appears", async () => {
    // The case that shipped broken twice. Arc resolves sidePanel.open() and
    // renders nothing, so the promise settling is worthless as evidence — the
    // only trustworthy signal is whether a SIDE_PANEL context actually exists.
    vi.useFakeTimers();
    g.chrome.sidePanel = { open: vi.fn(async () => {}), setPanelBehavior: vi.fn(async () => {}) };
    installSidePanelContexts(false);

    const pending = tryOpenSidePanel({ tabId: 1 });
    await vi.advanceTimersByTimeAsync(SIDE_PANEL_DOCUMENT_TIMEOUT_MS + 200);
    await expect(pending).resolves.toBe("unsupported");
  });

  it("reports 'opened' when a panel document does appear", async () => {
    g.chrome.sidePanel = { open: vi.fn(async () => {}), setPanelBehavior: vi.fn(async () => {}) };
    installSidePanelContexts(true);

    await expect(tryOpenSidePanel({ tabId: 1 })).resolves.toBe("opened");
  });

  it("falls back to the liveness ping when getContexts is unavailable", async () => {
    // getContexts is Chrome 116+; a fork may simply not have it. Treating
    // "can't measure" as "works fine" is right for a healthy browser and
    // exactly wrong for the broken one this module exists for — so a second,
    // universally available signal has to carry the check.
    delete g.chrome.runtime.getContexts;
    g.chrome.sidePanel = { open: vi.fn(async () => {}), setPanelBehavior: vi.fn(async () => {}) };
    g.chrome.runtime.sendMessage = vi.fn(async () => ({ pong: true }));

    await expect(tryOpenSidePanel({ tabId: 1 })).resolves.toBe("opened");
  });

  it("reports 'unsupported' when neither getContexts nor the ping finds a panel", async () => {
    vi.useFakeTimers();
    delete g.chrome.runtime.getContexts;
    g.chrome.sidePanel = { open: vi.fn(async () => {}), setPanelBehavior: vi.fn(async () => {}) };
    g.chrome.runtime.sendMessage = vi.fn(async () => {
      throw new Error("Receiving end does not exist.");
    });

    const pending = tryOpenSidePanel({ tabId: 1 });
    await vi.advanceTimersByTimeAsync(SIDE_PANEL_DOCUMENT_TIMEOUT_MS + 200);
    await expect(pending).resolves.toBe("unsupported");
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

  it("keeps icon clicks with the extension when it gives up on the side panel", async () => {
    vi.useFakeTimers();
    const setPanelBehavior = vi.fn(async () => {});
    g.chrome.sidePanel = { open: vi.fn(() => new Promise<void>(() => {})), setPanelBehavior };

    const pending = tryOpenSidePanel({ tabId: 1 });
    await vi.advanceTimersByTimeAsync(SIDE_PANEL_PROBE_TIMEOUT_MS);
    await pending;

    expect(setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: false });
    expect(setPanelBehavior).not.toHaveBeenCalledWith({ openPanelOnActionClick: true });
  });

  it("hands click handling to the browser ONLY after an open actually succeeds", async () => {
    // The regression that shipped in the first cut: openPanelOnActionClick:true
    // was set at startup. That flag suppresses action.onClicked, and Arc stores
    // it happily while still being unable to show a panel — so the click was
    // swallowed by a browser that did nothing, onClicked never fired, and the
    // probe that would have cleared the flag sat behind the click the flag was
    // eating. The flag has to be earned by a successful open, never assumed.
    const setPanelBehavior = vi.fn(async () => {});
    g.chrome.sidePanel = { open: vi.fn(async () => {}), setPanelBehavior };

    await tryOpenSidePanel({ tabId: 1 });

    expect(setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
  });
});

describe("panel mode override", () => {
  it("skips detection entirely when the user has chosen a window", async () => {
    // Three rounds of probing were defeated by the same browser. When the
    // person looking at the screen has already answered the question, asking
    // the API again is both pointless and slow.
    installTabs([{ id: 1, url: "https://a.test/", windowId: 200 }]);
    const open = vi.fn(async () => {});
    g.chrome.sidePanel = { open, setPanelBehavior: vi.fn(async () => {}) };
    __setCachedPanelMode("window");

    openPanel({ tabId: 1 }, "test");
    await vi.waitFor(() => expect(g.chrome.windows!.create).toHaveBeenCalledTimes(1));

    expect(open).not.toHaveBeenCalled();
  });
});

describe("forceFallbackPanel", () => {
  it("persists the choice so it survives a browser restart", async () => {
    // The session-scoped verdict dies with the browser session. Without a
    // persisted preference the user would have to rediscover the right-click
    // workaround after every restart.
    installTabs([{ id: 1, url: "https://a.test/", windowId: 200 }]);
    g.chrome.sidePanel = { open: vi.fn(async () => {}), setPanelBehavior: vi.fn(async () => {}) };

    await forceFallbackPanel({ windowId: 200 });

    expect(await getConfig(PANEL_MODE_KEY)).toBe("window");
  });

  it("opens the window AND pins the verdict so later clicks follow suit", async () => {
    // The last line of defence: a browser that reports a live SIDE_PANEL
    // context while still rendering nothing would beat auto-detection, and
    // there is no further signal to check. One use must be enough — the user
    // shouldn't have to hit the shortcut every single time.
    installTabs([{ id: 1, url: "https://a.test/", windowId: 200 }]);
    const setPanelBehavior = vi.fn(async () => {});
    g.chrome.sidePanel = { open: vi.fn(async () => {}), setPanelBehavior };
    installSidePanelContexts(true); // auto-detection would say "supported"

    await forceFallbackPanel({ windowId: 200 });

    expect(g.chrome.windows!.create).toHaveBeenCalledTimes(1);
    expect(setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: false });
    await expect(tryOpenSidePanel({ tabId: 1 })).resolves.toBe("unsupported");
  });
});

describe("initPanelOpening", () => {
  it("takes click handling BACK from the browser on startup", async () => {
    // Also un-sticks installs that ran the earlier build and had `true`
    // persisted into their extension prefs — on Arc that pref is the reason
    // the toolbar icon did nothing at all.
    const setPanelBehavior = vi.fn(async () => {});
    g.chrome.sidePanel = { open: vi.fn(async () => {}), setPanelBehavior };

    initPanelOpening();

    expect(setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: false });
  });

  it("restores browser click handling when a prior probe already proved support", async () => {
    const setPanelBehavior = vi.fn(async () => {});
    g.chrome.sidePanel = { open: vi.fn(async () => {}), setPanelBehavior };
    g.chrome.storage.session!.get = vi.fn(async () => ({ sidepanel_support: "supported" }));

    initPanelOpening();
    await vi.waitFor(() =>
      expect(setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true }),
    );
  });

  it("leaves clicks with the extension when a prior probe found no side panel", async () => {
    const setPanelBehavior = vi.fn(async () => {});
    g.chrome.sidePanel = { open: vi.fn(async () => {}), setPanelBehavior };
    g.chrome.storage.session!.get = vi.fn(async () => ({ sidepanel_support: "unsupported" }));

    initPanelOpening();
    await vi.waitFor(() => expect(g.chrome.storage.session!.get).toHaveBeenCalled());

    expect(setPanelBehavior).not.toHaveBeenCalledWith({ openPanelOnActionClick: true });
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

  it("falls back to a normal tab when the popup window can't be created", async () => {
    // Fallback-of-the-fallback: worse UX, but a reachable panel beats none and
    // the port (and any running task) survives either way.
    installTabs([{ id: 1, url: "https://a.test/", windowId: 200 }]);
    g.chrome.windows!.create = vi.fn(async () => {
      throw new Error("popup windows unavailable");
    });
    const tabsCreate = vi.fn(async () => ({ id: 7 }));
    (g.chrome.tabs as unknown as { create: unknown }).create = tabsCreate;

    await openFallbackPanelWindow({ windowId: 200 });

    expect(tabsCreate).toHaveBeenCalledWith({ url: `${PANEL_URL}?hostWindowId=200` });
  });

  it("escalates when a strategy reports success but no panel actually appears", async () => {
    // The failure that keeps recurring in this browser: the call resolves and
    // nothing shows up. Error handling alone walks straight past it, so each
    // strategy is verified by looking for the panel tab afterwards.
    const FALLBACK_URL = `${PANEL_URL}?hostWindowId=200`;
    installTabs([{ id: 1, url: "https://a.test/", windowId: 200 }]);

    // windows.create resolves happily but never produces a tab — the suspected
    // Arc behaviour for popup-type windows, and the exact shape of failure that
    // plain error handling cannot see.
    g.chrome.windows!.create = vi.fn(async () => ({ id: 999 }));
    const tabsCreate = vi.fn(async () => {
      worldTabs.push({ id: 7, url: FALLBACK_URL, windowId: 200 });
      return { id: 7 };
    });
    (g.chrome.tabs as unknown as { create: unknown }).create = tabsCreate;

    await openFallbackPanelWindow({ windowId: 200 });

    // Both window strategies attempted, then the tab strategy that actually worked.
    expect(g.chrome.windows!.create).toHaveBeenCalledTimes(2);
    expect(g.chrome.windows!.create.mock.calls[0][0].type).toBe("popup");
    expect(g.chrome.windows!.create.mock.calls[1][0].type).toBe("normal");
    expect(tabsCreate).toHaveBeenCalledWith({ url: FALLBACK_URL });
  });

  it("stops at the first strategy that really works", async () => {
    installTabs([{ id: 1, url: "https://a.test/", windowId: 200 }]);
    const tabsCreate = vi.fn(async () => ({ id: 9 }));
    (g.chrome.tabs as unknown as { create: unknown }).create = tabsCreate;

    // The default windows.create fixture models a working browser.
    await openFallbackPanelWindow({ windowId: 200 });

    expect(g.chrome.windows!.create).toHaveBeenCalledTimes(1);
    expect(tabsCreate).not.toHaveBeenCalled();
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
