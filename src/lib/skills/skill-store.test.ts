import { describe, it, expect, beforeEach } from "vitest";
import { putPackage, getPackage, listPackages, deletePackage, getPackageFile } from "./skill-store";
import type { SkillPackage } from "./package-types";

const pkg = (id: string): SkillPackage => ({
  id,
  frontmatter: { name: id, description: `${id} desc` },
  files: { "SKILL.md": `---\nname: ${id}\ndescription: ${id} desc\n---\nbody of ${id}` },
  builtIn: false,
  createdAt: 1,
});

describe("skill-store (IndexedDB)", () => {
  beforeEach(async () => {
    for (const p of await listPackages()) await deletePackage(p.id);
  });

  it("put + get round-trips", async () => {
    await putPackage(pkg("a"));
    const got = await getPackage("a");
    expect(got?.frontmatter.name).toBe("a");
  });

  it("list 返回全部", async () => {
    await putPackage(pkg("a"));
    await putPackage(pkg("b"));
    const ids = (await listPackages()).map((p) => p.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  it("delete 移除", async () => {
    await putPackage(pkg("a"));
    await deletePackage("a");
    expect(await getPackage("a")).toBeNull();
  });

  it("getPackageFile 取单个文件,缺失返回 null", async () => {
    await putPackage(pkg("a"));
    expect(await getPackageFile("a", "SKILL.md")).toContain("body of a");
    expect(await getPackageFile("a", "nope.md")).toBeNull();
  });
});
