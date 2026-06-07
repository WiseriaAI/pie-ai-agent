import { describe, it, expect, beforeEach } from "vitest";
import { openDb, tx, txMulti, STORES, _resetForTests } from "../db";

beforeEach(async () => {
  await _resetForTests();
});

describe("openDb", () => {
  it("creates all four object stores", async () => {
    const db = await openDb();
    expect(db.objectStoreNames.contains(STORES.sessions)).toBe(true);
    expect(db.objectStoreNames.contains(STORES.sessionIndex)).toBe(true);
    expect(db.objectStoreNames.contains(STORES.instances)).toBe(true);
    expect(db.objectStoreNames.contains(STORES.config)).toBe(true);
    db.close();
  });
});

describe("tx", () => {
  it("round-trips a record in the config store", async () => {
    await tx(STORES.config, "readwrite", (s) => s.put({ key: "k", value: 1 }));
    const got = await tx<{ key: string; value: number } | undefined>(
      STORES.config, "readonly", (s) => s.get("k"),
    );
    expect(got?.value).toBe(1);
  });
});

describe("txMulti", () => {
  it("writes across two stores atomically in one transaction", async () => {
    await txMulti([STORES.sessions, STORES.sessionIndex], "readwrite", (stores) => {
      stores[STORES.sessions].put({ id: "s1:meta", value: { title: "x" } });
      stores[STORES.sessionIndex].put({ id: "index", value: [{ id: "s1" }] });
    });
    const meta = await tx<{ id: string; value: { title: string } } | undefined>(
      STORES.sessions, "readonly", (s) => s.get("s1:meta"),
    );
    expect(meta?.value.title).toBe("x");
  });
});
