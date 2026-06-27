import { describe, it, expect } from "vitest";
import {
  isRestrictedUrl,
  safeParseOrigin,
  resolveStartupPin,
  NO_PAGE_SENTINEL,
} from "./loop";

describe("isRestrictedUrl", () => {
  it("blocks restricted schemes", () => {
    expect(isRestrictedUrl("chrome://settings")).toBe(true);
    expect(isRestrictedUrl("chrome-extension://abc/popup.html")).toBe(true);
    expect(isRestrictedUrl("about:blank")).toBe(true);
    expect(isRestrictedUrl("edge://settings")).toBe(true);
    expect(isRestrictedUrl("data:text/html,foo")).toBe(true);
    expect(isRestrictedUrl("javascript:alert(1)")).toBe(true);
    expect(isRestrictedUrl("blob:https://example.com/x")).toBe(true);
  });

  it("blocks non-pdf file:// urls", () => {
    expect(isRestrictedUrl("file:///Users/me/page.html")).toBe(true);
    expect(isRestrictedUrl("file:///etc/passwd")).toBe(true);
    expect(isRestrictedUrl("file:///Users/me/notes.txt")).toBe(true);
  });

  it("allows file://*.pdf (sealed viewer exception)", () => {
    expect(isRestrictedUrl("file:///Users/me/paper.pdf")).toBe(false);
    expect(isRestrictedUrl("file:///C:/docs/report.PDF")).toBe(false);
    expect(isRestrictedUrl("file:///x.pdf?v=1")).toBe(false);
    expect(isRestrictedUrl("file:///x.pdf#page=3")).toBe(false);
  });

  it("allows http(s) urls", () => {
    expect(isRestrictedUrl("https://example.com")).toBe(false);
    expect(isRestrictedUrl("http://example.com")).toBe(false);
    expect(isRestrictedUrl("https://arxiv.org/pdf/2401.12345.pdf")).toBe(false);
  });
});

describe("safeParseOrigin", () => {
  it("returns parsed origin for http(s)", () => {
    expect(safeParseOrigin("https://example.com/path?x=1")).toBe(
      "https://example.com",
    );
    expect(safeParseOrigin("http://foo.bar:8080/p")).toBe("http://foo.bar:8080");
  });

  it("returns null for non-pdf file:// (opaque origin)", () => {
    expect(safeParseOrigin("file:///Users/me/page.html")).toBeNull();
  });

  it("returns URL itself for file://*.pdf (used as pin identity)", () => {
    // Per-iteration `origin === pinnedOrigin` becomes URL-equality for file
    // PDFs. The PDF viewer is sealed → URL won't change without user
    // navigation, at which point the gate trips correctly.
    expect(safeParseOrigin("file:///Users/me/paper.pdf")).toBe(
      "file:///Users/me/paper.pdf",
    );
    expect(safeParseOrigin("file:///x.pdf?v=1")).toBe("file:///x.pdf?v=1");
  });

  it("returns null for malformed urls", () => {
    expect(safeParseOrigin("not a url")).toBeNull();
    expect(safeParseOrigin("")).toBeNull();
  });
});

// Issue #231 — start-time hard stops removed. resolveStartupPin replaces the
// three old emitDone(...abort) bailouts ("Cannot run agent on this page type" /
// "unresolvable origin" / "Failed to get active tab"). It NEVER terminates: it
// only chooses what to pin so the per-iteration advisory gate can take over.
describe("resolveStartupPin (Issue #231 — page-less / restricted start no longer hard-stops)", () => {
  it("pins an operable http(s) tab to its origin (unchanged behavior)", () => {
    expect(resolveStartupPin({ id: 7, url: "https://example.com/path?x=1" })).toEqual({
      pinnedTabId: 7,
      pinnedOrigin: "https://example.com",
    });
    expect(resolveStartupPin({ id: 9, url: "http://foo.bar:8080/p" })).toEqual({
      pinnedTabId: 9,
      pinnedOrigin: "http://foo.bar:8080",
    });
  });

  it("pins a restricted chrome:// / settings tab to the tab with an empty origin (no hard-stop)", () => {
    // Real tab.id is always present on chrome://, so we pin to it; the empty
    // origin is never consulted on interpretPinnedTabUrl's restricted branch.
    expect(resolveStartupPin({ id: 3, url: "chrome://settings" })).toEqual({
      pinnedTabId: 3,
      pinnedOrigin: "",
    });
    expect(resolveStartupPin({ id: 4, url: "edge://settings" })).toEqual({
      pinnedTabId: 4,
      pinnedOrigin: "",
    });
  });

  it("pins the new-tab page to the tab with an empty origin", () => {
    expect(resolveStartupPin({ id: 5, url: "chrome://newtab/" })).toEqual({
      pinnedTabId: 5,
      pinnedOrigin: "",
    });
  });

  it("pins a non-pdf file:// tab (restricted) to the tab with an empty origin", () => {
    expect(resolveStartupPin({ id: 6, url: "file:///Users/me/page.html" })).toEqual({
      pinnedTabId: 6,
      pinnedOrigin: "",
    });
  });

  it("pins a file://*.pdf tab to its URL identity (not restricted)", () => {
    expect(resolveStartupPin({ id: 8, url: "file:///Users/me/paper.pdf" })).toEqual({
      pinnedTabId: 8,
      pinnedOrigin: "file:///Users/me/paper.pdf",
    });
  });

  it("pins a real tab with an unresolvable but non-restricted url to an empty origin", () => {
    // A real tab.id with a url that parses to no usable origin must NOT
    // hard-stop (the old "unresolvable origin" abort is gone).
    expect(resolveStartupPin({ id: 10, url: "not a url" })).toEqual({
      pinnedTabId: 10,
      pinnedOrigin: "",
    });
  });

  it("pins a real tab that has an id but no url to an empty origin", () => {
    expect(resolveStartupPin({ id: 11 })).toEqual({
      pinnedTabId: 11,
      pinnedOrigin: "",
    });
  });

  it("falls back to the no-page sentinel when there is no active tab", () => {
    // Replaces the old "Failed to get active tab" / no-tab hard-stops. The
    // loop recognizes the sentinel before chrome.tabs.get and nudges open_url.
    expect(resolveStartupPin(undefined)).toEqual({
      pinnedTabId: NO_PAGE_SENTINEL,
      pinnedOrigin: "",
    });
    expect(resolveStartupPin({ url: "https://example.com" })).toEqual({
      pinnedTabId: NO_PAGE_SENTINEL,
      pinnedOrigin: "",
    });
  });

  it("treats a negative tab id as page-less (sentinel never collides with a real tab)", () => {
    expect(resolveStartupPin({ id: -1 })).toEqual({
      pinnedTabId: NO_PAGE_SENTINEL,
      pinnedOrigin: "",
    });
    expect(NO_PAGE_SENTINEL).toBe(-1);
  });
});
