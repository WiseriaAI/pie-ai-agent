import { describe, it, expect, beforeEach } from "vitest";
import { migrateSkillsToPackages } from "./migration-packages";
import { listPackages, deletePackage } from "./skill-store";

describe("migrateSkillsToPackages", () => {
  beforeEach(async () => {
    for (const p of await listPackages()) await deletePackage(p.id);
    await chrome.storage.local.clear();
  });

  it("旧 skill_* (promptTemplate) → 包 (SKILL.md body)", async () => {
    await chrome.storage.local.set({
      skill_user_x: { id: "skill_user_x", name: "Old Skill", description: "od", promptTemplate: "Do the old thing.", builtIn: false },
    });
    await migrateSkillsToPackages();
    const pkg = (await listPackages()).find((p) => p.id === "skill_user_x");
    expect(pkg?.files["SKILL.md"]).toContain("Do the old thing.");
    expect(pkg?.frontmatter.name).toBe("Old Skill");
    const old = await chrome.storage.local.get("skill_user_x");
    expect(old.skill_user_x).toBeUndefined();
  });

  it("幂等:再次运行不抛错", async () => {
    await migrateSkillsToPackages();
    await migrateSkillsToPackages();
    expect(true).toBe(true);
  });
});
