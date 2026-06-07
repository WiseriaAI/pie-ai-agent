import type { ProviderRef, BuiltinProvider, ModelConfig } from "@/lib/model-router";
import { resolveProviderMeta, getProviderMeta, resolveModelVision, resolveModelMeta } from "@/lib/model-router/providers/registry";
import { getOrCreateEncryptionKey, encrypt, decrypt } from "@/lib/crypto";
import { getCustomProvider, providerRefToId } from "@/lib/custom-providers";
import { tx, STORES } from "@/lib/idb/db";
import { getConfig, setConfig, removeConfig } from "@/lib/idb/config-store";
import { publishChange } from "@/lib/store-bus";

export interface StoredInstance {
  id: string;
  provider: ProviderRef;
  nickname: string;
  encryptedKey: string;
  customModels?: string[];
  fetchedModels?: { id: string; vision: boolean; tools: boolean; maxContextTokens: number }[];
  fetchedAt?: number;
  maxTokens?: number;
  createdAt: number;
}

export interface DecryptedInstance extends Omit<StoredInstance, "encryptedKey"> {
  apiKey: string;
}

export const INSTANCE_KEY = (id: string) => `instance_${id}`;
export const INDEX_KEY = "instances_index";
const ACTIVE_KEY = "active_instance_id";

async function readIndex(): Promise<string[]> {
  return ((await getConfig<string[]>(INDEX_KEY)) ?? []).slice();
}

export async function createInstance(input: {
  provider: ProviderRef;
  nickname: string;
  apiKey: string;
  /** Optional. Provider-level custom model ids associated with this instance
   *  (back-compat pool). Model selection itself lives in the Composer, not here. */
  customModels?: string[];
}): Promise<string> {
  if (!input.apiKey.trim()) throw new Error("API key cannot be empty");
  const id = crypto.randomUUID();
  const key = await getOrCreateEncryptionKey();
  const stored: StoredInstance = {
    id,
    provider: input.provider,
    nickname: input.nickname,
    encryptedKey: await encrypt(input.apiKey, key),
    ...(input.customModels && input.customModels.length > 0 && { customModels: input.customModels }),
    createdAt: Date.now(),
  };
  const idx = await readIndex();
  idx.push(id);
  await tx(STORES.instances, "readwrite", (s) => s.put(stored));
  await setConfig(INDEX_KEY, idx);
  publishChange("instances", "put", id);
  return id;
}

export async function getInstance(id: string): Promise<DecryptedInstance | null> {
  const stored = await tx<StoredInstance | undefined>(STORES.instances, "readonly", (s) => s.get(id));
  if (!stored) return null;
  const key = await getOrCreateEncryptionKey();
  const apiKey = await decrypt(stored.encryptedKey, key);
  const { encryptedKey: _enc, ...rest } = stored;
  return { ...rest, apiKey };
}

export async function listInstances(): Promise<DecryptedInstance[]> {
  const idx = await readIndex();
  const out: DecryptedInstance[] = [];
  for (const id of idx) {
    const inst = await getInstance(id);
    if (inst) out.push(inst);
  }
  return out;
}

export async function deleteInstance(id: string): Promise<void> {
  const idx = (await readIndex()).filter((x) => x !== id);
  await setConfig(INDEX_KEY, idx);
  await tx(STORES.instances, "readwrite", (s) => s.delete(id));
  publishChange("instances", "remove", id);
  if ((await getActiveInstance()) === id) {
    if (idx.length > 0) await setActiveInstance(idx[0]!);
    else await removeConfig(ACTIVE_KEY);
  }
}

export async function setActiveInstance(id: string): Promise<void> {
  await setConfig(ACTIVE_KEY, id);
}

export async function getActiveInstance(): Promise<string | null> {
  return (await getConfig<string>(ACTIVE_KEY)) ?? null;
}

