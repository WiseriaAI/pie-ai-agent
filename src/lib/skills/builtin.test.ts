import { describe, it, expect } from "vitest";
import { BUILT_IN_SKILL_PACKAGES } from "./builtin";
import { parseSkillMarkdown } from "./frontmatter";

describe("BUILT_IN_SKILL_PACKAGES", () => {
  it("每个包都有 SKILL.md 且能解析", () => {
    expect(BUILT_IN_SKILL_PACKAGES.length).toBeGreaterThan(0);
    for (const pkg of BUILT_IN_SKILL_PACKAGES) {
      expect(pkg.builtIn).toBe(true);
      expect(pkg.files["SKILL.md"]).toBeTruthy();
      const { frontmatter } = parseSkillMarkdown(pkg.files["SKILL.md"]);
      expect(frontmatter.name).toBe(pkg.frontmatter.name);
    }
  });

  it("包含 extract / group / dedupe 三个内置技能", () => {
    const ids = BUILT_IN_SKILL_PACKAGES.map((p) => p.id);
    expect(ids).toContain("extract_structured_data");
    expect(ids).toContain("auto_group_tabs");
    expect(ids).toContain("close_duplicate_tabs");
  });

  it("extract_structured_data 引导 schema 提议/预览/保存 + 多页 + output_extraction", () => {
    const p = BUILT_IN_SKILL_PACKAGES.find((x) => x.id === "extract_structured_data")!;
    const md = p.files["SKILL.md"];
    for (const kw of ["read_page", "max_bytes", "schema", "preview", "save_extraction_skill", "add_extraction_rows", "output_extraction", "_source"]) {
      expect(md).toContain(kw);
    }
  });
});
