import { describe, it, expect } from "vitest";
import { chromeMock } from "@/test/setup";
import { migrateSkillsEnabledAllOn } from "../migration-enabled-v1";

describe("migrateSkillsEnabledAllOn", () => {
  it("strips '!<id>' entries from enabled_skills and writes flag", async () => {
    await chromeMock.storage.local.set({
      enabled_skills: [
        "!close_duplicate_tabs",
        "!close_inactive_tabs",
        "skill_user_a",
      ],
    });
    await migrateSkillsEnabledAllOn();
    const got = await chromeMock.storage.local.get([
      "enabled_skills",
      "enabled_skills_migrated_v1",
    ]);
    expect(got.enabled_skills).toEqual(["skill_user_a"]);
    expect(got.enabled_skills_migrated_v1).toBe(true);
  });

  it("is idempotent — second run is a no-op", async () => {
    await chromeMock.storage.local.set({
      enabled_skills: ["!close_duplicate_tabs"],
    });
    await migrateSkillsEnabledAllOn();
    const afterFirst = await chromeMock.storage.local.get("enabled_skills");
    expect(afterFirst.enabled_skills).toEqual([]);

    // Manually re-introduce a '!<id>' entry to prove migration doesn't run again.
    await chromeMock.storage.local.set({
      enabled_skills: ["!close_duplicate_tabs"],
    });
    await migrateSkillsEnabledAllOn();
    const afterSecond = await chromeMock.storage.local.get("enabled_skills");
    expect(afterSecond.enabled_skills).toEqual(["!close_duplicate_tabs"]);
  });

  it("handles missing enabled_skills (fresh install) gracefully", async () => {
    await migrateSkillsEnabledAllOn();
    const got = await chromeMock.storage.local.get([
      "enabled_skills",
      "enabled_skills_migrated_v1",
    ]);
    expect(got.enabled_skills).toEqual([]);
    expect(got.enabled_skills_migrated_v1).toBe(true);
  });

  it("does not throw if storage.get throws (best-effort)", async () => {
    const origGet = chromeMock.storage.local.get;
    chromeMock.storage.local.get = (() =>
      Promise.reject(new Error("storage borked"))) as typeof origGet;
    await expect(migrateSkillsEnabledAllOn()).resolves.toBeUndefined();
    chromeMock.storage.local.get = origGet;
  });
});
