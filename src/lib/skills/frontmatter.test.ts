import { describe, it, expect } from "vitest";
import { parseSkillMarkdown } from "./frontmatter";

describe("parseSkillMarkdown", () => {
  it("拆出 frontmatter 与 body", () => {
    const md = [
      "---",
      "name: Extract Data",
      "description: 抽取页面字段",
      "version: 1.0.0",
      "inputs:",
      "  - fields: 哪些字段",
      "  - format: json 或 csv",
      "capabilities:",
      "  tools: [read_page, click]",
      "---",
      "",
      "Extract the fields the user asked for.",
    ].join("\n");

    const { frontmatter, body } = parseSkillMarkdown(md);
    expect(frontmatter.name).toBe("Extract Data");
    expect(frontmatter.description).toBe("抽取页面字段");
    expect(frontmatter.version).toBe("1.0.0");
    expect(frontmatter.inputs).toEqual(["fields: 哪些字段", "format: json 或 csv"]);
    expect(frontmatter.capabilities?.tools).toEqual(["read_page", "click"]);
    expect(body.trim()).toBe("Extract the fields the user asked for.");
  });

  it("解析 capabilities 下的块状列表", () => {
    const md = [
      "---",
      "name: Block List",
      "description: 块状列表能力",
      "capabilities:",
      "  tools:",
      "    - read_page",
      "    - click",
      "---",
      "body",
    ].join("\n");

    const { frontmatter } = parseSkillMarkdown(md);
    expect(frontmatter.capabilities?.tools).toEqual(["read_page", "click"]);
  });

  it("处理 CRLF 行尾", () => {
    const md = [
      "---",
      "name: CRLF Skill",
      "description: 带回车换行",
      "---",
      "",
      "Body line.",
    ].join("\r\n");

    const { frontmatter, body } = parseSkillMarkdown(md);
    expect(frontmatter.name).toBe("CRLF Skill");
    expect(frontmatter.description).toBe("带回车换行");
    expect(body.trim()).toBe("Body line.");
  });

  it("无 frontmatter 时抛错(name/description 必填)", () => {
    expect(() => parseSkillMarkdown("just body, no fence")).toThrow(/frontmatter/i);
  });

  it("缺 name 抛错", () => {
    const md = "---\ndescription: x\n---\nbody";
    expect(() => parseSkillMarkdown(md)).toThrow(/name/i);
  });

  it("缺 description 抛错", () => {
    expect(() => parseSkillMarkdown("---\nname: foo\n---\nbody")).toThrow(/description/i);
  });
});
