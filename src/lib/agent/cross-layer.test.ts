import { describe, it, expect } from "vitest";
import "@/test/setup";
import { buildObservationMessage } from "./prompt";
import type { PageSnapshot } from "@/lib/dom-actions/types";

describe("Cross-layer PageSnapshot.semantic → agentMessages (#44)", () => {
  function fakeSnapshot(): PageSnapshot {
    return {
      url: "https://example.com/issues/new",
      title: "New Issue",
      frames: [
        {
          frameId: 0,
          frameUrl: "https://example.com/issues/new",
          origin: "https://example.com",
          crossOrigin: false,
          parentFrameId: null,
          elements: [
            {
              index: 0,
              tag: "input",
              text: "",
              placeholder: "Title",
              label: "Issue title",
              error: "Title is required",
              disabled: false,
              region: "main",
              boundingBox: { x: 0, y: 0, width: 200, height: 30 },
            },
          ],
        },
      ],
      semantic: {
        headings: [
          { level: 1, text: "Open a new issue" },
          { level: 2, text: "Add a description" },
        ],
        alerts: ["Title is required"],
        status: ["Loading templates..."],
      },
    };
  }

  it("Semantic: block survives structuredClone (mirrors storage round-trip)", () => {
    const snap = fakeSnapshot();
    const observation = buildObservationMessage(snap, snap.url);
    const message = { role: "user" as const, content: observation };

    const cloned = structuredClone(message);

    expect(cloned.content).toContain("Semantic:");
    expect(cloned.content).toContain("    H1: Open a new issue");
    expect(cloned.content).toContain('    - "Title is required"');
    expect(cloned.content).toContain('    - "Loading templates..."');
    expect(cloned.content).toContain('label="Issue title"');
    expect(cloned.content).toContain('error="Title is required"');
  });

  it("HARD INVARIANT: wrapper-tag literals injected into semantic fields stay [filtered] across the wire", () => {
    const snap = fakeSnapshot();
    snap.semantic.alerts = ["[filtered] attempt"];
    snap.semantic.headings = [{ level: 1, text: "Title [filtered] suffix" }];
    const observation = buildObservationMessage(snap, snap.url);
    const cloned = structuredClone({ role: "user" as const, content: observation });

    // With multi-frame format, each frame has its own <untrusted_page_content> block.
    // The top frame (frame_id=0) block has exactly one opening + one closing.
    const openCount = (cloned.content.match(/<untrusted_page_content/g) || []).length;
    const closeCount = (cloned.content.match(/<\/untrusted_page_content>/g) || []).length;
    // Open = 1 per frame; we have 1 frame → 1 open + 1 close.
    expect(openCount).toBe(1);
    expect(closeCount).toBe(1);
    expect(cloned.content).toContain("[filtered]");
  });

  it("empty semantic does not emit a Semantic: block (avoids noise on plain pages)", () => {
    const snap = fakeSnapshot();
    snap.semantic = { headings: [], alerts: [], status: [] };
    snap.frames[0].elements = [];
    const observation = buildObservationMessage(snap, snap.url);
    expect(observation).not.toContain("Semantic:");
    expect(observation).toContain("Elements:");
  });
});
