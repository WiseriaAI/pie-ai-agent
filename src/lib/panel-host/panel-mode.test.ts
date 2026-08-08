// Panel display mode — the user's override for a browser that fools every probe.
//
// Two properties matter here and both were learned the hard way:
//   - the synchronous read, because the click path runs inside a user gesture
//     and cannot await an IDB round-trip before calling sidePanel.open();
//   - persistence, because a browser that can't show a side panel today still
//     can't tomorrow, and re-discovering the workaround after every restart
//     would be its own bug.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DEFAULT_PANEL_MODE,
  PANEL_MODE_KEY,
  __setCachedPanelMode,
  getPanelMode,
  getPanelModeSync,
  setPanelMode,
} from "./panel-mode";
import { getConfig } from "@/lib/idb/config-store";

beforeEach(() => {
  __setCachedPanelMode(DEFAULT_PANEL_MODE);
});

describe("panel mode", () => {
  it("defaults to auto", async () => {
    expect(DEFAULT_PANEL_MODE).toBe("auto");
    expect(getPanelModeSync()).toBe("auto");
  });

  it("persists to the config store so the choice survives a browser restart", async () => {
    await setPanelMode("window");
    expect(await getConfig(PANEL_MODE_KEY)).toBe("window");
  });

  it("updates the synchronous cache immediately on write", async () => {
    // The click path reads this without awaiting — a cache that only refreshed
    // on the next read would send the very next click down the wrong route.
    await setPanelMode("window");
    expect(getPanelModeSync()).toBe("window");
  });

  it("primes the cache from storage", async () => {
    await setPanelMode("window");
    __setCachedPanelMode("auto"); // simulate a fresh service worker
    expect(await getPanelMode()).toBe("window");
    expect(getPanelModeSync()).toBe("window");
  });

  it("round-trips back to auto", async () => {
    await setPanelMode("window");
    await setPanelMode("auto");
    expect(await getPanelMode()).toBe("auto");
    expect(getPanelModeSync()).toBe("auto");
  });

  it("falls back to auto for an unreadable or unknown stored value", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await setPanelMode("window");
      // Anything that isn't exactly "window" must not silently mean "window".
      const { setConfig } = await import("@/lib/idb/config-store");
      await setConfig(PANEL_MODE_KEY, "nonsense");
      expect(await getPanelMode()).toBe("auto");
    } finally {
      spy.mockRestore();
    }
  });
});
