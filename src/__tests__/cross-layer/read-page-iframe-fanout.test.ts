import { describe, it, expect, beforeEach, vi } from "vitest";
import { readPageTool } from "../../lib/agent/tools/read-page";

describe("read_page iframe fanout cross-layer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("三 frame（top + same-origin + cross-origin），正确标记 cross_origin", async () => {
    vi.stubGlobal("chrome", {
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 1,
          url: "https://parent.com/",
          title: "P",
          discarded: false,
        }),
      },
      scripting: {
        executeScript: vi.fn().mockResolvedValue([
          {
            frameId: 0,
            result: { op: "snapshot" as const, html: "<p>top</p>", interactiveElements: [], scrollableHints: [] },
          },
          {
            frameId: 2,
            result: { op: "snapshot" as const, html: "<p>same</p>", interactiveElements: [], scrollableHints: [] },
          },
          {
            frameId: 3,
            result: { op: "snapshot" as const, html: "<p>cross</p>", interactiveElements: [], scrollableHints: [] },
          },
        ]),
      },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, url: "https://parent.com/" },
          { frameId: 2, url: "https://parent.com/sub" },
          { frameId: 3, url: "https://other.com/widget" },
        ]),
      },
    });

    const r = await readPageTool.handler({ tabId: 1 }, {} as any);
    expect(r.success).toBe(true);

    // All three frames should be in frame_map
    expect(r.observation).toMatch(/frame_id="0"/);
    expect(r.observation).toMatch(/frame_id="2"/);
    expect(r.observation).toMatch(/frame_id="3"[\s\S]*cross_origin="true"/);

    // Same-origin frame 2 should NOT have cross_origin mark in frame_map or blocks
    const frame2Section = r.observation!.match(/frame_id="2".*?(?=frame_id="3"|<\/frame_map>|<untrusted)/s);
    expect(frame2Section?.[0]).not.toMatch(/cross_origin/);

    // All three frames should appear as HTML blocks
    expect(r.observation).toMatch(/<untrusted_page_content frame_id="0">/);
    expect(r.observation).toMatch(/<untrusted_page_content frame_id="2">/);
    expect(r.observation).toMatch(
      /<untrusted_page_content frame_id="3" cross_origin="true">/,
    );
  });
});
