// src/lib/scratchpad/operations.test.ts
import { describe, it, expect } from "vitest";
import { emptyScratchpad } from "./types";
import {
  appendRecords,
  setNotes,
  clearScratchpad,
  readRecords,
  estimateBytes,
} from "./operations";

describe("appendRecords", () => {
  it("appends records into a new collection", () => {
    const pad = emptyScratchpad("s");
    const r = appendRecords(pad, "products", [{ url: "a" }, { url: "b" }]);
    expect(r.added).toBe(2);
    expect(r.skipped).toBe(0);
    expect(r.total).toBe(2);
    expect(r.pad.collections.products.records).toHaveLength(2);
  });

  it("records fields and dedupeKey on first save", () => {
    const pad = emptyScratchpad("s");
    const r = appendRecords(pad, "products", [{ url: "a", name: "x" }], {
      dedupeKey: "url",
      fields: ["url", "name"],
    });
    expect(r.pad.collections.products.dedupeKey).toBe("url");
    expect(r.pad.collections.products.fields).toEqual(["url", "name"]);
  });

  it("skips duplicates by dedupeKey across calls (idempotent retry)", () => {
    let pad = emptyScratchpad("s");
    pad = appendRecords(pad, "products", [{ url: "a" }], { dedupeKey: "url" }).pad;
    const r = appendRecords(pad, "products", [{ url: "a" }, { url: "c" }]);
    expect(r.added).toBe(1); // only "c"
    expect(r.skipped).toBe(1); // "a" duplicate
    expect(r.total).toBe(2);
  });

  it("dedupes within a single batch too", () => {
    const pad = emptyScratchpad("s");
    const r = appendRecords(pad, "p", [{ url: "a" }, { url: "a" }], { dedupeKey: "url" });
    expect(r.added).toBe(1);
    expect(r.skipped).toBe(1);
  });
});

describe("setNotes", () => {
  it("overwrites the whole notes block", () => {
    let pad = emptyScratchpad("s");
    pad = setNotes(pad, "done page 1");
    expect(pad.notes).toBe("done page 1");
    pad = setNotes(pad, "done page 2");
    expect(pad.notes).toBe("done page 2");
  });
});

describe("clearScratchpad", () => {
  it("clears one collection by name", () => {
    let pad = emptyScratchpad("s");
    pad = appendRecords(pad, "a", [{ x: 1 }]).pad;
    pad = appendRecords(pad, "b", [{ y: 2 }]).pad;
    pad = clearScratchpad(pad, "a");
    expect(pad.collections.a).toBeUndefined();
    expect(pad.collections.b).toBeDefined();
  });

  it("clears everything when no collection given", () => {
    let pad = emptyScratchpad("s");
    pad = appendRecords(pad, "a", [{ x: 1 }]).pad;
    pad = setNotes(pad, "hi");
    pad = clearScratchpad(pad);
    expect(pad.collections).toEqual({});
    expect(pad.notes).toBe("");
  });
});

describe("readRecords", () => {
  it("returns an error for unknown collection with available names", () => {
    let pad = emptyScratchpad("s");
    pad = appendRecords(pad, "products", [{ url: "a" }]).pad;
    const r = readRecords(pad, "missing");
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("products");
  });

  it("paginates with offset/limit", () => {
    let pad = emptyScratchpad("s");
    pad = appendRecords(pad, "p", [{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }]).pad;
    const r = readRecords(pad, "p", { offset: 1, limit: 2 });
    if ("error" in r) throw new Error("unexpected error");
    expect(r.records).toEqual([{ i: 1 }, { i: 2 }]);
    expect(r.total).toBe(4);
    expect(r.offset).toBe(1);
  });

  it("filters by query substring across stringified record", () => {
    let pad = emptyScratchpad("s");
    pad = appendRecords(pad, "p", [{ name: "apple" }, { name: "banana" }]).pad;
    const r = readRecords(pad, "p", { query: "ana" });
    if ("error" in r) throw new Error("unexpected error");
    expect(r.records).toEqual([{ name: "banana" }]);
    expect(r.total).toBe(1);
  });
});

describe("estimateBytes", () => {
  it("grows with content", () => {
    const empty = estimateBytes(emptyScratchpad("s"));
    const full = estimateBytes(appendRecords(emptyScratchpad("s"), "p", [{ x: "y".repeat(1000) }]).pad);
    expect(full).toBeGreaterThan(empty);
  });
});
