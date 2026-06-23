/**
 * Session lifecycle operations — M2-U4.
 *
 * archive / unarchive / soft-delete / hard-delete / expired sweep.
 *
 * All storage reads/writes in this module go through the IndexedDB-backed
 * `storage.ts` helpers: `writeAtomic` for multi-key atomic batches and
 * `getSessionRecord` for reads. Writes go through `writeAtomic` directly, NOT
 * through `setSessionAgent` / `setSessionMeta`, so these helpers can build the
 * meta+agent+index single-transaction batches the archive/unarchive flows need.
 *
 * Archive transactionality (ADV-11 fix):
 *   1. Write `session_${id}_archived` key with merged payload.
 *   2. In the SAME atomic batch, set meta + agent keys to `undefined` (removes
 *      them). Single `writeAtomic` call = one IDB transaction = atomic.
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

import type { SessionMeta, SessionAgentState } from "./types";
import {
  writeAtomic,
  metaKey,
  agentKey,
  archivedKey,
  getSessionMeta,
  getSessionAgent,
  readIndexRaw,
  INDEX_KEY,
} from "./storage";
import { getSessionRecord } from "@/lib/idb/sessions-store";
import { deleteSessionArtifacts } from "@/lib/files/output-store";
import { deleteScratchpad } from "../scratchpad/store";

// Re-export INDEX_KEY usage via the private helper we expose
// (see storage.ts for readIndexRaw export added in M2-U4)

// ── Constants ─────────────────────────────────────────────────────────────────

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
  const existing = await getSessionRecord(archivedKey(id));
  if (existing != null) return;

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

  // output_file artifacts expire when the session is archived (their lifecycle
  // is tied to the live session). Best-effort: a failure here must not block
  // the archive itself.
  await deleteSessionArtifacts(id).catch(() => {});
  // NOTE (intentional asymmetry): the scratchpad is NOT deleted on archive.
  // Unlike output_file artifacts (tied to the live task), the scratchpad is
  // tied to the SESSION lifecycle — unarchiving must be able to resume on the
  // accumulated data. It is finally reclaimed by hardDeleteSession and the
  // 30-day hardDeleteExpired sweep. Do not "fix" this by deleting it here.
}

// ── unarchiveSession ──────────────────────────────────────────────────────────

/**
 * Reverse of archiveSession: read the archived key, split back to meta + agent,
 * remove the archived key, and flip the index status to `active`.
 *
 * No-op if the archived key doesn't exist.
 */
export async function unarchiveSession(id: string): Promise<void> {
  const payload = await getSessionRecord<ArchivedSession>(archivedKey(id));
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
      pendingInstructions: [],
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

// ── hardDeleteSessions (shared core) ─────────────────────────────────────────

/**
 * Hard-delete a set of sessions in ONE atomic batch (their :meta/:agent/:archived
 * keys + index update), then best-effort reclaim each session's output artifacts
 * and scratchpad out-of-band. Shared core for hardDeleteSession (single),
 * hardDeleteExpired (30-day sweep) and hardDeleteAllArchived (manual clear).
 */
export async function hardDeleteSessions(
  ids: string[],
): Promise<{ deleted: number }> {
  if (ids.length === 0) return { deleted: 0 };
  const idSet = new Set(ids);
  const indexRaw = await readIndexRaw();
  const updatedIndex = indexRaw.filter((e) => !idSet.has(e.id));

  const batch: Record<string, unknown> = { [INDEX_KEY]: updatedIndex };
  for (const id of ids) {
    batch[archivedKey(id)] = undefined;
    batch[metaKey(id)] = undefined;
    batch[agentKey(id)] = undefined;
  }
  await writeAtomic(batch);

  for (const id of ids) {
    await deleteSessionArtifacts(id).catch(() => {});
    await deleteScratchpad(id).catch(() => {});
  }
  return { deleted: ids.length };
}

// ── hardDeleteSession ─────────────────────────────────────────────────────────

/**
 * Immediately and permanently delete a single session (thin wrapper over
 * hardDeleteSessions).
 */
export async function hardDeleteSession(id: string): Promise<void> {
  await hardDeleteSessions([id]);
}

// ── hardDeleteAllArchived ─────────────────────────────────────────────────────

/**
 * Permanently delete EVERY archived session (the "clear all archived" action).
 * Returns the count deleted.
 */
export async function hardDeleteAllArchived(): Promise<{ deleted: number }> {
  const indexRaw = await readIndexRaw();
  const ids = indexRaw.filter((e) => e.status === "archived").map((e) => e.id);
  return hardDeleteSessions(ids);
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

  // Fetch all archived records.
  const allArchived: Record<string, ArchivedSession | undefined> = {};
  for (const e of archivedEntries) {
    allArchived[archivedKey(e.id)] = await getSessionRecord<ArchivedSession>(
      archivedKey(e.id),
    );
  }

  const toDelete: string[] = [];
  for (const entry of archivedEntries) {
    const payload = allArchived[archivedKey(entry.id)];
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
  return hardDeleteSessions(toDelete);
}
