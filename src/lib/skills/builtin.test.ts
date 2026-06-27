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

  it("extract_structured_data 升级为 scratchpad 长程抽取 playbook", () => {
    const extract = BUILT_IN_SKILL_PACKAGES.find((p) => p.id === "extract_structured_data")!;
    const md = extract.files["SKILL.md"];
    // description 进 catalog，须带触发信号（何时调用）
    expect(extract.frontmatter.description).toMatch(/scrape|collect/i);
    // body 编排 scratchpad 工具链 + 导出前与用户确认
    expect(md).toMatch(/scratchpad/i);
    expect(md).toContain("save_scratchpad");
    expect(md).toContain("update_scratchpad_notes");
    expect(md).toContain("query_scratchpad");
    expect(md).toContain("output_file");
    expect(md).toMatch(/before export/i);
    // 旧的单页 output-json playbook 已不再
    expect(md).not.toContain("data-pie-idx");
  });

  it("没有 builtin 残留 capabilities 死配置", () => {
    for (const p of BUILT_IN_SKILL_PACKAGES) {
      expect(p.frontmatter.capabilities).toBeUndefined();
      expect(p.files["SKILL.md"]).not.toContain("capabilities:");
    }
  });

  it("create_skill_from_recording instructs preserving cross-tab steps", () => {
    const pkg = BUILT_IN_SKILL_PACKAGES.find((p) => p.id === "create_skill_from_recording");
    expect(pkg).toBeTruthy();
    const text = JSON.stringify(pkg);
    expect(text).toContain("switch_to_new_tab");
    expect(text).toMatch(/标签页|tab/);
  });
});
