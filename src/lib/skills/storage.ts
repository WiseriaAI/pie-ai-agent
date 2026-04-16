import type { SkillDefinition } from "./types";

// Key prefix for individual skill definitions (not encrypted — not secrets)
function skillStorageKey(id: string): string {
  return `skill_${id}`;
}

// "enabled_skills" is a whitelist of skill ids that are explicitly enabled.
// Semantics:
//   - If the key is absent (or id not in the array), fall back to SkillDefinition.enabled.
//   - Once setSkillEnabled is called, the id is explicitly tracked in this array.
const ENABLED_SKILLS_KEY = "enabled_skills";

// --- User-defined skill CRUD ---

export async function listUserSkills(): Promise<SkillDefinition[]> {
  // Use get(null) to retrieve all keys, then filter by skill_ prefix
  const all = await chrome.storage.local.get(null);
  const skills: SkillDefinition[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith("skill_")) {
      skills.push(value as SkillDefinition);
    }
  }
  return skills;
}

export async function getSkill(id: string): Promise<SkillDefinition | null> {
  const result = await chrome.storage.local.get(skillStorageKey(id));
  return (result[skillStorageKey(id)] as SkillDefinition) ?? null;
}

export async function saveSkill(skill: SkillDefinition): Promise<void> {
  await chrome.storage.local.set({ [skillStorageKey(skill.id)]: skill });
}

export async function deleteSkill(id: string): Promise<void> {
  await chrome.storage.local.remove(skillStorageKey(id));
  // Also remove from enabled list if present
  const enabledIds = await getEnabledSkillIds();
  const updated = enabledIds.filter((eid) => eid !== id);
  await chrome.storage.local.set({ [ENABLED_SKILLS_KEY]: updated });
}

// --- Enable/disable tracking ---

/**
 * Returns the raw whitelist+blacklist markers stored in chrome.storage.
 * Format: plain id = explicitly enabled, "!<id>" = explicitly disabled.
 * Consumers must split on the "!" prefix to determine the actual state.
 */
export async function getEnabledSkillIds(): Promise<string[]> {
  const result = await chrome.storage.local.get(ENABLED_SKILLS_KEY);
  return (result[ENABLED_SKILLS_KEY] as string[]) ?? [];
}

export async function setSkillEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  const current = await getEnabledSkillIds();
  const withoutId = current.filter((eid) => eid !== id);
  // We track enabled ids (whitelist); disabled ids are simply absent.
  // To track the disabled state explicitly we use a separate convention:
  // prefix with "!" to mark explicitly disabled, plain id = explicitly enabled.
  const withoutMarked = withoutId.filter((eid) => eid !== `!${id}`);
  const updated = enabled
    ? [...withoutMarked, id]
    : [...withoutMarked, `!${id}`];
  await chrome.storage.local.set({ [ENABLED_SKILLS_KEY]: updated });
}
