import type {
  SessionMeta,
  SessionAgentState,
  SessionIndexEntry,
  SessionStatus,
  PendingConfirmRecord,
} from "./types";

// ── Key shape ────────────────────────────────────────────────────────────────
//
// One `session_index` singleton + per-session `session_${id}_meta` and
// `session_${id}_agent`. The split (D2) keeps panel-facing meta writes
// independent of SW-facing agent-state writes so they don't race each other.
// `session_index` is what `listSessionIndex` reads — without it, the drawer
// would have to `get(null)` the entire storage namespace (provider keys,
// skill keys, encryption_key, etc.) on every render.

export const INDEX_KEY = "session_index";

// ── Atomic write helper ─────────────────────────────────────────────────────
//
// All multi-key writes flow through this so the D9 single-call atomicity
// invariant is enforced in one place. `chrome.storage.local.set({...})` with
// multiple keys is the platform's atomic-batch primitive (all or nothing on
// the single quota check / change notification). Setting a key to
// `undefined` removes it — emulated by the test harness too.
//
// Exported for `lifecycle.ts` so it can write directly (bypassing the
// pre-write quota guard in `setSessionAgent`) without a skipQuotaGuard
// flag leaking into the public API.
export type WriteBatch = Record<string, unknown>;

export async function writeAtomic(batch: WriteBatch): Promise<void> {
  await chrome.storage.local.set(batch);
}

// ── Key helpers (exported for lifecycle.ts) ──────────────────────────────────
export function metaKey(id: string): string {
  return `session_${id}_meta`;
}

export function agentKey(id: string): string {
  return `session_${id}_agent`;
}

export function archivedKey(id: string): string {
  return `session_${id}_archived`;
}

// ── Index helpers ───────────────────────────────────────────────────────────

async function readIndex(): Promise<SessionIndexEntry[]> {
  const result = await chrome.storage.local.get(INDEX_KEY);
  const raw = result[INDEX_KEY];
  if (!Array.isArray(raw)) return [];
  // Defensive: drop entries missing required fields so a corrupt index
  // doesn't break the entire session list.
  return raw.filter(
    (e): e is SessionIndexEntry =>
      e !== null &&
      typeof e === "object" &&
      typeof (e as SessionIndexEntry).id === "string" &&
      typeof (e as SessionIndexEntry).lastAccessedAt === "number" &&
      typeof (e as SessionIndexEntry).status === "string",
  );
}

/**
 * Read the raw session index (including archived entries) without filtering.
 * Exported for `lifecycle.ts` which needs to iterate ALL entries including
 * archived ones (for hardDeleteExpired, checkAndArchiveLRU, etc.).
 * Returns an empty array if the index doesn't exist or isn't an array.
 */
export async function readIndexRaw(): Promise<SessionIndexEntry[]> {
  const result = await chrome.storage.local.get(INDEX_KEY);
  const raw = result[INDEX_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is SessionIndexEntry =>
      e !== null &&
      typeof e === "object" &&
      typeof (e as SessionIndexEntry).id === "string" &&
      typeof (e as SessionIndexEntry).lastAccessedAt === "number" &&
      typeof (e as SessionIndexEntry).status === "string",
  );
}

function indexEntryFromMeta(meta: SessionMeta): SessionIndexEntry {
  const entry: SessionIndexEntry = {
    id: meta.id,
    lastAccessedAt: meta.lastAccessedAt,
    status: meta.status,
    messageCount: meta.messages.length,
  };
  if (meta.title !== undefined) entry.title = meta.title;
  if (meta.pinnedTabId !== undefined) entry.pinnedTabId = meta.pinnedTabId;
  return entry;
}

