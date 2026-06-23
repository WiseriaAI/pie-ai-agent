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

// Task 7 — Schedule CRUD meta tools (always present in BUILT_IN_TOOLS).
//   create_schedule / update_schedule / delete_schedule — write (mutate persistent
//       schedule state; headless runs exclude create/update via excludeToolNames
//       to prevent self-replicating schedules).
//   list_schedules — read (pure query, no mutation).
const SCHEDULE_META_TOOL_NAMES_FOR_REGISTRY = [
  "create_schedule",
  "update_schedule",
  "delete_schedule",
  "list_schedules",
] as const;

// Standard skill mediation tools — use_skill invokes a skill by name;
// read_skill_file reads a file from a skill's bundle. Both are pure text
// producers (no tab/page side effects) → class=read.
const SKILL_MEDIATION_TOOL_NAMES = [
  "use_skill",
  "read_skill_file",
] as const;

// The progressive-disclosure mediator tool. Always core.
export const DISCLOSURE_TOOL_NAMES = ["load_tools"] as const;

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
  "unpin_tab", // Issue #110 — remove a tab from session pins so it can be closed
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

// Page Atlas target tools (always present in BUILT_IN_TOOLS).
//
// class=read: reads structured targets captured by read_page({mode:"atlas"});
// no tab/page state mutation.
export const PAGE_ATLAS_TOOL_NAMES = [
  "find_target",
  "read_records",
  "read_target",
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
//   output_file — read (produces an in-memory artifact + side-panel card;
//     no disk write at call time — the user triggers download later).
//   read_local_file / request_local_file — read.
export const LOCAL_FILE_TOOL_NAMES = [
  "output_file",
  "read_local_file",
  "request_local_file",
] as const;

// Scratchpad tools — per-session durable memory for long-horizon extraction.
//   save_records / update_notes / clear_scratchpad — write (mutate IDB state).
//   read_records — read (observe stored data, no mutation).
//   query_scratchpad — read FOR TAB-LOCK PURPOSES. It can mutate IDB state (its
//     optional `into` arg writes the result set back as a collection), but the
//     read/write class is only consumed by collectCrossSessionConflicts, which
//     gates a cross-session *tab* lock. query_scratchpad takes no tab argument
//     and can never conflict on a tab, so classing it `read` is deliberate
//     (same rationale as the skill-meta IDB-write tools below).
export const SCRATCHPAD_TOOL_NAMES = [
  "save_records",
  "update_notes",
  "read_records",
  "clear_scratchpad",
  "query_scratchpad",
] as const;

export const KNOWN_BUILT_IN_TOOL_NAMES = [
  ...PHASE_2_TOOL_NAMES,
  ...SKILL_META_TOOL_NAMES_FOR_REGISTRY,
  ...SCHEDULE_META_TOOL_NAMES_FOR_REGISTRY,
  ...SKILL_MEDIATION_TOOL_NAMES,
  ...TAB_TOOL_NAMES,
  ...SCREENSHOT_TOOL_NAMES,
  ...SEARCH_TOOL_NAMES,
  ...PAGE_SNAPSHOT_TOOL_NAMES,
  ...PAGE_ATLAS_TOOL_NAMES,
  ...PDF_TOOL_NAMES,
  ...LOCAL_FILE_TOOL_NAMES,
  ...SCRATCHPAD_TOOL_NAMES,
  ...DISCLOSURE_TOOL_NAMES,
] as const;

export const KNOWN_KEYBOARD_TOOL_NAMES = [
  "dispatch_keyboard_input",
  "press_key",
] as const;

// Editor tools (CDP getValue/setValue against Monaco/CodeMirror).
//   read_editor — read (extracts full editor text; no page mutation).
//   set_editor_value — write (replaces editor content).
export const KNOWN_EDITOR_TOOL_NAMES = [
  "read_editor",
  "set_editor_value",
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
  // Task 7 schedule meta tools — write (mutate persistent schedule/alarm state).
  // list_schedules is read (pure query). create/update are excluded from headless
  // runs via excludeToolNames in run.ts to prevent self-replicating schedules.
  create_schedule: "write",
  update_schedule: "write",
  delete_schedule: "write",
  list_schedules: "read",
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
  unpin_tab: "read", // Issue #110 — removes a session pin; no tab/page state change

  // Phase 2.5 CDP keyboard tools
  dispatch_keyboard_input: "write",
  press_key: "write",
  // Phase 5 screenshot tools
  capture_visible_tab: "read",
  capture_fullpage_tab: "read",
  // Web search tool — reads external data, no browser tab mutation
  search_web: "read",
  // Progressive disclosure mediator — read (returns a tool manifest, no side effects)
  load_tools: "read",
  // Page snapshot tool — reads page DOM structure, no tab/page state mutation
  read_page: "read",
  // Page Atlas target tools — reads structured atlas targets, no tab/page state mutation
  find_target: "read",
  read_target: "read",
  // PDF tools — pure text producers, parse-only, no tab mutation
  read_pdf: "read",
  search_pdf: "read",
  get_pdf_outline: "read",
  // Local file I/O
  output_file: "read",
  read_local_file: "read",
  request_local_file: "read",
  // Editor tools — CDP main-context getValue/setValue
  read_editor: "read",
  set_editor_value: "write",
  // Scratchpad tools — per-session durable memory for long-horizon extraction
  save_records: "write",
  update_notes: "write",
  read_records: "read",
  clear_scratchpad: "write",
  // query_scratchpad can write IDB state via its optional `into` arg, but the
  // class only gates the cross-session *tab* lock (collectCrossSessionConflicts).
  // It has no tab target and can never conflict on a tab, so `read` is correct
  // here — this is a tab-lock classification, not a "does it mutate" flag.
  query_scratchpad: "read",
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
  ...KNOWN_EDITOR_TOOL_NAMES,
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

// ── Progressive tool disclosure — disclosure group registry ──────────────────
//
// Every tool belongs to exactly one DisclosureGroup. The agent loop discloses
// only the tools whose group is currently active (core is always active; env
// groups light up from runtime signals; lazy groups are pulled in via the
// load_tools tool). Mirrors the TOOL_CLASSES build-time-invariant pattern above.
//
// v1 keeps tabs / keyboard / editor / output_file in `core` (see the spec's
// §4.2 for the v2 plan to env-gate editor/keyboard and split tab-advanced).

export type DisclosureGroup =
  | "core"
  | "screenshot"
  | "skill-mediation"
  | "pdf"
  | "local-file"
  | "scratchpad"
  | "schedule"
  | "skill-authoring";

export const TOOL_GROUPS: Readonly<Record<string, DisclosureGroup>> = {
  // core — basic sense/act/control loop
  click: "core", hover: "core", type: "core", scroll: "core", select: "core",
  wait: "core", done: "core", fail: "core",
  read_page: "core",
  find_target: "core", read_target: "core",
  list_tabs: "core", close_tabs: "core", activate_tab: "core", group_tabs: "core",
  ungroup_tabs: "core", move_tabs: "core", focus_tab: "core", open_url: "core",
  unpin_tab: "core",
  search_web: "core",
  output_file: "core",
  dispatch_keyboard_input: "core", press_key: "core",
  read_editor: "core", set_editor_value: "core",
  load_tools: "core",
  // env-lit
  capture_visible_tab: "screenshot", capture_fullpage_tab: "screenshot",
  use_skill: "skill-mediation", read_skill_file: "skill-mediation",
  read_pdf: "pdf", search_pdf: "pdf", get_pdf_outline: "pdf",
  read_local_file: "local-file", request_local_file: "local-file",
  // lazy
  save_records: "scratchpad", update_notes: "scratchpad", read_records: "scratchpad",
  clear_scratchpad: "scratchpad", query_scratchpad: "scratchpad",
  create_schedule: "schedule", update_schedule: "schedule",
  delete_schedule: "schedule", list_schedules: "schedule",
  create_skill: "skill-authoring", update_skill: "skill-authoring",
  delete_skill: "skill-authoring", list_skills: "skill-authoring",
};

// Build-time exhaustive check — every known tool MUST declare a group.
for (const name of [
  ...KNOWN_BUILT_IN_TOOL_NAMES,
  ...KNOWN_KEYBOARD_TOOL_NAMES,
  ...KNOWN_EDITOR_TOOL_NAMES,
]) {
  if (!(name in TOOL_GROUPS)) {
    throw new Error(
      `[disclosure] tool "${name}" is in KNOWN_*_TOOL_NAMES but not assigned a ` +
        `DisclosureGroup in TOOL_GROUPS (src/lib/agent/tool-names.ts). Every tool ` +
        `MUST belong to exactly one group so progressive disclosure can filter it.`,
    );
  }
}

export function getToolGroup(name: string): DisclosureGroup {
  return TOOL_GROUPS[name] ?? "core";
}
