import { describe, expect, it } from "vitest";
import { groupsForEnv, selectTools, GROUP_META, LOADABLE_GROUPS } from "./disclosure";
import {
  buildToolCatalogBlock,
  buildActivationNotice,
  resolveLoadTools,
} from "./disclosure";

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

describe("buildToolCatalogBlock", () => {
  it("lists loadable groups NOT active at start, wrapped in a tag", () => {
    const block = buildToolCatalogBlock(new Set(["core"]));
    expect(block).toContain("<available_tools_catalog>");
    expect(block).toContain("pdf —");
    expect(block).toContain("scratchpad —");
    expect(block).toContain("load_tools");
  });
  it("omits groups already active at start", () => {
    const block = buildToolCatalogBlock(new Set(["core", "pdf"]));
    expect(block).not.toContain("pdf —");
    expect(block).toContain("scratchpad —");
  });
  it("returns empty string when every loadable group is active", () => {
    const all = new Set<string>(["core", "pdf", "local-file", "scratchpad", "schedule", "skill-authoring"]);
    expect(buildToolCatalogBlock(all)).toBe("");
  });
});

describe("buildActivationNotice", () => {
  it("includes guidance + the newly available tool names", () => {
    const note = buildActivationNotice(["pdf"]);
    expect(note).toContain("read_pdf");
    expect(note).toContain("get_pdf_outline");
    expect(note.toLowerCase()).toContain("pdf");
  });
  it("empty groups → empty string", () => {
    expect(buildActivationNotice([])).toBe("");
  });
});

describe("resolveLoadTools — validate + partition", () => {
  it("loads a fresh loadable group", () => {
    const active = new Set<string>(["core"]);
    const r = resolveLoadTools(["scratchpad"], active, { headless: false });
    expect(r.loaded).toEqual(["scratchpad"]);
    expect(active.has("scratchpad")).toBe(true);
  });
  it("idempotent — already active goes to alreadyActive", () => {
    const active = new Set<string>(["core", "pdf"]);
    const r = resolveLoadTools(["pdf"], active, { headless: false });
    expect(r.alreadyActive).toEqual(["pdf"]);
    expect(r.loaded).toEqual([]);
  });
  it("unknown / non-loadable names go to unknown", () => {
    const active = new Set<string>(["core"]);
    const r = resolveLoadTools(["screenshot", "bogus"], active, { headless: false });
    expect(r.unknown).toEqual(expect.arrayContaining(["screenshot", "bogus"]));
    expect(active.has("screenshot")).toBe(false);
  });
  it("headless cannot load schedule", () => {
    const active = new Set<string>(["core"]);
    const r = resolveLoadTools(["schedule"], active, { headless: true });
    expect(r.unknown).toContain("schedule");
    expect(active.has("schedule")).toBe(false);
  });
});