function upsertIndexEntry(
  entries: SessionIndexEntry[],
  next: SessionIndexEntry,
): SessionIndexEntry[] {
  const without = entries.filter((e) => e.id !== next.id);
  return [...without, next];
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface CreateSessionOptions {
  /** Pinned tab captured at session creation (M3-U2). M1 callers omit. */
  pinnedTabId?: number;
  pinnedOrigin?: string;
  /** Initial messages, e.g. for migration scenarios. M1 callers omit. */
  messages?: SessionMeta["messages"];
  /** Override clock for tests. Defaults to Date.now(). */
  now?: number;
}

/**
 * Create a new session. Writes meta + agent + updated index in a single
 * atomic batch (D9). Returns the created `SessionMeta`.
 *
 * ID is `crypto.randomUUID()` (no prefix, no `default` — PRD-3 fix).
 */
export async function createSession(
  options: CreateSessionOptions = {},
): Promise<SessionMeta> {
  const id = crypto.randomUUID();
  const now = options.now ?? Date.now();

  const meta: SessionMeta = {
    id,
    createdAt: now,
    lastAccessedAt: now,
    status: "active",
    messages: options.messages ?? [],
    ...(options.pinnedTabId !== undefined
      ? { pinnedTabId: options.pinnedTabId }
      : {}),
    ...(options.pinnedOrigin !== undefined
      ? { pinnedOrigin: options.pinnedOrigin }
      : {}),
  };

  const agent: SessionAgentState = {
    agentMessages: [],
    stepIndex: 0,
    skillExecutionScopeStack: [],
  };

  const index = await readIndex();
  const updatedIndex = upsertIndexEntry(index, indexEntryFromMeta(meta));

  await writeAtomic({
    [metaKey(id)]: meta,
    [agentKey(id)]: agent,
    [INDEX_KEY]: updatedIndex,
  });

  return meta;
}

export async function getSessionMeta(id: string): Promise<SessionMeta | null> {
  const result = await chrome.storage.local.get(metaKey(id));
  const raw = result[metaKey(id)] as SessionMeta | undefined;
  return raw ?? null;
}

/**
 * Persist session meta. If `status`, `pinnedTabId`, `lastAccessedAt`, or
 * `title` differ from what's currently in the index, the index is updated
 * in the same atomic batch (D9). If the session is missing from the index
 * altogether (e.g. createSession was bypassed in a test) it is added.
 */
export async function setSessionMeta(meta: SessionMeta): Promise<void> {
  const index = await readIndex();
  const nextEntry = indexEntryFromMeta(meta);
  const existingEntry = index.find((e) => e.id === meta.id);

  const indexChanged =
    !existingEntry ||
    existingEntry.lastAccessedAt !== nextEntry.lastAccessedAt ||
    existingEntry.status !== nextEntry.status ||
    existingEntry.title !== nextEntry.title ||
    existingEntry.pinnedTabId !== nextEntry.pinnedTabId ||
    existingEntry.messageCount !== nextEntry.messageCount;

  const batch: WriteBatch = { [metaKey(meta.id)]: meta };
  if (indexChanged) {
    batch[INDEX_KEY] = upsertIndexEntry(index, nextEntry);
  }
  await writeAtomic(batch);
}

export async function getSessionAgent(
  id: string,
): Promise<SessionAgentState | null> {
  const result = await chrome.storage.local.get(agentKey(id));
  const raw = result[agentKey(id)] as SessionAgentState | undefined;
  return raw ?? null;
}

// ── Pre-write quota guard ─────────────────────────────────────────────────────
//
// `checkAndArchiveLRU` lives in `lifecycle.ts` to avoid coupling storage.ts to
// archive logic. We import it lazily (dynamic import) inside `setSessionAgent`
// so there's no circular-module dependency at module load time.
//
// `lifecycle.ts` writes via `writeAtomic` directly (not via `setSessionAgent`),
// which naturally bypasses this guard — no `skipQuotaGuard` flag needed.
const QUOTA_GUARD_BYTES = 8 * 1024 * 1024; // 8 MB

/**
 * Persist agent state. Does NOT touch the index — agent writes are the
 * hottest path (every step) and the index does not carry any agent-side
 * fields.
 *
 * M2-U4: before writing, checks total storage usage. If already at or above
 * the 8 MB budget, triggers `checkAndArchiveLRU` to free space (archive the
 * oldest non-archived sessions). The guard is NOT recursive — lifecycle.ts
 * writes via `writeAtomic` directly, bypassing this function.
 */
export async function setSessionAgent(
  id: string,
  state: SessionAgentState,
): Promise<void> {
  // Pre-write quota guard (D6 / M2-U4). Lazy import avoids circular dependency.
  const used = await chrome.storage.local.getBytesInUse(null);
  if (used >= QUOTA_GUARD_BYTES) {
    // Estimate new bytes: conservatively use JSON length of the agent state.
    const estimatedNewBytes = JSON.stringify(state).length;
    const { checkAndArchiveLRU } = await import("./lifecycle");
    await checkAndArchiveLRU(estimatedNewBytes);
  }
  await writeAtomic({ [agentKey(id)]: state });
}

/**
 * List sessions in `lastAccessedAt` desc order. Reads only the single
 * `session_index` key — does not touch per-session meta/agent storage.
 */
export async function listSessionIndex(): Promise<SessionIndexEntry[]> {
  const entries = await readIndex();
  return entries.slice().sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
}

/**
 * Bump `lastAccessedAt` (and optionally other index-tracked fields) on a
 * session, writing both the per-session meta and the index in a single
 * atomic batch.
 *
 * Returns false if the session does not exist (no-op).
 */
export async function updateLastAccessed(
  id: string,
  options: {
    now?: number;
    status?: SessionStatus;
    title?: string;
    pinnedTabId?: number;
  } = {},
): Promise<boolean> {
  const meta = await getSessionMeta(id);
  if (!meta) return false;

  const updated: SessionMeta = {
    ...meta,
    lastAccessedAt: options.now ?? Date.now(),
    ...(options.status !== undefined ? { status: options.status } : {}),
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.pinnedTabId !== undefined
      ? { pinnedTabId: options.pinnedTabId }
      : {}),
  };

  await setSessionMeta(updated);
  return true;
}

