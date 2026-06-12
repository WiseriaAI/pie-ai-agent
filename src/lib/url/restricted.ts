// src/lib/url/restricted.ts
//
// Single source of truth for the "restricted URL" scheme check that gates
// agent tab-pinning, per-iteration origin re-checks, and schedule startUrls.
//
// This was historically defined inside loop.ts (2200+ lines), which forced any
// consumer to import the entire agent runtime. That created a circular import
// for url-guard.ts (url-guard → loop → tools → schedule-meta → url-guard) and
// pressured callers (schedule-meta, tabs, useSession) into hand-maintained
// inline copies that drifted from the canonical logic.
//
// `isRestrictedUrl` has exactly ONE dependency — `isFilePdfUrl` (pdf/detect.ts),
// which has zero agent-layer dependencies — so lifting it here is a pure,
// side-effect-free move. loop.ts now re-exports from this module to preserve
// every existing `import { isRestrictedUrl } from "../agent/loop"` call site.

import { isFilePdfUrl } from "@/lib/pdf/detect";

/**
 * True when `url`'s scheme is one the agent must never operate on.
 *
 * Rejects schemes whose origin collapses to the string "null" or that the agent
 * has no sensible way to pin: file://, data:, javascript:, blob:. Without these
 * checks, any subsequent navigation within one of these schemes would pass the
 * per-round origin comparison (`"null" === "null"`), defeating the isolation.
 *
 * Exception: `file://*.pdf` is allowed (Chrome's built-in PDF viewer is sealed
 * and cannot navigate, so the full file URL is a safe pin identity — see
 * `isFilePdfUrl`). The PDF exception strips the hash fragment via the shared
 * `PDF_URL_RE` regex, so create-time and runtime guards agree on every URL.
 */
export function isRestrictedUrl(url: string): boolean {
  if (isFilePdfUrl(url)) return false;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("about:") ||
    url.startsWith("edge://") ||
    url.startsWith("file://") ||
    url.startsWith("data:") ||
    url.startsWith("javascript:") ||
    url.startsWith("blob:")
  );
}
