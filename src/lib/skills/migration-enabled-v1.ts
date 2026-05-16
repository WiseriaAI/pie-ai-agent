const FLAG_KEY = "enabled_skills_migrated_v1";
const ENABLED_KEY = "enabled_skills";

export async function migrateSkillsEnabledAllOn(): Promise<void> {
  try {
    const got = await chrome.storage.local.get([FLAG_KEY, ENABLED_KEY]);
    if (got[FLAG_KEY]) return;
    const raw = Array.isArray(got[ENABLED_KEY]) ? (got[ENABLED_KEY] as unknown[]) : [];
    const next = raw.filter(
      (id): id is string => typeof id === "string" && !id.startsWith("!"),
    );
    await chrome.storage.local.set({
      [ENABLED_KEY]: next,
      [FLAG_KEY]: true,
    });
  } catch (err) {
    console.warn("[migration-enabled-v1] failed (will retry on next boot)", err);
  }
}
