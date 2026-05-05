/**
 * Recording v1 — element label + optional CSS hint.
 *
 * describeElement() generates:
 *   1. Human-readable label for the replay prompt.
 *      The LLM uses the label + fresh snapshot to find the element by index.
 *   2. Optional CSS selectorHint when a strong identifier exists.
 *      The LLM uses it as a fallback when text is ambiguous.
 *
 * Not used directly by replay dispatch — click/type tools are index-based.
 */

interface ElementMetaForDescribe {
  tag: string;
  role: string | undefined;
  ariaLabel: string | undefined;
  text: string;
  placeholder: string | undefined;
  name: string | undefined;
  id: string | undefined;
  dataTestId: string | undefined;
  autocomplete: string | undefined;
  /** 'main' / 'nav' / 'header' / 'footer' / 'aside' / 'other'. From snapshot.ts getRegion. */
  region: string;
  /** 0-based index among siblings sharing the same primary tag in this region. */
  regionSiblingIndex: number;
  /** How many elements share the primary tag in this region (>1 triggers disambiguation). */
  regionSiblingCount: number;
  /** Pre-computed by detectSensitive. When true, no selectorHint is ever attached. */
  isSensitive: boolean;
}

interface DescribeResult {
  label: string;
  selectorHint?: string;
  unstable: boolean;
}

const ROLE_TO_CN: Record<string, string> = {
  button: "按钮",
  link: "链接",
  tab: "标签页",
  checkbox: "复选框",
  radio: "单选框",
  switch: "开关",
  menuitem: "菜单项",
  option: "下拉选项",
};

const TAG_TO_CN: Record<string, string> = {
  a: "链接",
  button: "按钮",
  input: "输入框",
  textarea: "文本框",
  select: "下拉框",
  summary: "折叠标签",
};

const REGION_TO_CN: Record<string, string> = {
  main: "main",
  nav: "nav",
  header: "header",
  footer: "footer",
  aside: "aside",
  other: "页面",
};

// Mirror snapshot.ts wrapper-tag neutralization list.
const WRAPPER_TAGS_RE =
  /<\/?(?:untrusted_page_content|untrusted_skill_params|untrusted_tab_metadata|untrusted_user_message|untrusted_prior_task_summary|untrusted_continuity_marker)>/gi;

// Suppress selectorHint when id/name contains any sensitive keyword.
// Wider than redact.ts's SENSITIVE_TEXT_PATTERN by design — false positives
// here only mute a hint (recoverable; LLM still has the label), so a wider
// net is fail-safe. NOT word-boundary-anchored on purpose.
const SENSITIVE_HINT_RE = /password|secret|token|api|auth|pwd/i;

// Strip C0 controls (U+0000-U+001F), DEL + C1 (U+007F-U+009F),
// Arabic Letter Mark (U+061C), line/paragraph separators (U+2028-2029),
// zero-width chars (U+200B-200F), bidi overrides (U+202A-202E),
// Word Joiner (U+2060), directional isolates (U+2066-2069), BOM (U+FEFF).
// Mirrors the ZERO_WIDTH_RE family in src/lib/agent/untrusted-wrappers.ts.
const CONTROL_CHARS_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u2028-\u2029\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

function sanitize(s: string, maxLen = 80): string {
  let cleaned = s.replace(CONTROL_CHARS_RE, "");
  cleaned = cleaned.replace(WRAPPER_TAGS_RE, "[filtered]");
  if (cleaned.length > maxLen) cleaned = cleaned.slice(0, maxLen) + "...";
  return cleaned;
}

function elementKindCn(meta: ElementMetaForDescribe): string {
  if (meta.role && ROLE_TO_CN[meta.role.toLowerCase()]) {
    return ROLE_TO_CN[meta.role.toLowerCase()]!;
  }
  if (TAG_TO_CN[meta.tag.toLowerCase()]) {
    return TAG_TO_CN[meta.tag.toLowerCase()]!;
  }
  return "元素";
}

function pickPrimaryTag(meta: ElementMetaForDescribe):
  | { kind: "named"; text: string }
  | { kind: "placeholder"; text: string }
  | { kind: "name"; text: string }
  | { kind: "nth"; index: number } {
  const ariaLabel = meta.ariaLabel ? sanitize(meta.ariaLabel) : "";
  if (ariaLabel) return { kind: "named", text: ariaLabel };
  const text = meta.text ? sanitize(meta.text) : "";
  if (text) return { kind: "named", text };
  const placeholder = meta.placeholder ? sanitize(meta.placeholder) : "";
  if (placeholder) return { kind: "placeholder", text: placeholder };
  const name = meta.name ? sanitize(meta.name, 40) : "";
  if (name) return { kind: "name", text: name };
  return { kind: "nth", index: meta.regionSiblingIndex + 1 };
}

function buildSelectorHint(meta: ElementMetaForDescribe): string | undefined {
  if (meta.isSensitive) return undefined;
  if (meta.dataTestId) {
    return `[data-testid="${cssEscape(meta.dataTestId)}"]`;
  }
  if (meta.id && !SENSITIVE_HINT_RE.test(meta.id)) {
    return `#${cssEscape(meta.id)}`;
  }
  if (meta.name && !SENSITIVE_HINT_RE.test(meta.name)) {
    return `${meta.tag.toLowerCase()}[name="${cssEscape(meta.name)}"]`;
  }
  return undefined;
}

function cssEscape(value: string): string {
  return value.replace(/['"\\\n]/g, (c) => "\\" + c);
}

export function describeElement(meta: ElementMetaForDescribe): DescribeResult {
  const kind = elementKindCn(meta);
  const primary = pickPrimaryTag(meta);
  const selectorHint = buildSelectorHint(meta);
  const ambiguous = meta.regionSiblingCount > 1;
  const regionCn = REGION_TO_CN[meta.region] ?? "页面";

  let label: string;
  let unstable = false;

  switch (primary.kind) {
    case "named": {
      label = ambiguous
        ? `位于 ${regionCn} 的${kind} '${primary.text}'`
        : `${kind} '${primary.text}'`;
      break;
    }
    case "placeholder":
      label = `${kind} (placeholder='${primary.text}')`;
      break;
    case "name":
      label = `${kind} (name='${primary.text}')`;
      break;
    case "nth": {
      label = `${regionCn} 第 ${primary.index} 个${kind}`;
      unstable = true;
      break;
    }
  }

  return selectorHint !== undefined
    ? { label, selectorHint, unstable }
    : { label, unstable };
}
