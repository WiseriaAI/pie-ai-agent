import { describe, it, expect, vi, afterEach } from "vitest";
import { isFilePdfUrl, isPdfTab, isPdfTabAsync, tabUrlForCacheKey } from "./detect";

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

describe("isFilePdfUrl", () => {
  it("matches file:// + .pdf", () => {
    expect(isFilePdfUrl("file:///Users/me/paper.pdf")).toBe(true);
    expect(isFilePdfUrl("file:///C:/docs/report.PDF")).toBe(true);
    expect(isFilePdfUrl("file:///x.pdf?v=1")).toBe(true);
    expect(isFilePdfUrl("file:///x.pdf#page=3")).toBe(true);
  });

  it("rejects file:// non-pdf", () => {
    expect(isFilePdfUrl("file:///Users/me/page.html")).toBe(false);
    expect(isFilePdfUrl("file:///Users/me/notes.txt")).toBe(false);
    expect(isFilePdfUrl("file:///Users/me/")).toBe(false);
  });

  it("rejects non-file scheme even when path ends in .pdf", () => {
    expect(isFilePdfUrl("https://example.com/a.pdf")).toBe(false);
    expect(isFilePdfUrl("chrome://settings/a.pdf")).toBe(false);
    expect(isFilePdfUrl("data:application/pdf;base64,JVBE")).toBe(false);
  });

  it("handles undefined / null / empty", () => {
    expect(isFilePdfUrl(undefined)).toBe(false);
    expect(isFilePdfUrl(null)).toBe(false);
    expect(isFilePdfUrl("")).toBe(false);
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

describe("isPdfTabAsync", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubScripting(impl: (opts: unknown) => Promise<unknown>) {
    const executeScript = vi.fn(impl);
    vi.stubGlobal("chrome", { scripting: { executeScript } });
    return executeScript;
  }

  it("returns true from the URL heuristic without probing (short-circuit)", async () => {
    const executeScript = stubScripting(async () => {
      throw new Error("should not be called");
    });
    expect(await isPdfTabAsync(7, "https://example.com/a.pdf")).toBe(true);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("returns true for a suffixless URL whose contentType is application/pdf", async () => {
    const executeScript = stubScripting(async () => [
      { result: "application/pdf" },
    ]);
    expect(await isPdfTabAsync(7, "https://arxiv.org/pdf/2407.13943")).toBe(true);
    expect(executeScript).toHaveBeenCalledOnce();
    // Probes the tab's main document, not a specific frame.
    expect(executeScript.mock.calls[0][0]).toMatchObject({ target: { tabId: 7 } });
  });

  it("returns false for a normal HTML page (contentType text/html)", async () => {
    stubScripting(async () => [{ result: "text/html" }]);
    expect(await isPdfTabAsync(7, "https://example.com/index.html")).toBe(false);
  });

  it("returns false (fail-closed) when executeScript throws", async () => {
    stubScripting(async () => {
      throw new Error("cannot access chrome:// scheme");
    });
    expect(await isPdfTabAsync(7, "https://example.com/")).toBe(false);
  });

  it("returns false (fail-closed) when the injection result is empty", async () => {
    stubScripting(async () => []);
    expect(await isPdfTabAsync(7, "https://example.com/")).toBe(false);
  });

  it("skips the probe when there is no valid tabId (sentinel / undefined)", async () => {
    const executeScript = stubScripting(async () => [
      { result: "application/pdf" },
    ]);
    expect(await isPdfTabAsync(-1, "https://example.com/")).toBe(false);
    expect(await isPdfTabAsync(undefined, "https://example.com/")).toBe(false);
    expect(await isPdfTabAsync(null, "https://example.com/")).toBe(false);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("still returns true from the URL heuristic even without a tabId", async () => {
    expect(await isPdfTabAsync(undefined, "file:///Users/me/paper.pdf")).toBe(true);
  });
});
