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

const INDEX_KEY = "session_index";

function metaKey(id: string): string {
  return `session_${id}_meta`;
}

function agentKey(id: string): string {
  return `session_${id}_agent`;
}

// ── Atomic write helper ─────────────────────────────────────────────────────
//
// All multi-key writes flow through this so the D9 single-call atomicity
// invariant is enforced in one place. `chrome.storage.local.set({...})` with
// multiple keys is the platform's atomic-batch primitive (all or nothing on
// the single quota check / change notification). Setting a key to
// `undefined` removes it — emulated by the test harness too.
type WriteBatch = Record<string, unknown>;

async function writeAtomic(batch: WriteBatch): Promise<void> {
  await chrome.storage.local.set(batch);
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

function indexEntryFromMeta(meta: SessionMeta): SessionIndexEntry {
  const entry: SessionIndexEntry = {
    id: meta.id,
    lastAccessedAt: meta.lastAccessedAt,
    status: meta.status,
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
    existingEntry.pinnedTabId !== nextEntry.pinnedTabId;

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

/**
 * Persist agent state. Does NOT touch the index — agent writes are the
 * hottest path (every step) and the index does not carry any agent-side
 * fields. M2-U1 will add `lastAccessedAt` bumping here as a separate step.
 */
export async function setSessionAgent(
  id: string,
  state: SessionAgentState,
): Promise<void> {
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
