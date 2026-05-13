/**
 * Issue #50 (R11 / navigation-transient-tolerance) — wait until a tab's
 * top-frame navigation commits, so the agent loop's per-iteration origin
 * check no longer mis-fires on the brief `about:blank` window between
 * `chrome.tabs.create` and the first onCommitted event.
 *
 * This helper is intentionally NOT a refactor of `wait-for-settle.ts`
 * (`withActionSettle`). The two cover different observation moments:
 *   - withActionSettle waits AFTER an action for the page to quiet down
 *     (cross-doc commit OR SPA pushState OR DOM mutation).
 *   - waitForUrlSettle waits for a SPECIFIC cross-doc commit to a given
 *     origin. SPA pushState is not relevant — the loop only enters the
 *     transient branch when `tab.url === "about:blank"`, and pushState
 *     never starts from about:blank.
 *
 * One listener per call: `chrome.webNavigation.onCommitted` filtered to
 * `details.tabId === tabId && details.frameId === 0`. We re-read
 * `chrome.tabs.get(tabId)` inside the listener rather than trusting
 * `details.url` so we observe the same surface the loop's origin check
 * will use on the next iteration.
 */

export type UrlSettleResult =
  | { committed: true; url: string }
  | {
      committed: false;
      reason: "timeout" | "origin-mismatch" | "tab-gone";
      observedUrl?: string;
    };

function safeOrigin(url: string): string | null {
  try {
    const o = new URL(url).origin;
    if (!o || o === "null") return null;
    return o;
  } catch {
    return null;
  }
}

export function waitForUrlSettle(
  tabId: number,
  expectedOrigin: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<UrlSettleResult> {
  return new Promise<UrlSettleResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    const onCommitted = (details: {
      tabId: number;
      frameId: number;
    }): void => {
      if (settled) return;
      if (details.tabId !== tabId || details.frameId !== 0) return;
      // Top-frame commit observed; re-read tab.url so we observe the
      // same surface the loop's standard origin check will use.
      chrome.tabs
        .get(tabId)
        .then((tab) => {
          if (settled) return;
          const url = tab.url ?? "";
          const observedOrigin = safeOrigin(url);
          if (observedOrigin && observedOrigin === expectedOrigin) {
            finish({ committed: true, url });
          } else {
            finish({
              committed: false,
              reason: "origin-mismatch",
              observedUrl: url,
            });
          }
        })
        .catch(() => {
          if (settled) return;
          finish({ committed: false, reason: "tab-gone" });
        });
    };

    const finish = (r: UrlSettleResult): void => {
      if (settled) return;
      settled = true;
      try {
        chrome.webNavigation.onCommitted.removeListener(onCommitted);
      } catch {
        // best-effort
      }
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      resolve(r);
    };

    const abortNow = (): void => {
      if (settled) return;
      settled = true;
      try {
        chrome.webNavigation.onCommitted.removeListener(onCommitted);
      } catch {
        // best-effort
      }
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      reject(new DOMException("aborted", "AbortError"));
    };

    chrome.webNavigation.onCommitted.addListener(onCommitted);
    timer = setTimeout(() => {
      finish({ committed: false, reason: "timeout" });
    }, timeoutMs);
    if (signal) {
      onAbort = abortNow;
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
