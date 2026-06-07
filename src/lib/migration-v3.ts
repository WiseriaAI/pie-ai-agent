// src/lib/migration-v3.ts
//
// One-time V2→V3 sweep: chrome.storage.local → IndexedDB. Runs AFTER all
// existing chrome.storage-based migrations (migrate-v2, migration-*,
// cleanup-migration) so it sweeps the final settled state. Idempotent via
// config.schema_version.
import { txMulti, STORES } from "@/lib/idb/db";
import { getConfig, setConfig } from "@/lib/idb/config-store";
import type { SessionIndexEntry } from "@/lib/sessions/types";

const SESSION_RE = /^session_(.+)_(meta|agent|archived)$/;

export async function migrateV2toV3(): Promise<void> {
  if ((await getConfig<number>("schema_version")) === 3) return;

  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all);
  if (keys.length === 0) {
    await setConfig("schema_version", 3);
    return;
  }

  const configEntries: [string, unknown][] = [];
  const instanceEntries: [string, unknown][] = [];
  const sessionRecords: Record<string, unknown> = {};
  let sessionIndex: SessionIndexEntry[] | undefined;

  for (const k of keys) {
    const v = all[k];
    if (k === "session_index") {
      sessionIndex = v as SessionIndexEntry[];
      continue;
    }
    const m = SESSION_RE.exec(k);
    if (m) {
      sessionRecords[`${m[1]}:${m[2]}`] = v;
      continue;
    }
    if (k.startsWith("instance_")) {
      instanceEntries.push([k.slice("instance_".length), v]);
      continue;
    }
    configEntries.push([k, v]);
  }

  await txMulti([STORES.instances], "readwrite", (mp) => {
    for (const [id, value] of instanceEntries)
      mp[STORES.instances].put({ ...(value as object), id });
  });
  await txMulti([STORES.sessions, STORES.sessionIndex], "readwrite", (mp) => {
    for (const [id, value] of Object.entries(sessionRecords))
      mp[STORES.sessions].put({ id, value });
    if (sessionIndex !== undefined)
      mp[STORES.sessionIndex].put({ id: "index", value: sessionIndex });
  });
  await txMulti([STORES.config], "readwrite", (mp) => {
    for (const [key, value] of configEntries)
      mp[STORES.config].put({ key, value });
  });

  await chrome.storage.local.clear();
  await setConfig("schema_version", 3);
}
