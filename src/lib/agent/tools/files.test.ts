import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildOutputFileTool, buildReadLocalFileTool, buildRequestLocalFileTool } from "./files";
import type { FileArtifact } from "@/lib/files/output-store";
import { sendToOffscreen } from "@/background/offscreen-manager";
vi.mock("@/background/offscreen-manager", () => ({ sendToOffscreen: vi.fn() }));

describe("output_file tool", () => {
  const ctx = { tabId: 1 } as Parameters<ReturnType<typeof buildOutputFileTool>["handler"]>[1];
  let originalChrome: typeof globalThis.chrome;
  beforeEach(() => { originalChrome = globalThis.chrome; });
  afterEach(() => { globalThis.chrome = originalChrome; });
  function build() {
    const stored: FileArtifact[] = [];
    const tool = buildOutputFileTool({ sessionId: "s1", store: (a) => { stored.push(a); } });
    return { tool, stored };
  }

  it("is named output_file and read-class-shaped (no save_as param)", () => {
    const { tool } = build();
    expect(tool.name).toBe("output_file");
    expect(JSON.stringify(tool.parameters)).not.toContain("save_as");
  });

  it("stores an artifact and returns fileOutput (does NOT call chrome.downloads)", async () => {
    const dl = vi.fn();
    // @ts-expect-error test global
    globalThis.chrome = { downloads: { download: dl } };
    const { tool, stored } = build();
    const r = await tool.handler({ filename: "report.md", content: "# hi", mime: "text/markdown" }, ctx);
    expect(r.success).toBe(true);
    expect(dl).not.toHaveBeenCalled();
    expect(stored).toHaveLength(1);
    expect(stored[0].filename).toBe("pie/report.md");
    expect(stored[0].content).toBe("# hi");
    expect(r.fileOutput).toMatchObject({ filename: "pie/report.md", mime: "text/markdown", size: stored[0].byteLength });
    expect(r.fileOutput?.id).toBe(stored[0].id);
  });

  it("rejects content over 5MB before storing", async () => {
    const { tool, stored } = build();
    const r = await tool.handler({ filename: "big.txt", content: "x".repeat(5 * 1024 * 1024 + 1) }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/content_too_large/);
    expect(stored).toHaveLength(0);
  });

  it("forces text/plain for non-allowlisted mime (e.g. text/html)", async () => {
    const { tool, stored } = build();
    await tool.handler({ filename: "a.html", content: "<b>hi</b>", mime: "text/html" }, ctx);
    expect(stored[0].mime).toBe("text/plain");
  });

  it("sanitizes path traversal to pie/untitled.txt", async () => {
    const { tool, stored } = build();
    const r = await tool.handler({ filename: "../..", content: "hi" }, ctx);
    expect(r.success).toBe(true);
    expect(stored[0].filename).toBe("pie/untitled.txt");
  });

  it("requires content", async () => {
    const { tool } = build();
    const r = await tool.handler({ filename: "a.txt" }, ctx);
    expect(r.success).toBe(false);
  });
});

describe("read_local_file tool", () => {
  const readLocalFileTool = buildReadLocalFileTool();
  beforeEach(() => {
    vi.clearAllMocks();
    (chrome.extension as unknown as { isAllowedFileSchemeAccess: ReturnType<typeof vi.fn> })
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
    (chrome.extension as unknown as { isAllowedFileSchemeAccess: ReturnType<typeof vi.fn> })
      .isAllowedFileSchemeAccess = vi.fn(async () => false);
    const r = await readLocalFileTool.handler({ uri: "file:///tmp/a.txt" }, { tabId: 1 } as never);
    expect(r.success).toBe(false);
    expect(r.error).toContain("file_access_denied");
  });

  it("calls notifyNeedsFileAccess (to surface the permission card) when the toggle is off", async () => {
    (chrome.extension as unknown as { isAllowedFileSchemeAccess: ReturnType<typeof vi.fn> })
      .isAllowedFileSchemeAccess = vi.fn(async () => false);
    const notify = vi.fn();
    const tool = buildReadLocalFileTool({ notifyNeedsFileAccess: notify });
    const r = await tool.handler({ uri: "file:///tmp/a.txt" }, { tabId: 1 } as never);
    expect(r.success).toBe(false);
    expect(r.error).toContain("file_access_denied");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("does NOT call notifyNeedsFileAccess when access is granted", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, headers: { get: () => "text/plain" }, text: async () => "ok",
    });
    const notify = vi.fn();
    const tool = buildReadLocalFileTool({ notifyNeedsFileAccess: notify });
    await tool.handler({ uri: "file:///tmp/a.txt" }, { tabId: 1 } as never);
    expect(notify).not.toHaveBeenCalled();
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

describe("buildRequestLocalFileTool", () => {
  const ctx = { tabId: 1 } as never;

  it("returns success + untrusted_local_file wrapper on a picked file", async () => {
    const tool = buildRequestLocalFileTool({
      sessionId: "s",
      requestFile: async () => ({ name: "a.md", mime: "text/markdown", text: "hi", truncated: false }),
    });
    const r = await tool.handler({}, ctx);
    expect(r.success).toBe(true);
    expect(r.observation).toContain('<untrusted_local_file name="a.md"');
    expect(r.observation).toContain("hi");
  });

  it("returns actionable error message when requestFile rejects", async () => {
    const tool = buildRequestLocalFileTool({
      sessionId: "s",
      requestFile: async () => { throw new Error("no sidepanel port for session s"); },
    });
    const r = await tool.handler({}, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toContain("Could not get a file");
    expect(r.error).toContain("attach (+) button");
    expect(r.error).toContain("read_local_file");
  });
});
