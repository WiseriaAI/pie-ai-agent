import {
  getSessionAgent,
  getSessionMeta,
  listSessionIndex,
  markFailedAndScrub,
  markPaused,
  setSessionMeta,
} from "@/lib/sessions/storage";

/**
 * M1-U5 — SW cold-start recovery: detect in-flight tasks that died
 * with the Service Worker and transition them to a state the user can
 * act on (`paused` for tasks that reached at least one step boundary;
 * `failed` for tasks that died mid-confirm — the resolver is gone, we
 * can't honor the pending approval).
 *
 * Trigger paths (advisor: don't rely on `onStartup` alone — MV3 SW
 * dies silently after 30s idle and `onStartup` does NOT fire on the
 * subsequent wake-up):
 *   1. SW top-level (every wake-up re-imports the file)        — main
 *   2. `chrome.runtime.onStartup` (Chrome process start)       — belt
 *   3. `chrome.runtime.onInstalled`                            — belt
 *   4. `panel-mounted` message handler                         — belt
 *
 * `recoveryGuard` (independent storage key — NOT in SessionMeta)
 * deduplicates calls within a 30s window so concurrent triggers
 * don't double-mark.
 *
 * Step ordering (P0 invariant — see plan SEC-PLAN-002):
 *   Step 1: scan all sessions, mark failed + scrub pendingConfirm for
 *           any session whose agent state has a pendingConfirm record.
 *           markFailed *before* scrub so a panel never observes
 *           "status=active + pendingConfirm cleared" mid-state.
 *   Step 2: re-list, mark paused for any remaining `active` session
 *           whose `stepIndex > 0` (in-flight when SW died).
 *   Step 3: bump the guard timestamp.
 *
 * Step 1 + 2 must be sequential (Step 2 reads the result of Step 1).
 */

const GUARD_KEY = "recovery_guard";
const GUARD_WINDOW_MS = 30_000;

interface RecoveryStats {
  /** Number of sessions transitioned active → paused (in-flight tasks). */
  paused: number;
  /** Number of sessions transitioned active → failed (had pendingConfirm). */
  failed: number;
  /** Set when the call returned early due to the guard window. */
  skippedDueToGuard: boolean;
}

async function readGuard(): Promise<number | null> {
  const r = await chrome.storage.local.get(GUARD_KEY);
  const value = r[GUARD_KEY];
  return typeof value === "number" ? value : null;
}

async function bumpGuard(now: number): Promise<void> {
  await chrome.storage.local.set({ [GUARD_KEY]: now });
}

export interface DetectAndMarkPausedOptions {
  /** Override `Date.now()` (tests). */
  now?: number;
  /** Bypass the 30s guard (tests + first-install handler). */
  skipGuard?: boolean;
}

