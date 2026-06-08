import { describe, it, expect } from "vitest";
import initSqlJs from "sql.js";
import path from "path";
import fs from "fs";

describe("sql.js smoke (node)", () => {
  it("creates a table, inserts, selects", async () => {
    const wasmBinary = fs.readFileSync(
      path.resolve(__dirname, "../../node_modules/sql.js/dist/sql-wasm.wasm"),
    );
    const SQL = await initSqlJs({ wasmBinary });
    const db = new SQL.Database();
    db.run("CREATE TABLE t (url TEXT, price INTEGER)");
    db.run("INSERT INTO t VALUES ('a', 10), ('a', 10), ('b', 20)");
    const res = db.exec("SELECT DISTINCT url, price FROM t ORDER BY url");
    expect(res[0].columns).toEqual(["url", "price"]);
    expect(res[0].values).toEqual([["a", 10], ["b", 20]]);
    db.close();
  });
});
