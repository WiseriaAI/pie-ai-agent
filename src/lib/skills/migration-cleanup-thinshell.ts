//
// One-shot cleanup for the 2 thin-shell builtin skills removed by
// docs/specs/2026-05-08-skill-tool-convention-design.md.
//
// Removes:
//   - chrome.storage.local["skill_take_screenshot"]   (user-side override copy, if any)
//   - chrome.storage.local["skill_open_url_in_tab"]   (user-side override copy, if any)
//   - matching markers in chrome.storage.local["enabled_skills"]:
//       "take_screenshot" / "!take_screenshot" / "open_url_in_tab" / "!open_url_in_tab"
//
// Idempotent (filter + conditional remove are no-ops once storage is clean).
// Called silently from src/background/index.ts at SW start, mirroring
// migrateV1toV2 wiring.

const REMOVED_BUILTIN_SKILL_IDS = ["take_screenshot", "open_url_in_tab"] as const;
const ENABLED_SKILLS_KEY = "enabled_skills";

export async function cleanupThinShellSkills(): Promise<void> {
  const skillKeys = REMOVED_BUILTIN_SKILL_IDS.map((id) => `skill_${id}`);
  const all = await chrome.storage.local.get([
    ...skillKeys,
    ENABLED_SKILLS_KEY,
  ]);

  // Pass 1 — drop user-side override copies for the removed builtin ids.
  const presentSkillKeys = skillKeys.filter((k) => k in all);
  if (presentSkillKeys.length > 0) {
    await chrome.storage.local.remove(presentSkillKeys);
  }

  // Pass 2 — filter enabled_skills markers (both plain id and "!id" form).
  const enabledIds = (all[ENABLED_SKILLS_KEY] as string[] | undefined) ?? [];
  const removedSet = new Set<string>([
    ...REMOVED_BUILTIN_SKILL_IDS,
    ...REMOVED_BUILTIN_SKILL_IDS.map((id) => `!${id}`),
  ]);
  const filtered = enabledIds.filter((eid) => !removedSet.has(eid));
  if (filtered.length !== enabledIds.length) {
    await chrome.storage.local.set({ [ENABLED_SKILLS_KEY]: filtered });
  }
}
