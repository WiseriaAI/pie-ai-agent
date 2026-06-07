// Persistent store for output_file artifacts (IndexedDB). Replaces the old
// in-memory output-cache: artifacts now survive SW restarts + panel close, and
// stay downloadable for the life of the session. They are cleared when the
// session is archived or hard-deleted (see sessions/lifecycle.ts), with a
// per-session LRU cap as a safety bound. Lives under lib/ (not background/) so
// both the SW (tool store + download handler) and the panel (existence probe)
// and the sessions lifecycle (eviction) can share the one IndexedDB.

export interface FileArtifact {
  id: string;
  sessionId: string;
  filename: string; // already sanitized "pie/…"
  mime: string;
  content: string;
  byteLength: number;
  addedAt: number;
}

const DB_NAME = "pie-output-files";
const STORE = "artifacts";
const SESSION_INDEX = "sessionId";
const DB_VERSION = 1;

const SESSION_BYTE_BUDGET = 10 * 1024 * 1024; // 10 MB/session
const SESSION_COUNT_BUDGET = 20; // ≤20 artifacts/session

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: "id" });
        s.createIndex(SESSION_INDEX, "sessionId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

/** Persist an artifact, then enforce the per-session LRU bound. */
export async function putArtifact(a: FileArtifact): Promise<void> {
  await tx("readwrite", (s) => s.put(a));
  await enforceSessionLRU(a.sessionId);
}

/** Fetch an artifact by its (globally unique) id. */
export async function getArtifact(id: string): Promise<FileArtifact | undefined> {
  const r = await tx<FileArtifact | undefined>("readonly", (s) => s.get(id));
  return r ?? undefined;
}

/** Cheap existence check for the panel card's expired-state probe. */
export async function artifactExists(id: string): Promise<boolean> {
  const k = await tx<IDBValidKey | undefined>("readonly", (s) => s.getKey(id));
  return k != null;
}

/** Remove every artifact belonging to a session (archive / hard-delete). */
export async function deleteSessionArtifacts(sessionId: string): Promise<void> {
  const keys = await tx<IDBValidKey[]>("readonly", (s) => s.index(SESSION_INDEX).getAllKeys(sessionId));
  for (const k of keys) await tx("readwrite", (s) => s.delete(k));
}

/** Drop oldest artifacts (smallest addedAt) until the session is within both
 *  the byte budget and the count cap. A single artifact never self-evicts
 *  (content is capped well below the session budget). */
async function enforceSessionLRU(sessionId: string): Promise<void> {
  const list = await tx<FileArtifact[]>("readonly", (s) => s.index(SESSION_INDEX).getAll(sessionId));
  list.sort((x, y) => x.addedAt - y.addedAt); // oldest first
  let total = list.reduce((n, x) => n + x.byteLength, 0);
  let count = list.length;
  const toDelete: string[] = [];
  for (let i = 0; i < list.length && (total > SESSION_BYTE_BUDGET || count > SESSION_COUNT_BUDGET); i++) {
    toDelete.push(list[i].id);
    total -= list[i].byteLength;
    count--;
  }
  for (const id of toDelete) await tx("readwrite", (s) => s.delete(id));
}

export async function _clearAllForTests(): Promise<void> {
  await tx("readwrite", (s) => s.clear());
}
