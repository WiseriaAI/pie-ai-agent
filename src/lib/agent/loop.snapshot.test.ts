import { describe, expect, it } from "vitest";
import { mergeSessionAgentSnapshot, buildSessionAgentSnapshot } from "./loop";

describe("activeToolGroups survives the per-step snapshot merge", () => {
  it("merge preserves a previously-written activeToolGroups", () => {
    // existing = the persisted state that has activeToolGroups written by Task 7
    const existing = {
      agentMessages: [],
      pendingInstructions: [],
      stepIndex: 2,
      hasImageContent: false,
      activeToolGroups: ["core", "pdf"],
    };
    // fresh = the per-step snapshot produced by buildSessionAgentSnapshot
    // (carries agentMessages / stepIndex / hasImageContent; no activeToolGroups)
    const fresh = buildSessionAgentSnapshot([], 3, false);
    // Real signature: mergeSessionAgentSnapshot(existing, snapshot)
    // Merge: { ...existing, ...snapshot } so snapshot wins for the three fields
    // it carries, but activeToolGroups (only in existing) is preserved.
    const merged = mergeSessionAgentSnapshot(existing, fresh);
    expect(merged.activeToolGroups).toEqual(["core", "pdf"]);
    expect(merged.stepIndex).toBe(3);
  });
});
