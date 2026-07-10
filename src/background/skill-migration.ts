// 首次进磁盘模式：把 IDB 里的用户 skill 一次性、幂等地迁到 daemon 磁盘
// (~/.pie/skills/<slug>/)。IDB 原件保留作 daemon-off 回退（行为规格 §6）。
// 这是 SW 启动路径（fire-and-forget），全程绝不抛出——单包失败只跳过它自己，
// 整体异常也只 console.warn，绝不能拖垮 SW 冷启动的其它初始化。

import {
  bridgeHasSkillFs,
  bridgeSettled,
  maybeInitLocalBridge,
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

/** 启动/授权后入口：先等 bridge init 分派完成（settledPromise 已换成真握手），
 *  再迁移。若两者并行发射，migrate 同步捕获的是模块初始的已 resolve promise，
 *  微任务排干时 IPC 还没回来 → bridgeHasSkillFs 恒 false → 每次冷启动确定性
 *  空转。维持绝不 throw 的启动路径契约（两个被调方各自 never-throws）。 */
export async function initBridgeAndMigrate(): Promise<void> {
  await maybeInitLocalBridge(); // 同步分支内已调 initLocalBridge → settledPromise 已换真
  await migrateIdbSkillsToDisk(); // 自身 never-throws
}

/** marker 写入的窄 try/catch：写失败只 warn，绝不改变迁移结果的归属——
 *  盘上的迁移本身已成功，slug 留在 migrated；下一轮跑到 skip 分支时
 *  no-marker guard 的自愈继承会补写上。 */
async function writeDisabledMarker(slug: string, pkgId: string): Promise<void> {
  try {
    await setSkillEnabled(slug, false);
  } catch (e) {
    console.warn(
      `[skill-migration] skill "${slug}" (${pkgId}) 的禁用 marker 写入失败（下一轮自愈补写）：`,
      e,
    );
  }
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
          // crash 自愈：上一轮写完盘但 marker 没落上就挂了 → 本轮补继承。
          // no-marker guard（slug 两种 marker 都不存在才写）保证幂等，且绝不
          // 覆盖用户在磁盘模式下对 slug 已做出的显式开/关选择。
          if (
            markers.includes(`!${pkg.id}`) &&
            !markers.includes(slug) &&
            !markers.includes(`!${slug}`)
          ) {
            await writeDisabledMarker(slug, pkg.id);
          }
          continue;
        }
        await requestWriteSkill({
          name: slug,
          files: Object.entries(pkg.files).map(([path, content]) => ({ path, content })),
        });
        migrated.push(slug);
        existing.add(slug);
        // enabled 继承：只有旧 marker 显式关过才继承关闭；其余不动，磁盘默认开覆盖。
        // 窄 try/catch 在 writeDisabledMarker 内——marker 失败不把已成功迁移的
        // slug 二次归入 skipped（避免同一 slug 同时出现在两个数组的矛盾结果）。
        if (markers.includes(`!${pkg.id}`)) {
          await writeDisabledMarker(slug, pkg.id);
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
