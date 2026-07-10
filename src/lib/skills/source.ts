//
// Skill 真源抽象（spec docs/specs/2026-07-10-skill-system-with-local-daemon.md §4.5）。
// IdbSkillSource = 现状 IDB 后端；DaemonSkillSource（磁盘后端）在 src/background/
// daemon-skill-source.ts（依赖桥，panel 不可 import）。builtin 是只读层，
// 由 withBuiltins 在任一后端上并入。
import type { SkillPackage } from "./package-types";
import { listPackages, getPackage, putPackage, deletePackage } from "./skill-store";
import { BUILT_IN_SKILL_PACKAGES } from "./builtin";
import { parseSkillMarkdown } from "./frontmatter";
import { parseScriptDecls } from "./script-decl";

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
  origin: "builtin" | "idb" | "disk";
  files: string[];
  runnableScripts: string[];
  createdAt?: number;
  author?: string;
}

export interface SkillWriteFile {
  path: string;
  content: string;
}

export interface SkillSource {
  mode: "idb" | "disk";
  list(): Promise<SkillEntry[]>;
  readFile(id: string, path: string): Promise<string | null>;
  write(id: string, files: SkillWriteFile[]): Promise<void>;
  delete(id: string): Promise<boolean>;
}

function pkgToEntry(p: SkillPackage, origin: "builtin" | "idb"): SkillEntry {
  return {
    id: p.id,
    name: p.frontmatter.name,
    description: p.frontmatter.description,
    builtIn: p.builtIn,
    origin,
    files: Object.keys(p.files),
    runnableScripts: parseScriptDecls(p.frontmatter.capabilities?.scripts).map((d) => d.entry),
    createdAt: p.createdAt,
    author: typeof p.frontmatter.author === "string" ? p.frontmatter.author : undefined,
  };
}

export const idbSkillSource: SkillSource = {
  mode: "idb",
  async list() {
    return (await listPackages()).map((p) => pkgToEntry(p, "idb"));
  },
  async readFile(id, path) {
    const pkg = await getPackage(id);
    return pkg?.files[path] ?? null;
  },
  async write(id, files) {
    const existing = await getPackage(id);
    const fileMap: Record<string, string> = { ...(existing?.files ?? {}) };
    for (const f of files) fileMap[f.path] = f.content;
    const md = fileMap["SKILL.md"];
    if (typeof md !== "string") throw new Error("write requires SKILL.md");
    const { frontmatter } = parseSkillMarkdown(md);
    await putPackage({
      id,
      frontmatter,
      files: fileMap,
      builtIn: false,
      createdAt: existing?.createdAt ?? Date.now(),
    });
  },
  async delete(id) {
    const existing = await getPackage(id);
    if (!existing) return false;
    await deletePackage(id);
    return true;
  },
};

const BUILTIN_ENTRIES: SkillEntry[] = BUILT_IN_SKILL_PACKAGES.map((p) => pkgToEntry(p, "builtin"));
const BUILTIN_BY_ID = new Map(BUILT_IN_SKILL_PACKAGES.map((p) => [p.id, p]));

/** builtin 只读层：任一后端上并入 builtin；后端同 id 覆盖 builtin（IDB 现状语义）。 */
export function withBuiltins(backend: SkillSource): SkillSource {
  return {
    mode: backend.mode,
    async list() {
      const user = await backend.list();
      const userIds = new Set(user.map((e) => e.id));
      return [...BUILTIN_ENTRIES.filter((b) => !userIds.has(b.id)), ...user];
    },
    async readFile(id, path) {
      const fromBackend = await backend.readFile(id, path);
      if (fromBackend !== null) return fromBackend;
      return BUILTIN_BY_ID.get(id)?.files[path] ?? null;
    },
    write: (id, files) => backend.write(id, files),
    delete: (id) => backend.delete(id),
  };
}

const BUILT_IN_IDS = new Set(BUILT_IN_SKILL_PACKAGES.map((b) => b.id));

/** enabled marker 语义（storage.ts）："!id"=关、"id"=开、无 marker 走默认。
 *  默认开 = builtin 或磁盘 skill（放上盘=意图，对齐 Claude Code）；IDB 用户 skill 默认关。 */
export function filterEnabled(entries: SkillEntry[], markers: string[]): SkillEntry[] {
  const on = new Set(markers.filter((m) => !m.startsWith("!")));
  const off = new Set(markers.filter((m) => m.startsWith("!")).map((m) => m.slice(1)));
  return entries.filter((e) => {
    if (off.has(e.id)) return false;
    if (on.has(e.id)) return true;
    return e.builtIn || BUILT_IN_IDS.has(e.id) || e.origin === "disk";
  });
}

const FENCE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** 剥 frontmatter 拿正文；不校验字段（磁盘 SKILL.md 是标准 frontmatter，
 *  extension 的 parseSkillMarkdown 不认连字符 key——正文提取只需 fence）。 */
export function stripFrontmatter(md: string): string {
  const m = md.match(FENCE);
  return m ? md.slice(m[0].length) : md;
}

/** 磁盘目录名 slug：小写、非字母数字折叠成 -、去首尾 -。结果空 = 名字无 ASCII 字母数字。 */
export function kebabSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
