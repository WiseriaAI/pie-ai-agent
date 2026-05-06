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

// --- Schema upgrade helpers (Phase 2.6) ---

/**
 * Apply default values to optional fields that may be absent on skills stored
 * before the Phase 2.6 schema upgrade. Idempotent.
 *
 * Defaults:
 *   author = 'user'              (treat unknown-origin as user-authored, matching pre-2.6 storage)
 *   createdAt = 0                (sorts to the bottom of SkillsList)
 */
export function withSkillDefaults(skill: SkillDefinition): SkillDefinition {
  return {
    ...skill,
    author: skill.author ?? "user",
    createdAt: skill.createdAt ?? 0,
  };
}

/**
 * Generate a fresh skill id with the `skill_agent_` prefix. The prefix prevents
 * accidental collision with BUILT_IN_TOOLS names (click / type / scroll / etc.)
 * even if an agent attempts id spoofing (P1-E defense layer 2; layer 1 is the
 * meta tool JSON Schema in tools.ts which forbids passing `id`).
 */
export function generateSkillId(): string {
  return `skill_agent_${crypto.randomUUID()}`;
}

/** User-authored skill id — separate prefix for visual distinction in storage
 *  inspection, with the same anti-collision property. */
export function generateUserSkillId(): string {
  return `skill_user_${crypto.randomUUID()}`;
}

/**
 * Compute total bytes used by `skill_*` keys in chrome.storage.local. Used by
 * the meta tool quota gate (P1-H, default 1 MB budget). Approximates by
 * JSON-serialized length, matching how chrome.storage.local accounts quota.
 */
export async function getSkillStorageBytes(): Promise<number> {
  const all = await chrome.storage.local.get(null);
  let total = 0;
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith("skill_")) {
      total += JSON.stringify(value).length + key.length;
    }
  }
  return total;
}

// --- User-defined skill CRUD ---

export async function listUserSkills(): Promise<SkillDefinition[]> {
  // Use get(null) to retrieve all keys, then filter by skill_ prefix
  const all = await chrome.storage.local.get(null);
  const skills: SkillDefinition[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith("skill_")) {
      skills.push(withSkillDefaults(value as SkillDefinition));
    }
  }
  return skills;
}

export async function getSkill(id: string): Promise<SkillDefinition | null> {
  const result = await chrome.storage.local.get(skillStorageKey(id));
  const raw = result[skillStorageKey(id)] as SkillDefinition | undefined;
  return raw ? withSkillDefaults(raw) : null;
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
  const withoutMarked = withoutId.filter((eid) => eid !== `!${id}`);
  const updated = enabled
    ? [...withoutMarked, id]
    : [...withoutMarked, `!${id}`];
  await chrome.storage.local.set({ [ENABLED_SKILLS_KEY]: updated });
}
