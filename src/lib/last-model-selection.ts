/**
 * 全局「上次选择的模型」。取代旧的「默认 instance（active_instance_id）」语义：
 * 新会话从这里继承 (instanceId, model)。每次用户在 Composer 选定模型时更新。
 * 一 provider 一 key（D1），instanceId ↔ provider 一一对应。
 */
import { getConfig, setConfig } from "@/lib/idb/config-store";

export interface LastModelSelection {
  instanceId: string;
  model: string;
}

const KEY = "last_model_selection";

export async function getLastModelSelection(): Promise<LastModelSelection | null> {
  const v = await getConfig<LastModelSelection>(KEY);
  return v && v.instanceId && v.model ? v : null;
}

export async function setLastModelSelection(sel: LastModelSelection): Promise<void> {
  await setConfig(KEY, sel);
}
