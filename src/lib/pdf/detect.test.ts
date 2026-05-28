import { describe, it, expect } from "vitest";
import { isPdfTab, tabUrlForCacheKey } from "./detect";

describe("isPdfTab", () => {
  function tab(url: string): Pick<chrome.tabs.Tab, "url"> {
    return { url };
  }

  it("matches lowercase .pdf", () => {
    expect(isPdfTab(tab("https://arxiv.org/pdf/2401.12345.pdf"))).toBe(true);
  });

  it("matches uppercase .PDF", () => {
    expect(isPdfTab(tab("https://example.com/doc.PDF"))).toBe(true);
  });

  it("matches .pdf followed by query string", () => {
    expect(isPdfTab(tab("https://example.com/file.pdf?x=1&y=2"))).toBe(true);
  });

  it("matches .pdf followed by hash fragment", () => {
    expect(isPdfTab(tab("https://example.com/file.pdf#page=3"))).toBe(true);
  });

  it("matches file:// scheme", () => {
    expect(isPdfTab(tab("file:///Users/me/paper.pdf"))).toBe(true);
  });

  it("rejects non-pdf urls", () => {
    expect(isPdfTab(tab("https://example.com/index.html"))).toBe(false);
    expect(isPdfTab(tab("https://example.com/pdf-tutorial"))).toBe(false);
  });

  it("handles missing url gracefully", () => {
    expect(isPdfTab({})).toBe(false);
    expect(isPdfTab(tab(""))).toBe(false);
  });

  it("rejects .pdfx extension", () => {
    expect(isPdfTab(tab("https://example.com/report.pdfx"))).toBe(false);
  });

  it("rejects .pdf appearing only in a hash fragment", () => {
    expect(isPdfTab(tab("https://example.com/viewer#file.pdf"))).toBe(false);
  });
});

describe("tabUrlForCacheKey", () => {
  it("returns the url verbatim (MVP: no normalization)", () => {
    expect(tabUrlForCacheKey("https://example.com/a.pdf?x=1")).toBe(
      "https://example.com/a.pdf?x=1",
    );
  });

  it("does not strip hash fragments (MVP: verbatim)", () => {
    expect(tabUrlForCacheKey("https://example.com/a.pdf#page=5")).toBe(
      "https://example.com/a.pdf#page=5",
    );
  });
});
