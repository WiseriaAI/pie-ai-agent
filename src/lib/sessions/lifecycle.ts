/**
 * Session lifecycle operations — M2-U4.
 *
 * archive / unarchive / soft-delete / hard-delete / LRU eviction / expired sweep.
 *
 * All storage writes in this module go through `writeAtomic` directly, NOT
 * through `setSessionAgent` or `setSessionMeta`. This is the intentional
 * recursion-bypass: `setSessionAgent` has a pre-write quota guard that calls
 * `checkAndArchiveLRU` (this module). If archive logic called back through
 * `setSessionAgent`, it would recurse. Writing via `writeAtomic` directly is
 * the clean break.
 *
 * Archive transactionality (ADV-11 fix):
 *   1. Write `session_${id}_archived` key with merged payload.
 *   2. In the SAME atomic batch, set meta + agent keys to `undefined` (removes
 *      them). Single `chrome.storage.local.set` call = atomic.
 *   Idempotent: if the archived key already exists, we skip (no-op). On partial
 *   failure the archived key exists so unarchive can still recover.
 *
 * Archive-time redaction (SEC-PLAN-010):
 *   Active sessions keep raw `agentMessages` for LLM resume (R28 v2). On
 *   archive the task is done (status=failed|paused|active-but-LRU-evicted).
 *   The archived snapshot is for display-only recovery (unarchive path) so we
 *   could strip sensitive tool args here. However, the existing storage schema
 *   already holds raw agentMessages at rest for active sessions — the redaction
 *   boundary is at panel render time (`redactArgsForPanel`), not at rest. We
 *   maintain that invariant for consistency: archived data at the same
 *   sensitivity level as active data. A note is kept here for future policy
 *   tightening (e.g. strip raw args on archive when the BYOK key is rotated).
 */

import type { SessionMeta, SessionAgentState, SessionIndexEntry } from "./types";
import {
  writeAtomic,
  metaKey,
  agentKey,
  archivedKey,
  getSessionMeta,
  getSessionAgent,
  listSessionIndex,
  readIndexRaw,
  INDEX_KEY,
} from "./storage";

// Re-export INDEX_KEY usage via the private helper we expose
// (see storage.ts for readIndexRaw export added in M2-U4)

// ── Constants ─────────────────────────────────────────────────────────────────

/** Total storage budget. LRU eviction fires when bytes-in-use reaches this. */
const QUOTA_BYTES = 8 * 1024 * 1024; // 8 MB

/** Hard cap on sessions archived in one checkAndArchiveLRU call. */
const MAX_LRU_ARCHIVE_PER_CALL = 5;

/** 30 days in milliseconds. */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// ── Archive stored shape ──────────────────────────────────────────────────────
//
// `archivedAt` lives on `meta.archivedAt` (SessionMeta field). Storing it
// again at the top level was a 16-byte-per-archive redundancy that, for
// small sessions, made archived bundles grow larger than the meta+agent
// keys they replaced (testing-2 finding: net bytes +12 for empty session).
// hardDeleteExpired reads from `payload.meta.archivedAt`.

interface ArchivedSession {
  meta: SessionMeta;
  agent: SessionAgentState | null;
}

// ── archiveSession ────────────────────────────────────────────────────────────

/**
 * Migrate a session to the archived storage key.
 *
 * Idempotent — if `session_${id}_archived` already exists, returns early.
 * On completion:
 *   - `session_${id}_archived` holds merged meta + agent snapshot.
 *   - `session_${id}_meta` and `session_${id}_agent` are removed.
 *   - `session_index` entry status flips to `archived` + `archivedAt` set.
 *
 * `now` override is for deterministic tests.
 */
export async function archiveSession(
  id: string,
  opts: { now?: number } = {},
): Promise<void> {
  const now = opts.now ?? Date.now();

  // Idempotency check: already archived → no-op.
  const existing = await chrome.storage.local.get(archivedKey(id));
  if (existing[archivedKey(id)] != null) return;

  const meta = await getSessionMeta(id);
  if (!meta) return; // session doesn't exist — no-op

  const agent = await getSessionAgent(id);

  const archivedAt = meta.archivedAt ?? now;
  const archivedMeta: SessionMeta = { ...meta, status: "archived", archivedAt };

  const payload: ArchivedSession = {
    meta: archivedMeta,
    agent: agent,
  };

  // Read the index and update entry atomically.
  const indexRaw = await readIndexRaw();
  const updatedIndex = indexRaw.map((e) =>
    e.id === id ? { ...e, status: "archived" as const } : e,
  );

  // Single atomic batch: write archived key, remove meta + agent, update index.
  await writeAtomic({
    [archivedKey(id)]: payload,
    [metaKey(id)]: undefined,
    [agentKey(id)]: undefined,
    [INDEX_KEY]: updatedIndex,
  });
}

// ── unarchiveSession ──────────────────────────────────────────────────────────

/**
 * Reverse of archiveSession: read the archived key, split back to meta + agent,
 * remove the archived key, and flip the index status to `active`.
 *
 * No-op if the archived key doesn't exist.
 */
export async function unarchiveSession(id: string): Promise<void> {
  const result = await chrome.storage.local.get(archivedKey(id));
  const payload = result[archivedKey(id)] as ArchivedSession | undefined;
  if (!payload) return; // not archived — no-op

  const restoredMeta: SessionMeta = {
    ...payload.meta,
    status: "active",
    archivedAt: undefined,
    lastAccessedAt: Date.now(),
  };

  const indexRaw = await readIndexRaw();
  const updatedIndex = indexRaw.map((e) =>
    e.id === id
      ? {
          ...e,
          status: "active" as const,
          lastAccessedAt: restoredMeta.lastAccessedAt,
        }
      : e,
  );

  await writeAtomic({
    [metaKey(id)]: restoredMeta,
    [agentKey(id)]: payload.agent ?? {
      agentMessages: [],
      stepIndex: 0,
    },
    [archivedKey(id)]: undefined,
    [INDEX_KEY]: updatedIndex,
  });
}

