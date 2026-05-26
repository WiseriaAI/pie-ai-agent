import { describe, it, expect } from "vitest";
import "@/test/setup";
import { buildObservationMessage } from "./prompt";

describe("Cross-layer title + url → agentMessages (#44 / Phase 3)", () => {
  it("Phase 3: observation emits url + title only (no elements pushed)", () => {
    const observation = buildObservationMessage("New Issue", "https://example.com/issues/new");
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
    const observation = buildObservationMessage("New Issue", "https://example.com/issues/new");
    const message = { role: "user" as const, content: observation };
    const cloned = structuredClone(message);

    expect(cloned.content).toBe(observation);
  });
});