/**
 * Remove a session entirely — meta + agent + index entry — in one atomic
 * batch. M2-U4's archive flow uses this after copying state to the
 * archive key; M1 callers can use this for hard delete in tests.
 */
export async function removeSession(id: string): Promise<void> {
  const index = await readIndex();
  const updatedIndex = index.filter((e) => e.id !== id);
  await writeAtomic({
    [metaKey(id)]: undefined,
    [agentKey(id)]: undefined,
    [INDEX_KEY]: updatedIndex,
  });
}

/**
 * M1-U5 — mark a session as `paused`. Used by `detectAndMarkPaused`
 * (cold-start) when an in-flight task (`stepIndex > 0`) is found
 * after SW restart.
 *
 * Goes through `setSessionMeta` so the `session_index` is updated
 * atomically (D9). Does NOT bump `lastAccessedAt` — that would
 * pollute LRU ordering with cold-start churn.
 *
 * Returns `false` if the session does not exist.
 */
export async function markPaused(id: string): Promise<boolean> {
  const meta = await getSessionMeta(id);
  if (!meta) return false;
  if (meta.status === "paused") return true;
  await setSessionMeta({ ...meta, status: "paused" });
  return true;
}

/**
 * M1-U5 — mark a session as `failed`. Used when a session has a
 * `pendingConfirm` record across SW restart (resolver dead, can't
 * resume) or when the user clicks 'Discard' on an R11 drift card.
 *
 * Same atomicity / no-LRU-bump rules as `markPaused`.
 */
export async function markFailed(id: string): Promise<boolean> {
  const meta = await getSessionMeta(id);
  if (!meta) return false;
  if (meta.status === "failed") return true;
  await setSessionMeta({ ...meta, status: "failed" });
  return true;
}

/**
 * M1-U5 — combined helper for the cold-start path: mark a session as
 * failed AND scrub its pendingConfirm. Order matters (see
 * `detectAndMarkPaused`'s JSDoc): we mark first so the panel never
 * observes a state where `status='active'` but pendingConfirm is gone.
 */
export async function markFailedAndScrub(id: string): Promise<boolean> {
  const ok = await markFailed(id);
  if (ok) await scrubPendingConfirm(id);
  return ok;
}

/**
 * M1-U4 — set the pendingConfirm slot on a session's agent state.
 * Called by the SW BEFORE pushing a confirm request to the panel so a
 * panel re-mount that lands during the confirm window can recover. The
 * payload is RAW (raw `args.text` for keyboard tools, raw `args` in
 * general) — Phase 2.5 binary channel: confirm cards need raw to give
 * the user an informed approval. Storage trust face is identical to
 * Phase 1 chat content (K9), and the record is short-lived.
 *
 * Idempotent: if the session does not exist, this is a no-op
 * (rather than creating an orphan agent record). Caller is expected
 * to have already created the session via the chat flow.
 *
 * Atomicity: writes only the agent key; meta + index untouched (D2).
 */
