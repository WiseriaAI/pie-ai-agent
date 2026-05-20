import { describe, it, expect, beforeEach } from "vitest";
import { getEnabledSkillPackages } from "./index";
import { putPackage, listPackages, deletePackage } from "./skill-store";
import { setSkillEnabled } from "./storage";

describe("getEnabledSkillPackages", () => {
  beforeEach(async () => {
    // Clear storage state first to prevent enabled-state leaks across tests
    await chrome.storage.local.clear();
    // Then clean up any user packages in IndexedDB
    for (const p of await listPackages()) await deletePackage(p.id);
  });

  it("内置包默认启用,显式禁用后排除", async () => {
    const ids = (await getEnabledSkillPackages()).map((p) => p.id);
    expect(ids).toContain("extract_structured_data");

    await setSkillEnabled("extract_structured_data", false);
    const after = (await getEnabledSkillPackages()).map((p) => p.id);
    expect(after).not.toContain("extract_structured_data");
  });

  it("user 包 id 覆盖同名内置包", async () => {
    await putPackage({
      id: "extract_structured_data",
      frontmatter: { name: "Custom Extract", description: "x" },
      files: { "SKILL.md": "---\nname: Custom Extract\ndescription: x\n---\nbody" },
      builtIn: false,
      createdAt: 5,
    });
    const found = (await getEnabledSkillPackages()).find((p) => p.id === "extract_structured_data");
    expect(found?.frontmatter.name).toBe("Custom Extract");
  });

  it("新建 user 包必须显式 setSkillEnabled(true) 才出现在 enabled 列表中", async () => {
    const pkg = {
      id: "skill_user_new",
      frontmatter: { name: "My New Skill", description: "d" },
      files: { "SKILL.md": "---\nname: My New Skill\ndescription: d\n---\nbody" },
      builtIn: false,
      createdAt: 9,
    };
    // Without an enabled marker, a brand-new user package is excluded
    // (getEnabledSkillPackages only defaults built-ins on).
    await putPackage(pkg);
    const before = (await getEnabledSkillPackages()).map((p) => p.id);
    expect(before).not.toContain("skill_user_new");

    // The SkillsList create path writes the marker — then it appears.
    await setSkillEnabled("skill_user_new", true);
    const after = (await getEnabledSkillPackages()).map((p) => p.id);
    expect(after).toContain("skill_user_new");
  });

  it("resolveSkillToTools 不再导出", async () => {
    const mod = await import("./index");
    expect(mod).not.toHaveProperty("resolveSkillToTools");
  });
});
