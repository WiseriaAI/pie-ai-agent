import { describe, it, expect } from "vitest";
import { classifyRisk, hasCrossOriginTab } from "./risk";
import type { PageSnapshot } from "@/lib/dom-actions/types";

const emptySnapshot: PageSnapshot = { url: "https://example.com", title: "", elements: [] };

describe("Phase 5 — screenshot risk", () => {
  it("capture_visible_tab is always high (R5)", () => {
    const r = classifyRisk("capture_visible_tab", {}, emptySnapshot);
    expect(r.level).toBe("high");
    expect(r.reason).toMatch(/screenshot/i);
  });
  it("capture_fullpage_tab is always high (R6)", () => {
    const r = classifyRisk("capture_fullpage_tab", {}, emptySnapshot);
    expect(r.level).toBe("high");
    expect(r.reason).toMatch(/screenshot/i);
  });
});

describe("v1.5 multi-pin cross-origin detection", () => {
  it("hasCrossOriginTab returns crossOrigin=false when args.tabIds ⊆ pinnedTabs", () => {
    const ctx = {
      pinnedTabs: [
        { tabId: 12, origin: "https://a.com" },
        { tabId: 13, origin: "https://b.com" },
      ],
      allTabsCache: new Map([
        [12, { origin: "https://a.com" }],
        [13, { origin: "https://b.com" }],
      ]),
    };
    const result = hasCrossOriginTab({ tabIds: [12, 13] }, ctx);
    expect(result.crossOrigin).toBe(false);
  });

  it("hasCrossOriginTab flags cross-origin when args target an unpinned tab", () => {
    const ctx = {
      pinnedTabs: [{ tabId: 12, origin: "https://a.com" }],
      allTabsCache: new Map([
        [12, { origin: "https://a.com" }],
        [99, { origin: "https://malicious.com" }],
      ]),
    };
    const result = hasCrossOriginTab({ tabIds: [12, 99] }, ctx);
    expect(result.crossOrigin).toBe(true);
    expect(result.offendingOrigins).toContain("https://malicious.com");
  });

  it("hasCrossOriginTab tolerates pinnedTabs[] empty (auto mode safety)", () => {
    const ctx = {
      pinnedTabs: [],
      allTabsCache: new Map([[12, { origin: "https://a.com" }]]),
    };
    const result = hasCrossOriginTab({ tabIds: [12] }, ctx);
    expect(result.crossOrigin).toBe(true);
  });

  it("hasCrossOriginTab handles singular args.tabId variant (used by activate_tab / get_tab_content)", () => {
    const ctx = {
      pinnedTabs: [{ tabId: 12, origin: "https://a.com" }],
      allTabsCache: new Map([
        [12, { origin: "https://a.com" }],
        [99, { origin: "https://malicious.com" }],
      ]),
    };
    expect(hasCrossOriginTab({ tabId: 12 }, ctx).crossOrigin).toBe(false);
    expect(hasCrossOriginTab({ tabId: 99 }, ctx).crossOrigin).toBe(true);
  });

  it("hasCrossOriginTab returns same-origin when allTabsCache is absent (no targets to classify)", () => {
    expect(hasCrossOriginTab({ tabIds: [12] }, { pinnedTabs: [] }).crossOrigin).toBe(false);
  });
});
