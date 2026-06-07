// src/lib/idb/sessions-store.ts
//
// Low-level IDB access for session records (meta/agent/archived) + the
// lightweight session index. `writeSessionBatch` is the IDB equivalent of the
// old `writeAtomic` chrome.storage.local multi-key set: it writes record puts,
// record removals (value === undefined), and the index in ONE transaction
// spanning the `sessions` + `session_index` stores.

import type { SessionIndexEntry } from "../sessions/types";
import { tx, txMulti, STORES } from "./db";
import { publishChange } from "../store-bus";

const INDEX_ID = "index";
interface Wrapped { id: string; value: unknown; }

export async function getSessionRecord<T>(id: string): Promise<T | undefined> {
  const r = await tx<Wrapped | undefined>(STORES.sessions, "readonly", (s) => s.get(id));
  return r === undefined ? undefined : (r.value as T);
}

export async function putSessionRecord(id: string, value: unknown): Promise<void> {
  await tx(STORES.sessions, "readwrite", (s) => s.put({ id, value }));
  publishChange("sessions", "put", id);
}

export async function removeSessionRecord(id: string): Promise<void> {
  await tx(STORES.sessions, "readwrite", (s) => s.delete(id));
  publishChange("sessions", "remove", id);
}

export async function getIndex(): Promise<SessionIndexEntry[]> {
  const r = await tx<Wrapped | undefined>(STORES.sessionIndex, "readonly", (s) => s.get(INDEX_ID));
  return r === undefined ? [] : (r.value as SessionIndexEntry[]);
}

export interface SessionBatch {
  /** record id → value; `undefined` value removes the record. */
  records?: Record<string, unknown>;
  /** new full index array; omit to leave index untouched. */
  index?: SessionIndexEntry[];
}

export async function writeSessionBatch(batch: SessionBatch): Promise<void> {
  await txMulti([STORES.sessions, STORES.sessionIndex], "readwrite", (m) => {
    if (batch.records) {
      for (const [id, value] of Object.entries(batch.records)) {
        if (value === undefined) m[STORES.sessions].delete(id);
        else m[STORES.sessions].put({ id, value });
      }
    }
    if (batch.index) m[STORES.sessionIndex].put({ id: INDEX_ID, value: batch.index });
  });
  // One coarse change notification per batch — consumers re-read the index.
  publishChange("sessions", "put");
}

export async function setIndex(index: SessionIndexEntry[]): Promise<void> {
  await writeSessionBatch({ index });
}
