import { describe, it, expect } from "vitest";
import path from "path";
import fs from "fs";
import { runQuery, __setSqlInitForTests } from "./sql-engine";
import initSqlJs from "sql.js";

// Point the engine at a node-readable wasm binary (offscreen uses locateFile).
__setSqlInitForTests(() =>
  initSqlJs({ wasmBinary: fs.readFileSync(path.resolve(__dirname, "../../node_modules/sql.js/dist/sql-wasm.wasm")) as unknown as ArrayBuffer }),
);

describe("runQuery", () => {
  it("imports records and runs a dedupe SELECT", async () => {
    const records = [{ url: "a", price: 10 }, { url: "a", price: 10 }, { url: "b", price: 20 }];
    const r = await runQuery("products", records, "SELECT DISTINCT url, price FROM products ORDER BY url");
    if ("error" in r) throw new Error(r.error);
    expect(r.columns).toEqual(["url", "price"]);
    expect(r.rows).toEqual([{ url: "a", price: 10 }, { url: "b", price: 20 }]);
  });

  it("stores nested objects as JSON text columns", async () => {
    const records = [{ id: 1, meta: { tag: "x" } }];
    const r = await runQuery("t", records, "SELECT id, meta FROM t");
    if ("error" in r) throw new Error(r.error);
    expect(r.rows[0].id).toBe(1);
    expect(JSON.parse(r.rows[0].meta as string)).toEqual({ tag: "x" });
  });

  it("returns a structured error on bad SQL", async () => {
    const r = await runQuery("t", [{ a: 1 }], "SELEKT * FROM t");
    expect("error" in r).toBe(true);
  });
});
