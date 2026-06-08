// src/lib/scratchpad/store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { _resetForTests } from "../idb/db";
import { emptyScratchpad } from "./types";
import { appendRecords } from "./operations";
import { readScratchpad, writeScratchpad, deleteScratchpad } from "./store";

describe("scratchpad store", () => {
  beforeEach(async () => {
    await _resetForTests();
  });

  it("returns an empty scratchpad on miss", async () => {
    const pad = await readScratchpad("nope");
    expect(pad.id).toBe("nope");
    expect(pad.collections).toEqual({});
  });

  it("round-trips a written scratchpad and stamps updatedAt", async () => {
    const pad = appendRecords(emptyScratchpad("s1"), "p", [{ url: "a" }]).pad;
    await writeScratchpad(pad);
    const read = await readScratchpad("s1");
    expect(read.collections.p.records).toEqual([{ url: "a" }]);
    expect(read.updatedAt).toBeGreaterThan(0);
  });

  it("deletes a scratchpad", async () => {
    await writeScratchpad(appendRecords(emptyScratchpad("s2"), "p", [{ x: 1 }]).pad);
    await deleteScratchpad("s2");
    const read = await readScratchpad("s2");
    expect(read.collections).toEqual({});
  });
});
