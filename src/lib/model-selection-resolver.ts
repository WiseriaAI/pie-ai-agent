import { getInstance, listInstances, firstModelForProvider } from "./instances";
import { getLastModelSelection } from "./last-model-selection";

export interface Selection {
  instanceId: string;
  model: string;
}

/**
 * 按 D3 优先级解析 (instanceId, model)：
 *   1) session 自带的 (instanceId, model)，且 instance 仍存在
 *   2) 全局 last_model_selection，且 instance 仍存在
 *   3) 第一个 instance 的 provider 第一个可用 model（firstModelForProvider）
 *   4) 零配置 → null（Composer 显示「去设置页加 Provider」空态）
 * session 入参来自 SessionMeta（instanceId/model 均可缺省）。
 */
export async function resolveSelection(session: {
  instanceId?: string;
  model?: string;
}): Promise<Selection | null> {
  // 1) session 自带且 instance 仍存在
  if (session.instanceId) {
    const inst = await getInstance(session.instanceId);
    if (inst) {
      const model = session.model ?? (await firstModelForProvider(inst.provider, inst.id));
      if (model) return { instanceId: inst.id, model };
    }
  }
  // 2) 全局上次选择（instance 仍存在）
  const last = await getLastModelSelection();
  if (last) {
    const inst = await getInstance(last.instanceId);
    if (inst) return { instanceId: inst.id, model: last.model };
  }
  // 3) 第一个 instance 的 provider 第一个 model
  const all = await listInstances();
  if (all.length > 0) {
    const first = all[0]!;
    const model = await firstModelForProvider(first.provider, first.id);
    if (model) return { instanceId: first.id, model };
  }
  // 4) 零配置
  return null;
}
