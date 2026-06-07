import { describe, it, expect } from "vitest";

describe("test env IndexedDB", () => {
  it("exposes a working indexedDB global", async () => {
    expect(typeof indexedDB).toBe("object");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("pie-test-probe", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("s", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(db.objectStoreNames.contains("s")).toBe(true);
    db.close();
  });
});
