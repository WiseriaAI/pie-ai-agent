import { describe, it, expect } from "vitest";
import { buildSkillMd, patchSkillMd, isSingleLineSafe } from "./skill-md";
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

describe("patchSkillMd（frontmatter 保真更新）", () => {
  it("替换 name/description、追加缺失的 author，其余 frontmatter（metadata.pie/license）原样保留", () => {
    const md = `---
name: web-fetch
description: old desc
license: MIT
allowed-tools: [read_page]
metadata:
  pie:
    network: [api.example.com]
    write: [~/Documents/pie-out]
---
OLD BODY`;
    const out = patchSkillMd(md, { name: "web-fetch", description: "new desc", author: "agent" }, "NEW BODY");
    expect(out).toContain("description: new desc");
    expect(out).not.toContain("old desc");
    expect(out).toContain("author: agent"); // 原文没有 author → 追加
    expect(out).toContain("license: MIT");
    expect(out).toContain("allowed-tools: [read_page]");
    expect(out).toContain("network: [api.example.com]");
    expect(out).toContain("write: [~/Documents/pie-out]");
    expect(out.endsWith("NEW BODY")).toBe(true);
    expect(out).not.toContain("OLD BODY");
  });

  it("已有 author 行被替换而非重复；version 原样保留", () => {
    const md = buildSkillMd("n", "d", "1.0.0", "user", "b");
    const out = patchSkillMd(md, { name: "n2", description: "d2", author: "agent" }, "b2");
    expect(out.match(/^author:/gm)).toHaveLength(1);
    expect(out).toContain("author: agent");
    expect(out).toContain("version: 1.0.0");
    const { frontmatter, body } = parseSkillMarkdown(out);
    expect(frontmatter.name).toBe("n2");
    expect(frontmatter.description).toBe("d2");
    expect(body).toBe("b2");
  });

  it("只动零缩进的顶层键：metadata 下嵌套的同名键不受影响", () => {
    const md = `---
name: x
metadata:
  name: nested-keep
  description: nested-desc-keep
---
b`;
    const out = patchSkillMd(md, { name: "nx", description: "nd", author: "agent" }, "b");
    expect(out).toContain("  name: nested-keep");
    expect(out).toContain("  description: nested-desc-keep");
    expect(out).toContain("name: nx");
    expect(out).toContain("description: nd"); // 顶层缺失 → 追加
  });

  it("无 frontmatter fence → 退回 buildSkillMd 全新构建", () => {
    const out = patchSkillMd("no fence here", { name: "n", description: "d", author: "user" }, "body");
    expect(out).toBe(buildSkillMd("n", "d", "1.0.0", "user", "body"));
  });
});
