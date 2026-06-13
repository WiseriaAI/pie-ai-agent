import { describe, expect, it } from "vitest";
import { buildLoadToolsTool } from "./disclosure";

function makeTool(active: Set<string>, headless = false) {
  return buildLoadToolsTool({
    getActiveGroups: () => active,
    headless,
  });
}

describe("load_tools tool", () => {
  it("declares name + a groups array param", () => {
    const t = makeTool(new Set(["core"]));
    expect(t.name).toBe("load_tools");
    expect(t.parameters).toMatchObject({ type: "object" });
  });

  it("loading scratchpad succeeds and mutates the active set", async () => {
    const active = new Set<string>(["core"]);
    const t = makeTool(active);
    const r = await t.handler({ groups: ["scratchpad"] }, {} as any);
    expect(r.success).toBe(true);
    expect(active.has("scratchpad")).toBe(true);
    expect(r.observation).toContain("scratchpad");
    expect(r.observation).toContain("save_records");
  });

  it("unknown group → observation mentions unknown", async () => {
    const active = new Set<string>(["core"]);
    const t = makeTool(active);
    const r = await t.handler({ groups: ["bogus"] }, {} as any);
    expect((r.observation ?? "").toLowerCase()).toContain("unknown");
  });

  it("empty groups → error observation", async () => {
    const t = makeTool(new Set(["core"]));
    const r = await t.handler({ groups: [] }, {} as any);
    expect(r.success).toBe(false);
  });

  it("headless excludes schedule from the loadable enum + description", () => {
    const t = makeTool(new Set(["core"]), true);
    const enumVals = (t.parameters as any).properties.groups.items.enum as string[];
    expect(enumVals).not.toContain("schedule");
  });
});
