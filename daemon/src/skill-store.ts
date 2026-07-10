import { existsSync, readFileSync, readdirSync, lstatSync, realpathSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join, resolve, relative, isAbsolute, sep, dirname } from "path";
import { paths } from "./paths";
import { parseSkillMd } from "./skill-md";
import type { SkillSummary, WriteSkillFile } from "../../src/types/local-bridge";

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
  // 规范化根（skillDir 调用时一定存在）后再判定，杜绝根本身经 symlink 逃逸。
  const realRoot = realpathSync(skillDir);
  const abs = resolve(realRoot, rel);
  const r = relative(realRoot, abs);
  if (r === "" || r.startsWith("..") || isAbsolute(r)) {
    throw new Error(`unsafe path: ${JSON.stringify(rel)}`);
  }
  // 逐段拒 symlink：字符串检查挡不住 `link/passwd`（link -> /etc）——OS 层 readFile
  // 会跟随 symlink 逃出 skillDir。已存在的每一段若是 symlink 即拒（新建文件的尾段
  // 尚不存在，lstat ENOENT → break，其父段已校验）。
  let cur = realRoot;
  for (const seg of r.split(sep)) {
    cur = join(cur, seg);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      break; // 段不存在（新建文件路径）→ 后续段也不存在，停
    }
    if (st.isSymbolicLink()) {
      throw new Error(`symlink in skill path: ${JSON.stringify(rel)}`);
    }
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

const FILES_CAP = 200;
const EXCLUDED_DIRS = new Set(["workspace", ".runs"]);

/** skill 目录内文件相对路径（递归；排除 workspace/.runs 与点文件；封顶 FILES_CAP）。 */
function packageFiles(skillDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    if (out.length >= FILES_CAP) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= FILES_CAP) return;
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) {
        if (!prefix && EXCLUDED_DIRS.has(e.name)) continue;
        walk(join(dir, e.name), prefix ? `${prefix}/${e.name}` : e.name);
      } else if (e.isFile()) {
        out.push(prefix ? `${prefix}/${e.name}` : e.name);
      }
    }
  };
  walk(skillDir, "");
  return out;
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
        files: packageFiles(dir),
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

export function writeSkill(
  name: string,
  files: WriteSkillFile[],
  root: string = paths.skillsDir,
): { dir: string } {
  const dir = join(root, assertSkillName(name));
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const abs = safeRelPath(dir, f.path); // 遍历/越界即 throw
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  return { dir };
}

export function deleteSkill(name: string, root: string = paths.skillsDir): boolean {
  const dir = join(root, assertSkillName(name));
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}
