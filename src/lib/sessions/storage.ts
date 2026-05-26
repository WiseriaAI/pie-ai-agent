import type {
  SessionMeta,
  SessionAgentState,
  SessionIndexEntry,
  SessionStatus,
  PendingConfirmRecord,
} from "./types";
import type { ImageAttachment } from "@/lib/images";
import { getEffectivePinMode, clearTaskPinIfActive } from "./pin-state";
import { getMigrationMapping } from "@/lib/migration-v2";

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
  if (meta.pinnedTabs && meta.pinnedTabs.length > 0) {
    entry.pinnedTabIds = meta.pinnedTabs.map((p) => p.tabId);
  }
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
  /**
   * v1.5 — Native multi-pin option. Preferred over legacy fields.
   * Pinned tabs captured at session creation.
   *
   * Precedence: when both `pinnedTabs[]` and legacy `pinnedTabId`/
   * `pinnedOrigin` are provided, `pinnedTabs[]` wins; legacy is ignored.
   * When only one of `pinnedTabId`/`pinnedOrigin` is provided (without the
   * matching twin), both are silently dropped — partial legacy options are
   * not converted.
   */
  pinnedTabs?: Array<{ tabId: number; origin: string }>;
  /**
   * @deprecated v1.5 — Use `pinnedTabs[]` instead. Accepted here for
   * back-compat with existing test fixtures and pre-migration callers.
   * Internally converted to `pinnedTabs:[{tabId, origin}]` only when BOTH
   * `pinnedTabId` AND `pinnedOrigin` are present; otherwise silently dropped.
   * Never persisted as a legacy field directly — storage's dual-write shim
   * re-synthesizes legacy fields from `pinnedTabs[0]`.
   */
  pinnedTabId?: number;
  /**
   * @deprecated v1.5 — Use `pinnedTabs[]` instead. See `pinnedTabId` for
   * the both-required-or-dropped precedence rule.
   */
  pinnedOrigin?: string;
  /** M5 — Explicit pin mode. If omitted: defaults to 'user' when a pin
   *  is passed (back-compat for existing tests that use createSession to
   *  set up a pinned session as a fixture); defaults to 'auto' when no
   *  pin is passed. */
  pinMode?: "auto" | "task" | "user";
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

  // v1.5 — Resolve pinnedTabs[] from either the native option or legacy
  // back-compat fields. Legacy pinnedTabId+pinnedOrigin (both required) are
  // converted to a single-element array here and never persisted as legacy.
  const resolvedPinnedTabs: Array<{ tabId: number; origin: string }> =
    options.pinnedTabs ??
    (typeof options.pinnedTabId === "number" &&
    typeof options.pinnedOrigin === "string"
      ? [{ tabId: options.pinnedTabId, origin: options.pinnedOrigin }]
      : []);

  // M5 — pinMode default policy:
  //   - explicit options.pinMode wins
  //   - else if a pin is provided → 'user' (back-compat: existing tests pass a
  //     pin to set up a fixture; user is the right default since it persists
  //     and includes the session in the cross-session registry)
  //   - else → 'auto' (no pin)
  const pinMode: "auto" | "task" | "user" =
    options.pinMode ??
    (resolvedPinnedTabs.length > 0 ? "user" : "auto");

  const rawMeta: SessionMeta = {
    id,
    createdAt: now,
    lastAccessedAt: now,
    status: "active",
    messages: options.messages ?? [],
    pinMode,
    ...(pinMode !== "auto" && resolvedPinnedTabs.length > 0
      ? { pinnedTabs: resolvedPinnedTabs }
      : {}),
  };

  // I-1 — scrub ImageAttachment.data bytes before persisting, consistent
  // with setSessionMeta's R10 scrub. Today no caller passes ImageAttachments
  // to createSession, but the surface is open; this closes it defensively.
  const meta = scrubAttachmentBytes(rawMeta);

  const agent: SessionAgentState = {
    agentMessages: [],
    pendingInstructions: [],
    stepIndex: 0,
    hasImageContent: false,
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

// ── Lazy V1→V2 backfill ──────────────────────────────────────────────────────
//
// Pre-migration sessions have a legacy `provider` field (runtime-only, not in
// the static type) but no `instanceId`. On first access, look up the
// migration_v2_mapping and rewrite the stored meta with instanceId set and
// the legacy provider field removed. This is a structural rewrite — we do NOT
// bump lastAccessedAt to avoid polluting LRU ordering.
async function backfillInstanceId(meta: SessionMeta & { provider?: string }): Promise<SessionMeta> {
  if (meta.instanceId || !meta.provider) return meta;
  const mapping = await getMigrationMapping();
  const instanceId = mapping[meta.provider];
  if (!instanceId) return meta;
  const { provider: _drop, ...rest } = meta as SessionMeta & { provider?: string };
  void _drop;
  const next: SessionMeta = { ...rest, instanceId };
  // Persist the backfill so we don't keep doing it on subsequent reads.
  await chrome.storage.local.set({ [`session_${meta.id}_meta`]: next });
  return next;
}

export async function getSessionMeta(id: string): Promise<SessionMeta | null> {
  const result = await chrome.storage.local.get(metaKey(id));
  const raw = result[metaKey(id)] as (SessionMeta & { provider?: string }) | undefined;
  if (!raw) return null;
  return backfillInstanceId(raw);
}

// ── R10 storage scrub ────────────────────────────────────────────────────────
//
// `ImageAttachment.data` (base64 bytes) must never land in chrome.storage —
// the 8 MB quota would be exhausted by a handful of screenshots. Before
// persisting SessionMeta we strip `data` + `byteLength` from every
// ImageAttachment in `meta.messages`, replacing the entry with an
// ImagePlaceholder. The in-memory cache (image-cache.ts) holds the bytes for
// the lifetime of the session; hydrateAttachments re-inflates on resume if
// the session is still warm, or leaves the placeholder on a cold-start cache
// miss (the user sees a "session drifted" card, not a quota error).
function scrubAttachmentBytes(meta: SessionMeta): SessionMeta {
  if (!meta.messages?.length) return meta;
  let mutated = false;
  // Cast through unknown: DisplayMessage currently has no `attachments` field
  // in its static type, but Phase 5 may add one; this guard is defensive and
  // runtime-correct regardless of the static type shape.
  const scrubbed = (meta.messages as unknown[]).map((msg) => {
    const m = msg as Record<string, unknown>;
    const attachments = m["attachments"];
    if (!Array.isArray(attachments) || attachments.length === 0) return msg;
    const scrubbed = attachments.map((a) => {
      if ((a as ImageAttachment).kind !== "image") return a;
      const img = a as ImageAttachment;
      // Strip bytes → ImagePlaceholder. `data` and `byteLength` are omitted.
      const placeholder = {
        kind: "image_placeholder" as const,
        id: img.id,
        mediaType: img.mediaType,
        width: img.width,
        height: img.height,
      };
      mutated = true;
      return placeholder;
    });
    return { ...m, attachments: scrubbed };
  });
  if (!mutated) return meta;
  return { ...meta, messages: scrubbed as SessionMeta["messages"] };
}

/**
 * Persist session meta. If `status`, `pinnedTabIds`, `lastAccessedAt`, or
 * `title` differ from what's currently in the index, the index is updated
 * in the same atomic batch (D9). If the session is missing from the index
 * altogether (e.g. createSession was bypassed in a test) it is added.
 *
 * R10 — strips `ImageAttachment.data` bytes from `meta.messages` before
 * persisting. Bytes live in the in-memory image cache; placeholders survive
 * in storage so identity is preserved for warm-resume hydration.
 */
export async function setSessionMeta(meta: SessionMeta): Promise<void> {
  const scrubbedMeta = scrubAttachmentBytes(meta);
  const index = await readIndex();
  const nextEntry = indexEntryFromMeta(scrubbedMeta);
  const existingEntry = index.find((e) => e.id === scrubbedMeta.id);

  const indexChanged =
    !existingEntry ||
    existingEntry.lastAccessedAt !== nextEntry.lastAccessedAt ||
    existingEntry.status !== nextEntry.status ||
    existingEntry.title !== nextEntry.title ||
    JSON.stringify(existingEntry.pinnedTabIds) !== JSON.stringify(nextEntry.pinnedTabIds) ||
    existingEntry.messageCount !== nextEntry.messageCount;

  const batch: WriteBatch = { [metaKey(scrubbedMeta.id)]: scrubbedMeta };
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
    /**
     * v1.5 — Native multi-pin patch. Preferred over legacy fields.
     *
     * Precedence: when both `pinnedTabs[]` and legacy `pinnedTabId`/
     * `pinnedOrigin` are provided, `pinnedTabs[]` wins; legacy is ignored.
     * When only one of `pinnedTabId`/`pinnedOrigin` is provided (without the
     * matching twin), both are silently dropped — partial legacy patches are
     * not converted.
     */
    pinnedTabs?: Array<{ tabId: number; origin: string }>;
    /**
     * @deprecated v1.5 — Use `pinnedTabs[]` instead. Accepted here for
     * back-compat with existing callers. When both `pinnedTabId` AND
     * `pinnedOrigin` are provided, they are converted to a single-element
     * `pinnedTabs[]` entry; storage's dual-write shim then re-synthesizes
     * legacy fields from `pinnedTabs[0]` on persist. When only one is
     * provided, the pin patch is a silent no-op (partial legacy patch is
     * not supported).
     */
    pinnedTabId?: number;
    /**
     * @deprecated v1.5 — Use `pinnedTabs[]` instead. See `pinnedTabId` for
     * the both-required-or-dropped precedence rule.
     */
    pinnedOrigin?: string;
    /** M5 — explicit pin mode. When pinnedTabs is patched and non-empty without
     *  a pinMode, the effective mode defaults to 'user' (back-compat with M3
     *  first-message capture path; the new SW chat-start upgrade path passes
     *  'task' explicitly). */
    pinMode?: "auto" | "task" | "user";
  } = {},
): Promise<boolean> {
  const meta = await getSessionMeta(id);
  if (!meta) return false;

  // v1.5 — Resolve pinnedTabs from either native option or legacy back-compat.
  // Both pinnedTabId AND pinnedOrigin must be present for legacy conversion;
  // a partial legacy patch (only one field) is a no-op for the pin.
  const resolvedPinnedTabs: Array<{ tabId: number; origin: string }> | undefined =
    options.pinnedTabs ??
    (typeof options.pinnedTabId === "number" &&
    typeof options.pinnedOrigin === "string"
      ? [{ tabId: options.pinnedTabId, origin: options.pinnedOrigin }]
      : undefined);

  // M5 — if caller patches pin but doesn't pass pinMode, default to 'user'.
  const inferredPinMode =
    options.pinMode ??
    (resolvedPinnedTabs !== undefined && resolvedPinnedTabs.length > 0
      ? "user"
      : undefined);

  const updated: SessionMeta = {
    ...meta,
    lastAccessedAt: options.now ?? Date.now(),
    ...(options.status !== undefined ? { status: options.status } : {}),
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(inferredPinMode !== undefined ? { pinMode: inferredPinMode } : {}),
    ...(resolvedPinnedTabs !== undefined
      ? { pinnedTabs: resolvedPinnedTabs }
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
 * M5 — chat-start auto→task pin upgrade (SW-side authoritative).
 *
 * On every chat-start: if the session's effective pin mode is 'auto', read
 * the active tab via the provided capture function and upgrade the session
 * to 'task' mode with that tab as the captured pin. Idempotent — already
 * 'task' / 'user' modes return null without writing.
 *
 * The captureFn parameter is injected so the helper can be unit-tested
 * without dragging chrome.tabs into the storage module's import surface.
 * SW dispatcher passes a wrapper that calls
 * `chrome.tabs.query({active: true, currentWindow: true})` and parses
 * origin (with restricted-URL filter, mirroring useSession.captureActivePinned).
 *
 * Returns the captured pin object on upgrade, or null on no-op.
 */
export async function upgradeAutoToTaskAtChatStart(
  sessionId: string,
  captureFn: () => Promise<{ tabId: number; origin: string } | null>,
): Promise<{ tabId: number; origin: string } | null> {
  const meta = await getSessionMeta(sessionId);
  if (!meta) return null;
  const agent = await getSessionAgent(sessionId);
  const mode = getEffectivePinMode(meta, agent);
  if (mode !== "auto") return null;
  const pin = await captureFn();
  if (!pin) return null;
  await setSessionMeta({
    ...meta,
    pinMode: "task",
    pinnedTabs: [{ tabId: pin.tabId, origin: pin.origin }],
  });
  return pin;
}

/**
 * M5 — task-mode pin auto-unpin at task end.
 *
 * Called by runAgentLoop's emitDone (via ctx.onTaskDone) on every terminal
 * state. Idempotent — 'user' mode pins are preserved (`clearTaskPinIfActive`
 * is a no-op for them). Writes meta only when the helper actually mutated;
 * for 'auto' / 'user' / fresh sessions this is a no-op pair (one read, no write).
 *
 * Returns true when a pin was cleared, false when no change was needed.
 *
 * Errors are logged by the caller (emitDone wraps the call in .catch); the
 * fire-and-forget contract means emitDone proceeds regardless of failure.
 */
export async function clearTaskPinAtSessionEnd(
  sessionId: string,
): Promise<boolean> {
  const meta = await getSessionMeta(sessionId);
  if (!meta) return false;
  const cleared = clearTaskPinIfActive(meta);
  if (cleared === meta) return false;
  await setSessionMeta(cleared);
  return true;
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
 * task dispatch finally block so approve / reject / abort all
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