export async function detectAndMarkPaused(
  options: DetectAndMarkPausedOptions = {},
): Promise<RecoveryStats> {
  const now = options.now ?? Date.now();
  const stats: RecoveryStats = {
    paused: 0,
    failed: 0,
    skippedDueToGuard: false,
  };

  if (!options.skipGuard) {
    const lastRun = await readGuard();
    if (lastRun !== null && now - lastRun < GUARD_WINDOW_MS) {
      stats.skippedDueToGuard = true;
      return stats;
    }
  }

  // Step 1 — scan for sessions with pendingConfirm and mark failed + scrub.
  // The resolver lives in SW memory; after SW restart it's gone, so any
  // pendingConfirm record is stale by definition. Mark failed *before*
  // scrubbing to avoid a window where `status=active` and the record is
  // gone (panel would interpret as "all clear, in-flight task is healthy").
  const initialIndex = await listSessionIndex();
  for (const entry of initialIndex) {
    if (entry.status !== "active") continue;
    const agent = await getSessionAgent(entry.id);
    if (agent?.pendingConfirm) {
      const ok = await markFailedAndScrub(entry.id);
      if (ok) stats.failed += 1;
    }
  }

  // Step 2 — re-list to skip the sessions just marked failed; among
  // remaining `active`, mark paused for any with stepIndex > 0
  // (in-flight task interrupted by SW death).
  //
  // R14 — image-bearing in-flight sessions MUST be marked `failed` (not
  // `paused`) on SW cold-start. The in-memory image cache (image-cache.ts)
  // is cleared by evictAllOnSWStartup at startup, so any session whose
  // `hasImageContent` flag is true cannot be resumed — the image bytes the
  // LLM originally saw are gone. We mark these `failed` so the UI shows
  // an appropriate error state rather than a "Resume" button that would
  // silently drop image context.
  const refreshedIndex = await listSessionIndex();
  for (const entry of refreshedIndex) {
    if (entry.status !== "active") continue;
    const agent = await getSessionAgent(entry.id);
    if (agent && agent.stepIndex > 0) {
      if (agent.hasImageContent) {
        // R14 — image cache evicted on SW restart; session is unresumable.
        const meta = await getSessionMeta(entry.id);
        if (meta) {
          await setSessionMeta({ ...meta, status: "failed" });
          stats.failed += 1;
        }
      } else {
        const ok = await markPaused(entry.id);
        if (ok) stats.paused += 1;
      }
    }
    // stepIndex === 0 is the tombstone state (M1-U3) — no in-flight task,
    // leave the session as `active`.
  }

  // Step 3 — bump guard so re-entrant triggers within 30s skip.
  await bumpGuard(now);

  return stats;
}

/**
 * Bug-fix-E — panel-disconnect recovery (per-port subset of detectAndMarkPaused).
 *
 * Walks the supplied session ids (= the inFlightSessionIds set kept inside
 * the onConnect closure for one sidepanel port) and applies the same
 * step-1 + step-2 transitions detectAndMarkPaused does on cold-start, but
 * scoped to ONLY this port's sessions. Multi-sidepanel safety: a sibling
 * port running its own tasks must not be touched when this port closes.
 *
 * Step ordering matches detectAndMarkPaused (SEC-PLAN-002):
 *   1. pendingConfirm present → markFailedAndScrub (resolver gone with
 *      the closing port; the request is unhonorable post-disconnect).
 *   2. else stepIndex > 0 → markPaused (in-flight, user-resumable via R10).
 *   3. else (tombstone, stepIndex===0) → no-op (task finished cleanly).
 *
 * No 30s guard: this is a user-driven event, not an idempotent SW wake-up
 * trigger; multiple panel close+reopen cycles must always re-mark.
 *
 * Errors are caught + logged per-session so a single bad agent record
 * does not abort the cleanup of remaining sessions.
 */
export async function transitionPortInFlightSessionsToPaused(
  sessionIds: Iterable<string>,
): Promise<{ paused: number; failed: number }> {
  const stats = { paused: 0, failed: 0 };
  for (const sid of sessionIds) {
    try {
      const agent = await getSessionAgent(sid);
      if (!agent) continue;
      if (agent.pendingConfirm) {
        const ok = await markFailedAndScrub(sid);
        if (ok) stats.failed += 1;
      } else if (agent.stepIndex > 0) {
        // R14 — mirror cold-start logic: port disconnect triggers
        // evictByInFlightSet which drops image bytes; image-bearing sessions
        // can't be resumed (bytes gone with the port's in-memory cache).
        if (agent.hasImageContent) {
          const meta = await getSessionMeta(sid);
          if (meta) {
            await setSessionMeta({ ...meta, status: "failed" });
            stats.failed += 1;
          }
        } else {
          const ok = await markPaused(sid);
          if (ok) stats.paused += 1;
        }
      }
      // stepIndex === 0 → tombstone, task finished cleanly; leave it alone.
    } catch (e) {
      console.warn(
        `[sw] panel-disconnect transition failed for session=${sid}:`,
        e,
      );
    }
  }
  return stats;
}
