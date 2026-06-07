// src/lib/idb/config-store.ts
//
// Key→value store over the `config` object store. Replaces the long tail of
// single-value chrome.storage.local keys (theme, locale, encryption_key,
// instances_index, active_instance_id, last_model_selection, pcm_*/pcmm_*,
// custom providers, search provider, cdp-input-enabled, schema_version, …).

import { tx, STORES } from "./db";
import { publishChange } from "../store-bus";

interface ConfigRecord { key: string; value: unknown; }

export async function getConfig<T>(key: string): Promise<T | undefined> {
  const rec = await tx<ConfigRecord | undefined>(
    STORES.config, "readonly", (s) => s.get(key),
  );
  return rec === undefined ? undefined : (rec.value as T);
}

export async function setConfig(key: string, value: unknown): Promise<void> {
  await tx(STORES.config, "readwrite", (s) => s.put({ key, value }));
  publishChange("config", "put", key);
}

export async function removeConfig(key: string): Promise<void> {
  await tx(STORES.config, "readwrite", (s) => s.delete(key));
  publishChange("config", "remove", key);
}

export async function getAllConfig(): Promise<Record<string, unknown>> {
  const all = await tx<ConfigRecord[]>(STORES.config, "readonly", (s) => s.getAll());
  const out: Record<string, unknown> = {};
  for (const r of all) out[r.key] = r.value;
  return out;
}
