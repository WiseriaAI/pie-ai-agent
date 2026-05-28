import { describe, it, expect } from "vitest";
import { isRestrictedUrl, safeParseOrigin } from "./loop";

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
