// 首次进磁盘模式：把 IDB 里的用户 skill 一次性、幂等地迁到 daemon 磁盘
// (~/.pie/skills/<slug>/)。IDB 原件保留作 daemon-off 回退（行为规格 §6）。
// 这是 SW 启动路径（fire-and-forget），全程绝不抛出——单包失败只跳过它自己，
// 整体异常也只 console.warn，绝不能拖垮 SW 冷启动的其它初始化。

import {
  bridgeHasSkillFs,
  bridgeSettled,
  requestListSkills,
  requestWriteSkill,
} from "./local-bridge";
import { listPackages } from "@/lib/skills/skill-store";
import { kebabSlug } from "@/lib/skills/source";
import { getEnabledSkillIds, setSkillEnabled } from "@/lib/skills/storage";

export interface MigrateSkillsResult {
  migrated: string[];
  skipped: string[];
}

export async function migrateIdbSkillsToDisk(): Promise<MigrateSkillsResult> {
  const migrated: string[] = [];
  const skipped: string[] = [];
  try {
    // 桥握手落定前模式判定是陈旧的（可能还没连上/还没拿到 capabilities）；
    // 等它落定再问 bridgeHasSkillFs，避免用旧状态误判。
    await bridgeSettled();
    if (!bridgeHasSkillFs()) return { migrated, skipped };

    const userPkgs = (await listPackages()).filter((p) => !p.builtIn);
    if (userPkgs.length === 0) return { migrated, skipped };

    const existing = new Set((await requestListSkills()).skills.map((s) => s.name));
    const markers = await getEnabledSkillIds();

    for (const pkg of userPkgs) {
      const slug = kebabSlug(pkg.frontmatter.name);
      try {
        if (!slug) {
          // 名字里没有可用的 ASCII 字母数字，无法生成可预期的磁盘目录名——
          // 不造随机名（那样每次迁移结果都不一样，用户认不出自己的 skill）。
          console.warn(
            `[skill-migration] skill "${pkg.frontmatter.name}" (${pkg.id}) 的名字生成不出磁盘目录名，已跳过；请改个含字母/数字的名字后重新触发迁移。`,
          );
          skipped.push(pkg.frontmatter.name || pkg.id);
          continue;
        }
        if (existing.has(slug)) {
          // 幂等核心：磁盘上已有同名目录 = 已经迁过，或用户在磁盘模式下自建的——
          // 两种情况都绝不覆盖。
          skipped.push(slug);
          continue;
        }
        await requestWriteSkill({
          name: slug,
          files: Object.entries(pkg.files).map(([path, content]) => ({ path, content })),
        });
        migrated.push(slug);
        existing.add(slug);
        // enabled 继承：只有旧 marker 显式关过才继承关闭；其余不动，磁盘默认开覆盖。
        if (markers.includes(`!${pkg.id}`)) {
          await setSkillEnabled(slug, false);
        }
      } catch (e) {
        console.warn(`[skill-migration] 迁移 skill "${pkg.frontmatter.name}" (${pkg.id}) 失败，已跳过：`, e);
        skipped.push(slug || pkg.frontmatter.name || pkg.id);
      }
    }
    return { migrated, skipped };
  } catch (e) {
    console.warn("[skill-migration] 整体迁移异常，已跳过（不影响 SW 启动）：", e);
    return { migrated, skipped };
  }
}
