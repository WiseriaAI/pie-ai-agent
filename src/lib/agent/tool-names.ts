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
  "focus_tab", // v1.5 multi-pin
  "open_url",  // v1.5
] as const;

// Phase 5 screenshot tools (always present in BUILT_IN_TOOLS).
//
// class=read: no tab-state mutation. Pinned-tab-only — R7 cross-session
// lock cannot fire (same session pins the target by construction).
//
// risk=always-high: enforced separately in risk.ts ALWAYS_HIGH_SCREENSHOT_TOOLS.
// Class and risk are orthogonal axes — class drives R7 (cross-session
// concurrency), risk drives confirm-card gating. R5/R6 mandate confirm
// every capture (no "extractPageContentHardened"-style strip is possible
// against pixel data).
export const SCREENSHOT_TOOL_NAMES = [
  "capture_visible_tab",
  "capture_fullpage_tab",
] as const;

export const KNOWN_BUILT_IN_TOOL_NAMES = [
  ...PHASE_2_TOOL_NAMES,
  ...SKILL_META_TOOL_NAMES_FOR_REGISTRY,
  ...TAB_TOOL_NAMES,
  ...SCREENSHOT_TOOL_NAMES,
] as const;

export const KNOWN_KEYBOARD_TOOL_NAMES = [
  "dispatch_keyboard_input",
  "press_key",
] as const;

// ── M3-U4 — Tool class registry ─────────────────────────────────────────────
//
// Every built-in tool declares whether it is a `read` or `write` operation
// against page / tab / browser state. The R7 lock (loop.ts dispatch) uses
// the class to gate cross-session conflicts: a `write` tool whose target
// tab is pinned by another active session is refused with an observation.
// `read` tools (list_tabs, get_tab_content, scroll, etc.) are allowed
// concurrently because the user has informed-approved the data exposure
// at confirm time and read concurrency does not corrupt page state.
//
// Classification rationale:
//   - click / type / select / dispatch_keyboard_input / press_key — write
//       (mutates form state, focus, IME buffer, page nav).
//   - scroll / wait / done / fail — read or no-op against tab state.
//   - create_skill / update_skill / delete_skill — write (mutates persistent
//       extension storage; not a tab interaction but still write-class so
//       a future cross-session quota lock could reuse the same dispatch
//       point if needed).
//   - list_skills — read.
//   - list_tabs / get_tab_content / activate_tab — read (informational
//       reads + activate-tab which only changes which tab is foregrounded,
//       not its content).
//   - close_tabs / group_tabs / ungroup_tabs / move_tabs — write (mutates
//       tab existence / containment / order).
//
// Skill-resolved tools (resolveSkillToTools) are pure text producers and
// are treated as `read` by default (loop.ts uses `tool.class ?? "read"`).
//
// Build-time check below ensures every name in KNOWN_BUILT_IN_TOOL_NAMES
// or KNOWN_KEYBOARD_TOOL_NAMES has a matching entry. A new tool that
// doesn't declare a class throws at module load — matching the G-1 gate
// pattern in risk.ts (every TAB_TOOL_NAMES entry must appear in either
// ALWAYS_HIGH_TAB_TOOLS or ARGS_CONDITIONAL_TAB_TOOLS).

export type ToolClass = "read" | "write";

export const TOOL_CLASSES: Readonly<Record<string, ToolClass>> = {
  // Phase 2 DOM tools
  click: "write",
  type: "write",
  select: "write",
  scroll: "read",
  wait: "read",
  done: "read",
  fail: "read",
  // Phase 2.6 skill meta tools
  create_skill: "write",
  update_skill: "write",
  delete_skill: "write",
  list_skills: "read",
  // Phase 3 cross-tab tools
  list_tabs: "read",
  get_tab_content: "read",
  activate_tab: "read",
  close_tabs: "write",
  group_tabs: "write",
  ungroup_tabs: "write",
  move_tabs: "write",
  focus_tab: "read", // mutates only internal session pointer, no tab state change
  open_url: "write", // creates a new tab; mutates browser state
  // Phase 2.5 CDP keyboard tools
  dispatch_keyboard_input: "write",
  press_key: "write",
  // Phase 5 screenshot tools
  capture_visible_tab: "read",
  capture_fullpage_tab: "read",
};

// Build-time exhaustive check — every known tool name MUST have a class
// declared. If a future PR adds a tool to KNOWN_BUILT_IN_TOOL_NAMES or
// KNOWN_KEYBOARD_TOOL_NAMES without classifying it here, module load
// throws with a pointer to this section so the omission can never ship.
//
// Derived directly from the canonical constants (no hand-maintained
// duplicate list). Adding a tool name to KNOWN_*_TOOL_NAMES without a
// matching TOOL_CLASSES entry trips the throw; adding it to TOOL_CLASSES
// without registering the name is also caught (unknown classified
// names would still pass this check, but tooling — agent loop dispatch
// — would never call getToolClass with a non-registered name, so the
// over-classification path is harmless).
for (const name of [
  ...KNOWN_BUILT_IN_TOOL_NAMES,
  ...KNOWN_KEYBOARD_TOOL_NAMES,
]) {
  if (!(name in TOOL_CLASSES)) {
    throw new Error(
      `[M3-U4] tool "${name}" is in KNOWN_*_TOOL_NAMES but not classified in ` +
        `TOOL_CLASSES (src/lib/agent/tool-names.ts). Every tool MUST declare ` +
        `class: 'read' | 'write' so the cross-session R7 lock in loop.ts ` +
        `dispatch can mechanically gate write conflicts.`,
    );
  }
}

export function getToolClass(name: string): ToolClass {
  // Skill-resolved tools (resolveSkillToTools) are pure text producers and
  // not in the registry. Default to read; their downstream tool calls
  // (click / type / etc.) carry their own class.
  return TOOL_CLASSES[name] ?? "read";
}

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
  ...SCREENSHOT_TOOL_NAMES,
]);

/**
 * Superset of ALL_KNOWN_NON_SKILL_TOOL_NAMES that ALSO includes skill meta tool
 * names. Used **only** by the BUILT_IN_SKILLS import-time assertion in
 * `lib/skills/builtin.ts` — built-in skills are vetted at ship time and may
 * legitimately reference meta tools (e.g. the `create_skill_from_recording`
 * built-in needs `create_skill` in allowedTools so the LLM can persist a skill
 * derived from the user's recorded trace).
 *
 * **DO NOT use this for user/agent skill validation** — `skill-meta.ts`'s
 * `validateSkillContent` continues to use `ALL_KNOWN_NON_SKILL_TOOL_NAMES`
 * to prevent agent-authored skills from chaining into create_skill etc.
 * (the original confirm-fatigue privilege-chain defense).
 */
export const ALL_KNOWN_BUILT_IN_ALLOWED_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  ...PHASE_2_TOOL_NAMES,
  ...KNOWN_KEYBOARD_TOOL_NAMES,
  ...TAB_TOOL_NAMES,
  ...SCREENSHOT_TOOL_NAMES,
  ...SKILL_META_TOOL_NAMES_FOR_REGISTRY,
]);
