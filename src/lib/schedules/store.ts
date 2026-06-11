// src/lib/schedules/store.ts
//
// CRUD layer for the `schedules` IDB store (DB_VERSION 3).
// Both ScheduleRecord (key prefix "sched_") and ScheduleRunRecord (key prefix
// "run_") live in the same store, differentiated by key prefix.
//
// appendRun uses txMulti to atomically:
//   1. put the new ScheduleRunRecord
//   2. push its id onto ScheduleRecord.runIds (circular, max DEFAULT_RUN_HISTORY)
//   3. delete any evicted ScheduleRunRecords in the same transaction
//
// Every write publishes a change notification via store-bus so the management
// UI can reactively refresh without polling.

import { tx, txMulti, STORES } from "@/lib/idb/db";
import { publishChange } from "@/lib/store-bus";
import type { ScheduleRecord, ScheduleRunRecord } from "./types";
import { SCHEDULE_KEY_PREFIX, RUN_KEY_PREFIX, DEFAULT_RUN_HISTORY } from "./types";

// ── Read helpers ──────────────────────────────────────────────────────────────

/** Get a ScheduleRecord by id, or null if not found. */
export async function getSchedule(id: string): Promise<ScheduleRecord | null> {
  const result = await tx<ScheduleRecord | undefined>(
    STORES.schedules,
    "readonly",
    (s) => s.get(id) as IDBRequest<ScheduleRecord | undefined>,
  );
  return result ?? null;
}

/** List all ScheduleRecords (sched_* keys only). */
export async function listSchedules(): Promise<ScheduleRecord[]> {
  const all = await tx<ScheduleRecord[]>(
    STORES.schedules,
    "readonly",
    (s) => {
      const range = IDBKeyRange.bound(
        SCHEDULE_KEY_PREFIX,
        SCHEDULE_KEY_PREFIX + "￿",
      );
      return s.getAll(range) as IDBRequest<ScheduleRecord[]>;
    },
  );
  return all;
}

/** Get a ScheduleRunRecord by recordId, or null if not found.
 *  Runs are persisted with a phantom `id` field (= recordId) to satisfy the
 *  store's keyPath:"id"; strip it on read so consumers get a clean
 *  ScheduleRunRecord whose key set matches the interface exactly. */
export async function getRun(recordId: string): Promise<ScheduleRunRecord | null> {
  const raw = await tx<(ScheduleRunRecord & { id?: string }) | undefined>(
    STORES.schedules,
    "readonly",
    (s) => s.get(recordId) as IDBRequest<(ScheduleRunRecord & { id?: string }) | undefined>,
  );
  if (!raw) return null;
  const { id: _id, ...rest } = raw;
  return rest as ScheduleRunRecord;
}

// ── Write helpers ─────────────────────────────────────────────────────────────

/** Insert or replace a ScheduleRecord. */
export async function putSchedule(record: ScheduleRecord): Promise<void> {
  await tx<IDBValidKey>(STORES.schedules, "readwrite", (s) => s.put(record));
  publishChange(STORES.schedules, "put", record.id);
}

/** Delete a ScheduleRecord and cascade-delete all run records it references.
 *  The schedule delete + every run delete happen in a single txMulti transaction
 *  (D9 atomic — no orphaned run_* records left behind). */
export async function deleteSchedule(id: string): Promise<void> {
  let deletedRunIds: string[] = [];

  await txMulti([STORES.schedules], "readwrite", (m) => {
    const store = m[STORES.schedules];
    const getReq = store.get(id) as IDBRequest<ScheduleRecord | undefined>;
    // If the inner get fails, abort the transaction so txMulti rejects rather
    // than committing empty and resolving as a silent no-op.
    getReq.onerror = () => store.transaction.abort();
    getReq.onsuccess = () => {
      const sched = getReq.result;
      const runIds = sched?.runIds ?? [];
      for (const runId of runIds) store.delete(runId);
      deletedRunIds = runIds;
      store.delete(id);
    };
  });

  publishChange(STORES.schedules, "remove", id);
  for (const runId of deletedRunIds) {
    publishChange(STORES.schedules, "remove", runId);
  }
}

/**
 * Atomically append a ScheduleRunRecord to its parent ScheduleRecord's runIds,
 * evicting the oldest entry (and deleting its record) when the circular buffer
 * exceeds DEFAULT_RUN_HISTORY. D9 atomic: the run put + runIds update + eviction
 * delete all happen in a single IDB transaction.
 */
export async function appendRun(
  scheduleId: string,
  run: ScheduleRunRecord,
): Promise<void> {
  let evictedRunId: string | null = null;

  await txMulti([STORES.schedules], "readwrite", (m) => {
    const store = m[STORES.schedules];

    // Read current schedule to get runIds — we need a request chain.
    const getReq = store.get(scheduleId) as IDBRequest<ScheduleRecord | undefined>;
    // If the inner get fails, abort the transaction so txMulti rejects rather
    // than committing empty and resolving while silently dropping the run.
    getReq.onerror = () => store.transaction.abort();
    getReq.onsuccess = () => {
      const sched = getReq.result;
      if (!sched) return; // schedule not found — silently skip

      // Append new run id
      const newRunIds = [...sched.runIds, run.recordId];

      // Evict oldest if over limit
      if (newRunIds.length > DEFAULT_RUN_HISTORY) {
        evictedRunId = newRunIds.shift()!;
        store.delete(evictedRunId!);
      }

      // The store's keyPath is "id", but ScheduleRunRecord's key is "recordId".
      // Persist runs with a phantom id (= recordId); getRun strips it on read.
      const storedRun = { ...run, id: run.recordId };
      store.put(storedRun);

      // Update the schedule with new runIds
      store.put({ ...sched, runIds: newRunIds });
    };
  });

  publishChange(STORES.schedules, "put", run.recordId);
  publishChange(STORES.schedules, "put", scheduleId);
  if (evictedRunId) {
    publishChange(STORES.schedules, "remove", evictedRunId);
  }
}

/**
 * Partially update a ScheduleRunRecord (read-modify-write). Silently no-ops
 * for unknown recordIds.
 */
export async function updateRun(
  recordId: string,
  patch: Partial<Omit<ScheduleRunRecord, "recordId" | "scheduleId" | "runIndex">>,
): Promise<void> {
  await txMulti([STORES.schedules], "readwrite", (m) => {
    const store = m[STORES.schedules];
    const getReq = store.get(recordId) as IDBRequest<(ScheduleRunRecord & { id: string }) | undefined>;
    // If the inner get fails, abort the transaction so txMulti rejects rather
    // than committing empty and resolving while silently dropping the patch.
    getReq.onerror = () => store.transaction.abort();
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) return;
      // existing already carries recordId; only the phantom `id` is load-bearing.
      store.put({ ...existing, ...patch, id: recordId });
    };
  });
  publishChange(STORES.schedules, "put", recordId);
}
