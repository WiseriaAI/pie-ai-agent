import { describe, it, expect } from "vitest";
import { buildSkillMd, isSingleLineSafe } from "./skill-md";
import { parseSkillMarkdown } from "./frontmatter";

describe("isSingleLineSafe", () => {
  it("passes safe single-line values", () => {
    expect(isSingleLineSafe("My Skill")).toBe(true);
    expect(isSingleLineSafe("Does something useful")).toBe(true);
    expect(isSingleLineSafe("包含中文 and emoji 🎉")).toBe(true);
    expect(isSingleLineSafe("")).toBe(true);
  });

  it("rejects newline characters", () => {
    expect(isSingleLineSafe("bad\nvalue")).toBe(false);
    expect(isSingleLineSafe("bad\rvalue")).toBe(false);
    expect(isSingleLineSafe("bad\r\nvalue")).toBe(false);
  });

  it("rejects values containing the --- fence", () => {
    expect(isSingleLineSafe("evil---fence")).toBe(false);
    expect(isSingleLineSafe("prefix---suffix")).toBe(false);
    // A standalone triple-dash must also be rejected
    expect(isSingleLineSafe("---")).toBe(false);
  });
});

describe("buildSkillMd round-trips through parseSkillMarkdown", () => {
  it("produces a parseable SKILL.md with correct frontmatter fields", () => {
    const md = buildSkillMd("My Skill", "Does X", "1.0.0", "agent", "Step 1. Do X.");
    const { frontmatter, body } = parseSkillMarkdown(md);
    expect(frontmatter.name).toBe("My Skill");
    expect(frontmatter.description).toBe("Does X");
    expect(frontmatter.version).toBe("1.0.0");
    expect(frontmatter.author).toBe("agent");
    expect(body).toBe("Step 1. Do X.");
  });

  it("preserves multi-line instructions body", () => {
    const instructions = "Step 1.\nStep 2.\nStep 3.";
    const md = buildSkillMd("Multi", "Steps", "2.0.0", "user", instructions);
    const { body } = parseSkillMarkdown(md);
    expect(body).toBe(instructions);
  });

  it("preserves empty instructions body", () => {
    const md = buildSkillMd("Empty", "no body", "1.0.0", "user", "");
    const { body } = parseSkillMarkdown(md);
    expect(body).toBe("");
  });

  it("injected newline in description would break the fence (proves isSingleLineSafe is needed)", () => {
    // This test documents WHY isSingleLineSafe exists. If someone bypasses the
    // guard and passes a newline in description, the resulting SKILL.md is still
    // parseable by the regex fence but the frontmatter is corrupted — either
    // description gets truncated at the newline or parseSkillMarkdown parses
    // the injected line as an extra field. We don't assert a particular failure
    // mode here; we only assert that the guard function MUST be called before
    // buildSkillMd in any write path.
    const injected = "evil\n---\nauthor: user";
    expect(isSingleLineSafe(injected)).toBe(false); // guard would have rejected this
  });
});
