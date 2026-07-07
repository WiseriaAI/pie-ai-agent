import { getConfig, setConfig } from "@/lib/idb/config-store";

// 设置页「本地 Agent」启用偏好。null（用户从没动过开关）= 已安装即启用（开箱
// 即用，"安装之后自动检测"）；一旦动过开关就落显式数组。
const KEY = "enabled_local_agents";

export async function getEnabledLocalAgents(): Promise<string[] | null> {
  return (await getConfig<string[]>(KEY)) ?? null;
}

export async function setEnabledLocalAgents(ids: string[]): Promise<void> {
  await setConfig(KEY, ids);
}

/** handoff 卡片可用列表 = 已安装 ∩ 已启用（null = 已安装全启用）。 */
export function filterUsableAgents<T extends { id: string; installed: boolean }>(
  detected: T[],
  enabled: string[] | null,
): T[] {
  return detected.filter((a) => a.installed && (enabled == null || enabled.includes(a.id)));
}

/** 开关决策纯函数：启用时现检测把关——未安装启用不了；null 偏好先物化为「当前已安装全启用」。 */
export function applyToggle(
  detected: { id: string; installed: boolean }[],
  enabled: string[] | null,
  id: string,
  next: boolean,
): { ok: true; next: string[] } | { ok: false; reason: "not_installed" } {
  if (next && !detected.some((a) => a.id === id && a.installed)) {
    return { ok: false, reason: "not_installed" };
  }
  const base = enabled ?? detected.filter((a) => a.installed).map((a) => a.id);
  return { ok: true, next: next ? [...new Set([...base, id])] : base.filter((x) => x !== id) };
}
