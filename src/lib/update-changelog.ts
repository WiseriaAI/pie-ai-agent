import type { Locale } from "@/lib/i18n/types";

// Post-update changelog notification (issue #351).
//
// After an extension auto-update, Pie opens a tab pointing at the website
// changelog page — but ONLY for a minor or major version bump. Patch bumps stay
// completely silent (Chrome updates silently in the background; a tab on every
// patch would nag the user). Downgrades, no-op reinstalls, and missing/garbage
// previousVersion values are all silent too.
//
// The logic is a pure function with a single-purpose test matrix so the
// pop/no-pop decision never regresses.

interface ParsedVersion {
  major: number;
  minor: number;
}

/**
 * Parse an `x.y[.z...]` version string into its major/minor components.
 * Returns null when the string is missing or not a dot-joined run of
 * non-negative integers (at least `major.minor`). We only need major/minor to
 * decide whether to pop — patch and beyond are intentionally ignored.
 */
function parseVersion(v: string | undefined): ParsedVersion | null {
  if (typeof v !== "string") return null;
  const parts = v.trim().split(".");
  if (parts.length < 2) return null;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
  }
  return { major: Number(parts[0]), minor: Number(parts[1]) };
}

/**
 * Decide whether an extension update from `previousVersion` to `currentVersion`
 * should open the changelog tab. True only when the (major, minor) tuple
 * strictly increased — i.e. a minor or major bump. Everything else (patch-only,
 * identical, downgrade, or an unparseable/absent previousVersion) is false.
 */
export function shouldOpenChangelog(
  previousVersion: string | undefined,
  currentVersion: string,
): boolean {
  const prev = parseVersion(previousVersion);
  const cur = parseVersion(currentVersion);
  if (!prev || !cur) return false;
  if (cur.major !== prev.major) return cur.major > prev.major;
  return cur.minor > prev.minor;
}

// Extension UI locale → website changelog locale directory. The website hosts
// its localized changelog under a per-locale directory (root = English). The
// Simplified/Traditional Chinese UI locales map onto the website's script-based
// `zh-Hans` / `zh-Hant` directory names; the rest share the same tag.
// Declared as a full Record so adding a new UI Locale is a compile error here
// until the website mapping is filled in.
const WEBSITE_LOCALE_PATH: Record<Locale, string> = {
  en: "",
  "zh-CN": "zh-Hans/",
  "zh-TW": "zh-Hant/",
  "es-419": "es-419/",
  ja: "ja/",
  "pt-BR": "pt-BR/",
};

/**
 * Map an extension UI locale to the website changelog locale path segment
 * (with trailing slash, or "" for the English root).
 */
export function websiteLocalePath(locale: Locale): string {
  return WEBSITE_LOCALE_PATH[locale];
}

/**
 * Build the website changelog URL for the given UI locale and version range.
 * The page tolerates malformed/missing params itself, so we don't validate
 * them here — we only URL-encode the query.
 */
export function buildChangelogUrl(
  locale: Locale,
  fromVersion: string,
  toVersion: string,
): string {
  const localePath = websiteLocalePath(locale);
  const params = new URLSearchParams({ from: fromVersion, to: toVersion });
  return `https://www.pie.chat/${localePath}changelog?${params.toString()}`;
}
