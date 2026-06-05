import { INSTANCE_KEY, INDEX_KEY, getActiveInstance } from "./instances";
import { setLastModelSelection, getLastModelSelection } from "./last-model-selection";

interface LegacyStored {
  id: string;
  provider: string;
  nickname: string;
  encryptedKey: string;
  model?: string;
  customModels?: string[];
  createdAt: number;
  [k: string]: unknown;
}

/**
 * 一次性迁移（V2 内）：
 *  ① 同 provider 多 instance → 保留 active 指向的；无 active 则保留 createdAt 最新的；其余删。
 *  ② 剥离 instance.model 字段；把保留的 active instance 旧 model 写入 last_model_selection
 *     （保证迁移后首个会话仍用老模型）。
 *
 * 幂等：所有 instance 都已无 model 字段时直接返回（不重复删除/覆盖）。
 */
export async function migrateInstanceModel(): Promise<void> {
  const idxR = await chrome.storage.local.get(INDEX_KEY);
  const ids: string[] = (idxR[INDEX_KEY] as string[]) ?? [];
  if (ids.length === 0) return;

  const stored: LegacyStored[] = [];
  for (const id of ids) {
    const r = await chrome.storage.local.get(INSTANCE_KEY(id));
    const s = r[INSTANCE_KEY(id)] as LegacyStored | undefined;
    if (s) stored.push(s);
  }
  const anyHasModel = stored.some((s) => typeof s.model === "string");
  if (!anyHasModel) return; // 幂等：已迁移

  const activeId = await getActiveInstance();

  // 按 provider 分组，选保留者（active 优先，否则 createdAt 最新）
  const byProvider = new Map<string, LegacyStored[]>();
  for (const s of stored) {
    const g = byProvider.get(s.provider) ?? [];
    g.push(s);
    byProvider.set(s.provider, g);
  }
  const kept: LegacyStored[] = [];
  for (const [, group] of byProvider) {
    let keep = group.find((s) => s.id === activeId);
    if (!keep) keep = group.slice().sort((a, b) => b.createdAt - a.createdAt)[0]!;
    kept.push(keep);
  }

  // last_model_selection ← active 保留者的旧 model（无 active 用第一个保留者）
  if (!(await getLastModelSelection())) {
    const seed = kept.find((s) => s.id === activeId) ?? kept[0];
    if (seed?.model) await setLastModelSelection({ instanceId: seed.id, model: seed.model });
  }

  // 写回：保留者去 model；删除非保留者
  const keptIds = new Set(kept.map((s) => s.id));
  const writes: Record<string, unknown> = {};
  const removes: string[] = [];
  for (const s of stored) {
    if (keptIds.has(s.id)) {
      const { model: _model, ...rest } = s;
      void _model;
      writes[INSTANCE_KEY(s.id)] = rest;
    } else {
      removes.push(INSTANCE_KEY(s.id));
    }
  }
  writes[INDEX_KEY] = kept.map((s) => s.id);
  await chrome.storage.local.set(writes);
  if (removes.length) await chrome.storage.local.remove(removes);
}