// ── softDeleteSession ─────────────────────────────────────────────────────────

/**
 * Soft-delete a session: equivalent to archiveSession with archivedAt = now.
 * The session appears in the "Show archived" section (same queue as LRU
 * evictions) and will be hard-deleted after 30 days by `hardDeleteExpired`.
 *
 * Deviation from plan line 661 (which proposed a separate hide-deleted toggle):
 * soft-deleted sessions show in the same "archived" bucket as LRU-evicted ones.
 * The simpler model avoids a second toggle for identical lifecycle semantics.
 */
export async function softDeleteSession(
  id: string,
  opts: { now?: number } = {},
): Promise<void> {
  await archiveSession(id, opts);
}

// ── hardDeleteSession ─────────────────────────────────────────────────────────

/**
 * Immediately and permanently delete a session.
 * Removes the archived key (if present) and the index entry.
 * Also removes meta + agent keys in case the session was somehow not archived.
 */
export async function hardDeleteSession(id: string): Promise<void> {
  const indexRaw = await readIndexRaw();
  const updatedIndex = indexRaw.filter((e) => e.id !== id);

  await writeAtomic({
    [archivedKey(id)]: undefined,
    [metaKey(id)]: undefined,
    [agentKey(id)]: undefined,
    [INDEX_KEY]: updatedIndex,
  });
}

// ── hardDeleteExpired ─────────────────────────────────────────────────────────

/**
 * Sweep all archived sessions and hard-delete those archived > 30 days ago.
 * Called opportunistically on sidepanel mount (fire-and-forget, non-blocking).
 *
 * `now` override is for deterministic tests.
 *
 * Returns the count of sessions deleted.
 */
export async function hardDeleteExpired(
  now?: number,
): Promise<{ deleted: number }> {
  const cutoff = (now ?? Date.now()) - THIRTY_DAYS_MS;

  const indexRaw = await readIndexRaw();
  const archivedEntries = indexRaw.filter((e) => e.status === "archived");
  if (archivedEntries.length === 0) return { deleted: 0 };

  // Fetch all archived keys in one batch.
  const archiveKeys = archivedEntries.map((e) => archivedKey(e.id));
  const allArchived = await chrome.storage.local.get(archiveKeys);

  const toDelete: string[] = [];
  for (const entry of archivedEntries) {
    const payload = allArchived[archivedKey(entry.id)] as
      | ArchivedSession
      | undefined;
    // Malformed archive payloads (missing archivedAt on the embedded meta)
    // must NOT be treated as "very old" — that would silently hard-delete
    // corrupt entries on the next mount, bypassing the user-visible 30-day
    // grace window. Use MAX_SAFE_INTEGER so corrupt entries survive sweeps
    // and remain visible in 'Show Archived' for manual triage / Delete Forever.
    const archivedAt = payload?.meta?.archivedAt ?? Number.MAX_SAFE_INTEGER;
    if (archivedAt < cutoff) {
      toDelete.push(entry.id);
    }
  }

  if (toDelete.length === 0) return { deleted: 0 };

  // Build atomic batch: remove archived keys + meta + agent (belt-and-suspenders)
  // + update index.
  const updatedIndex = indexRaw.filter((e) => !toDelete.includes(e.id));
  const batch: Record<string, unknown> = { [INDEX_KEY]: updatedIndex };
  for (const id of toDelete) {
    batch[archivedKey(id)] = undefined;
    batch[metaKey(id)] = undefined;
    batch[agentKey(id)] = undefined;
  }

  await writeAtomic(batch);
  return { deleted: toDelete.length };
}

// ── checkAndArchiveLRU ────────────────────────────────────────────────────────

/**
 * Called by `setSessionAgent` when total storage is at or above the 8 MB
 * budget. Archives the oldest (by `lastAccessedAt`) non-archived sessions
 * until we're under budget or the MAX_LRU_ARCHIVE_PER_CALL cap is hit.
 *
 * Only archives sessions with status `active | paused | failed` — already-
 * archived sessions are already freed from meta + agent keys.
 *
 * `estimatedNewBytes` is used for the inner budget check (after each archive
 * operation we re-fetch `getBytesInUse`).
 *
 * Returns the count of sessions archived.
 */
export async function checkAndArchiveLRU(
  estimatedNewBytes: number,
): Promise<{ archived: number }> {
  let usedBytes = await chrome.storage.local.getBytesInUse(null);
  if (usedBytes + estimatedNewBytes < QUOTA_BYTES) return { archived: 0 };

  const index = await listSessionIndex();
  // Candidates: non-archived, sorted oldest-first.
  const candidates = index
    .filter((e): e is SessionIndexEntry =>
      e.status === "active" || e.status === "paused" || e.status === "failed",
    )
    .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

  let archived = 0;
  for (const entry of candidates) {
    if (archived >= MAX_LRU_ARCHIVE_PER_CALL) break;

    await archiveSession(entry.id);
    archived++;

    // Re-check bytes after each archive to stop as soon as we're under budget.
    usedBytes = await chrome.storage.local.getBytesInUse(null);
    if (usedBytes + estimatedNewBytes < QUOTA_BYTES) break;
  }

  return { archived };
}
