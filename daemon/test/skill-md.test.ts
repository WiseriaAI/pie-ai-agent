import { test, expect } from "bun:test";
import { parseSkillMd } from "../src/skill-md";

const SKILL = `---
name: web-fetch
description: Fetch a URL and summarize.
license: MIT
allowed-tools: [read_page]
metadata:
  pie:
    network: [api.example.com, example.com]
    write: [~/Documents/pie-out]
---
# Web Fetch

Body instructions here.
`;

test("parses standard frontmatter incl. metadata.pie caps and body", () => {
  const p = parseSkillMd(SKILL);
  expect(p.name).toBe("web-fetch");
  expect(p.description).toBe("Fetch a URL and summarize.");
  expect(p.declaredCaps.network).toEqual(["api.example.com", "example.com"]);
  expect(p.declaredCaps.write).toEqual(["~/Documents/pie-out"]);
  expect(p.body.trim().startsWith("# Web Fetch")).toBe(true);
});

test("no metadata.pie → empty caps", () => {
  const p = parseSkillMd(`---\nname: x\ndescription: y\n---\nbody\n`);
  expect(p.declaredCaps).toEqual({ network: [], write: [] });
});

test("throws on missing required fields", () => {
  expect(() => parseSkillMd(`---\ndescription: y\n---\nb\n`)).toThrow(/name/);
  expect(() => parseSkillMd(`no fence`)).toThrow(/frontmatter/);
});

test("strict-YAML-hostile frontmatter (colon-space in description) falls back to lenient line parse", () => {
  // 真机案例：2b 时代 IDB skill 迁盘后，description 里的「（skillId: fs-acceptance）」
  // 让 strict yaml 抛 Nested mappings 错 → listSkills 静默跳过 → 磁盘模式看不见 +
  // 迁移每次冷启动重写。宽松回退只提顶层 name/description 行，caps 拿不到给空
  //（默认沙箱兜底，fail-safe）。
  const md = `---
name: fs-acceptance
description: Slice 2b 验收：按用户点名的脚本调 run_skill_script（skillId: fs-acceptance）
capabilities:
  scripts:
    - {"entry": "scripts/save.js", "fs": true}
---
BODY HERE`;
  const p = parseSkillMd(md);
  expect(p.name).toBe("fs-acceptance");
  expect(p.description).toContain("skillId: fs-acceptance");
  expect(p.declaredCaps).toEqual({ network: [], write: [] });
  expect(p.body.trim()).toBe("BODY HERE");
});

test("lenient fallback still throws when name line is absent", () => {
  expect(() => parseSkillMd(`---\ndescription: has: colon but no name\n---\nb`)).toThrow(/name/);
});
