/**
 * Shared helper for escaping wrapper-tag literals inside content that flows
 * into LLM context wrapped in <untrusted_*> tags.
 *
 * Phase 3 invariant P3-O: any third-party data (page content, tab metadata,
 * agent-supplied skill args) inserted between <untrusted_*> opening and
 * closing tags must have ALL wrapper-tag literals neutralized so the inner
 * content cannot prematurely close the wrapper and inject instructions.
 *
 * Adversarial review (ADV-1) found that src/lib/skills/index.ts:91
 * `renderTemplate` was emitting `<untrusted_skill_params>${JSON.stringify(args)}</untrusted_skill_params>`
 * without escaping closing-tag literals — agent-supplied skill args could
 * carry a literal `</untrusted_skill_params>` and break out of the wrapper.
 * This helper closes that gap.
 *
 * Note: src/lib/dom-actions/snapshot.ts has its own inline `[filtered]`
 * substitution (it runs in an executeScript context that cannot import
 * external modules). Both implementations cover the same wrapper-tag set.
 *
 * Bypass families this helper defends against:
 *  1. Plain ASCII closing: `</untrusted_page_content>`
 *  2. Unicode confusables: `‹/untrusted_skill_params›` (U+2039 / U+203A)
 *  3. Full-width brackets: `＜/untrusted_tab_metadata＞` (U+FF1C / U+FF1E)
 *  4. Mathematical angle:  `〈/untrusted_*〉` (U+2329 / U+232A)
 *  5. CJK angle bracket:   `〈/untrusted_*〉` (U+3008 / U+3009)
 *  6. Zero-width injection: `<​/untrusted_*>` (U+200B-200F, U+2060, U+FEFF)
 *  7. Closing tag with attribute: `</untrusted_X attr=val>` — HTML and most
 *     LLM tokenizers tolerate attributes on closing tags
 *  8. Multi-slash close: `<//untrusted_X>`, `</⁄untrusted_X>` (U+2044
 *     fraction slash, U+2215 division slash)
 *
 * Strategy: strip zero-width chars first (cannot hide inside a tag name),
 * then match any "less-than-like" char + 0..3 slash variants + known wrapper
 * tag + arbitrary non-bracket payload up to 200 chars + "greater-than-like"
 * char, and rewrite to ASCII HTML entities. HTML entities are chosen over
 * Unicode lookalikes because attackers can pre-poison content with
 * lookalikes; entities are unambiguously not-a-tag in any markup grammar
 * the LLM might apply.
 */

export const UNTRUSTED_WRAPPER_TAGS = [
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
] as const;

// Zero-width / invisible chars that an attacker might hide inside a tag literal.
// U+200B..U+200F: zero-width space, ZWNJ, ZWJ, LRM, RLM
// U+2060: word joiner
// U+FEFF: zero-width no-break space (BOM)
const ZERO_WIDTH_RE = /[​-‏⁠﻿]/g;

// All bracket-like chars we accept as "less-than" or "greater-than" in
// attack input. Covered (in order):
//   U+003C  <  ASCII less-than
//   U+2039  ‹  Single Left-Pointing Angle Quotation Mark
//   U+2329  〈  Left-Pointing Angle Bracket (mathematical)
//   U+3008  〈  Left Angle Bracket (CJK)
//   U+FF1C  ＜  Fullwidth Less-Than Sign
const LT_CLASS = "[\\u003c\\u2039\\u2329\\u3008\\uff1c]";
const GT_CLASS = "[\\u003e\\u203a\\u232a\\u3009\\uff1e]";

// Char class for "anything that is NOT a closing bracket variant" — used
// inside the wrapper match to consume attribute-style payloads up to 200
// chars without breaking out of the regex via a valid `>`.
const NOT_GT_CLASS = "[^\\u003e\\u203a\\u232a\\u3009\\uff1e]";

// Slash variants accepted before the tag name. ASCII /, U+2044 fraction
// slash, U+2215 division slash. 0..3 occurrences tolerates `<tag>` (open),
// `</tag>` (close), `<//tag>` (malformed close some parsers accept).
const SLASH_CLASS = "[\\u002f\\u2044\\u2215]";

const TAG_ALT = UNTRUSTED_WRAPPER_TAGS.join("|");

// Single regex matching <...untrusted_X[...]> or </...untrusted_X[...]>
// with any bracket variant + slash variant + arbitrary attribute payload.
const WRAPPER_RE = new RegExp(
  `${LT_CLASS}\\s*${SLASH_CLASS}{0,3}\\s*(?:${TAG_ALT})${NOT_GT_CLASS}{0,200}${GT_CLASS}`,
  "gi",
);

export function escapeUntrustedWrappers(text: string): string {
  if (!text) return "";
  // Strip zero-width chars first so they cannot hide inside a tag name.
  const noZeroWidth = text.replace(ZERO_WIDTH_RE, "");
  // Replace each matched wrapper-tag literal: rewrite the bracketing chars
  // to ASCII HTML entities and preserve the inner tag name + slash + any
  // attribute payload so the LLM still sees the intent (data echoing the
  // tag) but can't parse it as a wrapper boundary.
  return noZeroWidth.replace(WRAPPER_RE, (match) => {
    const inner = match.slice(1, -1);
    return `&lt;${inner}&gt;`;
  });
}

/**
 * iframe spec §4 — sanitize attribute values before embedding into wrapper
 * open tags (e.g. <untrusted_page_content frame_url="${escape(url)}">).
 *
 * Replaces the three characters that can break attribute syntax in HTML-like
 * grammar — `<`, `>`, and `"` — with their HTML entities. Other characters
 * pass through unchanged so URLs / origins remain human-readable.
 *
 * Defends against: a malicious page injecting a URL query string with
 * `?x="><tag x="...` that would otherwise terminate the attribute and
 * inject a new tag boundary into the LLM's view.
 *
 * NOTE: this is for the OPEN tag's attribute values only. The CLOSE tag and
 * any wrapper-tag literals appearing inside the wrapper body are handled by
 * `escapeUntrustedWrappers` above.
 */
export function escapeWrapperAttribute(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
