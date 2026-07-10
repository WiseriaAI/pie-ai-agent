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
