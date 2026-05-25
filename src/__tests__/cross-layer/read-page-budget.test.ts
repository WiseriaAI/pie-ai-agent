import { describe, it, expect, beforeEach, vi } from "vitest";
import { readPageTool } from "../../lib/agent/tools/read-page";
import { resetRegistry, getFrameVersion } from "../../lib/agent/tools/page-version-registry";

describe("read_page budget enforcement", () => {
  beforeEach(() => {
    resetRegistry();
    vi.restoreAllMocks();
  });

  it("第二 frame 超预算时 unread=budget 但仍登记 version", async () => {
    const huge = "x".repeat(55_000);
    let scriptCallCount = 0;
    vi.stubGlobal("chrome", {
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 1,
          url: "https://x.com/",
          title: "",
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
              { frameId: 1, result: { installed: true } },
            ]);
          }
          // Second call: page-snapshot
          return Promise.resolve([
            {
              frameId: 0,
              result: { html: huge, version: 1, scrollableHints: [] },
            },
            {
              frameId: 1,
              result: { html: "<p>small</p>", version: 99, scrollableHints: [] },
            },
          ]);
        }),
      },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, url: "https://x.com/" },
          { frameId: 1, url: "https://x.com/sub" },
        ]),
      },
    });

    const r = await readPageTool.handler({ tabId: 1 }, {} as any);
    expect(r.success).toBe(true);

    // Frame 0 should be truncated due to budget
    expect(r.observation).toMatch(/frame_id="0"[\s\S]*truncated="true"/);

    // Frame 1 should be marked as unread="budget" because budget already exhausted
    expect(r.observation).toMatch(/frame_id="1"[\s\S]*unread="budget"/);

    // Frame 1 should still be in frame_map with its version
    expect(r.observation).toMatch(
      /<frame_map>[\s\S]*frame_id="1"[\s\S]*version="99"[\s\S]*<\/frame_map>/,
    );

    // Both versions should be registered even though frame 1 wasn't fully read
    expect(getFrameVersion(1, 0)).toEqual({ version: 1 });
    expect(getFrameVersion(1, 1)).toEqual({ version: 99 });

    // Frame 0 should have HTML content (truncated)
    expect(r.observation).toMatch(/<untrusted_page_content frame_id="0" frame_version="1" truncated="true">/);

    // Frame 1 should be empty since unread="budget"
    expect(r.observation).toMatch(
      /<untrusted_page_content frame_id="1" frame_version="99" unread="budget"><\/untrusted_page_content>/,
    );
  });
});
