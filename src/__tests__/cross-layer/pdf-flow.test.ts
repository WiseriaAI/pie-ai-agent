import { describe, it, expect, vi, beforeEach } from "vitest";
import { readPdfTool, searchPdfTool, getPdfOutlineTool } from "@/lib/agent/tools/pdf";

function installChromeMock(initial: {
  url: string;
  outline: {
    title: string | null;
    total_pages: number;
    outline: Array<{ level: number; title: string; page: number }>;
  };
  pagesByNumber: Map<number, string>;
  fileAccessAllowed?: boolean;
}) {
  const sendMessage = vi.fn(async (msg: unknown) => {
    const m = msg as { type: string; pages?: number[]; query?: string };
    if (m.type === "pdf:outline") return { ok: true, result: initial.outline };
    if (m.type === "pdf:read_page") {
      const pages = (m.pages ?? []).map((p) => ({
        page: p,
        text: initial.pagesByNumber.get(p) ?? "",
      }));
      return {
        ok: true,
        result: { pages, total_pages: initial.outline.total_pages },
      };
    }
    if (m.type === "pdf:search") {
      const query = (m.query ?? "").toLowerCase();
      const matches: Array<{ page: number; snippet: string; match_offset: number }> = [];
      for (const [page, text] of initial.pagesByNumber.entries()) {
        const idx = text.toLowerCase().indexOf(query);
        if (idx !== -1) {
          matches.push({
            page,
            snippet: text.slice(Math.max(0, idx - 20), idx + 20),
            match_offset: idx,
          });
        }
      }
      return { ok: true, result: { matches, total_matches: matches.length } };
    }
    return { ok: false, error: "unknown_message" };
  });

  vi.stubGlobal("chrome", {
    tabs: {
      get: vi.fn(async () => ({ id: 7, url: initial.url } as chrome.tabs.Tab)),
    },
    extension: {
      isAllowedFileSchemeAccess: vi.fn(async () => initial.fileAccessAllowed ?? true),
    },
    runtime: {
      getURL: (p: string) => `chrome-extension://abc/${p}`,
      sendMessage,
      id: "abc",
    },
    offscreen: {
      createDocument: vi.fn(async () => {}),
      hasDocument: vi.fn(async () => true),
      Reason: { BLOBS: "BLOBS" },
    },
  });
  return { sendMessage };
}

describe("pdf-flow cross-layer", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("outline → read → search roundtrip for a remote PDF", async () => {
    const { sendMessage } = installChromeMock({
      url: "https://x/a.pdf",
      outline: {
        title: "Paper",
        total_pages: 3,
        outline: [{ level: 1, title: "Intro", page: 1 }],
      },
      pagesByNumber: new Map([
        [1, "Hello world. The cat sat."],
        [2, "Cats and dogs cohabit."],
        [3, "Conclusion."],
      ]),
    });

    const outline = await getPdfOutlineTool.handler({}, { tabId: 7 } as never);
    expect(outline.success).toBe(true);
    expect(outline.observation).toContain('title="Paper"');

    const read = await readPdfTool.handler({ page_range: "1-2" }, { tabId: 7 } as never);
    expect(read.success).toBe(true);
    expect(read.observation).toContain("Hello world");
    expect(read.observation).toContain("Cats and dogs");

    const search = await searchPdfTool.handler({ query: "cat" }, { tabId: 7 } as never);
    expect(search.success).toBe(true);
    expect(search.observation).toContain('total_matches="2"');

    // Confirm: all calls went through chrome.runtime.sendMessage with target=offscreen.
    expect(sendMessage).toHaveBeenCalled();
    for (const call of sendMessage.mock.calls) {
      expect((call[0] as { target?: string }).target).toBe("offscreen");
    }
  });

  it("returns file_access_denied for file:// when permission is off", async () => {
    installChromeMock({
      url: "file:///Users/me/a.pdf",
      outline: { title: null, total_pages: 1, outline: [] },
      pagesByNumber: new Map([[1, "x"]]),
      fileAccessAllowed: false,
    });
    const r = await readPdfTool.handler({}, { tabId: 7 } as never);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/file_access_denied/);
  });
});
