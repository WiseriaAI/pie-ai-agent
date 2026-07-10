import { test, expect } from "bun:test";
import { mkdirSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { writeSkill, deleteSkill } from "../src/skill-store";

function tmpRoot(): string {
  const root = join(import.meta.dir, ".tmp-skw-" + Math.random().toString(36).slice(2));
  mkdirSync(root, { recursive: true });
  return root;
}

test("writeSkill lays out SKILL.md + nested files, returns dir", () => {
  const root = tmpRoot();
  const { dir } = writeSkill(
    "my-skill",
    [
      { path: "SKILL.md", content: "---\nname: my-skill\ndescription: d\n---\nb\n" },
      { path: "scripts/run.ts", content: "export default () => 1;" },
    ],
    root,
  );
  expect(dir).toBe(join(root, "my-skill"));
  expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toContain("my-skill");
  expect(readFileSync(join(dir, "scripts", "run.ts"), "utf8")).toContain("export default");
  rmSync(root, { recursive: true, force: true });
});

test("writeSkill rejects bad name and path traversal in files", () => {
  const root = tmpRoot();
  expect(() => writeSkill("..", [{ path: "SKILL.md", content: "x" }], root)).toThrow();
  expect(() => writeSkill("ok", [{ path: "../escape", content: "x" }], root)).toThrow();
  rmSync(root, { recursive: true, force: true });
});

test("deleteSkill removes the dir; returns false if absent", () => {
  const root = tmpRoot();
  writeSkill("gone", [{ path: "SKILL.md", content: "---\nname: gone\ndescription: d\n---\nb\n" }], root);
  expect(deleteSkill("gone", root)).toBe(true);
  expect(existsSync(join(root, "gone"))).toBe(false);
  expect(deleteSkill("gone", root)).toBe(false);
  rmSync(root, { recursive: true, force: true });
});
