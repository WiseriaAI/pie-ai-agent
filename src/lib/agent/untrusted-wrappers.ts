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
 *  4. Mathematical angle:  `〈/untrusted_*〉` (U+2329 / U+232A or U+3008 / U+3009)
 *  5. Zero-width injection: `<​/untrusted_*>` (U+200B-200F, U+2060, U+FEFF)
 *
 * Strategy: strip zero-width chars first (cannot hide inside a tag name),
 * then match any "less-than-like" char + optional `/` + known wrapper tag +
 * "greater-than-like" char, and rewrite to ASCII HTML entities. HTML entities
 * are chosen over Unicode lookalikes because attackers can pre-poison content
 * with lookalikes; entities are unambiguously not-a-tag in any markup grammar
 * the LLM might apply.
 */

export const UNTRUSTED_WRAPPER_TAGS = [
  "untrusted_page_content",
  "untrusted_skill_params",
  "untrusted_tab_metadata",
] as const;

// Zero-width / invisible chars that an attacker might hide inside a tag literal.
// U+200B..U+200F: zero-width space, ZWNJ, ZWJ, LRM, RLM
// U+2060: word joiner
// U+FEFF: zero-width no-break space (BOM)
const ZERO_WIDTH_RE = /[​-‏⁠﻿]/g;

// All bracket-like chars we accept as "less-than" or "greater-than" in attack input.
const LT_CLASS = "[<‹〈〈＜]";
const GT_CLASS = "[>›〉〉＞]";

const TAG_ALT = UNTRUSTED_WRAPPER_TAGS.join("|");

// Single regex matching <...untrusted_X...> or </...untrusted_X...> with any
// bracket variant + optional whitespace tolerance.
const WRAPPER_RE = new RegExp(
  `${LT_CLASS}\\s*/?\\s*(?:${TAG_ALT})\\s*${GT_CLASS}`,
  "gi",
);

export function escapeUntrustedWrappers(text: string): string {
  if (!text) return "";
  // Strip zero-width chars first so they cannot hide inside a tag name.
  const noZeroWidth = text.replace(ZERO_WIDTH_RE, "");
  // Replace each matched wrapper-tag literal: rewrite the bracketing chars
  // to ASCII HTML entities and preserve the inner tag name + slash so the
  // LLM still sees the intent (data echoing the tag) but can't parse it as
  // a wrapper boundary.
  return noZeroWidth.replace(WRAPPER_RE, (match) => {
    const inner = match.slice(1, -1);
    return `&lt;${inner}&gt;`;
  });
}
