import { describe, it, expect, vi } from "vitest";
import { handleMessage, createState, type ParsedPdf } from "./pdf-parser";

const sample: ParsedPdf = {
  totalPages: 3,
  title: "Sample",
  outline: [{ level: 1, title: "Intro", page: 1 }],
  pages: [
    { page: 1, text: "Hello world. Hello PDF." },
    { page: 2, text: "Page two content with the word hello." },
    { page: 3, text: "" },
  ],
};

function fakeFetch() {
  return vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(8),
  })) as unknown as typeof fetch;
}

describe("offscreen pdf-parser dispatch", () => {
  it("pdf:outline parses on first call and caches the result", async () => {
    const state = createState();
    const parseBytes = vi.fn(async () => sample);
    const fetchImpl = fakeFetch();
    const deps = { parseBytes, fetchImpl };

    const r1 = await handleMessage(
      { type: "pdf:outline", url: "https://x/a.pdf" },
      state,
      deps,
    );
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.result).toEqual({
        title: "Sample",
        total_pages: 3,
        outline: [{ level: 1, title: "Intro", page: 1 }],
      });
    }
    expect(parseBytes).toHaveBeenCalledTimes(1);

    const r2 = await handleMessage(
      { type: "pdf:outline", url: "https://x/a.pdf" },
      state,
      deps,
    );
    expect(r2.ok).toBe(true);
    expect(parseBytes).toHaveBeenCalledTimes(1); // cache hit
  });

  it("pdf:read_page returns pages by 1-indexed numbers", async () => {
    const state = createState();
    const deps = { parseBytes: vi.fn(async () => sample), fetchImpl: fakeFetch() };
    const r = await handleMessage(
      { type: "pdf:read_page", url: "u", pages: [1, 2] },
      state,
      deps,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const result = r.result as {
        pages: Array<{ page: number; text: string }>;
        total_pages: number;
      };
      expect(result.total_pages).toBe(3);
      expect(result.pages.map((p) => p.page)).toEqual([1, 2]);
      expect(result.pages[0].text).toMatch(/Hello world/);
    }
  });

  it("pdf:search returns matches with snippets across pages", async () => {
    const state = createState();
    const deps = { parseBytes: vi.fn(async () => sample), fetchImpl: fakeFetch() };
    const r = await handleMessage(
      { type: "pdf:search", url: "u", query: "hello", maxResults: 10 },
      state,
      deps,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const result = r.result as {
        matches: Array<{ page: number; snippet: string; match_offset: number }>;
        total_matches: number;
      };
      // Two hits on page 1, one on page 2 → total_matches >= 3.
      expect(result.total_matches).toBeGreaterThanOrEqual(3);
      expect(result.matches[0].snippet.toLowerCase()).toContain("hello");
    }
  });

  it("reports scanned_pdf when every page has empty text", async () => {
    const state = createState();
    const empty: ParsedPdf = {
      totalPages: 2,
      title: null,
      outline: [],
      pages: [
        { page: 1, text: "  \n " },
        { page: 2, text: "" },
      ],
    };
    const deps = { parseBytes: vi.fn(async () => empty), fetchImpl: fakeFetch() };
    const r = await handleMessage(
      { type: "pdf:outline", url: "scan" },
      state,
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/scanned_pdf/);
  });

  it("reports fetch_failed on non-OK fetch", async () => {
    const state = createState();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    const deps = { parseBytes: vi.fn(async () => sample), fetchImpl };
    const r = await handleMessage(
      { type: "pdf:outline", url: "u" },
      state,
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/fetch_failed.*404/);
  });

  it("reports too_large for >100MB payloads", async () => {
    const state = createState();
    const big = new ArrayBuffer(101 * 1024 * 1024);
    const fetchImpl = vi.fn(async () => ({ ok: true, arrayBuffer: async () => big })) as unknown as typeof fetch;
    const deps = { parseBytes: vi.fn(async () => sample), fetchImpl };
    const r = await handleMessage(
      { type: "pdf:outline", url: "u" },
      state,
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too_large/);
  });
});
