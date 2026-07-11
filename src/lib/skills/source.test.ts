import { describe, it, expect, beforeEach } from "vitest";
import {
  idbSkillSource, withBuiltins, filterEnabled, stripFrontmatter, kebabSlug,
  type SkillEntry, type SkillSource,
} from "./source";
import { putPackage, listPackages, deletePackage } from "./skill-store";
import { BUILT_IN_SKILL_PACKAGES } from "./builtin";
import type { SkillPackage } from "./package-types";

const pkg = (id: string, extra?: Partial<SkillPackage>): SkillPackage => ({
  id,
  frontmatter: { name: `Name ${id}`, description: `${id} desc` },
  files: { "SKILL.md": `---\nname: Name ${id}\ndescription: ${id} desc\n---\nBODY ${id}`, "references/a.md": "ref" },
  builtIn: false,
  createdAt: 42,
  ...extra,
});

describe("idbSkillSource", () => {
  beforeEach(async () => {
    for (const p of await listPackages()) await deletePackage(p.id);
  });

  it("list maps packages to SkillEntry (origin=idb, files, createdAt)", async () => {
    await putPackage(pkg("skill_user_x"));
    const [e] = await idbSkillSource.list();
    expect(e.id).toBe("skill_user_x");
    expect(e.name).toBe("Name skill_user_x");
    expect(e.origin).toBe("idb");
    expect(e.files.sort()).toEqual(["SKILL.md", "references/a.md"]);
    expect(e.createdAt).toBe(42);
  });

  it("readFile returns content / null", async () => {
    await putPackage(pkg("skill_user_x"));
    expect(await idbSkillSource.readFile("skill_user_x", "references/a.md")).toBe("ref");
    expect(await idbSkillSource.readFile("skill_user_x", "nope")).toBeNull();
  });

  it("write upserts a package parsed from SKILL.md; delete removes", async () => {
    await idbSkillSource.write("skill_user_w", [
      { path: "SKILL.md", content: "---\nname: W\ndescription: wd\n---\nbody" },
    ]);
    const [e] = await idbSkillSource.list();
    expect(e.name).toBe("W");
    expect(await idbSkillSource.delete("skill_user_w")).toBe(true);
    expect(await idbSkillSource.list()).toEqual([]);
    expect(await idbSkillSource.delete("skill_user_w")).toBe(false);
  });
});

describe("withBuiltins", () => {
  const fakeBackend = (entries: SkillEntry[]): SkillSource => ({
    mode: "idb",
    list: async () => entries,
    readFile: async () => null,
    write: async () => {},
    delete: async () => false,
  });

  it("merges builtin entries; backend wins on same id", async () => {
    const someBuiltinId = BUILT_IN_SKILL_PACKAGES[0].id;
    const override: SkillEntry = {
      id: someBuiltinId, name: "override", description: "o", builtIn: false,
      origin: "idb", files: ["SKILL.md"], runnableScripts: [],
    };
    const merged = await withBuiltins(fakeBackend([override])).list();
    expect(merged.filter((e) => e.id === someBuiltinId)).toHaveLength(1);
    expect(merged.find((e) => e.id === someBuiltinId)?.name).toBe("override");
    // 其余 builtin 全在
    expect(merged.filter((e) => e.origin === "builtin")).toHaveLength(BUILT_IN_SKILL_PACKAGES.length - 1);
  });

  it("readFile falls back to builtin files when backend misses", async () => {
    const someBuiltin = BUILT_IN_SKILL_PACKAGES[0];
    const src = withBuiltins(fakeBackend([]));
    const md = await src.readFile(someBuiltin.id, "SKILL.md");
    expect(md).toBe(someBuiltin.files["SKILL.md"]);
  });
});

describe("filterEnabled", () => {
  const entry = (id: string, origin: SkillEntry["origin"], builtIn = false): SkillEntry => ({
    id, name: id, description: "", builtIn, origin, files: [], runnableScripts: [],
  });
  it("disk + builtin default on; idb default off; markers override both ways", () => {
    const entries = [
      entry("b", "builtin", true), entry("d", "disk"), entry("u", "idb"),
      entry("d2", "disk"), entry("u2", "idb"),
    ];
    const on = filterEnabled(entries, ["!d2", "u2"]).map((e) => e.id).sort();
    expect(on).toEqual(["b", "d", "u2"]);
  });
});

describe("helpers", () => {
  it("stripFrontmatter removes fence, keeps body; passthrough without fence", () => {
    expect(stripFrontmatter("---\nname: x\n---\nBODY")).toBe("BODY");
    expect(stripFrontmatter("no fence")).toBe("no fence");
  });
  it("kebabSlug produces daemon-safe names", () => {
    expect(kebabSlug("Web Fetch 2")).toBe("web-fetch-2");
    expect(kebabSlug("  --Weird__name!  ")).toBe("weird-name");
    expect(kebabSlug("中文名")).toBe("");
  });
});
