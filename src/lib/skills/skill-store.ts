import type { SkillPackage } from "./package-types";

const DB_NAME = "pie-skills";
const STORE = "packages";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
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

export async function putPackage(pkg: SkillPackage): Promise<void> {
  await tx("readwrite", (s) => s.put(pkg));
}

export async function getPackage(id: string): Promise<SkillPackage | null> {
  const r = await tx<SkillPackage | undefined>("readonly", (s) => s.get(id));
  return r ?? null;
}

export async function listPackages(): Promise<SkillPackage[]> {
  return tx<SkillPackage[]>("readonly", (s) => s.getAll());
}

export async function deletePackage(id: string): Promise<void> {
  await tx<undefined>("readwrite", (s) => s.delete(id));
}

export async function getPackageFile(id: string, path: string): Promise<string | null> {
  const pkg = await getPackage(id);
  return pkg?.files[path] ?? null;
}
