const PDF_URL_RE = /\.pdf(?:$|[?])/i;

/**
 * MVP heuristic: tab.url ends in `.pdf` (case-insensitive), optionally
 * followed by a query string. The hash fragment is stripped before the
 * regex check so that `viewer#file.pdf` does NOT match — `.pdf` must
 * appear in the path itself. PDFs served without a `.pdf` suffix are
 * out of scope for the auto-detection path — the LLM may still call
 * `read_pdf` directly, and LiteParse's parse-failure branch will
 * return `not_a_pdf` if the bytes aren't PDF.
 */
export function isPdfTab(tab: Pick<chrome.tabs.Tab, "url">): boolean {
  const url = tab?.url;
  if (!url) return false;
  const hashIdx = url.indexOf("#");
  const beforeHash = hashIdx === -1 ? url : url.slice(0, hashIdx);
  return PDF_URL_RE.test(beforeHash);
}

/**
 * `file://*.pdf` exception used by the agent pin-gate (loop.ts isRestrictedUrl
 * + safeParseOrigin) and the panel pin-capture (useSession). Chrome's built-in
 * PDF viewer is sealed and cannot navigate, so a file:// PDF tab is safe to
 * pin via its full URL as identity. Other file:// URLs remain restricted
 * because `new URL(...).origin` collapses to "null" and would defeat
 * per-iteration origin isolation.
 */
export function isFilePdfUrl(url: string | undefined | null): boolean {
  if (!url || !url.startsWith("file://")) return false;
  return isPdfTab({ url });
}

/**
 * Cache key derivation. MVP just returns the URL — SW recycle / sidepanel
 * close already flushes the offscreen-resident cache (in-memory map). If
 * a user edits a PDF in place and re-asks the agent we'd serve stale text;
 * upgrade to a content hash if that ever surfaces as a real complaint.
 */
export function tabUrlForCacheKey(url: string): string {
  return url;
}
