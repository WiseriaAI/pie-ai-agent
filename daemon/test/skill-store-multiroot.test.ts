import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listSkillsMerged, resolveSkillRoot, deleteSkillGuarded } from "../src/skill-store";

let primary: string;
let secondary: string;

function putSkill(root: string, name: string, description = "d"): void {
  const dir = join(root, name);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nbody`);
  writeFileSync(join(dir, "scripts", "run.sh"), "echo ok");
}

beforeEach(() => {
  primary = mkdtempSync(join(tmpdir(), "pie-mr-p-"));
  secondary = mkdtempSync(join(tmpdir(), "pie-mr-s-"));
});
afterEach(() => {
  rmSync(primary, { recursive: true, force: true });
  rmSync(secondary, { recursive: true, force: true });
});

test("listSkillsMerged: 两根合并且带 source", () => {
  putSkill(primary, "alpha");
  putSkill(secondary, "beta");
  const skills = listSkillsMerged({ primary, secondary });
  expect(skills).toHaveLength(2);
  expect(skills.find((s) => s.name === "alpha")?.source).toBe("pie");
  expect(skills.find((s) => s.name === "beta")?.source).toBe("agents");
});

test("listSkillsMerged: 同名主根遮蔽副根", () => {
  putSkill(primary, "dup", "from-pie");
  putSkill(secondary, "dup", "from-agents");
  const skills = listSkillsMerged({ primary, secondary });
  expect(skills).toHaveLength(1);
  expect(skills[0].source).toBe("pie");
  expect(skills[0].description).toBe("from-pie");
});

test("listSkillsMerged: 副根缺失 → 只有主根", () => {
  putSkill(primary, "alpha");
  const skills = listSkillsMerged({ primary, secondary: join(secondary, "nope") });
  expect(skills).toHaveLength(1);
});

test("resolveSkillRoot: 主根优先 / 落副根 / 双无 null", () => {
  putSkill(primary, "dup");
  putSkill(secondary, "dup");
  putSkill(secondary, "only-agents");
  expect(resolveSkillRoot("dup", { primary, secondary })).toEqual({ root: primary, source: "pie" });
  expect(resolveSkillRoot("only-agents", { primary, secondary })).toEqual({ root: secondary, source: "agents" });
  expect(resolveSkillRoot("ghost", { primary, secondary })).toBeNull();
});

test("deleteSkillGuarded: 副根 skill 抛 read_only 且 message 含磁盘路径", () => {
  putSkill(secondary, "ro-skill");
  let err: unknown;
  try {
    deleteSkillGuarded("ro-skill", { primary, secondary });
  } catch (e) {
    err = e;
  }
  expect((err as { code?: string }).code).toBe("read_only");
  expect(String(err)).toContain(join(secondary, "ro-skill"));
  expect(existsSync(join(secondary, "ro-skill", "SKILL.md"))).toBe(true); // 文件未动
});

test("deleteSkillGuarded: 删遮蔽副本后副根版本重新露出", () => {
  putSkill(primary, "dup", "from-pie");
  putSkill(secondary, "dup", "from-agents");
  expect(deleteSkillGuarded("dup", { primary, secondary })).toBe(true);
  const skills = listSkillsMerged({ primary, secondary });
  expect(skills).toHaveLength(1);
  expect(skills[0].source).toBe("agents");
  expect(skills[0].description).toBe("from-agents");
});

test("deleteSkillGuarded: 两根都无 → false", () => {
  expect(deleteSkillGuarded("ghost", { primary, secondary })).toBe(false);
});
