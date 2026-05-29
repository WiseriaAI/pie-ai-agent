import { describe, it, expect, beforeEach, vi } from "vitest";
import { saveToDownloadsTool } from "./files";

const ctx = { tabId: 1 } as Parameters<typeof saveToDownloadsTool.handler>[1];

describe("save_to_downloads tool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes content under pie/ via chrome.downloads with a data: URL", async () => {
    const r = await saveToDownloadsTool.handler(
      { filename: "notes/summary.md", content: "# Hello\nworld" }, ctx,
    );
    expect(r.success).toBe(true);
    expect(chrome.downloads.download).toHaveBeenCalledTimes(1);
    const opts = (chrome.downloads.download as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(opts.filename).toBe("pie/notes/summary.md");
    expect(opts.conflictAction).toBe("uniquify");
    expect(opts.saveAs).toBe(false);
    expect(opts.url).toMatch(/^data:text\/plain;charset=utf-8,/);
    expect(decodeURIComponent(opts.url.split(",")[1])).toBe("# Hello\nworld");
    expect(r.observation).toContain("pie/notes/summary.md");
  });

  it("passes save_as:true through (wire format)", async () => {
    await saveToDownloadsTool.handler({ filename: "x.txt", content: "hi", save_as: true }, ctx);
    const opts = (chrome.downloads.download as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(opts.saveAs).toBe(true);
  });

  it("uses provided mime in the data URL", async () => {
    await saveToDownloadsTool.handler({ filename: "a.json", content: "{}", mime: "application/json" }, ctx);
    const opts = (chrome.downloads.download as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(opts.url).toMatch(/^data:application\/json;charset=utf-8,/);
  });

  it("falls back to text/plain for a disallowed mime", async () => {
    await saveToDownloadsTool.handler({ filename: "a.html", content: "<b>hi</b>", mime: "text/html" }, ctx);
    const opts = (chrome.downloads.download as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(opts.url).toMatch(/^data:text\/plain;charset=utf-8,/);
  });

  it("rejects content over 5MB without calling download", async () => {
    const big = "x".repeat(5 * 1024 * 1024 + 1);
    const r = await saveToDownloadsTool.handler({ filename: "big.txt", content: big }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toContain("content_too_large");
    expect(chrome.downloads.download).not.toHaveBeenCalled();
  });

  it("notes when the filename was sanitized to the fallback", async () => {
    const r = await saveToDownloadsTool.handler({ filename: "../..", content: "hi" }, ctx);
    expect(r.success).toBe(true);
    const opts = (chrome.downloads.download as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(opts.filename).toBe("pie/untitled.txt");
    expect(r.observation).toContain("sanitized to untitled.txt");
  });

  it("fails when content is missing", async () => {
    const r = await saveToDownloadsTool.handler({ filename: "a.txt" }, ctx);
    expect(r.success).toBe(false);
    expect(chrome.downloads.download).not.toHaveBeenCalled();
  });
});
