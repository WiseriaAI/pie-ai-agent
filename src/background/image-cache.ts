// src/background/image-cache.ts
import type { ImageRef } from "@/lib/images";

const SESSION_BYTE_BUDGET = 30 * 1024 * 1024;
const SESSION_TURN_BUDGET = 3;

const cache = new Map<string, ImageRef[]>();

export function addImage(sessionId: string, ref: ImageRef): void {
  const list = cache.get(sessionId) ?? [];
  list.push(ref);
  cache.set(sessionId, list);
  enforceLRU(sessionId);
}

/**
 * Returns a shallow copy of the cached image refs for a session. Callers
 * may freely sort/reverse/filter without corrupting cache invariants.
 * `ImageRef` itself is treated as immutable (Task 4 contract — Tasks 11/12
 * never mutate fields of returned refs).
 */
export function getImages(sessionId: string): ImageRef[] {
  const list = cache.get(sessionId);
  return list ? [...list] : [];
}

export function getImagesByUserTurn(sessionId: string, userTurnId: string): ImageRef[] {
  return (cache.get(sessionId) ?? []).filter((r) => r.userTurnId === userTurnId);
}

export function getImageById(sessionId: string, imageId: string): ImageRef | undefined {
  return (cache.get(sessionId) ?? []).find((r) => r.id === imageId);
}

/**
 * R13 LRU enforcement: per session, if total bytes > 30 MB OR distinct
 * image-bearing user turns > 3, drop the oldest user turn (and all its
 * images) until both bounds satisfied. Same-turn images are atomic — the
 * brainstorm "last 3 含图 user turn" semantics mean turn-grain eviction.
 */
function enforceLRU(sessionId: string): void {
  const list = cache.get(sessionId);
  if (!list) return;

  while (list.length > 0) {
    const totalBytes = list.reduce((s, r) => s + r.byteLength, 0);
    const distinctTurns = new Set(list.map((r) => r.userTurnId));
    if (totalBytes <= SESSION_BYTE_BUDGET && distinctTurns.size <= SESSION_TURN_BUDGET) break;

    // Drop oldest turn entirely. Oldest = smallest addedAt.
    const oldestTurnId = list.reduce(
      (acc, r) => (acc === null || r.addedAt < acc.addedAt ? r : acc),
      null as ImageRef | null,
    )?.userTurnId;
    if (oldestTurnId == null) break;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].userTurnId === oldestTurnId) list.splice(i, 1);
    }
  }
  if (list.length === 0) cache.delete(sessionId);
}

// ── R13 4-path evict API ────────────────────────────────────────────────────

/** Path (a) emitDone any terminal state — wired in Task 11. */
export function evictSession(sessionId: string): void {
  cache.delete(sessionId);
}

/** Path (b) SW restart recovery scrub — wired in Task 12 SW startup. */
export function evictAllOnSWStartup(): void {
  cache.clear();
}

/** Path (c) session switch — wired in Task 12 setActive handler.
 *  Evicts all sessions OTHER than the newly active one (preserves
 *  current session continuity, drops every previously cached session). */
export function evictOnSetActive(newActiveSessionId: string): void {
  for (const sid of [...cache.keys()]) {
    if (sid !== newActiveSessionId) cache.delete(sid);
  }
}

/** Path (d) panel disconnect — wired in Task 12 port.onDisconnect.
 *  Evicts only sessions tracked as in-flight on the disconnected port. */
export function evictByInFlightSet(sessionIds: Iterable<string>): void {
  for (const sid of sessionIds) cache.delete(sid);
}

export function _resetForTests(): void {
  cache.clear();
}

// ── Telemetry helpers (read-only) ───────────────────────────────────────────
export function _getCacheSizeBytes(sessionId: string): number {
  return (cache.get(sessionId) ?? []).reduce((s, r) => s + r.byteLength, 0);
}
export function _getCacheSessionCount(): number {
  return cache.size;
}