export async function setPendingConfirm(
  sessionId: string,
  record: PendingConfirmRecord,
): Promise<void> {
  const current = await getSessionAgent(sessionId);
  if (!current) return;
  await setSessionAgent(sessionId, { ...current, pendingConfirm: record });
}

/**
 * M1-U4 — scrub the pendingConfirm slot. Called from the SW's
 * `sendConfirmRequest` finally block so approve / reject / abort all
 * converge on the same cleanup. Idempotent: re-scrubbing an already-
 * empty slot is fine.
 *
 * Failure here is non-fatal — M1-U5's `R10(session-resume)` cold-start
 * cleanup unconditionally clears any pendingConfirm field on SW
 * startup, so a missed scrub does not leak across SW lifetimes.
 */
export async function scrubPendingConfirm(sessionId: string): Promise<void> {
  const current = await getSessionAgent(sessionId);
  if (!current || current.pendingConfirm == null) return;
  // Build a copy without the field — explicit removal so the storage
  // value doesn't keep `pendingConfirm: undefined` (which serializes
  // identically but is awkward to assert against in tests).
  const { pendingConfirm: _drop, ...rest } = current;
  void _drop;
  await setSessionAgent(sessionId, rest);
}

// ── U3 — lastTaskSynth helpers ────────────────────────────────────────────────
//
// AD1 fix: lastTaskSynth was previously stored on SessionMeta, which caused a
// lost-update race — both `emitDone` (via setLastTaskSynth) and the panel's
// `persistMessages` perform read-modify-write on `session_${id}_meta`, and
// the concurrent writes at the chat-done boundary could silently clobber each
// other's changes.
//
// The field is now stored on SessionAgentState (`session_${id}_agent`), which
// is SW-only — no panel writer ever touches this key except for reading on
// resume. `emitDone` folds lastTaskSynth directly into the tombstone write
// (single atomic write, no race). `handleChatStream` reads from agent state
// and clears it via `clearLastTaskSynth` at chat-start.
//
// NOTE: `setLastTaskSynth` is kept as a standalone helper for testing and
// for any future caller that needs to set lastTaskSynth independently from
// the tombstone write. `emitDone` in loop.ts no longer calls this directly —
// it folds the synth into `buildSessionAgentTombstone(synth)` instead.

/**
 * Write the synthesized assistant turn text into the session's **agent
 * state** `lastTaskSynth` field. The value must already be wrapped in
 * `<untrusted_prior_task_summary>…</untrusted_prior_task_summary>`.
 *
 * AD1 fix: was previously a read-modify-write on the meta key (races with
 * panel's persistMessages). Now writes agent key only — SW-only, no panel
 * writer, no race.
 *
 * No-op if the session does not exist.
 */
export async function setLastTaskSynth(
  sessionId: string,
  synth: string,
): Promise<void> {
  const agent = await getSessionAgent(sessionId);
  if (!agent) return;
  await setSessionAgent(sessionId, { ...agent, lastTaskSynth: synth });
}

/**
 * Clear the `lastTaskSynth` field on a session's **agent state** (one-shot
 * consume). Called by `handleChatStream` immediately after reading the value
 * so it is never injected into a second chat's history.
 *
 * No-op if the session does not exist or `lastTaskSynth` is already absent.
 */
export async function clearLastTaskSynth(sessionId: string): Promise<void> {
  const agent = await getSessionAgent(sessionId);
  if (!agent || agent.lastTaskSynth == null) return;
  const { lastTaskSynth: _drop, ...rest } = agent;
  void _drop;
  await setSessionAgent(sessionId, rest);
}

/**
 * AD1 migration — idempotent one-shot: if the session meta still carries a
 * stale `lastTaskSynth` field from before the AD1 fix, move it to the agent
 * state and strip it from meta. Safe to call multiple times.
 *
 * Called by `handleChatStream` at chat-start (awaited, not fire-and-forget),
 * so the migrated value is available for the synth-injection read that
 * immediately follows.
 *
 * Returns `true` if a migration was performed, `false` otherwise.
 */
