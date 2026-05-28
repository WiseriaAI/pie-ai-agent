import { describe, it, expect, vi, beforeEach } from "vitest";
import { readPdfTool } from "./pdf";
import * as offscreen from "@/background/offscreen-manager";

const ctx = { tabId: 99 } as Parameters<typeof readPdfTool.handler>[1];

function mockTab(url: string) {
  vi.spyOn(chrome.tabs, "get").mockResolvedValue({
    id: 99,
    url,
  } as chrome.tabs.Tab);
}

describe("read_pdf tool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Ensure chrome.extension exists (not included in the global setup.ts mock).
    const g = globalThis as unknown as { chrome: Record<string, unknown> };
    g.chrome ??= {};
    g.chrome.extension ??= { isAllowedFileSchemeAccess: vi.fn() };
  });

  it("errors not_a_pdf for non-pdf tab", async () => {
    mockTab("https://example.com/index.html");
    const r = await readPdfTool.handler({}, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not_a_pdf/);
  });

  it("errors file_access_denied for file:// without permission", async () => {
    mockTab("file:///Users/me/a.pdf");
    vi.spyOn(chrome.extension, "isAllowedFileSchemeAccess").mockResolvedValue(false);
    const r = await readPdfTool.handler({}, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/file_access_denied/);
  });

  it("returns pages joined under read_pdf wrapper on success", async () => {
    mockTab("https://x/a.pdf");
    vi.spyOn(offscreen, "sendToOffscreen")
      .mockResolvedValueOnce({ title: null, total_pages: 5, outline: [] } as unknown)
      .mockResolvedValueOnce({
        pages: [
          { page: 1, text: "Page one body." },
          { page: 2, text: "Page two body." },
        ],
        total_pages: 5,
      } as unknown);

    const r = await readPdfTool.handler({ page_range: "1-2" }, ctx);
    expect(r.success).toBe(true);
    expect(r.observation).toContain('total_pages="5"');
    expect(r.observation).toContain('page="1"');
    expect(r.observation).toContain("Page one body.");
    expect(r.observation).toContain('page="2"');
    expect(r.observation).toContain("Page two body.");
    const calls = vi.mocked(offscreen.sendToOffscreen).mock.calls;
    expect(calls[0][0]).toMatchObject({ type: "pdf:outline" });
    expect(calls[1][0]).toMatchObject({ type: "pdf:read_page" });
  });

  it("truncates to max_chars at page boundary and marks truncated=true", async () => {
    mockTab("https://x/a.pdf");
    vi.spyOn(offscreen, "sendToOffscreen")
      .mockResolvedValueOnce({ title: null, total_pages: 3, outline: [] } as unknown)
      .mockResolvedValueOnce({
        pages: [
          { page: 1, text: "A".repeat(5000) },
          { page: 2, text: "B".repeat(5000) },
          { page: 3, text: "C".repeat(5000) },
        ],
        total_pages: 3,
      } as unknown);
    const r = await readPdfTool.handler({ page_range: "1-3", max_chars: 6000 }, ctx);
    expect(r.success).toBe(true);
    expect(r.observation).toContain('truncated="true"');
    // Page 1 fits because 5000 < 6000; page 2 doesn't fit (5000 + 5000 > 6000) so we cut at the boundary.
    expect(r.observation).toContain("AAAAA");
    expect(r.observation).not.toContain("BBBBB");
    expect(r.observation).not.toContain("CCCCC");
    const calls = vi.mocked(offscreen.sendToOffscreen).mock.calls;
    expect(calls[0][0]).toMatchObject({ type: "pdf:outline" });
    expect(calls[1][0]).toMatchObject({ type: "pdf:read_page" });
  });

  it("propagates offscreen-side error verbatim", async () => {
    mockTab("https://x/a.pdf");
    vi.spyOn(offscreen, "sendToOffscreen").mockRejectedValue(new Error("encrypted_pdf: needs password"));
    const r = await readPdfTool.handler({}, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/encrypted_pdf/);
  });
});
