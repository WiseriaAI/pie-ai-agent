/**
 * Canonical source for the interactive selector + zh element-kind maps. Shared
 * across the injected snapshot/search/capture functions.
 *
 * Injected functions (pageSnapshotInjected / searchPageInjected /
 * installCaptureListener) CANNOT import this at runtime — executeScript
 * serializes their bodies. They inline a VERBATIM copy of INTERACTIVE_SELECTOR
 * (single string literal); interactive-parity.test.ts asserts the inlined
 * literal matches this source. isVisible stays inlined inside the injected
 * snapshot/search functions, guarded by the idx-parity behaviour test.
 * Module-side consumers (selector.ts, tests) import directly.
 */

// Single-string literal (NOT array.join) so source-text parity checks can match
// the exact same literal inlined into each injected function. Content equals the
// joined form of page-snapshot.ts INTERACTIVE_SELECTOR, verbatim.
export const INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [contenteditable="true"], summary, [onclick], [tabindex]:not([tabindex=\'-1\'])';

export const ROLE_TO_CN: Record<string, string> = {
  button: "按钮",
  link: "链接",
  tab: "标签页",
  checkbox: "复选框",
  radio: "单选框",
  switch: "开关",
  menuitem: "菜单项",
  option: "下拉选项",
};

export const TAG_TO_CN: Record<string, string> = {
  a: "链接",
  button: "按钮",
  input: "输入框",
  textarea: "文本框",
  select: "下拉框",
  summary: "折叠标签",
};

/**
 * EDITOR_SELECTOR — CSS selector for rich-editor HOST elements that
 * read_editor / set_editor_value can directly operate on (Monaco, CodeMirror
 * 5/6, TinyMCE v4 + v6).
 *
 * DIFFERENT SEMANTICS from TYPE_EDITOR_MARKERS below:
 *   • EDITOR_SELECTOR  → read/write capable; used by page-snapshot to surface
 *     role=editor nodes and by read_editor/set_editor_value to locate targets.
 *   • TYPE_EDITOR_MARKERS → broader diagnostic set covering editors whose DOM
 *     makes them identifiable but which may NOT be read/write operable via CDP
 *     (e.g. cloud docs, Notion). Used only to produce human-readable "type
 *     failed — looks like <editor>" error messages; never used as an action
 *     target.
 *
 * Injected functions that need this selector MUST inline this string VERBATIM
 * (executeScript serializes function bodies; imports are not available at
 * runtime). A parity test should assert the inlined copy matches this source.
 */
export const EDITOR_SELECTOR =
  ".monaco-editor, .cm-editor, .CodeMirror, .tox-tinymce, .mce-tinymce";

/**
 * EDITOR_ENGINE_MAP — maps each host CSS class to a canonical engine name.
 * Ordered to match EDITOR_SELECTOR left-to-right so callers can zip the two
 * structures when needed. Used by page-snapshot (role=editor surfacing) and
 * by read_editor/set_editor_value to select the correct adapter branch.
 */
export const EDITOR_ENGINE_MAP: ReadonlyArray<readonly [string, string]> = [
  [".monaco-editor", "Monaco"],
  [".cm-editor", "CodeMirror"],
  [".CodeMirror", "CodeMirror"],
  [".tox-tinymce", "TinyMCE"],
  [".mce-tinymce", "TinyMCE"],
];

/**
 * WRAPPER_TAGS_LIST — verbatim copy of UNTRUSTED_WRAPPER_TAGS from
 * src/lib/agent/untrusted-wrappers.ts (same order).
 *
 * Injected snapshot functions cannot import the agent layer at runtime, so
 * they inline this list to perform their own wrapper-tag escaping. The parity
 * test in interactive.test.ts asserts this array stays in sync with the
 * agent-layer master.
 */
export const WRAPPER_TAGS_LIST: readonly string[] = [
  "untrusted_page_content",
  "untrusted_skill_params",
  "untrusted_tab_metadata",
  "untrusted_user_message",
  "untrusted_prior_task_summary",
  "untrusted_continuity_marker",
  "untrusted_page_quote",
  "untrusted_page_element",
  "untrusted_skill_content",
  "untrusted_compacted_steps",
  "untrusted_search_result",
  "untrusted_pdf_page",
  "untrusted_pdf_match",
  "untrusted_pdf_outline_entry",
  "untrusted_page_match",
  "untrusted_local_file",
  "untrusted_editor_content",
];

/**
 * TYPE_EDITOR_MARKERS — broader diagnostic set of [selector, engineName]
 * pairs used ONLY to produce human-readable error messages when a type action
 * fails ("type failed — looks like a <Monaco> editor; try set_editor_value").
 *
 * DIFFERENT SEMANTICS from EDITOR_SELECTOR above:
 *   • Covers editors that are detectable by DOM class/attribute but may NOT
 *     be read/write operable (cloud docs: Feishu, Notion, Google Docs).
 *   • MUST NOT be used as action targets or to surface role=editor nodes.
 */
export const TYPE_EDITOR_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ['[data-slate-editor="true"]', "Slate"],
  [".ProseMirror", "ProseMirror"],
  [".ql-editor", "Quill"],
  ['[data-lexical-editor="true"]', "Lexical"],
  [".monaco-editor", "Monaco"],
  [".cm-editor, .CodeMirror", "CodeMirror"],
  ['.suite-editor-container, .docx-root, [class*="lark-"], [class*="docx-"]', "Feishu Docs"],
  [".notion-page-content", "Notion"],
  [".kix-documentview-content", "Google Docs"],
];
