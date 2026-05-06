/**
 * Session storage migrations.
 *
 * M2-U1: Scan for 'default' id residue left by early M1 development and
 * either rename (if content exists) or drop (if empty). Idempotent —
 * second and subsequent calls are no-ops when there are no residue keys.
 *
 * Must be called BEFORE `detectAndMarkPaused` on every SW startup so the
 * cold-start scan operates on a clean namespace with UUID-only ids. The
 * SW index.ts wires this in sequence.
 */

import type { SessionMeta, SessionAgentState, SessionIndexEntry } from "./types";

const INDEX_KEY = "session_index";
const DEFAULT_META_KEY = "session_default_meta";
const DEFAULT_AGENT_KEY = "session_default_agent";

/** Key helpers (private — matches storage.ts shape) */
function metaKey(id: string) {
  return `session_${id}_meta`;
}
function agentKey(id: string) {
  return `session_${id}_agent`;
}

/**
 * Idempotent startup migration.
 *
 * - If `session_default_meta` / `session_default_agent` exist AND have
 *   non-empty content: rename to a new `crypto.randomUUID()` id in a
 *   single atomic batch.
 * - If they exist but are empty: delete without creating a new session.
 * - If they don't exist: no-op, return `{cleared: []}`.
 *
 * Returns the list of old key names that were cleared.
 */
export async function runSessionMigrations(): Promise<{ cleared: string[] }> {
  const raw = await chrome.storage.local.get([
    DEFAULT_META_KEY,
    DEFAULT_AGENT_KEY,
    INDEX_KEY,
  ]);

  const hasMeta = DEFAULT_META_KEY in raw;
  const hasAgent = DEFAULT_AGENT_KEY in raw;

  if (!hasMeta && !hasAgent) {
    // Nothing to migrate.
    return { cleared: [] };
  }

  const cleared: string[] = [];
  if (hasMeta) cleared.push(DEFAULT_META_KEY);
  if (hasAgent) cleared.push(DEFAULT_AGENT_KEY);

  const rawMeta = raw[DEFAULT_META_KEY] as SessionMeta | undefined;
  const rawAgent = raw[DEFAULT_AGENT_KEY] as SessionAgentState | undefined;

  const existingIndex: SessionIndexEntry[] = Array.isArray(raw[INDEX_KEY])
    ? (raw[INDEX_KEY] as SessionIndexEntry[]).filter(
        (e): e is SessionIndexEntry =>
          e !== null &&
          typeof e === "object" &&
          typeof (e as SessionIndexEntry).id === "string",
      )
    : [];

  // Drop the 'default' entry from the index regardless of path.
  const indexWithoutDefault = existingIndex.filter((e) => e.id !== "default");

  // Decide: is there meaningful content to preserve?
  const hasMessages = Array.isArray(rawMeta?.messages) && rawMeta!.messages.length > 0;
  const hasAgentHistory =
    Array.isArray(rawAgent?.agentMessages) && rawAgent!.agentMessages.length > 0;
  const hasStepProgress = typeof rawAgent?.stepIndex === "number" && rawAgent.stepIndex > 0;

  const isEmpty = !hasMessages && !hasAgentHistory && !hasStepProgress;

  if (isEmpty) {
    // Empty session — just delete old keys and remove from index.
    const batch: Record<string, unknown> = {
      [DEFAULT_META_KEY]: undefined,
      [DEFAULT_AGENT_KEY]: undefined,
      [INDEX_KEY]: indexWithoutDefault,
    };
    await chrome.storage.local.set(batch);
    return { cleared };
  }

  // Non-empty: rename to a fresh UUID.
  const newId = crypto.randomUUID();

  // Rewrite meta with the new id.
  const newMeta: SessionMeta = {
    ...(rawMeta as SessionMeta),
    id: newId,
  };

  // Agent state has no id field — just copy.
  const newAgent: SessionAgentState = {
    agentMessages: rawAgent?.agentMessages ?? [],
    stepIndex: rawAgent?.stepIndex ?? 0,
    hasImageContent: rawAgent?.hasImageContent ?? false,
    ...(rawAgent?.pendingConfirm != null
      ? { pendingConfirm: rawAgent.pendingConfirm }
      : {}),
  };

  // Build new index entry from the renamed meta.
  const newIndexEntry: SessionIndexEntry = {
    id: newId,
    lastAccessedAt: newMeta.lastAccessedAt,
    status: newMeta.status,
    ...(newMeta.title !== undefined ? { title: newMeta.title } : {}),
    ...(newMeta.pinnedTabs && newMeta.pinnedTabs.length > 0
      ? { pinnedTabIds: newMeta.pinnedTabs.map((p) => p.tabId) }
      : {}),
  };

  const updatedIndex: SessionIndexEntry[] = [
    ...indexWithoutDefault,
    newIndexEntry,
  ];

  // Single atomic batch: write new keys, delete old keys, update index.
  const batch: Record<string, unknown> = {
    [metaKey(newId)]: newMeta,
    [agentKey(newId)]: newAgent,
    [DEFAULT_META_KEY]: undefined,
    [DEFAULT_AGENT_KEY]: undefined,
    [INDEX_KEY]: updatedIndex,
  };
  await chrome.storage.local.set(batch);

  return { cleared };
}
