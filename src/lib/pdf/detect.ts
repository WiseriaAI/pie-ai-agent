const PDF_URL_RE = /\.pdf(?:$|[?])/i;

/**
 * Pure-URL heuristic: tab.url ends in `.pdf` (case-insensitive), optionally
 * followed by a query string. The hash fragment is stripped before the
 * regex check so that `viewer#file.pdf` does NOT match — `.pdf` must
 * appear in the path itself. PDFs served WITHOUT a `.pdf` suffix (e.g.
 * `arxiv.org/pdf/2407.13943`) are NOT caught here — use {@link isPdfTabAsync}
 * for the full detection path, which ORs this heuristic with a live
 * `document.contentType` probe. This sync form is still the right call for
 * the `file://` pin-gate (see {@link isFilePdfUrl}) and any place that only
 * has a URL string (no live tab to inject into).
 */
export function isPdfTab(tab: Pick<chrome.tabs.Tab, "url">): boolean {
  const url = tab?.url;
  if (!url) return false;
  const hashIdx = url.indexOf("#");
  const beforeHash = hashIdx === -1 ? url : url.slice(0, hashIdx);
  return PDF_URL_RE.test(beforeHash);
}

/**
 * Full PDF-tab detection: the pure-URL {@link isPdfTab} heuristic short-circuit
 * `||` a live probe of the tab's `document.contentType`.
 *
 * Chrome's built-in PDF viewer renders the document inside a shell whose
 * `document.contentType === "application/pdf"`, and that shell IS reachable via
 * `chrome.scripting.executeScript` (read_page already injects it — that's how it
 * ends up reading the sealed viewer's empty DOM). So a PDF served without a
 * `.pdf` suffix, which the URL regex misses, is still caught by the contentType
 * probe. This is the real signal; URL-suffix allow-listing (arxiv + the long
 * tail of suffixless PDF hosts) would only ever be a partial patch.
 *
 * fail-closed: any probe failure — injection rejected on a restricted scheme,
 * the tab having gone away, a timeout — resolves to `false` (treated as
 * non-PDF) rather than throwing. Callers that redirect to the PDF tools on a
 * `true` result therefore never redirect on a probe error.
 *
 * When `tabId` is absent / negative (e.g. the loop's NO_PAGE_SENTINEL, or a
 * placeholder URL with no live tab), there is nothing injectable: the probe is
 * skipped and only the URL heuristic applies.
 */
export async function isPdfTabAsync(
  tabId: number | undefined | null,
  url: string | undefined | null,
): Promise<boolean> {
  if (isPdfTab({ url: url ?? undefined })) return true;
  if (typeof tabId !== "number" || tabId < 0) return false;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.contentType,
      injectImmediately: true,
    });
    return results?.[0]?.result === "application/pdf";
  } catch {
    return false;
  }
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
