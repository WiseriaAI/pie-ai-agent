// src/lib/idb/db.ts
//
// Single IndexedDB database `pie` holding every former chrome.storage.local
// namespace. One database (not one-per-domain) so a single IDB transaction can
// span multiple stores — required to preserve the D9 atomic multi-key write
// invariant (e.g. session meta + index updated together).

export const DB_NAME = "pie";
// Bump DB_VERSION and add a new `if (!db.objectStoreNames.contains(...))` branch
// in onupgradeneeded whenever a new store is added (onupgradeneeded only runs
// when the version increases).
export const DB_VERSION = 2;

export const STORES = {
  sessions: "sessions",
  sessionIndex: "session_index",
  instances: "instances",
  config: "config",
  scratchpads: "scratchpads",
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

// The db handle is intentionally kept open (not closed per-tx, unlike
// output-store/skill-store). A single connection is required for txMulti:
// IDB multi-store transactions must open all stores from the same connection.
let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.sessions))
        db.createObjectStore(STORES.sessions, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORES.sessionIndex))
        db.createObjectStore(STORES.sessionIndex, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORES.instances))
        db.createObjectStore(STORES.instances, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORES.config))
        db.createObjectStore(STORES.config, { keyPath: "key" });
      if (!db.objectStoreNames.contains(STORES.scratchpads))
        db.createObjectStore(STORES.scratchpads, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

/** Single-store transaction. Resolves on transaction commit (oncomplete), not
 *  request success, so callers can rely on durability before publishing change
 *  notifications. */
export function tx<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        let result: T | undefined = undefined;
        req.onsuccess = () => { result = req.result; };
        req.onerror = () => reject(req.error);
        t.oncomplete = () => resolve(result as T);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

/** Multi-store atomic transaction. `fn` issues requests against the provided
 *  store map; resolves only when the whole transaction commits (all-or-nothing). */
export function txMulti(
  stores: StoreName[],
  mode: IDBTransactionMode,
  fn: (map: Record<StoreName, IDBObjectStore>) => void,
): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(stores, mode);
        const map = {} as Record<StoreName, IDBObjectStore>;
        for (const s of stores) map[s] = t.objectStore(s);
        try {
          fn(map);
        } catch (e) {
          try { t.abort(); } catch { /* noop */ }
          reject(e);
          return;
        }
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

/** Clear every store in the `pie` database in a single atomic transaction.
 *  Production use (e.g. eval harness reset between runs). */
export async function clearAllStores(): Promise<void> {
  await txMulti(
    [STORES.sessions, STORES.sessionIndex, STORES.instances, STORES.config, STORES.scratchpads],
    "readwrite",
    (m) => {
      m[STORES.sessions].clear();
      m[STORES.sessionIndex].clear();
      m[STORES.instances].clear();
      m[STORES.config].clear();
      m[STORES.scratchpads].clear();
    },
  );
}

/** Test-only: drop the cached db handle + delete the database. */
export async function _resetForTests(): Promise<void> {
  if (dbPromise) { (await dbPromise).close(); dbPromise = null; }
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}
