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

  it("passes saveAs:true through", async () => {
    await saveToDownloadsTool.handler({ filename: "x.txt", content: "hi", saveAs: true }, ctx);
    const opts = (chrome.downloads.download as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(opts.saveAs).toBe(true);
  });

  it("uses provided mime in the data URL", async () => {
    await saveToDownloadsTool.handler({ filename: "a.json", content: "{}", mime: "application/json" }, ctx);
    const opts = (chrome.downloads.download as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(opts.url).toMatch(/^data:application\/json;charset=utf-8,/);
  });

  it("fails when content is missing", async () => {
    const r = await saveToDownloadsTool.handler({ filename: "a.txt" }, ctx);
    expect(r.success).toBe(false);
    expect(chrome.downloads.download).not.toHaveBeenCalled();
  });
});
