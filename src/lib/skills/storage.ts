import { getConfig, setConfig } from "@/lib/idb/config-store";

// "enabled_skills" is a whitelist of skill ids that are explicitly enabled.
// Semantics:
//   - If the key is absent (or id not in the array), fall back to the built-in
//     default-on policy in getEnabledSkillPackages (index.ts).
//   - Once setSkillEnabled is called, the id is explicitly tracked in this array.
const ENABLED_SKILLS_KEY = "enabled_skills";

// --- Id generators ---

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

// --- Enable/disable tracking ---

/**
 * Returns the raw whitelist+blacklist markers stored in IDB config.
 * Format: plain id = explicitly enabled, "!<id>" = explicitly disabled.
 * Consumers must split on the "!" prefix to determine the actual state.
 */
export async function getEnabledSkillIds(): Promise<string[]> {
  return (await getConfig<string[]>(ENABLED_SKILLS_KEY)) ?? [];
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
  await setConfig(ENABLED_SKILLS_KEY, updated);
}
