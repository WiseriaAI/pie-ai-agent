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
      "---",
      "",
      "Extract the fields the user asked for.",
    ].join("\n");

    const { frontmatter, body } = parseSkillMarkdown(md);
    expect(frontmatter.name).toBe("Extract Data");
    expect(frontmatter.description).toBe("抽取页面字段");
    expect(frontmatter.version).toBe("1.0.0");
    expect(frontmatter.inputs).toEqual(["fields: 哪些字段", "format: json 或 csv"]);
    expect(body.trim()).toBe("Extract the fields the user asked for.");
  });

  it("老 idb 包带完整 capabilities 嵌套块 → name/description/正文 仍正确解析（残留字段无害）", () => {
    // capabilities frontmatter 已删（issue #303），但历史 idb 包的 SKILL.md 里仍可能
    // 带这个嵌套块。解析器不能因此崩，也不能把 capabilities 下的列表项误挂到必填字段上。
    const md = [
      "---",
      "name: Legacy Skill",
      "description: 带老 capabilities 块",
      "version: 2.1.0",
      "capabilities:",
      "  tools:",
      "    - read_page",
      "    - click",
      "  scripts:",
      "    - scripts/dedupe.js",
      "  hosts:",
      "    - api.example.com",
      "inputs:",
      "  - fields: 哪些字段",
      "---",
      "",
      "Body after capabilities.",
    ].join("\n");

    const { frontmatter, body } = parseSkillMarkdown(md);
    expect(frontmatter.name).toBe("Legacy Skill");
    expect(frontmatter.description).toBe("带老 capabilities 块");
    expect(frontmatter.version).toBe("2.1.0");
    expect(frontmatter.inputs).toEqual(["fields: 哪些字段"]);
    expect(body.trim()).toBe("Body after capabilities.");
  });

  it("capabilities 内联数组形（tools: [a, b]）→ 仍不影响必填字段", () => {
    const md = [
      "---",
      "name: Inline Caps",
      "description: 内联能力数组",
      "capabilities:",
      "  tools: [read_page, click]",
      "---",
      "body",
    ].join("\n");

    const { frontmatter } = parseSkillMarkdown(md);
    expect(frontmatter.name).toBe("Inline Caps");
    expect(frontmatter.description).toBe("内联能力数组");
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
