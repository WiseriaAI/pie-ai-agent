import type { ProviderRef } from "@/lib/model-router";
import { INSTANCE_KEY, INDEX_KEY as INSTANCES_INDEX_KEY } from "@/lib/instances";

export interface StoredCustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  models: CustomModelMeta[];
  createdAt: number;
  updatedAt: number;
}

export interface CustomModelMeta {
  id: string;
  displayName?: string;
  vision: boolean;
  tools: boolean;
  maxContextTokens: number;
}

export interface CustomProviderInstanceRef {
  id: string;
  nickname: string;
  model: string;
}

export const CUSTOM_PREFIX = "custom:";

const INDEX_KEY = "custom_providers_index";
const ENTITY_KEY = (id: string) => `custom_provider_${id}`;

export function providerRefToId(ref: ProviderRef): string | null {
  if (!ref.startsWith(CUSTOM_PREFIX)) return null;
  return ref.slice(CUSTOM_PREFIX.length);
}

async function readIndex(): Promise<string[]> {
  const r = await chrome.storage.local.get(INDEX_KEY);
  return ((r[INDEX_KEY] as string[]) ?? []).slice();
}

async function writeIndex(idx: string[]): Promise<void> {
  await chrome.storage.local.set({ [INDEX_KEY]: idx });
}

export async function listCustomProviders(): Promise<StoredCustomProvider[]> {
  const idx = await readIndex();
  const out: StoredCustomProvider[] = [];
  for (const id of idx) {
    const r = await chrome.storage.local.get(ENTITY_KEY(id));
    const stored = r[ENTITY_KEY(id)] as StoredCustomProvider | undefined;
    if (stored) out.push(stored);
  }
  return out;
}

export async function getCustomProvider(id: string): Promise<StoredCustomProvider | null> {
  const r = await chrome.storage.local.get(ENTITY_KEY(id));
  const stored = r[ENTITY_KEY(id)] as StoredCustomProvider | undefined;
  return stored ?? null;
}

export async function saveCustomProvider(input: {
  name: string;
  baseUrl: string;
  models: CustomModelMeta[];
}): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const entity: StoredCustomProvider = {
    id,
    name: input.name,
    baseUrl: input.baseUrl.replace(/\/$/, ""),
    models: input.models,
    createdAt: now,
    updatedAt: now,
  };
  const idx = await readIndex();
  idx.push(id);
  await chrome.storage.local.set({ [ENTITY_KEY(id)]: entity, [INDEX_KEY]: idx });
  return id;
}

export async function updateCustomProvider(
  id: string,
  patch: Partial<{ name: string; baseUrl: string; models: CustomModelMeta[] }>,
): Promise<void> {
  const r = await chrome.storage.local.get(ENTITY_KEY(id));
  const stored = r[ENTITY_KEY(id)] as StoredCustomProvider | undefined;
  if (!stored) throw new Error(`Custom provider ${id} not found`);
  const next: StoredCustomProvider = {
    ...stored,
    ...(patch.name !== undefined && { name: patch.name }),
    ...(patch.baseUrl !== undefined && { baseUrl: patch.baseUrl.replace(/\/$/, "") }),
    ...(patch.models !== undefined && { models: patch.models }),
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({ [ENTITY_KEY(id)]: next });
}

/** Append a model to a custom provider's model list. Idempotent on model id
 *  (a duplicate id is ignored, never overwritten — use updateCustomProviderModel
 *  to change an existing model's meta). */
export async function addCustomProviderModel(
  id: string,
  meta: CustomModelMeta,
): Promise<void> {
  const stored = await getCustomProvider(id);
  if (!stored) throw new Error(`Custom provider ${id} not found`);
  if (stored.models.some((m) => m.id === meta.id)) return;
  await updateCustomProvider(id, { models: [...stored.models, meta] });
}

/** Replace an existing model's meta (matched by id; id itself is preserved).
 *  No-op when the id is absent. */
export async function updateCustomProviderModel(
  id: string,
  modelId: string,
  meta: CustomModelMeta,
): Promise<void> {
  const stored = await getCustomProvider(id);
  if (!stored) throw new Error(`Custom provider ${id} not found`);
  if (!stored.models.some((m) => m.id === modelId)) return;
  await updateCustomProvider(id, {
    models: stored.models.map((m) => (m.id === modelId ? { ...meta, id: modelId } : m)),
  });
}

/** Remove a model from a custom provider (matched by id). */
export async function removeCustomProviderModel(id: string, modelId: string): Promise<void> {
  const stored = await getCustomProvider(id);
  if (!stored) throw new Error(`Custom provider ${id} not found`);
  await updateCustomProvider(id, { models: stored.models.filter((m) => m.id !== modelId) });
}

export async function getInstancesUsingCustomProvider(id: string): Promise<CustomProviderInstanceRef[]> {
  const ref = `${CUSTOM_PREFIX}${id}`;
  const r = await chrome.storage.local.get(INSTANCES_INDEX_KEY);
  const idx: string[] = (r[INSTANCES_INDEX_KEY] as string[]) ?? [];
  const result: CustomProviderInstanceRef[] = [];
  for (const iid of idx) {
    const r2 = await chrome.storage.local.get(INSTANCE_KEY(iid));
    const stored = r2[INSTANCE_KEY(iid)] as { provider?: string; nickname?: string; model?: string } | undefined;
    if (stored?.provider === ref) {
      result.push({
        id: iid,
        nickname: stored.nickname ?? "",
        model: stored.model ?? "",
      });
    }
  }
  return result;
}

export async function deleteCustomProvider(id: string): Promise<void> {
  const instances = await getInstancesUsingCustomProvider(id);
  if (instances.length > 0) {
    throw new Error(
      `Cannot delete custom provider: ${instances.length} instance(s) still reference it. Delete those instances first.`,
    );
  }
  const idx = (await readIndex()).filter((x) => x !== id);
  await chrome.storage.local.set({ [INDEX_KEY]: idx });
  await chrome.storage.local.remove(ENTITY_KEY(id));
}
