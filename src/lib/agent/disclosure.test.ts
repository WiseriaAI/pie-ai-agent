import { describe, expect, it } from "vitest";
import { groupsForEnv, selectTools, GROUP_META, LOADABLE_GROUPS } from "./disclosure";

describe("groupsForEnv — pure env → groups", () => {
  it("no signals → empty (core is added by the loop seed, not here)", () => {
    expect(groupsForEnv({ vision: false, hasSkills: false, isPdf: false, isFile: false })).toEqual([]);
  });
  it("vision lights screenshot", () => {
    expect(groupsForEnv({ vision: true, hasSkills: false, isPdf: false, isFile: false })).toContain("screenshot");
  });
  it("skills lights skill-mediation", () => {
    expect(groupsForEnv({ vision: false, hasSkills: true, isPdf: false, isFile: false })).toContain("skill-mediation");
  });
  it("pdf + file light their groups", () => {
    const g = groupsForEnv({ vision: false, hasSkills: false, isPdf: true, isFile: true });
    expect(g).toEqual(expect.arrayContaining(["pdf", "local-file"]));
  });
});

describe("selectTools — filter by active groups", () => {
  const tools = [
    { name: "click" }, { name: "read_pdf" }, { name: "save_records" }, { name: "load_tools" },
  ];
  it("core-only keeps core tools, drops pdf/scratchpad", () => {
    const names = selectTools(tools, new Set(["core"])).map((t) => t.name);
    expect(names).toEqual(["click", "load_tools"]);
  });
  it("active pdf adds read_pdf", () => {
    const names = selectTools(tools, new Set(["core", "pdf"])).map((t) => t.name);
    expect(names).toContain("read_pdf");
    expect(names).not.toContain("save_records");
  });
});

describe("GROUP_META / LOADABLE_GROUPS", () => {
  it("screenshot + skill-mediation are NOT loadable (env-only, vision/skills gated)", () => {
    expect(LOADABLE_GROUPS).not.toContain("screenshot");
    expect(LOADABLE_GROUPS).not.toContain("skill-mediation");
  });
  it("pdf / scratchpad / schedule / skill-authoring / local-file ARE loadable", () => {
    for (const g of ["pdf", "scratchpad", "schedule", "skill-authoring", "local-file"]) {
      expect(LOADABLE_GROUPS).toContain(g);
    }
  });
  it("every loadable group has a catalogLine and guidance", () => {
    for (const g of LOADABLE_GROUPS) {
      expect(GROUP_META[g].catalogLine, g).toBeTruthy();
      expect(GROUP_META[g].guidance, g).toBeTruthy();
    }
  });
});
