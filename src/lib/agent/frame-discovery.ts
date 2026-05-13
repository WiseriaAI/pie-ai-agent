import type {
  FrameSnapshot,
  ReachableFrameSnapshot,
  UnreachableFrameSnapshot,
  FrameInjectionResult,
} from "../dom-actions/types";

/**
 * iframe spec §2 — best-effort reason inference for unreachable frames.
 *
 * Not a legal definition — just hints surfaced to LLM / panel UX. The four
 * buckets cover the observable cases at executeScript time:
 *  - extension-child: child iframe is itself a chrome-extension:// document
 *    (can't inject into another extension's frame)
 *  - about-blank: blank iframe with no document yet (timing) — caller may
 *    retry on next iteration
 *  - frame-error: webNavigation flagged an error (covers X-Frame-Options /
 *    CSP frame-ancestors / network errors)
 *  - sandbox: catch-all for cases where executeScript silently returns
 *    no result — typically `sandbox` attribute iframes rejecting injection
 */
export function inferUnreachableReason(input: {
  url: string;
  errorOccurred: boolean;
}): "sandbox" | "extension-child" | "about-blank" | "frame-error" {
  if (input.url.startsWith("chrome-extension://")) return "extension-child";
  if (input.url === "about:blank" && !input.errorOccurred) return "about-blank";
  if (input.errorOccurred) return "frame-error";
  return "sandbox";
}

/**
 * Parse a URL's origin. Returns null for URLs without an origin (about:blank,
 * data:, chrome:// without scheme handler in URL ctor).
 */
function safeOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return u.origin === "null" ? null : u.origin;
  } catch {
    return null;
  }
}

/**
 * Injection-result shape — what chrome.scripting.executeScript with
 * allFrames:true returns per frame. result is undefined for frames where
 * injection silently failed (sandboxed / extension child / etc).
 */
export interface FrameInjection {
  frameId: number;
  result?: FrameInjectionResult;
}

/**
 * iframe spec §2 — compose FrameSnapshot[] from a webNavigation frame tree
 * and the executeScript injection results.
 *
 * Frames present in getAllFrames but absent from `injections` (or with
 * undefined result) become UnreachableFrameSnapshot. Frames present in both
 * become ReachableFrameSnapshot. Frames present in injections but absent
 * from getAllFrames (rare; race during nav) are dropped — webNavigation is
 * the authoritative frame tree.
 *
 * Top frame's origin (frameId=0) anchors crossOrigin determination.
 */
export async function getAllFramesAndDiff(
  tabId: number,
  injections: FrameInjection[],
): Promise<FrameSnapshot[]> {
  const tree = await chrome.webNavigation.getAllFrames({ tabId });
  if (!tree || tree.length === 0) return [];

  const top = tree.find((f) => f.frameId === 0);
  const topOrigin = top ? safeOrigin(top.url) : null;
  const injectionMap = new Map<number, FrameInjection>(
    injections.map((i) => [i.frameId, i]),
  );

  const frames: FrameSnapshot[] = tree.map((entry) => {
    const origin = safeOrigin(entry.url);
    const crossOrigin = topOrigin !== null && origin !== null && origin !== topOrigin;
    const parentFrameId = entry.frameId === 0 ? null : entry.parentFrameId;

    const injection = injectionMap.get(entry.frameId);
    if (injection && injection.result) {
      return {
        frameId: entry.frameId,
        frameUrl: entry.url,
        origin: origin ?? "",
        crossOrigin,
        parentFrameId,
        elements: injection.result.elements,
      } satisfies ReachableFrameSnapshot;
    }

    return {
      frameId: entry.frameId,
      frameUrl: entry.url,
      origin,
      crossOrigin,
      parentFrameId,
      unreachable: true,
      reason: inferUnreachableReason({
        url: entry.url,
        errorOccurred: entry.errorOccurred,
      }),
    } satisfies UnreachableFrameSnapshot;
  });

  // iframe spec R-iframe-3 implicit invariant — stable frame ordering by
  // frameId. chrome.webNavigation.getAllFrames does not document an ordering
  // guarantee (Chromium currently emits by frame creation time; this can
  // vary). Sort ascending so frame_id=0 (top) always renders first and
  // tests can rely on positional assertions.
  frames.sort((a, b) => a.frameId - b.frameId);

  return frames;
}
