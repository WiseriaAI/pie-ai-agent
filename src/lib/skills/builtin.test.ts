import { describe, it, expect } from "vitest";
import { BUILT_IN_SKILLS } from "./builtin";

describe("BUILT_IN_SKILLS audit (spec 2026-05-08)", () => {
  it("contains exactly the 5 expected skills after thin-shell removal", () => {
    const ids = BUILT_IN_SKILLS.map((s) => s.id).sort();
    expect(ids).toEqual([
      "auto_group_tabs",
      "close_duplicate_tabs",
      "close_inactive_tabs",
      "create_skill_from_recording",
      "extract_structured_data",
    ]);
  });

  it("does NOT contain removed thin-shell skills", () => {
    const ids = new Set(BUILT_IN_SKILLS.map((s) => s.id));
    expect(ids.has("take_screenshot")).toBe(false);
    expect(ids.has("open_url_in_tab")).toBe(false);
  });

  it("every entry has builtIn: true (P0-A regression guard)", () => {
    for (const skill of BUILT_IN_SKILLS) {
      expect(skill.builtIn).toBe(true);
    }
  });
});
