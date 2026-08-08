// Panel-document identity — the predicate everything else keys off.
//
// The stakes: `isOwnPanelUrl` is what keeps Pie's own UI out of the LLM's tab
// list and out of pin capture. A false negative hands the agent a tab id it can
// close, which would kill the panel it is talking through.

import { describe, it, expect } from "vitest";
import {
  buildFallbackPanelUrl,
  hostWindowIdFromPanelUrl,
  isOwnPanelUrl,
  panelPageBaseUrl,
  parseHostWindowId,
  PANEL_PAGE_PATH,
} from "./panel-page";

// setup.ts mocks chrome.runtime.getURL as `chrome-extension://test/${path}`.
const BASE = `chrome-extension://test/${PANEL_PAGE_PATH}`;

describe("panelPageBaseUrl", () => {
  it("resolves the manifest side_panel path through runtime.getURL", () => {
    expect(panelPageBaseUrl()).toBe(BASE);
  });
});

describe("isOwnPanelUrl", () => {
  it("matches the bare side-panel document", () => {
    expect(isOwnPanelUrl(BASE)).toBe(true);
  });

  it("matches a fallback panel carrying a hostWindowId query", () => {
    expect(isOwnPanelUrl(`${BASE}?hostWindowId=12`)).toBe(true);
  });

  it("rejects web pages", () => {
    expect(isOwnPanelUrl("https://example.com/")).toBe(false);
  });

  it("rejects OTHER extension pages, including our own non-panel ones", () => {
    // The offscreen document is same-origin with the panel — a naive
    // "starts with chrome-extension://<our id>" check would swallow it and
    // start hiding unrelated tabs from the agent.
    expect(isOwnPanelUrl("chrome-extension://test/src/offscreen/pdf-parser.html")).toBe(false);
    expect(isOwnPanelUrl("chrome-extension://other/src/sidepanel/index.html")).toBe(false);
  });

  it("treats absent / empty urls as not-panel", () => {
    // chrome.tabs.Tab.url is optional (missing without the tabs permission,
    // or mid-navigation); a bare `undefined` must not throw here.
    expect(isOwnPanelUrl(undefined)).toBe(false);
    expect(isOwnPanelUrl(null)).toBe(false);
    expect(isOwnPanelUrl("")).toBe(false);
  });
});

describe("buildFallbackPanelUrl / hostWindowIdFromPanelUrl", () => {
  it("round-trips a window id", () => {
    expect(hostWindowIdFromPanelUrl(buildFallbackPanelUrl(42))).toBe(42);
  });

  it("returns null for a real side panel (no query string)", () => {
    expect(hostWindowIdFromPanelUrl(BASE)).toBeNull();
  });

  it("returns null for non-panel urls", () => {
    expect(hostWindowIdFromPanelUrl("https://example.com/?hostWindowId=3")).toBeNull();
  });
});

describe("parseHostWindowId", () => {
  it("accepts non-negative integers, including 0", () => {
    expect(parseHostWindowId("0")).toBe(0);
    expect(parseHostWindowId("7")).toBe(7);
  });

  it("rejects malformed values rather than yielding NaN", () => {
    // A NaN windowId would poison every downstream chrome.tabs.query — better
    // to degrade to "no host window" (= current-window semantics).
    for (const bad of ["", "abc", "1.5", "-1", null, undefined]) {
      expect(parseHostWindowId(bad)).toBeNull();
    }
  });
});
