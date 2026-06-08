// src/lib/scratchpad/sql-bridge.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { _resetForTests } from "../idb/db";
import { saveRecords, readScratchpadRecords, MAX_SCRATCHPAD_BYTES } from "./service";
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

  it("in-place clean (into === from) sends the pre-clear snapshot and replaces the source", async () => {
    await saveRecords("s", "products", [{ url: "a" }, { url: "a" }, { url: "b" }], {});
    const sender = vi.fn().mockResolvedValue({ columns: ["url"], rows: [{ url: "a" }, { url: "b" }] });
    __setOffscreenSenderForTests(sender);

    const r = await queryScratchpad("s", {
      from: "products",
      sql: "SELECT DISTINCT url FROM products",
      into: "products",
    });
    if ("error" in r) throw new Error(r.error);
    expect(r.into).toBe("products");

    // ① The offscreen engine saw the original 3-row snapshot, not an emptied
    // table — the delete-then-write must not race the read of the source.
    expect(sender).toHaveBeenCalledWith({
      type: "sql:run",
      table: "products",
      records: [{ url: "a" }, { url: "a" }, { url: "b" }],
      sql: "SELECT DISTINCT url FROM products",
    });

    // ② The source collection is replaced by its own cleaned result — no loss.
    const read = await readScratchpadRecords("s", "products");
    if ("error" in read) throw new Error("expected products collection");
    expect(read.records).toEqual([{ url: "a" }, { url: "b" }]);
  });

  it("offscreen failure returns an error and never partially writes the target", async () => {
    await saveRecords("s", "products", [{ url: "a" }, { url: "b" }], {});
    __setOffscreenSenderForTests(
      vi.fn().mockRejectedValue(new Error("offscreen torn down")),
    );

    const r = await queryScratchpad("s", {
      from: "products",
      sql: "SELECT DISTINCT url FROM products",
      into: "clean",
    });
    // ① Surfaces a structured error.
    expect("error" in r).toBe(true);

    // ② No partial write: target collection never created, source untouched.
    const target = await readScratchpadRecords("s", "clean");
    expect("error" in target).toBe(true);
    const src = await readScratchpadRecords("s", "products");
    if ("error" in src) throw new Error("source collection must survive");
    expect(src.records).toEqual([{ url: "a" }, { url: "b" }]);
  });

  it("rejects an into write-back that exceeds the per-session byte budget", async () => {
    await saveRecords("s", "products", [{ url: "a" }], {});
    // SQL can amplify rows (e.g. a self cross-join), so the result set could
    // dwarf the source. Simulate an oversized result and confirm the budget
    // guard fires on the write-back path, not just on saveRecords.
    __setOffscreenSenderForTests(
      vi.fn().mockResolvedValue({
        columns: ["blob"],
        rows: [{ blob: "x".repeat(MAX_SCRATCHPAD_BYTES + 10) }],
      }),
    );

    const r = await queryScratchpad("s", {
      from: "products",
      sql: "SELECT 1",
      into: "huge",
    });
    // ① Structured capacity error.
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("capacity");

    // ② Nothing persisted: the oversized result never reached the store.
    const target = await readScratchpadRecords("s", "huge");
    expect("error" in target).toBe(true);
  });
});
