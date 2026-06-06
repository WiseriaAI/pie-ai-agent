// src/background/output-cache.ts
// In-memory file artifact cache for the output_file tool. Mirrors
// image-cache.ts: per-session, LRU on a byte budget + count cap, evicted on
// task end / SW restart / session switch / panel disconnect. NOT persisted —
// SW idle/restart drops everything (spec §2: task/SW-lifetime only).

export interface FileArtifact {
  id: string;
  sessionId: string;
  filename: string; // already sanitized "pie/…"
  mime: string;
  content: string;
  byteLength: number;
  addedAt: number;
}

const SESSION_BYTE_BUDGET = 10 * 1024 * 1024; // 10 MB/session
const SESSION_COUNT_BUDGET = 20;              // ≤20 artifacts/session

const cache = new Map<string, FileArtifact[]>();

export function addArtifact(sessionId: string, a: FileArtifact): void {
  const list = cache.get(sessionId) ?? [];
  list.push(a);
  cache.set(sessionId, list);
  enforceLRU(sessionId);
}

/**
 * Returns the cached artifact by (sessionId, id), or undefined. The returned
 * `FileArtifact` is treated as immutable — callers must not mutate its fields
 * (same contract as image-cache.ts getImages); the cache holds the live object.
 */
export function getArtifact(sessionId: string, id: string): FileArtifact | undefined {
  return (cache.get(sessionId) ?? []).find((a) => a.id === id);
}

/** Drop oldest artifacts (smallest addedAt) until both bounds satisfied. */
function enforceLRU(sessionId: string): void {
  const list = cache.get(sessionId);
  if (!list) return;
  while (list.length > 0) {
    const totalBytes = list.reduce((s, a) => s + a.byteLength, 0);
    if (totalBytes <= SESSION_BYTE_BUDGET && list.length <= SESSION_COUNT_BUDGET) break;
    let oldestIdx = 0;
    for (let i = 1; i < list.length; i++) if (list[i].addedAt < list[oldestIdx].addedAt) oldestIdx = i;
    list.splice(oldestIdx, 1);
  }
  if (list.length === 0) cache.delete(sessionId);
}

// ── evict API (mirrors image-cache 4-path) ──────────────────────────────────
export function evictSession(sessionId: string): void { cache.delete(sessionId); }
export function evictAllOnSWStartup(): void { cache.clear(); }
export function evictOnSetActive(newActiveSessionId: string): void {
  for (const sid of [...cache.keys()]) if (sid !== newActiveSessionId) cache.delete(sid);
}
export function evictByInFlightSet(sessionIds: Iterable<string>): void {
  for (const sid of sessionIds) cache.delete(sid);
}

export function _resetForTests(): void { cache.clear(); }
export function _getCacheSessionCount(): number { return cache.size; }
