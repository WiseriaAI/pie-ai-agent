// src/lib/scratchpad/types.test.ts
import { describe, it, expect } from "vitest";
import { emptyScratchpad } from "./types";

describe("emptyScratchpad", () => {
  it("creates an empty scratchpad keyed by sessionId", () => {
    const pad = emptyScratchpad("sess-1");
    expect(pad.id).toBe("sess-1");
    expect(pad.collections).toEqual({});
    expect(pad.notes).toBe("");
    expect(typeof pad.updatedAt).toBe("number");
  });
});
