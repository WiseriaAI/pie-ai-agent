import { describe, it, expect, beforeEach } from "vitest";
import { _resetForTests } from "../idb/db";
import { saveRecords, updateNotes, getOverview } from "../scratchpad/service";

// Smoke test for the data path loop.ts uses to inject the overview:
// service writes → getOverview returns a bounded block containing the data.
describe("scratchpad overview injection path", () => {
  beforeEach(async () => { await _resetForTests(); });

  it("reflects saved records and notes in the overview block", async () => {
    await saveRecords("sess", "products", [{ url: "a", name: "Widget" }], { dedupeKey: "url" });
    await updateNotes("sess", "page 1 done; next page 2");
    const overview = await getOverview("sess");
    expect(overview).toContain("<scratchpad_overview>");
    expect(overview).toContain("products: 1");
    expect(overview).toContain("page 1 done; next page 2");
    expect(overview).toContain("<untrusted_scratchpad_preview>");
  });

  it("is empty for a session that never used the scratchpad", async () => {
    expect(await getOverview("idle")).toBe("");
  });
});
