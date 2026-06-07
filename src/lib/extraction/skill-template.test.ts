// src/lib/extraction/skill-template.test.ts
import { describe, it, expect } from "vitest";
import { buildExtractionConfig, buildExtractionSkillMd } from "./skill-template";

const schema = [{ name: "title", type: "string" as const }];

describe("extraction skill template", () => {
  it("buildExtractionConfig 产出 version1 + 默认输出配置", () => {
    const cfg = buildExtractionConfig(schema, "until no next page");
    expect(cfg.version).toBe(1);
    expect(cfg.stopCondition).toBe("until no next page");
    expect(cfg.output).toEqual({ formats: ["csv", "json"], includeSourceColumns: true });
  });
  it("buildExtractionSkillMd 含 frontmatter + 关键执行指令", () => {
    const md = buildExtractionSkillMd("Orders", "extract orders");
    expect(md).toContain("name: Orders");
    expect(md).toContain('read_skill_file');
    expect(md).toContain("extraction.json");
    expect(md).toContain("max_bytes");
    expect(md).toContain("output_extraction");
    expect(md).toContain("add_extraction_rows");
    expect(md).toContain("_source");
  });
});
