import type { Provider, ModelConfig } from "@/lib/model-router";
import { getProviderMeta } from "@/lib/model-router";
import { getOrCreateEncryptionKey, encrypt, decrypt } from "@/lib/crypto";

export interface StoredInstance {
  id: string;
  provider: Provider;
  nickname: string;
  encryptedKey: string;
  model: string;
  customModels?: string[];
  fetchedModels?: { id: string; vision: boolean; tools: boolean; maxContextTokens: number }[];
  fetchedAt?: number;
  maxTokens?: number;
  createdAt: number;
}

export interface DecryptedInstance extends Omit<StoredInstance, "encryptedKey"> {
  apiKey: string;
}

const INSTANCE_KEY = (id: string) => `instance_${id}`;
const INDEX_KEY = "instances_index";
const ACTIVE_KEY = "active_instance_id";

export async function createInstance(input: {
  provider: Provider;
  nickname: string;
  apiKey: string;
  model: string;
  /** Optional. Custom model ids the user added during the form session.
   *  When omitted, auto-detects: if `model` isn't in the registry, push it
   *  to customModels so it survives as a dropdown entry on next edit. */
  customModels?: string[];
}): Promise<string> {
  if (!input.apiKey.trim()) throw new Error("API key cannot be empty");
  const id = crypto.randomUUID();
  const key = await getOrCreateEncryptionKey();
  const meta = getProviderMeta(input.provider);
  const inRegistry = meta?.models.some((m) => m.id === input.model) ?? false;
  // Resolve customModels: explicit > auto-detect (model not in registry)
  let resolvedCustomModels: string[] | undefined;
  if (input.customModels && input.customModels.length > 0) {
    // Ensure the selected model is included if it's custom
    resolvedCustomModels = inRegistry
      ? input.customModels
      : Array.from(new Set([...input.customModels, input.model]));
  } else if (!inRegistry) {
    resolvedCustomModels = [input.model];
  }
  const stored: StoredInstance = {
    id,
    provider: input.provider,
    nickname: input.nickname,
    encryptedKey: await encrypt(input.apiKey, key),
    model: input.model,
    ...(resolvedCustomModels && { customModels: resolvedCustomModels }),
    createdAt: Date.now(),
  };
  const idx = await readIndex();
  idx.push(id);
  await chrome.storage.local.set({ [INSTANCE_KEY(id)]: stored, [INDEX_KEY]: idx });
  if (idx.length === 1 && !(await getActiveInstance())) await setActiveInstance(id);
  return id;
}

export async function getInstance(id: string): Promise<DecryptedInstance | null> {
  const result = await chrome.storage.local.get(INSTANCE_KEY(id));
  const stored: StoredInstance | undefined = result[INSTANCE_KEY(id)] as StoredInstance | undefined;
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
  await chrome.storage.local.set({ [INDEX_KEY]: idx });
  await chrome.storage.local.remove(INSTANCE_KEY(id));
  if ((await getActiveInstance()) === id) {
    if (idx.length > 0) await setActiveInstance(idx[0]!);
    else await chrome.storage.local.remove(ACTIVE_KEY);
  }
}

export async function setActiveInstance(id: string): Promise<void> {
  await chrome.storage.local.set({ [ACTIVE_KEY]: id });
}

export async function getActiveInstance(): Promise<string | null> {
  const r = await chrome.storage.local.get(ACTIVE_KEY);
  return (r[ACTIVE_KEY] as string) ?? null;
}

export async function resolveInstanceToModelConfig(id: string): Promise<ModelConfig | null> {
  const inst = await getInstance(id);
  if (!inst) return null;
  const meta = getProviderMeta(inst.provider);
  if (!meta) return null;
  return {
    provider: inst.provider,
    model: inst.model,
    apiKey: inst.apiKey,
    baseUrl: meta.defaultBaseUrl,
    ...(inst.maxTokens != null && { maxTokens: inst.maxTokens }),
  };
}

export async function resolveActiveInstanceModelConfig(): Promise<ModelConfig | null> {
  const id = await getActiveInstance();
  if (!id) return null;
  return resolveInstanceToModelConfig(id);
}

async function readIndex(): Promise<string[]> {
  const r = await chrome.storage.local.get(INDEX_KEY);
  return ((r[INDEX_KEY] as string[]) ?? []).slice();
}

export async function updateInstance(id: string, patch: Partial<{
  nickname: string;
  apiKey: string;
  model: string;
  customModels: string[];
  fetchedModels: StoredInstance["fetchedModels"];
  fetchedAt: number;
  maxTokens: number;
}>): Promise<void> {
  const r = await chrome.storage.local.get(INSTANCE_KEY(id));
  const stored: StoredInstance | undefined = r[INSTANCE_KEY(id)] as StoredInstance | undefined;
  if (!stored) throw new Error(`Instance ${id} not found`);
  const next: StoredInstance = { ...stored };
  if (patch.nickname !== undefined) next.nickname = patch.nickname;
  if (patch.apiKey !== undefined) {
    const key = await getOrCreateEncryptionKey();
    next.encryptedKey = await encrypt(patch.apiKey, key);
  }
  if (patch.model !== undefined) next.model = patch.model;
  if (patch.customModels !== undefined) next.customModels = patch.customModels;
  if (patch.fetchedModels !== undefined) next.fetchedModels = patch.fetchedModels;
  if (patch.fetchedAt !== undefined) next.fetchedAt = patch.fetchedAt;
  if (patch.maxTokens !== undefined) next.maxTokens = patch.maxTokens;
  await chrome.storage.local.set({ [INSTANCE_KEY(id)]: next });
}