// #62 — resolve a custom provider model's vision capability from its stored
// CustomModelMeta. Returns `true`/`false` when the model is found in the
// provider's model list; `undefined` when the provider entity or the model
// id is missing (both treated as fail-closed downstream).
async function resolveCustomModelVision(
  provider: ProviderRef,
  model: string,
): Promise<boolean | undefined> {
  const id = providerRefToId(provider);
  if (!id) return undefined;
  const cp = await getCustomProvider(id);
  return cp?.models.find((m) => m.id === model)?.vision;
}

export async function resolveModelConfig(instanceId: string, model: string): Promise<ModelConfig | null> {
  const inst = await getInstance(instanceId);
  if (!inst) return null;
  const meta = await resolveProviderMeta(inst.provider);
  if (!meta) return null;
  // Custom providers: read the stored CustomModelMeta.vision (#62).
  // Builtin providers: registry/fetched catalog first; on a miss, consult the
  // pcmm sidecar (resolveModelMeta) so user-added custom models with vision:true
  // get screenshot tools. Stays `undefined` when pcmm also misses (truly unknown
  // → fail-closed downstream, unchanged).
  let vision: boolean | undefined;
  if (inst.provider.startsWith("custom:")) {
    vision = await resolveCustomModelVision(inst.provider, model);
  } else {
    vision = resolveModelVision(inst.provider as BuiltinProvider, model, inst.fetchedModels);
    if (vision === undefined) {
      vision = (await resolveModelMeta(inst.provider, model))?.vision;
    }
  }
  return {
    provider: inst.provider,
    providerName: meta.name,
    model,
    apiKey: inst.apiKey,
    baseUrl: meta.defaultBaseUrl,
    ...(inst.maxTokens != null && { maxTokens: inst.maxTokens }),
    ...(vision !== undefined && { vision }),
  };
}

/** provider 的「第一个可用 model」：instance.customModels[0]（用户/eval 显式）
 *  → registry[0] → fetched[0]。用于 D3 兜底（普通 instance 无 customModels →
 *  registry[0]）与 eval（把指定 model 存进 customModels）。 */
export async function firstModelForProvider(provider: ProviderRef, instanceId?: string): Promise<string | null> {
  const inst = instanceId
    ? await getInstance(instanceId)
    : (await listInstances()).find((i) => i.provider === provider);
  if (inst?.customModels && inst.customModels.length > 0) return inst.customModels[0]!;
  const meta = getProviderMeta(provider as BuiltinProvider);
  if (meta && meta.models.length > 0) return meta.models[0]!.id;
  return inst?.fetchedModels?.[0]?.id ?? null;
}

export async function resolveActiveInstanceModelConfig(): Promise<ModelConfig | null> {
  const id = await getActiveInstance();
  if (!id) return null;
  const inst = await getInstance(id);
  if (!inst) return null;
  const model = await firstModelForProvider(inst.provider, id);
  if (!model) return null;
  return resolveModelConfig(id, model);
}

export async function updateInstance(id: string, patch: Partial<{
  nickname: string;
  apiKey: string;
  customModels: string[];
  fetchedModels: StoredInstance["fetchedModels"];
  fetchedAt: number;
  maxTokens: number;
}>): Promise<void> {
  const stored = await tx<StoredInstance | undefined>(STORES.instances, "readonly", (s) => s.get(id));
  if (!stored) throw new Error(`Instance ${id} not found`);
  const next: StoredInstance = { ...stored };
  if (patch.nickname !== undefined) next.nickname = patch.nickname;
  if (patch.apiKey !== undefined) {
    const key = await getOrCreateEncryptionKey();
    next.encryptedKey = await encrypt(patch.apiKey, key);
  }
  if (patch.customModels !== undefined) next.customModels = patch.customModels;
  if (patch.fetchedModels !== undefined) next.fetchedModels = patch.fetchedModels;
  if (patch.fetchedAt !== undefined) next.fetchedAt = patch.fetchedAt;
  if (patch.maxTokens !== undefined) next.maxTokens = patch.maxTokens;
  await tx(STORES.instances, "readwrite", (s) => s.put(next));
  publishChange("instances", "put", id);
}
