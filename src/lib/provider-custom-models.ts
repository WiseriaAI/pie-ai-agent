import type { ProviderRef } from "@/lib/model-router";
// Alias for backward compatibility; ProviderRef superset covers both builtin and custom providers.
type Provider = ProviderRef;

/**
 * Provider-level "custom models pool" — sticky across instances of the same
 * provider. When a user adds a custom model id (e.g. "deepseek-chat") via
 * the dropdown, it persists at this layer so the next time they create a
 * new instance of the same provider, the same custom ids show up in the
 * dropdown without retyping.
 *
 * This complements per-instance `instance.customModels` (kept for
 * back-compat with v2 storage). Settings / Wizard always merge the two
 * for display, and writes go to BOTH layers — × delete removes from BOTH
 * so the model truly disappears across all instances of that provider.
 */

const KEY = (provider: Provider) => `pcm_${provider}`;

export async function getProviderCustomModels(provider: Provider): Promise<string[]> {
  const r = await chrome.storage.local.get(KEY(provider));
  return ((r[KEY(provider)] as string[]) ?? []).slice();
}

export async function addProviderCustomModel(
  provider: Provider,
  modelId: string,
): Promise<string[]> {
  const id = modelId.trim();
  if (!id) return getProviderCustomModels(provider);
  const cur = await getProviderCustomModels(provider);
  if (cur.includes(id)) return cur;
  const next = [...cur, id];
  await chrome.storage.local.set({ [KEY(provider)]: next });
  return next;
}

export async function removeProviderCustomModel(
  provider: Provider,
  modelId: string,
): Promise<string[]> {
  const cur = await getProviderCustomModels(provider);
  const next = cur.filter((x) => x !== modelId);
  if (next.length === cur.length) return cur;
  await chrome.storage.local.set({ [KEY(provider)]: next });
  return next;
}
