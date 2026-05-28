import { describe, it, expect, beforeEach, vi } from "vitest";
import { readPageTool } from "./read-page";
import { pageSnapshotInjected } from "../../dom-actions/page-snapshot";

describe("read_page tool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("返回 success + observation 含 frame_map + per-frame HTML", async () => {
    const fakeTab = { id: 7, url: "https://example.com/", discarded: false };
    const executeScript = vi.fn().mockResolvedValue([
      { frameId: 0, result: { html: "<h1>Hi</h1>", scrollableHints: [] } },
    ]);
    vi.stubGlobal("chrome", {
      tabs: { get: vi.fn().mockResolvedValue(fakeTab) },
      scripting: { executeScript },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, url: "https://example.com/" },
        ]),
      },
    });

    const result = await readPageTool.handler({ tabId: 7 }, {} as any);
    expect(result.success).toBe(true);
    expect(result.observation).toContain('Current URL: https://example.com/');
    expect(result.observation).toContain('<frame_map>');
    expect(result.observation).toContain('frame_id="0"');
    expect(result.observation).toContain('<untrusted_page_content frame_id="0">');
    expect(result.observation).toContain('<h1>Hi</h1>');
    const calls = (executeScript as any).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][0].func).toBe(pageSnapshotInjected);
  });

  it("cross-origin frame 加 cross_origin=true 标记", async () => {
    vi.stubGlobal("chrome", {
      tabs: { get: vi.fn().mockResolvedValue({ id: 7, url: "https://parent.com/", discarded: false }) },
      scripting: {
        executeScript: vi.fn().mockResolvedValue([
          { frameId: 0, result: { html: "<h1>P</h1>", scrollableHints: [] } },
          { frameId: 3, result: { html: "<h2>C</h2>", scrollableHints: [] } },
        ]),
      },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, url: "https://parent.com/" },
          { frameId: 3, url: "https://child.com/widget" },
        ]),
      },
    });
    const r = await readPageTool.handler({ tabId: 7 }, {} as any);
    expect(r.observation).toMatch(/frame_id="3".*cross_origin="true"/);
  });

  it("unreachable frame 输出 unreachable 块", async () => {
    vi.stubGlobal("chrome", {
      tabs: { get: vi.fn().mockResolvedValue({ id: 7, url: "https://x.com/", discarded: false }) },
      scripting: {
        executeScript: vi.fn().mockResolvedValue([{ frameId: 0, result: { html: "", scrollableHints: [] } }]),
      },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, url: "https://x.com/" },
          { frameId: 5, url: "about:blank", errorOccurred: false },
        ]),
      },
    });
    const r = await readPageTool.handler({ tabId: 7 }, {} as any);
    expect(r.observation).toMatch(/frame_id="5".*unreachable="true".*reason="about-blank"/s);
  });

  it("拒 restrictedScheme URL", async () => {
    vi.stubGlobal("chrome", {
      tabs: { get: vi.fn().mockResolvedValue({ id: 7, url: "chrome://settings/", discarded: false }) },
    });
    const r = await readPageTool.handler({ tabId: 7 }, {} as any);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/restricted/i);
  });

  it("iframe data-pie-iframe-position 在父 frame HTML 中被改写为 data-frame-id + 占位文本", async () => {
    vi.stubGlobal("chrome", {
      tabs: { get: vi.fn().mockResolvedValue({ id: 7, url: "https://parent.com/", title: "P", discarded: false }) },
      scripting: {
        executeScript: vi.fn().mockResolvedValue([
          { frameId: 0, result: { html: '<main><iframe data-pie-iframe-position="0">[iframe placeholder]</iframe></main>', scrollableHints: [] } },
          { frameId: 9, result: { html: "<p>child</p>", scrollableHints: [] } },
        ]),
      },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, parentFrameId: -1, url: "https://parent.com/" },
          { frameId: 9, parentFrameId: 0, url: "https://child.com/" },
        ]),
      },
    });
    const r = await readPageTool.handler({ tabId: 7 }, {} as any);
    expect(r.observation).toMatch(/<iframe data-frame-id="9">\[内容见 frame_id=9\]<\/iframe>/);
    expect(r.observation).not.toContain("data-pie-iframe-position");
  });

  it("超 50KB 总预算时按 frame 顺序截断后续 frame", async () => {
    const big = "x".repeat(60_000);
    vi.stubGlobal("chrome", {
      tabs: { get: vi.fn().mockResolvedValue({ id: 7, url: "https://x.com/", discarded: false }) },
      scripting: {
        executeScript: vi.fn().mockResolvedValue([
          { frameId: 0, result: { html: big, scrollableHints: [] } },
          { frameId: 3, result: { html: "small", scrollableHints: [] } },
        ]),
      },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, url: "https://x.com/" },
          { frameId: 3, url: "https://x.com/sub" },
        ]),
      },
    });
    const r = await readPageTool.handler({ tabId: 7 }, {} as any);
    expect(r.observation).toMatch(/frame_id="0".*truncated="true"/s);
    expect(r.observation).toMatch(/frame_id="3".*unread="budget"/s);
  });

  it("returns pdf_tab error when the target tab url ends in .pdf", async () => {
    // Use vi.stubGlobal to get a fresh mock — consistent with other tests in this file.
    const executeScript = vi.fn();
    const tabsGet = vi.fn().mockResolvedValue({
      id: 42,
      url: "https://arxiv.org/pdf/2401.12345.pdf",
    } as chrome.tabs.Tab);
    vi.stubGlobal("chrome", {
      tabs: { get: tabsGet },
      scripting: { executeScript },
    });

    const r = await readPageTool.handler({ tabId: 42 }, {} as never);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/pdf_tab/);
    expect(r.error).toMatch(/read_pdf/);
    // Make sure we never reached executeScript
    expect(executeScript).not.toHaveBeenCalled();
    expect(tabsGet).toHaveBeenCalledWith(42);
  });
});
