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
      "  tools: [get_tab_content, click]",
      "---",
      "",
      "Extract the fields the user asked for.",
    ].join("\n");

    const { frontmatter, body } = parseSkillMarkdown(md);
    expect(frontmatter.name).toBe("Extract Data");
    expect(frontmatter.description).toBe("抽取页面字段");
    expect(frontmatter.version).toBe("1.0.0");
    expect(frontmatter.inputs).toEqual(["fields: 哪些字段", "format: json 或 csv"]);
    expect(frontmatter.capabilities?.tools).toEqual(["get_tab_content", "click"]);
    expect(body.trim()).toBe("Extract the fields the user asked for.");
  });

  it("无 frontmatter 时抛错(name/description 必填)", () => {
    expect(() => parseSkillMarkdown("just body, no fence")).toThrow(/frontmatter/i);
  });

  it("缺 name 抛错", () => {
    const md = "---\ndescription: x\n---\nbody";
    expect(() => parseSkillMarkdown(md)).toThrow(/name/i);
  });
});
