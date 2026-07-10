import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve, relative, isAbsolute } from "path";
import { paths } from "./paths";
import { parseSkillMd } from "./skill-md";
import type { SkillSummary } from "../../src/types/local-bridge";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** skill 名 = 目录名 = id：kebab-case，无路径分隔符/遍历。非法即 throw。 */
export function assertSkillName(name: string): string {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new Error(`invalid skill name: ${JSON.stringify(name)}`);
  }
  return name;
}

/** 把 skill 目录内相对路径解析成绝对路径，越出目录即 throw。 */
export function safeRelPath(skillDir: string, rel: string): string {
  const abs = resolve(skillDir, rel);
  const r = relative(skillDir, abs);
  if (r === "" || r.startsWith("..") || isAbsolute(r)) {
    throw new Error(`unsafe path: ${JSON.stringify(rel)}`);
  }
  return abs;
}

/** scripts/ 下的文件名（一层，非递归）= 可执行集。目录不存在 → 空。 */
function runnableScripts(skillDir: string): string[] {
  const dir = join(skillDir, "scripts");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function listSkills(root: string = paths.skillsDir): SkillSummary[] {
  if (!existsSync(root)) return [];
  const out: SkillSummary[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || !NAME_RE.test(e.name)) continue;
    const dir = join(root, e.name);
    const mdPath = join(dir, "SKILL.md");
    if (!existsSync(mdPath)) continue;
    try {
      const parsed = parseSkillMd(readFileSync(mdPath, "utf8"));
      out.push({
        name: e.name, // 目录名即身份（与 frontmatter.name 应一致，以目录为准）
        description: parsed.description,
        runnableScripts: runnableScripts(dir),
        declaredCaps: parsed.declaredCaps,
      });
    } catch {
      // 坏 skill 跳过、不让整个 list 挂（韧性；坏 skill 在 authoring 期暴露）
    }
  }
  return out;
}

export function readSkillFile(name: string, rel: string, root: string = paths.skillsDir): string {
  const dir = join(root, assertSkillName(name));
  return readFileSync(safeRelPath(dir, rel), "utf8");
}
