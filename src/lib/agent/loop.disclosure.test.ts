import { describe, expect, it } from "vitest";
import { seedActiveGroups } from "./loop";

describe("seedActiveGroups", () => {
  it("flag ON, no env signals → core only", () => {
    const s = seedActiveGroups({ vision: false, hasSkills: false, isPdf: false, isFile: false }, { progressiveDisclosure: true });
    expect([...s].sort()).toEqual(["core"]);
  });
  it("flag ON + vision + skills → core + screenshot + skill-mediation", () => {
    const s = seedActiveGroups({ vision: true, hasSkills: true, isPdf: false, isFile: false }, { progressiveDisclosure: true });
    expect(s.has("core")).toBe(true);
    expect(s.has("screenshot")).toBe(true);
    expect(s.has("skill-mediation")).toBe(true);
  });
  it("flag OFF → ALL groups active (full disclosure fallback)", () => {
    const s = seedActiveGroups({ vision: false, hasSkills: false, isPdf: false, isFile: false }, { progressiveDisclosure: false });
    for (const g of ["core", "pdf", "scratchpad", "schedule", "skill-authoring", "local-file", "screenshot", "skill-mediation"]) {
      expect(s.has(g)).toBe(true);
    }
  });
});
