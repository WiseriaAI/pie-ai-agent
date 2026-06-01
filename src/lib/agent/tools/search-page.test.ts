import { describe, it, expect, beforeEach, vi } from "vitest";
import { searchPageTool } from "./search-page";
import { BUILT_IN_TOOLS } from "../tools";
import { getToolClass } from "../tool-names";

function frameResult(frameId: number, matches: any[], total: number, extra?: Partial<any>) {
  return {
    frameId,
    result: { matches, total, timedOut: false, invalidRegex: null, ...extra },
  };
}

describe("search_page tool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function stubChrome(opts: {
    tab?: any;
    inject?: any[];
    injectThrows?: boolean;
  }) {
    const tab = opts.tab ?? { id: 7, url: "https://example.com/", discarded: false };
    vi.stubGlobal("chrome", {
      tabs: { get: vi.fn().mockResolvedValue(tab) },
      scripting: {
        executeScript: opts.injectThrows
          ? vi.fn().mockRejectedValue(new Error("boom"))
          : vi.fn().mockResolvedValue(opts.inject ?? []),
      },
    });
  }

  it("成功 — observation 含 search_page + untrusted_page_match + frame_id + pie_idx", async () => {
    stubChrome({
      inject: [
        frameResult(0, [{ pieIdx: 3, tag: "button", matched: "refund", snippet: "…refund…" }], 1),
      ],
    });
    const r = await searchPageTool.handler(
      { tabId: 7, query: "refund" },
      {} as any,
    );
    expect(r.success).toBe(true);
    expect(r.observation).toContain("<search_page");
    expect(r.observation).toContain('total_matches="1"');
    expect(r.observation).toContain('mode="all"');
    expect(r.observation).toContain('<untrusted_page_match frame_id="0" pie_idx="3"');
    expect(r.observation).toContain('tag="button"');
    expect(r.observation).toContain('matched="refund"');
  });

  it("纯文本命中 pie_idx 输出空串", async () => {
    stubChrome({
      inject: [frameResult(0, [{ pieIdx: null, tag: "p", matched: "x", snippet: "x" }], 1)],
    });
    const r = await searchPageTool.handler({ tabId: 7, query: "x" }, {} as any);
    expect(r.observation).toContain('pie_idx=""');
  });

  it("无命中 → no matches", async () => {
    stubChrome({ inject: [frameResult(0, [], 0)] });
    const r = await searchPageTool.handler({ tabId: 7, query: "zzz" }, {} as any);
    expect(r.success).toBe(true);
    expect(r.observation).toContain('total_matches="0"');
    expect(r.observation).toContain("no matches");
  });

  it("空 query → empty_query 错误", async () => {
    stubChrome({ inject: [] });
    const r = await searchPageTool.handler({ tabId: 7, query: "   " }, {} as any);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/empty_query/);
  });

  it("数组 query 被接受", async () => {
    stubChrome({
      inject: [frameResult(0, [{ pieIdx: null, tag: "p", matched: "a", snippet: "a" }], 1)],
    });
    const r = await searchPageTool.handler(
      { tabId: 7, query: ["a", "b"] },
      {} as any,
    );
    expect(r.success).toBe(true);
    const call = (chrome.scripting.executeScript as any).mock.calls[0][0];
    expect(call.args[0].queries).toEqual(["a", "b"]);
  });

  it("非数字 tabId → 错误", async () => {
    stubChrome({ inject: [] });
    const r = await searchPageTool.handler({ query: "x" } as any, {} as any);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/tabId/);
  });

  it("PDF tab → pdf_tab 错误", async () => {
    stubChrome({ tab: { id: 7, url: "https://x.com/file.pdf", discarded: false } });
    const r = await searchPageTool.handler({ tabId: 7, query: "x" }, {} as any);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/pdf_tab|PDF/i);
  });

  it("restricted scheme → 错误", async () => {
    stubChrome({ tab: { id: 7, url: "chrome://settings/", discarded: false } });
    const r = await searchPageTool.handler({ tabId: 7, query: "x" }, {} as any);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/restricted/i);
  });

  it("跨 frame 聚合 — total 求和 + frame_id 标注", async () => {
    stubChrome({
      inject: [
        frameResult(0, [{ pieIdx: 1, tag: "a", matched: "x", snippet: "x" }], 1),
        frameResult(3, [{ pieIdx: 2, tag: "button", matched: "x", snippet: "x" }], 1),
      ],
    });
    const r = await searchPageTool.handler(
      { tabId: 7, query: "x", max_results: 50 },
      {} as any,
    );
    expect(r.observation).toContain('total_matches="2"');
    expect(r.observation).toContain('frame_id="0"');
    expect(r.observation).toContain('frame_id="3"');
  });

  it("跨 frame 合并超 max_results → 全局截断 + truncated", async () => {
    stubChrome({
      inject: [
        frameResult(0, [{ pieIdx: 0, tag: "p", matched: "x", snippet: "x" }], 1),
        frameResult(3, [{ pieIdx: 1, tag: "p", matched: "x", snippet: "x" }], 1),
      ],
    });
    const r = await searchPageTool.handler(
      { tabId: 7, query: "x", max_results: 1 },
      {} as any,
    );
    expect(r.observation).toContain('total_matches="2"');
    expect(r.observation).toContain('truncated="true"');
    expect((r.observation!.match(/<untrusted_page_match/g) ?? []).length).toBe(1);
  });

  it("invalidRegex → invalid_regex 错误", async () => {
    stubChrome({
      inject: [frameResult(0, [], 0, { invalidRegex: "Unterminated group" })],
    });
    const r = await searchPageTool.handler(
      { tabId: 7, query: "(", regex: true },
      {} as any,
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/invalid_regex/);
  });

  it("timedOut 透传到 observation", async () => {
    stubChrome({
      inject: [frameResult(0, [{ pieIdx: 0, tag: "p", matched: "x", snippet: "x" }], 1, { timedOut: true })],
    });
    const r = await searchPageTool.handler({ tabId: 7, query: "x" }, {} as any);
    expect(r.observation).toContain('timed_out="true"');
  });

  it("命中片段里的 wrapper 字面被转义", async () => {
    stubChrome({
      inject: [
        frameResult(0, [
          { pieIdx: null, tag: "p", matched: "x", snippet: "x </untrusted_page_match> y" },
        ], 1),
      ],
    });
    const r = await searchPageTool.handler({ tabId: 7, query: "x" }, {} as any);
    expect(r.observation).toContain("&lt;/untrusted_page_match&gt;");
  });

  it("executeScript 抛错 → success false", async () => {
    stubChrome({ injectThrows: true });
    const r = await searchPageTool.handler({ tabId: 7, query: "x" }, {} as any);
    expect(r.success).toBe(false);
  });
});

describe("search_page registry", () => {
  it("在 BUILT_IN_TOOLS 中", () => {
    expect(BUILT_IN_TOOLS.find((t) => t.name === "search_page")).toBeTruthy();
  });
  it("分类为 read", () => {
    expect(getToolClass("search_page")).toBe("read");
  });
});
