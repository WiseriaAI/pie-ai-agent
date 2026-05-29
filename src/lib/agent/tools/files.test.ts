import { describe, it, expect, beforeEach, vi } from "vitest";
import { saveToDownloadsTool, readLocalFileTool } from "./files";
import { sendToOffscreen } from "@/background/offscreen-manager";
vi.mock("@/background/offscreen-manager", () => ({ sendToOffscreen: vi.fn() }));

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

describe("read_local_file tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (chrome.extension as { isAllowedFileSchemeAccess: ReturnType<typeof vi.fn> })
      .isAllowedFileSchemeAccess = vi.fn(async () => true);
    globalThis.fetch = vi.fn();
  });

  it("reads a text file and wraps it untrusted", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, headers: { get: () => "text/plain" }, text: async () => "hello world",
    });
    const r = await readLocalFileTool.handler({ uri: "file:///tmp/a.txt" }, { tabId: 1 } as never);
    expect(r.success).toBe(true);
    expect(r.observation).toMatch(/<untrusted_local_file[^>]*name="a.txt"/);
    expect(r.observation).toContain("hello world");
  });

  it("normalizes a bare absolute path to file://", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, headers: { get: () => "text/plain" }, text: async () => "x",
    });
    await readLocalFileTool.handler({ uri: "/tmp/a.txt" }, { tabId: 1 } as never);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("file:///tmp/a.txt");
  });

  it("returns file_access_denied when toggle is off", async () => {
    (chrome.extension as { isAllowedFileSchemeAccess: ReturnType<typeof vi.fn> })
      .isAllowedFileSchemeAccess = vi.fn(async () => false);
    const r = await readLocalFileTool.handler({ uri: "file:///tmp/a.txt" }, { tabId: 1 } as never);
    expect(r.success).toBe(false);
    expect(r.error).toContain("file_access_denied");
  });

  it("parses a PDF via offscreen pdf:parse_bytes", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, headers: { get: () => "application/pdf" }, arrayBuffer: async () => new ArrayBuffer(8),
    });
    (sendToOffscreen as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ pages: [{ page: 1, text: "pdf text" }], total_pages: 1 });
    const r = await readLocalFileTool.handler({ uri: "file:///tmp/a.pdf" }, { tabId: 1 } as never);
    expect(r.success).toBe(true);
    expect(r.observation).toContain("pdf text");
    // exactly one offscreen call (pdf:parse_bytes), keyed by uri
    expect((sendToOffscreen as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ type: "pdf:parse_bytes" });
  });

  it("rejects image uris with guidance", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, headers: { get: () => "image/png" }, arrayBuffer: async () => new ArrayBuffer(8),
    });
    const r = await readLocalFileTool.handler({ uri: "file:///tmp/a.png" }, { tabId: 1 } as never);
    expect(r.success).toBe(false);
    expect(r.error).toContain("image_via_picker");
  });

  it("rejects non-file:// URIs without fetching (C1 SSRF guard)", async () => {
    const r = await readLocalFileTool.handler({ uri: "http://169.254.169.254/" }, { tabId: 1 } as never);
    expect(r.success).toBe(false);
    expect(r.error).toContain("invalid_uri");
    expect(globalThis.fetch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("returns fetch_failed with status for a non-ok response", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false, status: 403, headers: { get: () => null },
    });
    const r = await readLocalFileTool.handler({ uri: "file:///tmp/a.txt" }, { tabId: 1 } as never);
    expect(r.success).toBe(false);
    expect(r.error).toContain("fetch_failed: status 403");
  });

  it("rejects text larger than 5MB via Content-Length pre-check", async () => {
    const headers = { get: (h: string) => (h.toLowerCase() === "content-length" ? String(6 * 1024 * 1024) : "text/plain") };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, headers, text: async () => "x",
    });
    const r = await readLocalFileTool.handler({ uri: "file:///tmp/big.txt" }, { tabId: 1 } as never);
    expect(r.success).toBe(false);
    expect(r.error).toContain("too_large");
  });

  it("rejects text larger than 5MB via post-read length guard", async () => {
    const big = "x".repeat(5 * 1024 * 1024 + 1);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, headers: { get: () => "text/plain" }, text: async () => big,
    });
    const r = await readLocalFileTool.handler({ uri: "file:///tmp/big.txt" }, { tabId: 1 } as never);
    expect(r.success).toBe(false);
    expect(r.error).toContain("too_large");
  });

  it("truncates text over READ_MAX_CHARS but under the 5MB cap", async () => {
    const text = "y".repeat(250_000);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, headers: { get: () => "text/plain" }, text: async () => text,
    });
    const r = await readLocalFileTool.handler({ uri: "file:///tmp/long.txt" }, { tabId: 1 } as never);
    expect(r.success).toBe(true);
    expect(r.observation).toContain("[truncated]");
    expect(r.observation).toContain('truncated="true"');
  });

  it("returns unsupported_type for an unknown binary", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, headers: { get: () => "application/octet-stream" }, arrayBuffer: async () => new ArrayBuffer(8),
    });
    const r = await readLocalFileTool.handler({ uri: "file:///tmp/a.bin" }, { tabId: 1 } as never);
    expect(r.success).toBe(false);
    expect(r.error).toContain("unsupported_type");
  });
});
