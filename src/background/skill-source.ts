import { withBuiltins, filterEnabled, idbSkillSource, type SkillEntry, type SkillSource } from "@/lib/skills/source";
import { getEnabledSkillIds } from "@/lib/skills/storage";
import { bridgeHasSkillFs, bridgeSettled } from "./local-bridge";
import { daemonSkillSource } from "./daemon-skill-source";

/** 模式判定唯一入口：daemon 连着且声明 skill_fs → 磁盘真源，否则 IDB。 */
export function getActiveSkillSource(): SkillSource {
  return withBuiltins(bridgeHasSkillFs() ? daemonSkillSource : idbSkillSource);
}

/** loop/task-seed 用：桥落定后取 enabled 条目（防 SW 冷启动握手竞态掉回 IDB 模式）。 */
export async function getEnabledSkillEntries(): Promise<SkillEntry[]> {
  await bridgeSettled();
  const [entries, markers] = await Promise.all([getActiveSkillSource().list(), getEnabledSkillIds()]);
  return filterEnabled(entries, markers);
}
