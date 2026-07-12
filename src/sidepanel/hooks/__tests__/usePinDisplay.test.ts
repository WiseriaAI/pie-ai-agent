import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chromeMock } from "@/test/setup";
import { usePinDisplay, extractOrigin, extractHost } from "../usePinDisplay";

// The global setup.ts chrome mock provides tabs.query / tabs.get but not the
// live-tracking event listeners; patch them here (same pattern as Chat.test).
const noop = () => {};
const tabsOnActivated = { addListener: vi.fn(noop), removeListener: vi.fn(noop) };
const tabsOnUpdated = { addListener: vi.fn(noop), removeListener: vi.fn(noop) };
const windowsOnFocusChanged = { addListener: vi.fn(noop), removeListener: vi.fn(noop) };

type ChromeShape = Record<string, unknown>;
const g = globalThis as unknown as { chrome: ChromeShape };
// Patch the live-tracking listeners ONTO the shared chromeMock.tabs object so
// the setup.ts query/get closures still resolve against the same object.
Object.assign(chromeMock.tabs, { onActivated: tabsOnActivated, onUpdated: tabsOnUpdated });
g.chrome = {
  ...g.chrome,
  windows: { WINDOW_ID_NONE: -1, onFocusChanged: windowsOnFocusChanged },
};

const tabsMock = chromeMock.tabs as unknown as {
  __activeTab: unknown;
  get: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  tabsMock.__activeTab = { id: 1, url: "https://example.com/path", title: "Example Home", active: true };
  tabsOnActivated.addListener.mockClear();
  tabsOnActivated.removeListener.mockClear();
  tabsOnUpdated.addListener.mockClear();
  windowsOnFocusChanged.addListener.mockClear();
});

afterEach(cleanup);

describe("usePinDisplay — isLocked", () => {
  it("auto mode + not streaming → unlocked", () => {
    const { result } = renderHook(() =>
      usePinDisplay({ pinnedTabs: null, pinMode: "auto", streaming: false }),
    );
    expect(result.current.isLocked).toBe(false);
  });

  it("task / user mode → locked", () => {
    const task = renderHook(() =>
      usePinDisplay({ pinnedTabs: [{ tabId: 1, origin: "https://x.com" }], pinMode: "task", streaming: false }),
    );
    expect(task.result.current.isLocked).toBe(true);
    const user = renderHook(() =>
      usePinDisplay({ pinnedTabs: [{ tabId: 1, origin: "https://x.com" }], pinMode: "user", streaming: false }),
    );
    expect(user.result.current.isLocked).toBe(true);
  });

  it("streaming forces locked even in auto mode", () => {
    const { result } = renderHook(() =>
      usePinDisplay({ pinnedTabs: null, pinMode: "auto", streaming: true }),
    );
    expect(result.current.isLocked).toBe(true);
  });
});

describe("usePinDisplay — live-preview listeners", () => {
  it("auto (unlocked) → registers chrome.tabs live-tracking listeners", async () => {
    renderHook(() => usePinDisplay({ pinnedTabs: null, pinMode: "auto", streaming: false }));
    await waitFor(() => expect(tabsOnActivated.addListener).toHaveBeenCalled());
    expect(windowsOnFocusChanged.addListener).toHaveBeenCalled();
  });

  it("locked → does NOT register live-tracking listeners", () => {
    renderHook(() =>
      usePinDisplay({ pinnedTabs: [{ tabId: 1, origin: "https://x.com" }], pinMode: "task", streaming: false }),
    );
    expect(tabsOnActivated.addListener).not.toHaveBeenCalled();
    expect(windowsOnFocusChanged.addListener).not.toHaveBeenCalled();
  });
});

describe("usePinDisplay — display label", () => {
  it("auto mode reflects the live active-tab title", async () => {
    const { result } = renderHook(() =>
      usePinDisplay({ pinnedTabs: null, pinMode: "auto", streaming: false }),
    );
    await waitFor(() => expect(result.current.displayPinnedOrigin).toBe("Example Home"));
  });

  it("locked mode prefers the pinned tab title, falling back to host", async () => {
    tabsMock.get.mockResolvedValueOnce({ id: 42, title: "Pinned Doc" });
    const { result } = renderHook(() =>
      usePinDisplay({
        pinnedTabs: [{ tabId: 42, origin: "https://docs.example.com" }],
        pinMode: "user",
        streaming: false,
      }),
    );
    await waitFor(() => expect(result.current.displayPinnedOrigin).toBe("Pinned Doc"));
  });

  it("locked mode with no title falls back to host from origin", async () => {
    tabsMock.get.mockResolvedValueOnce({ id: 42, title: undefined });
    const { result } = renderHook(() =>
      usePinDisplay({
        pinnedTabs: [{ tabId: 42, origin: "https://docs.example.com" }],
        pinMode: "user",
        streaming: false,
      }),
    );
    await waitFor(() => expect(result.current.displayPinnedOrigin).toBe("docs.example.com"));
  });
});

describe("usePinDisplay — helpers", () => {
  it("extractOrigin keeps host + path for http(s), rejects other schemes", () => {
    expect(extractOrigin("https://a.com/x/y")).toBe("a.com/x/y");
    expect(extractOrigin("https://a.com/")).toBe("a.com");
    expect(extractOrigin("chrome://settings")).toBeNull();
    expect(extractOrigin("not a url")).toBeNull();
  });

  it("extractHost strips scheme to host-only", () => {
    expect(extractHost("https://docs.google.com")).toBe("docs.google.com");
    expect(extractHost("garbage")).toBeNull();
  });
});
