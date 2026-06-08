// src/lib/scratchpad/service.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { _resetForTests } from "../idb/db";
import {
  saveRecords,
  updateNotes,
  readScratchpadRecords,
  clearScratchpadCollections,
  getOverview,
  MAX_SCRATCHPAD_BYTES,
} from "./service";

describe("scratchpad service", () => {
  beforeEach(async () => {
    await _resetForTests();
  });

  it("saveRecords persists and reports added/skipped/total", async () => {
    const r1 = await saveRecords("s", "p", [{ url: "a" }, { url: "b" }], { dedupeKey: "url" });
    expect(r1).toMatchObject({ added: 2, skipped: 0, total: 2 });
    const r2 = await saveRecords("s", "p", [{ url: "a" }, { url: "c" }]);
    expect(r2).toMatchObject({ added: 1, skipped: 1, total: 3 });
  });

  it("saveRecords rejects when over the byte budget", async () => {
    const big = { blob: "x".repeat(MAX_SCRATCHPAD_BYTES + 10) };
    const r = await saveRecords("s", "p", [big]);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("capacity");
    // nothing persisted
    const read = await readScratchpadRecords("s", "p");
    expect("error" in read).toBe(true); // collection never created
  });

  it("updateNotes persists notes", async () => {
    await updateNotes("s", "progress: page 2");
    expect(await getOverview("s")).toContain("progress: page 2");
  });

  it("readScratchpadRecords paginates", async () => {
    await saveRecords("s", "p", [{ i: 0 }, { i: 1 }, { i: 2 }]);
    const r = await readScratchpadRecords("s", "p", { offset: 1, limit: 1 });
    if ("error" in r) throw new Error("unexpected");
    expect(r.records).toEqual([{ i: 1 }]);
    expect(r.total).toBe(3);
  });

  it("clearScratchpadCollections clears a collection", async () => {
    await saveRecords("s", "p", [{ i: 0 }]);
    await clearScratchpadCollections("s", "p");
    const r = await readScratchpadRecords("s", "p");
    expect("error" in r).toBe(true);
  });

  it("getOverview is empty for an unused session", async () => {
    expect(await getOverview("fresh")).toBe("");
  });
});
