import type { BuiltinProvider } from "@/lib/model-router";

/**
 * 旁路属性表：给 builtin provider 的自定义模型挂 vision / maxContextTokens。
 * 现有 `pcm_${provider}`（provider-custom-models.ts）只存 model id；本表是
 * id-keyed 的属性层，二者独立。删模型时两边都要清（见 Settings/Wizard 接线）。
 *
 * 不存 `tools`：loop 对所有 provider 无条件发 tools，该 flag 只是 dropdown
 * 展示用；builtin 自定义模型不暴露 tools 配置，构造 ModelMeta 时恒 true。
 */
export interface StoredCustomModelMeta {
  displayName?: string;
  vision: boolean;
  maxContextTokens: number;
}

export const DEFAULT_CUSTOM_MODEL_MAX_CONTEXT = 256_000;

const KEY = (provider: BuiltinProvider) => `pcmm_${provider}`;

export async function getProviderCustomModelMetas(
  provider: BuiltinProvider,
): Promise<Record<string, StoredCustomModelMeta>> {
  const r = await chrome.storage.local.get(KEY(provider));
  return { ...((r[KEY(provider)] as Record<string, StoredCustomModelMeta>) ?? {}) };
}

export async function getProviderCustomModelMeta(
  provider: BuiltinProvider,
  modelId: string,
): Promise<StoredCustomModelMeta | undefined> {
  return (await getProviderCustomModelMetas(provider))[modelId];
}

export async function setProviderCustomModelMeta(
  provider: BuiltinProvider,
  modelId: string,
  meta: StoredCustomModelMeta,
): Promise<void> {
  const all = await getProviderCustomModelMetas(provider);
  all[modelId] = meta;
  await chrome.storage.local.set({ [KEY(provider)]: all });
}

export async function removeProviderCustomModelMeta(
  provider: BuiltinProvider,
  modelId: string,
): Promise<void> {
  const all = await getProviderCustomModelMetas(provider);
  if (!(modelId in all)) return;
  delete all[modelId];
  await chrome.storage.local.set({ [KEY(provider)]: all });
}
