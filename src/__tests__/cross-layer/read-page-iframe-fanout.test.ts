import { describe, it, expect, beforeEach, vi } from "vitest";
import { readPageTool } from "../../lib/agent/tools/read-page";
import { resetRegistry, getFrameVersion } from "../../lib/agent/tools/page-version-registry";

describe("read_page iframe fanout cross-layer", () => {
  beforeEach(() => {
    resetRegistry();
    vi.restoreAllMocks();
  });

  it("三 frame（top + same-origin + cross-origin），每个 frame 独立 version", async () => {
    let scriptCallCount = 0;
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
        executeScript: vi.fn().mockImplementation(() => {
          scriptCallCount++;
          // First call: bootstrap
          if (scriptCallCount === 1) {
            return Promise.resolve([
              { frameId: 0, result: { installed: true } },
              { frameId: 2, result: { installed: true } },
              { frameId: 3, result: { installed: true } },
            ]);
          }
          // Second call: page-snapshot
          return Promise.resolve([
            {
              frameId: 0,
              result: { html: "<p>top</p>", version: 1, scrollableHints: [] },
            },
            {
              frameId: 2,
              result: { html: "<p>same</p>", version: 5, scrollableHints: [] },
            },
            {
              frameId: 3,
              result: { html: "<p>cross</p>", version: 8, scrollableHints: [] },
            },
          ]);
        }),
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

    // All three frames should be in frame_map with their respective versions
    expect(r.observation).toMatch(/frame_id="0"[\s\S]*version="1"/);
    expect(r.observation).toMatch(/frame_id="2"[\s\S]*version="5"/);
    expect(r.observation).toMatch(/frame_id="3"[\s\S]*version="8"[\s\S]*cross_origin="true"/);

    // Same-origin frame 2 should NOT have cross_origin mark in frame_map or blocks
    const frame2Section = r.observation.match(/frame_id="2".*?(?=frame_id="3"|<\/frame_map>|<untrusted)/s);
    expect(frame2Section?.[0]).not.toMatch(/cross_origin/);

    // Registry should have all three versions
    expect(getFrameVersion(1, 0)).toEqual({ version: 1 });
    expect(getFrameVersion(1, 2)).toEqual({ version: 5 });
    expect(getFrameVersion(1, 3)).toEqual({ version: 8 });

    // All three frames should appear as HTML blocks
    expect(r.observation).toMatch(/<untrusted_page_content frame_id="0" frame_version="1">/);
    expect(r.observation).toMatch(/<untrusted_page_content frame_id="2" frame_version="5">/);
    expect(r.observation).toMatch(
      /<untrusted_page_content frame_id="3" frame_version="8" cross_origin="true">/,
    );
  });
});
