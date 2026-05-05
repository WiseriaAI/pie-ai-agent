import type { Provider } from "@/lib/model-router";
import { PROVIDER_REGISTRY } from "@/lib/model-router/providers/registry";
import { getOrCreateEncryptionKey, encrypt, decrypt } from "@/lib/crypto";
import type { StoredInstance } from "@/lib/instances";

const SCHEMA_VERSION_KEY = "schema_version";
const MAPPING_KEY = "migration_v2_mapping";

export async function migrateV1toV2(): Promise<void> {
  const sv = (await chrome.storage.local.get(SCHEMA_VERSION_KEY))[SCHEMA_VERSION_KEY];
  if (sv === 2) return;

  const key = await getOrCreateEncryptionKey();
  const oldActiveResult = await chrome.storage.local.get("active_provider");
  const oldActive = oldActiveResult.active_provider as Provider | undefined;

  const mapping: Record<string, string> = {};
  const instancesIndex: string[] = [];
  const writes: Record<string, unknown> = {};
  const removes: string[] = [];

  for (const p of PROVIDER_REGISTRY) {
    const r = await chrome.storage.local.get(`provider_${p.id}`);
    const old = r[`provider_${p.id}`] as { encryptedKey: string; model: string; baseUrl?: string } | undefined;
    if (!old) continue;

    let plain: string;
    try {
      plain = await decrypt(old.encryptedKey, key);
    } catch (e) {
      console.warn(`[migration-v2] decrypt failed for provider_${p.id}, skipping`, e);
      // unable to decrypt — skip silently (corrupt data); user will reconfigure
      removes.push(`provider_${p.id}`);
      continue;
    }

    const newId = crypto.randomUUID();
    const inRegistry = p.models.some((m) => m.id === old.model);
    const stored: StoredInstance = {
      id: newId,
      provider: p.id,
      nickname: p.name,
      encryptedKey: await encrypt(plain, key),
      model: old.model,
      ...(inRegistry ? {} : { customModels: [old.model] }),
      createdAt: Date.now(),
    };
    writes[`instance_${newId}`] = stored;
    instancesIndex.push(newId);
    mapping[p.id] = newId;
    removes.push(`provider_${p.id}`);
  }

  writes["instances_index"] = instancesIndex;
  if (oldActive && mapping[oldActive]) writes["active_instance_id"] = mapping[oldActive];
  writes[SCHEMA_VERSION_KEY] = 2;
  writes[MAPPING_KEY] = mapping;

  await chrome.storage.local.set(writes);
  if (removes.length > 0) await chrome.storage.local.remove([...removes, "active_provider"]);
}

export async function getMigrationMapping(): Promise<Record<string, string>> {
  const r = await chrome.storage.local.get(MAPPING_KEY);
  return (r[MAPPING_KEY] as Record<string, string>) ?? {};
}
