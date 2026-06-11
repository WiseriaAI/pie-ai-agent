// src/lib/schedules/url-guard.ts
//
// Schedule-specific restricted-URL guard.
//
// The shared `isRestrictedUrl` (src/lib/url/restricted.ts; re-exported by
// loop.ts) only inspects the URL *scheme* (chrome://, about:, file:, data:, …).
// That is insufficient for schedule
// startUrls because the Chrome Web Store is served over plain https:// — its
// scheme passes, but Chrome forbids extensions from injecting/executing scripts
// on Web Store pages, so a schedule that opened a Web Store tab would run the
// loop only to have every tool fail (a misleading "tool error" rather than a
// clean "restricted page" failure). spec §8.2 lists "Web Store" as restricted.
//
// `isRestrictedScheduleUrl` therefore widens the scheme check with a Web Store
// HOST check sourced from the shared `web-store-urls` blocklist (the same list
// `src/background/content-reinject.ts` uses to skip injection). Keeping that
// list centralized avoids the two consumers diverging.
//
// Both runtime (run.ts) and create-time validation (Task 7) use this single
// function so the two paths can never disagree on what counts as restricted.
//
// NOTE (deliberate): file://*.pdf is intentionally NOT blocked. `isRestrictedUrl`
// returns false for file PDFs and we preserve that — local PDFs are a supported
// surface gated by the user's "Allow access to file URLs" permission, not a
// restricted page.

import { isRestrictedUrl } from "@/lib/url/restricted";
import { isWebStoreUrl } from "@/lib/web-store-urls";

/**
 * True when `url` cannot be used as a schedule startUrl: either its scheme is
 * restricted (isRestrictedUrl) or it is a Chrome Web Store page (host check).
 */
export function isRestrictedScheduleUrl(url: string): boolean {
  return isRestrictedUrl(url) || isWebStoreUrl(url);
}
