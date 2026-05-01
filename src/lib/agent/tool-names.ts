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

// Phase 3 cross-tab tools (always present in BUILT_IN_TOOLS).
//
// G-1 acceptance gate: every name listed here MUST also appear in
// ALWAYS_HIGH_TAB_TOOLS in src/lib/agent/risk.ts (the build-time exhaustive
// check enforces this). If a future PR introduces a low-risk cross-tab tool,
// it MUST first upgrade SkillDefinition.allowedTools schema from string[] to
// (name, scope) tuple — see plan G-1 / K-3.
//
// list_tabs is the only entry where risk depends on args (currentWindow vs
// allWindows); risk.ts handles the args introspection, but the tool name
// itself still belongs in this set so allowedTools validation accepts it.
export const TAB_TOOL_NAMES = [
  "list_tabs",
  "get_tab_content",
  "close_tabs",
  "activate_tab",
  "group_tabs",
  "ungroup_tabs",
  "move_tabs",
] as const;

export const KNOWN_BUILT_IN_TOOL_NAMES = [
  ...PHASE_2_TOOL_NAMES,
  ...SKILL_META_TOOL_NAMES_FOR_REGISTRY,
  ...TAB_TOOL_NAMES,
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
  ...TAB_TOOL_NAMES,
]);
