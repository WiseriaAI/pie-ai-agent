import type { SkillPackage } from "./package-types";
import { BUILT_IN_SKILL_PACKAGES } from "./builtin";
import { listPackages } from "./skill-store";
import { getEnabledSkillIds } from "./storage";

export type { SkillPackage, SkillFrontmatter } from "./package-types";
export { parseSkillMarkdown } from "./frontmatter";
export {
  putPackage, getPackage, listPackages, deletePackage, getPackageFile,
} from "./skill-store";
export {
  getEnabledSkillIds, setSkillEnabled, generateSkillId, generateUserSkillId,
} from "./storage";
export { BUILT_IN_SKILL_PACKAGES } from "./builtin";

// SkillId / SkillAuthor are still used by package-types.ts and external consumers.
// SkillDefinition is kept for historical migration code and back-compat deserialization.
export type { SkillDefinition, SkillId, SkillAuthor } from "./types";
export {
  normalizeSkillSlashKey,
  findSkillBySlashKey,
  resolveSlashCommand,
  expandSlashCommand,
  type SlashCommandMatch,
} from "./slash";

/** 合并内置包与 IndexedDB 用户包;同 id 用户包覆盖内置。 */
export async function getAllSkillPackages(): Promise<SkillPackage[]> {
  const userPkgs = await listPackages();
  const userById = new Map(userPkgs.map((p) => [p.id, p]));
  const merged = BUILT_IN_SKILL_PACKAGES.map((b) => userById.get(b.id) ?? b);
  const builtinIds = new Set(BUILT_IN_SKILL_PACKAGES.map((b) => b.id));
  for (const u of userPkgs) if (!builtinIds.has(u.id)) merged.push(u);
  return merged;
}

const BUILT_IN_IDS = new Set(BUILT_IN_SKILL_PACKAGES.map((b) => b.id));

/** enabled-ids 语义沿用 storage.ts:plain=启用, "!id"=禁用, 缺省=内置默认启用。
 *  用户包覆盖同名内置包时,该 id 仍视为"内置默认开"。 */
export async function getEnabledSkillPackages(): Promise<SkillPackage[]> {
  const [all, enabledIds] = await Promise.all([getAllSkillPackages(), getEnabledSkillIds()]);
  const on = new Set(enabledIds.filter((i) => !i.startsWith("!")));
  const off = new Set(enabledIds.filter((i) => i.startsWith("!")).map((i) => i.slice(1)));
  return all.filter((p) => {
    if (off.has(p.id)) return false;
    if (on.has(p.id)) return true;
    return p.builtIn || BUILT_IN_IDS.has(p.id); // 内置默认开;用户覆盖同名内置也默认开
  });
}
