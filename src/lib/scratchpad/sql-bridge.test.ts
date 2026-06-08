// src/lib/scratchpad/sql-bridge.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { _resetForTests } from "../idb/db";
import { saveRecords, readScratchpadRecords } from "./service";
import { queryScratchpad, __setOffscreenSenderForTests } from "./sql-bridge";

describe("queryScratchpad", () => {
  beforeEach(async () => {
    await _resetForTests();
    __setOffscreenSenderForTests(null); // reset
  });

  it("reads source collection, sends to offscreen, returns summary", async () => {
    await saveRecords("s", "products", [{ url: "a" }, { url: "a" }, { url: "b" }], {});
    const sender = vi.fn().mockResolvedValue({ columns: ["url"], rows: [{ url: "a" }, { url: "b" }] });
    __setOffscreenSenderForTests(sender);

    const r = await queryScratchpad("s", { from: "products", sql: "SELECT DISTINCT url FROM products" });
    if ("error" in r) throw new Error(r.error);
    expect(r.rows).toBe(2);
    expect(sender).toHaveBeenCalledWith({
      type: "sql:run",
      table: "products",
      records: [{ url: "a" }, { url: "a" }, { url: "b" }],
      sql: "SELECT DISTINCT url FROM products",
    });
    expect(r.preview).toHaveLength(2);
  });

  it("writes result back into a new collection when `into` is given", async () => {
    await saveRecords("s", "products", [{ url: "a" }, { url: "a" }], {});
    __setOffscreenSenderForTests(vi.fn().mockResolvedValue({ columns: ["url"], rows: [{ url: "a" }] }));

    const r = await queryScratchpad("s", { from: "products", sql: "SELECT DISTINCT url FROM products", into: "clean" });
    if ("error" in r) throw new Error(r.error);
    expect(r.into).toBe("clean");
    const read = await readScratchpadRecords("s", "clean");
    if ("error" in read) throw new Error("expected clean collection");
    expect(read.records).toEqual([{ url: "a" }]);
  });

  it("errors when source collection is missing", async () => {
    __setOffscreenSenderForTests(vi.fn());
    const r = await queryScratchpad("s", { from: "nope", sql: "SELECT 1" });
    expect("error" in r).toBe(true);
  });
});