export async function migrateLastTaskSynthFromMeta(
  sessionId: string,
): Promise<boolean> {
  const meta = await getSessionMeta(sessionId);
  // Cast to access the pre-AD1 field that no longer exists in the type.
  const staleSynth = (meta as Record<string, unknown> | null)?.["lastTaskSynth"] as string | undefined;
  if (!staleSynth) return false;

  const agent = await getSessionAgent(sessionId);
  if (!agent) return false;

  // Move synth to agent state, strip from meta — single atomic batch (D9).
  const { lastTaskSynth: _drop, ...metaRest } = meta as typeof meta & { lastTaskSynth?: string };
  void _drop;
  await writeAtomic({
    [metaKey(sessionId)]: metaRest,
    [agentKey(sessionId)]: { ...agent, lastTaskSynth: staleSynth },
  });
  return true;
}

/**
 * Total bytes currently used in chrome.storage.local — across ALL keys,
 * not just session_*. D6 quota guards care about overall storage
 * pressure (provider configs, skill defs, encryption_key, etc. all
 * compete for the same 10 MB MV3 budget).
 *
 * Uses `getBytesInUse(null)` per plan D6 — real value, not the
 * JSON.stringify approximation that `skill/storage.ts:getSkillStorageBytes`
 * applies to its own subset.
 */
export async function getTotalBytes(): Promise<number> {
  return chrome.storage.local.getBytesInUse(null);
}

// ── SEC-PLAN-009 — pending confirm flood protection ───────────────────────────
//
// When ≥ PENDING_CONFIRM_FLOOD_LIMIT sessions simultaneously have a live
// `pendingConfirm`, a runaway agent loop is the most likely cause. The SW
// uses `isPendingConfirmFloodLimited` to detect this and auto-reject the
// N+1th confirm rather than silently queueing an unbounded number of
// blocking confirm dialogs. This protects BYOK users from runaway spending
// (informed-approval invariant K-1) and prevents unbounded storage growth
// (D6). Limit = 5 (experimentally generous enough for multi-tab workflows
// while still catching runaway loops).

export const PENDING_CONFIRM_FLOOD_LIMIT = 5;

/**
 * Count the number of sessions that currently have a live `pendingConfirm`
 * in their agent state. Reads ALL `session_*_agent` keys from storage.
 *
 * Uses `chrome.storage.local.get(null)` to get all keys in one call, then
 * filters for the `session_*_agent` key pattern. This is deliberately
 * full-scan because (a) the index doesn't carry pendingConfirm, and
 * (b) this is called only in the hot confirm path, not on every tick.
 */
export async function getPendingConfirmCount(): Promise<number> {
  const all = await chrome.storage.local.get(null);
  let count = 0;
  for (const [key, value] of Object.entries(all)) {
    if (!key.endsWith("_agent")) continue;
    // Key shape: `session_${id}_agent`
    if (!key.startsWith("session_")) continue;
    const agentState = value as SessionAgentState | null | undefined;
    // P1-10 — only count agent-tool confirms toward the flood limit.
    // Drift-card pendingConfirm (kind='pinned-tab-drift') is written by
    // handleResumeRequest and persists as long as a session is paused-with-
    // drift (status='paused'). Cold-start scrub skips paused sessions, so
    // after ~6 Resume+drift cycles getPendingConfirmCount would return >5
    // forever, permanently DoSing every confirm in every session.
    // Fix (c): filter on kind='agent-tool' — only live agent-tool confirms
    // should count toward D6 storage pressure / SEC-PLAN-009 flood limit.
    if (agentState?.pendingConfirm?.kind === "agent-tool") {
      count++;
    }
  }
  return count;
}

/**
 * Returns `true` when the number of sessions with a live `pendingConfirm`
 * exceeds PENDING_CONFIRM_FLOOD_LIMIT. The SW should auto-reject the next
 * confirm and emit a toast warning to the panel.
 */
export async function isPendingConfirmFloodLimited(): Promise<boolean> {
  const count = await getPendingConfirmCount();
  return count > PENDING_CONFIRM_FLOOD_LIMIT;
}
