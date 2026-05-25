import { describe, it, expect } from "vitest";
import "@/test/setup";
import { buildObservationMessage } from "./prompt";
import type { PageSnapshot } from "@/lib/dom-actions/types";

describe("Cross-layer PageSnapshot → agentMessages (#44 / Phase 3)", () => {
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

  it("Phase 3: observation emits url + title only (no elements pushed)", () => {
    const snap = fakeSnapshot();
    const observation = buildObservationMessage(snap, snap.url);
    const message = { role: "user" as const, content: observation };
    const cloned = structuredClone(message);

    expect(cloned.content).toContain("Current URL: https://example.com/issues/new");
    expect(cloned.content).toContain("Page title: New Issue");
    expect(cloned.content).not.toContain("Semantic:");
    expect(cloned.content).not.toContain("<untrusted_page_content");
    expect(cloned.content).not.toContain("label=");
    expect(cloned.content).not.toContain("error=");
  });

  it("Phase 3: observation survives structuredClone (storage round-trip)", () => {
    const snap = fakeSnapshot();
    const observation = buildObservationMessage(snap, snap.url);
    const message = { role: "user" as const, content: observation };
    const cloned = structuredClone(message);

    expect(cloned.content).toBe(observation);
  });
});
