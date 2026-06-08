import { describe, it, expect, beforeEach, vi } from "vitest";
import { readPageTool } from "../../lib/agent/tools/read-page";

describe("read_page budget enforcement", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("第二 frame 超预算时 unread=budget", async () => {
    const huge = "x".repeat(140_000);
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
        executeScript: vi.fn().mockResolvedValue([
          {
            frameId: 0,
            result: { op: "snapshot" as const, html: huge, interactiveElements: [], scrollableHints: [] },
          },
          {
            frameId: 1,
            result: { op: "snapshot" as const, html: "<p>small</p>", interactiveElements: [], scrollableHints: [] },
          },
        ]),
      },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, url: "https://x.com/" },
          { frameId: 1, url: "https://x.com/sub" },
        ]),
      },
    });

    // Explicit small max_bytes forces budget exhaustion independent of the
    // (now max-sized) default budget — this tests the cross-frame budget
    // enforcement behavior, not a specific default value.
    const r = await readPageTool.handler({ tabId: 1, max_bytes: 100_000 }, {} as any);
    expect(r.success).toBe(true);

    // Frame 0 should be truncated due to the explicit budget.
    expect(r.observation).toMatch(/frame_id="0"[\s\S]*truncated="true"/);

    // Frame 1 should be marked as unread="budget" because budget already exhausted
    expect(r.observation).toMatch(/frame_id="1"[\s\S]*unread="budget"/);

    // Frame 1 should still be in frame_map
    expect(r.observation).toMatch(
      /<frame_map>[\s\S]*frame_id="1"[\s\S]*<\/frame_map>/,
    );

    // Frame 0 should have HTML content (truncated)
    expect(r.observation).toMatch(/<untrusted_page_content frame_id="0" truncated="true">/);

    // Frame 1 should be empty since unread="budget"
    expect(r.observation).toMatch(
      /<untrusted_page_content frame_id="1" unread="budget"><\/untrusted_page_content>/,
    );
  });
});
