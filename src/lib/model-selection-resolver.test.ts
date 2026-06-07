import { describe, it, expect, beforeEach } from "vitest";
import { chromeMock } from "@/test/setup";
import { resolveSelection } from "./model-selection-resolver";
import { createInstance } from "./instances";
import { setLastModelSelection } from "./last-model-selection";
import { _resetForTests } from "./idb/db";
import { _resetKeyForTests } from "./crypto";

// Instances + last_model_selection now persist in IDB. Reset the `pie` db per
// test so instances/last-selection from a prior test can't leak into the
// "no instances configured" / first-instance-fallback cases.
beforeEach(async () => {
  chromeMock.storage.local.__store = {};
  await _resetForTests();
  _resetKeyForTests();
});

describe("resolveSelection", () => {
  it("prefers session's own instanceId + model", async () => {
    const id = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "k" });
    const sel = await resolveSelection({ instanceId: id, model: "claude-opus-4-7" });
    expect(sel).toEqual({ instanceId: id, model: "claude-opus-4-7" });
  });

  it("falls back to last_model_selection when session has none", async () => {
    const id = await createInstance({ provider: "openai", nickname: "O", apiKey: "k" });
    await setLastModelSelection({ instanceId: id, model: "gpt-4o" });
    const sel = await resolveSelection({});
    expect(sel).toEqual({ instanceId: id, model: "gpt-4o" });
  });

  it("falls back to first instance's first registry model", async () => {
    const id = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "k" });
    const sel = await resolveSelection({});
    expect(sel).toEqual({ instanceId: id, model: "claude-opus-4-7" });
  });

  it("returns null when no instances configured", async () => {
    expect(await resolveSelection({})).toBeNull();
  });

  it("session instanceId but no model → backfills via firstModelForProvider", async () => {
    const id = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "k" });
    const sel = await resolveSelection({ instanceId: id });
    expect(sel).toEqual({ instanceId: id, model: "claude-opus-4-7" });
  });

  it("ignores a stale (deleted) session instanceId and falls back to last", async () => {
    const id = await createInstance({ provider: "openai", nickname: "O", apiKey: "k" });
    await setLastModelSelection({ instanceId: id, model: "gpt-4o" });
    const sel = await resolveSelection({ instanceId: "ghost", model: "x" });
    expect(sel).toEqual({ instanceId: id, model: "gpt-4o" });
  });
});
