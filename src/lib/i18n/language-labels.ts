import type { Locale } from "./locales";

/**
 * Human-readable language labels used in LLM meta-prompts (response-language
 * directive in the agent system prompt, and the session title generator).
 *
 * Single source of truth so the response-language block (prompt.ts) and the
 * title generator (sessions/title-generator.ts) can't drift. Lives in the
 * i18n layer to avoid an agent↔sessions import cycle.
 */
export const LANGUAGE_LABELS: Record<Locale, string> = {
  en: "English (en)",
  "zh-CN": "Simplified Chinese (zh-CN)",
  "zh-TW": "Traditional Chinese (zh-TW)",
  "es-419": "Latin American Spanish (es-419)",
  ja: "Japanese (ja)",
  "pt-BR": "Brazilian Portuguese (pt-BR)",
};

/**
 * Locales whose titles are counted in characters ("字") rather than words.
 * These keep the original CJK length budget; Latin-script locales use a
 * word-based hint and a looser character cap (words run longer than glyphs).
 */
const CJK_LOCALES: ReadonlySet<Locale> = new Set(["zh-CN", "zh-TW", "ja"]);

export function isCjkLocale(locale: Locale): boolean {
  return CJK_LOCALES.has(locale);
}

/**
 * Length hint injected into the title-generation system prompt.
 * CJK: "5-10 字"; Latin: "3-6 words".
 */
export function titleLengthHint(locale: Locale): string {
  return isCjkLocale(locale) ? "5-10 字" : "3-6 words";
}

/**
 * Post-sanitize hard truncation cap for a generated title, by locale.
 * CJK stays at 30 glyphs; Latin scripts get a looser 48-char cap so a normal
 * 3-6 word English/Spanish/Portuguese title isn't clipped mid-word.
 */
export function titleMaxLen(locale: Locale): number {
  return isCjkLocale(locale) ? 30 : 48;
}
