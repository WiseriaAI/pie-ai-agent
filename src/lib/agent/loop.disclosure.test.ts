import { describe, expect, it } from "vitest";
import { seedActiveGroups } from "./loop";

describe("seedActiveGroups", () => {
  it("no env signals → core only", () => {
    const s = seedActiveGroups({ vision: false, hasSkills: false, isPdf: false, isFile: false });
    expect([...s].sort()).toEqual(["core"]);
  });
  it("vision + skills → core + screenshot + skill-mediation", () => {
    const s = seedActiveGroups({ vision: true, hasSkills: true, isPdf: false, isFile: false });
    expect(s.has("core")).toBe(true);
    expect(s.has("screenshot")).toBe(true);
    expect(s.has("skill-mediation")).toBe(true);
  });
  it("never seeds lazy groups (they are pulled in via load_tools at runtime)", () => {
    const s = seedActiveGroups({ vision: true, hasSkills: true, isPdf: false, isFile: false });
    for (const g of ["scratchpad", "schedule", "skill-authoring"]) {
      expect(s.has(g)).toBe(false);
    }
  });
});
