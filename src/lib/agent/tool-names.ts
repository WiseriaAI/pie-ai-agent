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
  "hover",
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

// Standard skill mediation tools — use_skill invokes a skill by name;
// read_skill_file reads a file from a skill's bundle. Both are pure text
// producers (no tab/page side effects) → class=read.
const SKILL_MEDIATION_TOOL_NAMES = [
  "use_skill",
  "read_skill_file",
] as const;

// Phase 3 cross-tab tools (always present in BUILT_IN_TOOLS).
//
// list_tabs is an example where behavior depends on args (currentWindow vs
// allWindows).
export const TAB_TOOL_NAMES = [
  "list_tabs",
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
export const SCREENSHOT_TOOL_NAMES = [
  "capture_visible_tab",
  "capture_fullpage_tab",
] as const;

// Web search tool (always present in BUILT_IN_TOOLS).
//
// class=read: reads external data; no browser tab mutation.
export const SEARCH_TOOL_NAMES = [
  "search_web",
] as const;

// Page snapshot tool (always present in BUILT_IN_TOOLS).
//
// class=read: reads page DOM structure; no tab/page state mutation.
export const PAGE_SNAPSHOT_TOOL_NAMES = [
  "read_page",
] as const;

// PDF tools (always present in BUILT_IN_TOOLS once Task 10 lands).
//
// class=read: parses bytes and returns text observations; never mutates
// tab/page state. Snippet/outline/page text are streamed back into the
// agent loop only — no DOM writes, no chrome.tabs writes.
export const PDF_TOOL_NAMES = [
  "read_pdf",
  "search_pdf",
  "get_pdf_outline",
] as const;

// Local file I/O tools.
//   save_to_downloads — write (creates a file in the user's Downloads).
//   read_local_file / request_local_file — read (added in later phases).
export const LOCAL_FILE_TOOL_NAMES = [
  "save_to_downloads",
  "read_local_file",
] as const;

export const KNOWN_BUILT_IN_TOOL_NAMES = [
  ...PHASE_2_TOOL_NAMES,
  ...SKILL_META_TOOL_NAMES_FOR_REGISTRY,
  ...SKILL_MEDIATION_TOOL_NAMES,
  ...TAB_TOOL_NAMES,
  ...SCREENSHOT_TOOL_NAMES,
  ...SEARCH_TOOL_NAMES,
  ...PAGE_SNAPSHOT_TOOL_NAMES,
  ...PDF_TOOL_NAMES,
  ...LOCAL_FILE_TOOL_NAMES,
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
// `read` tools (list_tabs, scroll, etc.) are allowed
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
//   - list_tabs / activate_tab — read (informational
//       reads + activate-tab which only changes which tab is foregrounded,
//       not its content).
//   - close_tabs / group_tabs / ungroup_tabs / move_tabs — write (mutates
//       tab existence / containment / order).
//   - use_skill / read_skill_file — read (pure text producers; invoke a
//       skill or read a skill file; no tab/page side effects).
//
// Build-time check below ensures every name in KNOWN_BUILT_IN_TOOL_NAMES
// or KNOWN_KEYBOARD_TOOL_NAMES has a matching entry. A new tool that
// doesn't declare a class throws at module load.

export type ToolClass = "read" | "write";

export const TOOL_CLASSES: Readonly<Record<string, ToolClass>> = {
  // Phase 2 DOM tools
  click: "write",
  hover: "write",
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
  // Standard skill mediation tools — pure text producers, no tab/page side effects
  use_skill: "read",
  read_skill_file: "read",
  // Phase 3 cross-tab tools
  list_tabs: "read",
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
  // Web search tool — reads external data, no browser tab mutation
  search_web: "read",
  // Page snapshot tool — reads page DOM structure, no tab/page state mutation
  read_page: "read",
  // PDF tools — pure text producers, parse-only, no tab mutation
  read_pdf: "read",
  search_pdf: "read",
  get_pdf_outline: "read",
  // Local file I/O
  save_to_downloads: "write",
  read_local_file: "read",
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
  // Unknown tool names default to read. Downstream tool calls
  // (click / type / etc.) carry their own class.
  return TOOL_CLASSES[name] ?? "read";
}
