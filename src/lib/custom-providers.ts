import type { ProviderRef } from "@/lib/model-router";
import { listInstances } from "@/lib/instances";
import { getConfig, setConfig } from "@/lib/idb/config-store";
import { txMulti, STORES } from "@/lib/idb/db";
import { publishChange } from "@/lib/store-bus";

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
  return ((await getConfig<string[]>(INDEX_KEY)) ?? []).slice();
}

export async function listCustomProviders(): Promise<StoredCustomProvider[]> {
  const idx = await readIndex();
  const out: StoredCustomProvider[] = [];
  for (const id of idx) {
    const stored = await getConfig<StoredCustomProvider>(ENTITY_KEY(id));
    if (stored) out.push(stored);
  }
  return out;
}

export async function getCustomProvider(id: string): Promise<StoredCustomProvider | null> {
  return (await getConfig<StoredCustomProvider>(ENTITY_KEY(id))) ?? null;
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
  // Write entity + index in a single multi-put transaction so they commit
  // all-or-nothing (a crash between two separate writes would otherwise leave
  // an orphan entity that listCustomProviders can't see, or an index pointing
  // at a missing entity). Both records use the config `{ key, value }` shape —
  // mirrors config-store record shape; one txMulti to keep entity+index atomic.
  await txMulti([STORES.config], "readwrite", (m) => {
    m[STORES.config].put({ key: ENTITY_KEY(id), value: entity });
    m[STORES.config].put({ key: INDEX_KEY, value: idx });
  });
  // setConfig is bypassed above, so emit its config changes manually.
  publishChange("config", "put", ENTITY_KEY(id));
  publishChange("config", "put", INDEX_KEY);
  return id;
}

export async function updateCustomProvider(
  id: string,
  patch: Partial<{ name: string; baseUrl: string; models: CustomModelMeta[] }>,
): Promise<void> {
  const stored = await getConfig<StoredCustomProvider>(ENTITY_KEY(id));
  if (!stored) throw new Error(`Custom provider ${id} not found`);
  const next: StoredCustomProvider = {
    ...stored,
    ...(patch.name !== undefined && { name: patch.name }),
    ...(patch.baseUrl !== undefined && { baseUrl: patch.baseUrl.replace(/\/$/, "") }),
    ...(patch.models !== undefined && { models: patch.models }),
    updatedAt: Date.now(),
  };
  await setConfig(ENTITY_KEY(id), next);
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
  // Instances now live in the IDB `instances` store; read them through the
  // instances module rather than the legacy `instances_index` / `instance_*`
  // keys. Reference semantics unchanged: an instance references this custom
  // provider iff its `provider` ref equals `custom:<id>`.
  const insts = await listInstances();
  return insts
    .filter((i) => i.provider === ref)
    .map((i) => ({
      id: i.id,
      nickname: i.nickname ?? "",
      model: (i as { model?: string }).model ?? "",
    }));
}

export async function deleteCustomProvider(id: string): Promise<void> {
  const instances = await getInstancesUsingCustomProvider(id);
  if (instances.length > 0) {
    throw new Error(
      `Cannot delete custom provider: ${instances.length} instance(s) still reference it. Delete those instances first.`,
    );
  }
  const idx = (await readIndex()).filter((x) => x !== id);
  // Delete entity + update index in one transaction so they commit
  // all-or-nothing. Index record uses the config `{ key, value }` shape —
  // mirrors config-store record shape; one txMulti to keep entity+index atomic.
  await txMulti([STORES.config], "readwrite", (m) => {
    m[STORES.config].delete(ENTITY_KEY(id));
    m[STORES.config].put({ key: INDEX_KEY, value: idx });
  });
  // setConfig/removeConfig are bypassed above, so emit config changes manually.
  publishChange("config", "remove", ENTITY_KEY(id));
  publishChange("config", "put", INDEX_KEY);
}
