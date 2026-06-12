// Canonical Chrome Web Store host blocklist.
//
// Chrome forbids extensions from injecting content scripts / executing scripts
// on Web Store pages, so any surface that injects into a tab (content-reinject,
// schedule background tabs, …) must skip these. Both the old and the current
// Web Store hosts are listed.
//
// SINGLE SOURCE OF TRUTH: import `WEB_STORE_HOST_SUBSTRINGS` / `isWebStoreUrl`
// here instead of re-declaring the substrings. Previously this list was
// duplicated in `src/background/content-reinject.ts`; keep it centralized so
// the two consumers never diverge again.

/** Substrings that identify a Chrome Web Store URL (old + current hosts). */
export const WEB_STORE_HOST_SUBSTRINGS = [
  "chrome.google.com/webstore",
  "chromewebstore.google.com",
] as const;

/** True when `url` is a Chrome Web Store page (cannot be script-injected). */
export function isWebStoreUrl(url: string | undefined): boolean {
  if (!url) return false;
  return WEB_STORE_HOST_SUBSTRINGS.some((s) => url.includes(s));
}
