import type { StoredInstance } from "@/lib/instances";
import { INDEX_KEY } from "@/lib/instances";
import { getConfig } from "@/lib/idb/config-store";
import { STORES, tx, txMulti } from "@/lib/idb/db";
import { publishChange } from "@/lib/store-bus";

const ACTIVE_KEY = "active_instance_id";

interface IndexedInstance {
  inst: StoredInstance;
  index: number;
}

/** IDB-post migration: enforce the one-config-per-provider invariant for
 * historical data. For duplicates, keep the instance with the newest createdAt;
 * ties keep the later entry in instances_index. */
export async function migrateOneConfigPerProvider(): Promise<void> {
  const index = ((await getConfig<string[]>(INDEX_KEY)) ?? []).slice();
  if (index.length <= 1) return;

  const entries: IndexedInstance[] = [];
  for (const [position, id] of index.entries()) {
    const inst = await tx<StoredInstance | undefined>(STORES.instances, "readonly", (s) => s.get(id));
    if (inst) entries.push({ inst, index: position });
  }

  const keepByProvider = new Map<string, IndexedInstance>();
  const providerByDeletedId = new Map<string, string>();

  for (const entry of entries) {
    const current = keepByProvider.get(entry.inst.provider);
    if (!current) {
      keepByProvider.set(entry.inst.provider, entry);
      continue;
    }
    const entryIsNewer =
      entry.inst.createdAt > current.inst.createdAt ||
      (entry.inst.createdAt === current.inst.createdAt && entry.index > current.index);
    const deleted = entryIsNewer ? current : entry;
    const kept = entryIsNewer ? entry : current;
    keepByProvider.set(entry.inst.provider, kept);
    providerByDeletedId.set(deleted.inst.id, deleted.inst.provider);
  }

  if (providerByDeletedId.size === 0) return;

  const deletedIds = new Set(providerByDeletedId.keys());
  const nextIndex = index.filter((id) => !deletedIds.has(id));
  const activeId = await getConfig<string>(ACTIVE_KEY);
  const activeProvider = activeId ? providerByDeletedId.get(activeId) : undefined;
  const activeReplacement = activeProvider ? keepByProvider.get(activeProvider)?.inst.id : undefined;

  await txMulti([STORES.instances, STORES.config], "readwrite", (m) => {
    for (const id of deletedIds) m[STORES.instances].delete(id);
    m[STORES.config].put({ key: INDEX_KEY, value: nextIndex });
    if (activeReplacement) {
      m[STORES.config].put({ key: ACTIVE_KEY, value: activeReplacement });
    }
  });

  for (const id of deletedIds) publishChange("instances", "remove", id);
  publishChange("config", "put", INDEX_KEY);
  if (activeReplacement) publishChange("config", "put", ACTIVE_KEY);
}
