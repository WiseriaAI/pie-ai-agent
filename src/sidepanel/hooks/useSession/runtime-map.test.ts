import { describe, it, expect } from "vitest";
import { EMPTY_SLOT, withSlot } from "./runtime-map";
import type { Quote } from "@/types";

describe("SessionRuntimeSlot quotes field", () => {
  it("EMPTY_SLOT.quotes defaults to empty array", () => {
    expect(EMPTY_SLOT.quotes).toEqual([]);
  });

  it("withSlot can append a quote", () => {
    const q: Quote = { id: "1", kind: "text", text: "x", sourceUrl: "u", sourceTabId: 1 };
    const prev = new Map();
    const next = withSlot(prev, "S1", (s) => ({ quotes: [...s.quotes, q] }));
    expect(next.get("S1")!.quotes).toEqual([q]);
  });

  it("withSlot can clear quotes (set to [])", () => {
    const q: Quote = { id: "1", kind: "text", text: "x", sourceUrl: "u", sourceTabId: 1 };
    const seeded = withSlot(new Map(), "S1", { quotes: [q] });
    const cleared = withSlot(seeded, "S1", { quotes: [] });
    expect(cleared.get("S1")!.quotes).toEqual([]);
  });
});
