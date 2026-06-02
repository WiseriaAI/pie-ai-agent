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
