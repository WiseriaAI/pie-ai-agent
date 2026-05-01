// Pure name registry. Exported separately from BUILT_IN_TOOLS (which has
// handlers + chrome.* dependencies) so UI / sidepanel can validate
// allowedTools without pulling the agent runtime into the panel bundle.
//
// IMPORTANT: keep in sync when adding tools.
//   - KNOWN_BUILT_IN_TOOL_NAMES ↔ BUILT_IN_TOOLS (src/lib/agent/tools.ts)
//   - KNOWN_KEYBOARD_TOOL_NAMES ↔ KEYBOARD_TOOL_NAMES (src/lib/agent/tools/keyboard.ts)

// Phase 2 DOM action tools (always present in BUILT_IN_TOOLS).
const PHASE_2_TOOL_NAMES = [
  "click",
  "type",
  "scroll",
  "select",
  "wait",
  "done",
  "fail",
] as const;

// Phase 2.6 skill CRUD meta tools (always present in BUILT_IN_TOOLS).
const SKILL_META_TOOL_NAMES_FOR_REGISTRY = [
  "create_skill",
  "update_skill",
  "delete_skill",
  "list_skills",
] as const;

export const KNOWN_BUILT_IN_TOOL_NAMES = [
  ...PHASE_2_TOOL_NAMES,
  ...SKILL_META_TOOL_NAMES_FOR_REGISTRY,
] as const;

export const KNOWN_KEYBOARD_TOOL_NAMES = [
  "dispatch_keyboard_input",
  "press_key",
] as const;

/**
 * Tool names that are legal entries in a skill's `allowedTools` whitelist
 * (P1-G validation).
 *
 * **Intentionally excludes skill meta tool names (create_skill / update_skill /
 * delete_skill / list_skills).** A skill that could orchestrate further skill
 * CRUD inside its scope creates a confirm-fatigue privilege chain: the user
 * approves "skill X" once, X then proposes create_skill from inside its run,
 * and after a few approvals an arbitrary skill graph exists. classifyRisk
 * still gates each individual meta call as high-risk, but locking meta tools
 * out of allowedTools cuts this surface entirely. (Adversarial review,
 * residual risk #1.)
 *
 * Skill-resolved tool names (user / built-in skills) are also intentionally
 * absent — R3 forbids skills calling other skills.
 */
export const ALL_KNOWN_NON_SKILL_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ...PHASE_2_TOOL_NAMES,
  ...KNOWN_KEYBOARD_TOOL_NAMES,
]);
