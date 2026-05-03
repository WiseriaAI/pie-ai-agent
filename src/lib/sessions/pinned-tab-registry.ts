// M3-U4 — cross-session pinned-tab registry.
//
// Reads the lightweight session_index (D9) — the same key the drawer
// uses to render the session list — to enumerate every active session's
// pinnedTabId. Used by the SW dispatcher to compute
// `crossSessionPinnedTabIds` per chat-start / resume-task and by
// write-class tools (R7 lock) to refuse operations on a tab another
// session legitimately owns (close_tabs cross-session intent =
// "session A should not be allowed to close session B's pinned tab").
//
// Why session_index and not per-session meta:
//   - session_index already carries pinnedTabId (see
//     SessionIndexEntry.pinnedTabId in types.ts). It's the canonical
//     light-weight registry and is updated atomically with meta writes
//     via D9 single-call set().
//   - Reading per-session meta for every active session would multiply
//     storage round-trips on every chat-start; the index is one read.
//
// Status filtering: only `active` and `paused` sessions count. archived
// sessions don't have any active task; failed sessions have nothing
// running but their pin is still meaningful for "the user might unpause"
// — we pick the conservative side and include `paused`. `archived`
// sessions are deliberately excluded because (a) LRU archive can land
// on any session at any time, including one whose pin is stale, and
// (b) the user already accepted that archived sessions are "shelved".
//
// SECURITY note: this is informational, not a security boundary. K9
// states sessions are not a trust boundary; the cross-session lock
// here exists to prevent surprising cross-session interference (UX
// hardening), not to prevent malicious behavior — both sessions are
// the same user's BYOK extension.

import { listSessionIndex } from "./storage";
import type { SessionIndexEntry } from "./types";

export interface ActivePinnedTab {
  sessionId: string;
  tabId: number;
  /** Sessions in this set are eligible to "own" a pinned tab. paused
   *  sessions remain owners until the user resumes (and possibly drifts)
   *  or discards. */
  status: "active" | "paused";
}

const OWNING_STATUSES: ReadonlySet<SessionIndexEntry["status"]> = new Set([
  "active",
  "paused",
]);

/**
 * Returns every active/paused session's pinnedTabId. Sessions without a
 * pinnedTabId (M1 / M2 legacy that never got migrated) are skipped.
 *
 * Single read of session_index — O(N) in the number of session entries;
 * fine to call per chat-start.
 */
export async function getActivePinnedTabs(): Promise<ActivePinnedTab[]> {
  const index = await listSessionIndex();
  const out: ActivePinnedTab[] = [];
  for (const entry of index) {
    if (!OWNING_STATUSES.has(entry.status)) continue;
    if (typeof entry.pinnedTabId !== "number") continue;
    out.push({
      sessionId: entry.id,
      tabId: entry.pinnedTabId,
      status: entry.status as "active" | "paused",
    });
  }
  return out;
}

/**
 * Returns the set of tab ids pinned by sessions OTHER THAN the given
 * `excludeSessionId`. Pass this to runAgentLoop's ctx so write-class
 * handlers can `.has(tabId)` to check for cross-session conflicts.
 *
 * The "excludeSessionId" carve-out is what makes this useful at runtime:
 * the calling session's own pinnedTabId is not a conflict for itself.
 *
 * Returns an empty set when nothing else is pinned (the common single-
 * session case).
 */
export async function getCrossSessionPinnedTabIds(
  excludeSessionId: string,
): Promise<Set<number>> {
  const all = await getActivePinnedTabs();
  const out = new Set<number>();
  for (const entry of all) {
    if (entry.sessionId === excludeSessionId) continue;
    out.add(entry.tabId);
  }
  return out;
}
