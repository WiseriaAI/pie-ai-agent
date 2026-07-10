import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { assertSkillName, listSkills, readSkillFile } from "../src/skill-store";

function tmpRoot(): string {
  const root = join(import.meta.dir, ".tmp-skills-" + Math.random().toString(36).slice(2));
  mkdirSync(root, { recursive: true });
  return root;
}
function makeSkill(root: string, name: string, md: string, scripts: string[] = []) {
  const dir = join(root, name);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), md);
  for (const s of scripts) writeFileSync(join(dir, "scripts", s), "// " + s);
}

test("listSkills returns summary with runnableScripts and declaredCaps", () => {
  const root = tmpRoot();
  makeSkill(
    root,
    "web-fetch",
    `---\nname: web-fetch\ndescription: d\nmetadata:\n  pie:\n    network: [example.com]\n---\nbody\n`,
    ["fetch.ts", "helper.ts"],
  );
  const skills = listSkills(root);
  expect(skills).toHaveLength(1);
  expect(skills[0].name).toBe("web-fetch");
  expect(skills[0].runnableScripts.sort()).toEqual(["fetch.ts", "helper.ts"]);
  expect(skills[0].declaredCaps.network).toEqual(["example.com"]);
  rmSync(root, { recursive: true, force: true });
});

test("listSkills skips dirs without SKILL.md and tolerates a bad skill", () => {
  const root = tmpRoot();
  mkdirSync(join(root, "no-md"), { recursive: true });
  makeSkill(root, "bad", `no fence`, []);
  makeSkill(root, "good", `---\nname: good\ndescription: d\n---\nb\n`, []);
  const names = listSkills(root).map((s) => s.name);
  expect(names).toContain("good");
  expect(names).not.toContain("no-md");
  expect(names).not.toContain("bad");
  rmSync(root, { recursive: true, force: true });
});

test("readSkillFile returns file content; rejects traversal", () => {
  const root = tmpRoot();
  makeSkill(root, "s", `---\nname: s\ndescription: d\n---\nBODY\n`, []);
  expect(readSkillFile("s", "SKILL.md", root)).toContain("BODY");
  expect(() => readSkillFile("s", "../../etc/passwd", root)).toThrow();
  rmSync(root, { recursive: true, force: true });
});

test("assertSkillName rejects traversal / bad chars", () => {
  expect(assertSkillName("web-fetch")).toBe("web-fetch");
  expect(() => assertSkillName("..")).toThrow();
  expect(() => assertSkillName("a/b")).toThrow();
  expect(() => assertSkillName("Web_Fetch")).toThrow();
  expect(() => assertSkillName("")).toThrow();
});
