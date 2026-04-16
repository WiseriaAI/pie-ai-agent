export type { SkillDefinition, SkillId } from "./types";
export {
  listUserSkills,
  getSkill,
  saveSkill,
  deleteSkill,
  getEnabledSkillIds,
  setSkillEnabled,
} from "./storage";
export { BUILT_IN_SKILLS } from "./builtin";

import type { SkillDefinition } from "./types";
import type { Tool } from "@/lib/agent/types";
import type { ActionResult } from "@/lib/dom-actions/types";
import { BUILT_IN_SKILLS } from "./builtin";
import { listUserSkills, getEnabledSkillIds } from "./storage";

const MAX_TEMPLATE_VALUE_LEN = 500;

/** Merge BUILT_IN_SKILLS with user-defined skills.
 *  User skills with the same id override the built-in version. */
export async function getAllSkills(): Promise<SkillDefinition[]> {
  const userSkills = await listUserSkills();
  const userById = new Map(userSkills.map((s) => [s.id, s]));

  const merged: SkillDefinition[] = BUILT_IN_SKILLS.map((builtin) =>
    userById.has(builtin.id) ? userById.get(builtin.id)! : builtin,
  );

  // Append user skills that don't shadow any built-in
  const builtinIds = new Set(BUILT_IN_SKILLS.map((s) => s.id));
  for (const us of userSkills) {
    if (!builtinIds.has(us.id)) {
      merged.push(us);
    }
  }

  return merged;
}

/** Return all skills that are currently enabled.
 *
 *  Enabled-ids array semantics (see storage.ts):
 *  - plain id  → explicitly enabled
 *  - "!<id>"   → explicitly disabled
 *  - absent    → fall back to SkillDefinition.enabled (default)
 */
export async function getEnabledSkills(): Promise<SkillDefinition[]> {
  const [all, enabledIds] = await Promise.all([
    getAllSkills(),
    getEnabledSkillIds(),
  ]);

  const explicitEnabled = new Set(enabledIds.filter((id) => !id.startsWith("!")));
  const explicitDisabled = new Set(
    enabledIds.filter((id) => id.startsWith("!")).map((id) => id.slice(1)),
  );

  return all.filter((skill) => {
    if (explicitDisabled.has(skill.id)) return false;
    if (explicitEnabled.has(skill.id)) return true;
    return skill.enabled; // built-in default
  });
}

/** Render a promptTemplate by replacing {{key}} placeholders.
 *  Each value is JSON-stringified and capped at MAX_TEMPLATE_VALUE_LEN chars.
 *  Missing keys render as empty string.
 *  The entire rendered result is wrapped in <untrusted_skill_params> tags.
 */
function renderTemplate(template: string, args: Record<string, unknown>): string {
  const rendered = template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (!(key in args)) return "";
    const raw = JSON.stringify(args[key]) ?? "";
    return raw.length > MAX_TEMPLATE_VALUE_LEN
      ? raw.slice(0, MAX_TEMPLATE_VALUE_LEN)
      : raw;
  });
  return `<untrusted_skill_params>${rendered}</untrusted_skill_params>`;
}

/** Convert a list of SkillDefinitions into Tool objects.
 *
 *  Each skill becomes a tool whose handler renders the promptTemplate and
 *  returns it as an observation. The LLM then uses other tools (snapshot,
 *  click, etc.) to actually perform the work guided by the rendered prompt.
 *  Risk is "low" because the handler only produces text — no side effects.
 */
export function resolveSkillToTools(skills: SkillDefinition[]): Tool[] {
  return skills.map((skill): Tool => ({
    name: skill.id,
    description: skill.description,
    parameters: skill.toolSchema.parameters,
    // low: handler produces only text, actual side-effecting tools are separate
    riskHint: "low",
    handler: async (args): Promise<ActionResult> => {
      const safeArgs = (args && typeof args === "object") ? (args as Record<string, unknown>) : {};
      const observation = renderTemplate(skill.promptTemplate, safeArgs);
      return { success: true, observation };
    },
  }));
}
