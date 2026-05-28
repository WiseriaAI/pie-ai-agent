const PDF_URL_RE = /\.pdf(?:$|[?#])/i;

/**
 * MVP heuristic: tab.url ends in `.pdf` (case-insensitive), optionally
 * followed by a query string or hash fragment. PDFs served without a
 * `.pdf` suffix are out of scope for the auto-detection path — the LLM
 * may still call `read_pdf` directly, and LiteParse's parse-failure
 * branch will return `not_a_pdf` if the bytes aren't PDF.
 */
export function isPdfTab(tab: Pick<chrome.tabs.Tab, "url">): boolean {
  const url = tab?.url;
  if (!url) return false;
  return PDF_URL_RE.test(url);
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
