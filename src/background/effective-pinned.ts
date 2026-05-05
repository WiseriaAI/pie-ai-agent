// Phase 5 follow-up — first-task pin race fallback helper.
//
// sendConfirmRequest for screenshot tools uses closure-captured `pinned`
// from the SW's sessionMeta read at chat-start. That read happens before the
// panel-side captureActivePinned + setSessionMeta fire-and-forget (documented
// race at useSession.ts:760-790). For the very first chat-start the patch may
// not have landed yet, leaving the closure-captured value undefined.
//
// The loop's other tools fall back to chrome.tabs.query active-tab; this
// helper mirrors that fallback for screenshot tools.
//
// Extracted as a pure-function (with DI) so it is unit-testable without
// a Chrome runtime.

import { isRestrictedUrl } from "@/lib/agent/loop";
import type { SessionMeta } from "@/lib/sessions/types";
import { getPrimaryPin } from "@/lib/sessions/pin-state";

export type PinnedCtx = { tabId: number; origin: string };

export type GetSessionMetaFn = (
  id: string,
) => Promise<SessionMeta | undefined | null>;

export type QueryActiveTabFn = () => Promise<
  Array<{ id?: number; url?: string }>
>;

/**
 * Resolve the effective pinned context for a screenshot tool call using a
 * three-tier fallback:
 *
 * 1. `closurePinned` — already captured at chat-start (fast path, no I/O).
 * 2. Re-read sessionMeta — the panel-side pin patch may have landed since
 *    chat-start; resolved via `getPrimaryPin(meta)` which reads
 *    `pinnedTabs[0]` (v1.5 multi-pin schema).
 * 3. `chrome.tabs.query` active-tab — same fallback the agent loop uses for
 *    non-screenshot tools. Restricted-URL schemes are rejected.
 *
 * Returns `null` when all three tiers fail (genuinely unpinnable session,
 * e.g. the active tab is chrome://).
 */
export async function resolveEffectivePinned(
  closurePinned: PinnedCtx | undefined,
  sessionId: string,
  getMetaFn: GetSessionMetaFn,
  queryActiveTabFn: QueryActiveTabFn,
  isRestrictedUrlFn: (url: string) => boolean,
): Promise<PinnedCtx | null> {
  // Tier 1 — closure value (hot path, zero I/O).
  if (closurePinned) return closurePinned;

  // Tier 2 — re-read sessionMeta (pin patch may have landed since chat-start).
  try {
    const fresh = await getMetaFn(sessionId);
    const primary = fresh ? getPrimaryPin(fresh) : undefined;
    if (primary) {
      return primary;
    }
  } catch {
    // Non-fatal; fall through to tier 3.
  }

  // Tier 3 — chrome.tabs.query active-tab (same fallback the loop uses).
  try {
    const [activeTab] = await queryActiveTabFn();
    if (!activeTab?.id || !activeTab.url) return null;
    if (isRestrictedUrlFn(activeTab.url)) return null;
    let origin: string;
    try {
      origin = new URL(activeTab.url).origin;
    } catch {
      return null;
    }
    return { tabId: activeTab.id, origin };
  } catch {
    return null;
  }
}

/**
 * Convenience wrapper that wires the real Chrome + storage APIs.
 * Background script callers use this directly.
 */
export function makeResolveEffectivePinned(
  getSessionMetaFn: GetSessionMetaFn,
): (
  closurePinned: PinnedCtx | undefined,
  sessionId: string,
) => Promise<PinnedCtx | null> {
  return (closurePinned, sessionId) =>
    resolveEffectivePinned(
      closurePinned,
      sessionId,
      getSessionMetaFn,
      () => chrome.tabs.query({ active: true, currentWindow: true }),
      isRestrictedUrl,
    );
}
