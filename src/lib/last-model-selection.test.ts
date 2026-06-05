import { describe, it, expect } from "vitest";
import { getLastModelSelection, setLastModelSelection } from "./last-model-selection";

// chrome.storage.local in-memory mock + per-test reset provided by src/test/setup.ts

describe("last-model-selection", () => {
  it("returns null when nothing stored", async () => {
    expect(await getLastModelSelection()).toBeNull();
  });

  it("round-trips instanceId + model", async () => {
    await setLastModelSelection({ instanceId: "i1", model: "gpt-4o" });
    expect(await getLastModelSelection()).toEqual({ instanceId: "i1", model: "gpt-4o" });
  });

  it("overwrites prior selection", async () => {
    await setLastModelSelection({ instanceId: "i1", model: "gpt-4o" });
    await setLastModelSelection({ instanceId: "i2", model: "claude-opus-4-7" });
    expect(await getLastModelSelection()).toEqual({ instanceId: "i2", model: "claude-opus-4-7" });
  });
});
