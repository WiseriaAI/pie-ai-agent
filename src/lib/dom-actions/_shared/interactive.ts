/**
 * Canonical source for "what counts as an interactive element" + visibility +
 * Chinese element-kind maps. Shared across the injected snapshot/search/capture
 * functions.
 *
 * Injected functions (pageSnapshotInjected / searchPageInjected /
 * installCaptureListener) CANNOT import this at runtime — executeScript
 * serializes their bodies. They inline a VERBATIM copy of INTERACTIVE_SELECTOR
 * (single string literal) and isVisible; interactive-parity.test.ts asserts the
 * inlined literal matches this source. Module-side consumers (selector.ts,
 * tests) import directly.
 */

// Single-string literal (NOT array.join) so source-text parity checks can match
// the exact same literal inlined into each injected function. Content equals the
// joined form of page-snapshot.ts INTERACTIVE_SELECTOR, verbatim.
export const INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [contenteditable="true"], summary, [onclick], [tabindex]:not([tabindex=\'-1\'])';

/** Mirrors page-snapshot.ts isVisible exactly. */
export function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (parseFloat(style.opacity) === 0) return false;
  const tag = el.tagName.toLowerCase();
  if ((tag === "input" || tag === "textarea") && (rect.width < 8 || rect.height < 8)) {
    return false;
  }
  if (style.position !== "fixed" && (el as HTMLElement).offsetParent === null) return false;
  return true;
}

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
