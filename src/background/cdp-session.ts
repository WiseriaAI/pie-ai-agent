// Phase 2.5 — CdpSession lifecycle manager.
//
// Encapsulates chrome.debugger attach/send/detach so tool handlers don't
// touch chrome.debugger directly. Provides:
//
//   - Per-task lazy attach (first acquire attaches; subsequent acquires by
//     same owner reuse the live session)
//   - Idempotent detach across 5 paths: explicit caller, abort signal
//     listener, chrome.debugger.onDetach (yellow bar cancel), storage
//     kill switch, finally cleanup. All converge here.
//   - Owner-token guard against multi-Side-Panel collateral detach
//     (Phase 2 has no cross-port serial lock; two windows can run agents
//     concurrently). Same tabId across different owners → fail-fast.
//   - Attach race guard: if abort signal fires during the attach
//     roundtrip, detach immediately and reject (otherwise the listener
//     registered after attach resolves never tears down the session).
//   - Monotonic generationId on every successful attach, so stale
//     onDetach events from a previous session can't kill a fresh one
//     even if delivery is delayed past sessionMap.delete.
//
// Spec: docs/plans/2026-04-28-001-feat-phase2.5-cdp-keyboard-simulation-plan.md

const PROTOCOL_VERSION = "1.3";

export type DetachReason =
  | "user-cancelled-via-yellow-bar"
  | "abort-signal"
  | "tab-closed"
  | "kill-switch"
  | "explicit-detach"
  | "race-guard";

export class CdpAttachError extends Error {
  constructor(
    message: string,
    readonly kind: "conflict" | "race" | "other",
  ) {
    super(message);
    this.name = "CdpAttachError";
  }
}

/**
 * M3-U3 — owner token shape upgrade.
 *
 * Pre-M3 owner-token was an opaque crypto.randomUUID() string per
 * runAgentLoop call; it gated multi-Side-Panel collateral detach but
 * couldn't say *which session* owned the attach. M3-U3 makes it a
 * structured `{sessionId, tabId}` so:
 *
 *   - Cross-session conflict messages can name the offending session.
 *   - The 5-path detach (explicit / abort / onDetach / kill-switch /
 *     finally) carries the sessionId through every call site, which
 *     makes per-session debugging tractable and lets future kill-switch
 *     dispatches scope to a single session if needed.
 *
 * `tabId` here is redundant with the sessionMap key, but keeping it
 * inside the tuple means a future per-session-multiple-tabs design
 * doesn't need a schema change. For now the invariant holds: tabId in
 * ownerToken === tabId in sessionMap key === ctx.pinnedTabId.
 */
export interface CdpOwnerToken {
  sessionId: string;
  tabId: number;
}

export interface CdpSession {
  readonly tabId: number;
  readonly ownerToken: CdpOwnerToken;
  readonly generationId: number;
  readonly isAlive: boolean;
  readonly detachedReason: DetachReason | null;

  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(reason?: DetachReason): Promise<void>;
}

interface InternalSession extends CdpSession {
  // mutable state — only modified by helpers below
  alive: boolean;
  reason: DetachReason | null;
  signalListener: (() => void) | null;
  // Caller-provided callback fired when an EXTERNAL event (yellow-bar
  // cancel, kill switch) wants to abort the owning task. CdpSession
  // doesn't own the abortController; this callback is the bridge.
  // Not fired for caller-initiated detach() calls (where the caller is
  // already in control of the abort).
  onExternalDetach: ((reason: DetachReason) => void) | null;
}

const sessionMap = new Map<number, InternalSession>();
let nextGenerationId = 1;

/**
 * M3-U3 — per-tabId attach/detach lock.
 *
 * Prevents the "session A finally-detach interleaved with session B
 * acquire on the same tab" race (advisor ADV-9): without this, B's
 * `sessionMap.get(tabId)` returns undefined (A's detachInternal
 * deleted the entry) but A's `chromeDetach` hasn't completed at the
 * Chrome layer yet, so B's `chromeAttach` throws "Another debugger".
 *
 * Implementation: each tabId has a chained promise. acquire / detach
 * append themselves to the chain. The chain doesn't break on rejection
 * (tail uses `.then(() => {}, () => {})` to absorb errors), so a failed
 * attach by one caller does not deadlock subsequent callers.
 *
 * Map entry is cleaned up only when this specific operation is the
 * tail; intermediate entries naturally roll forward. No explicit GC
 * needed — chains for closed tabs go cold and become garbage when no
 * one else references them.
 */
const tabOpQueue = new Map<number, Promise<unknown>>();

async function queueTabOp<T>(
  tabId: number,
  op: () => Promise<T>,
): Promise<T> {
  const prev = tabOpQueue.get(tabId) ?? Promise.resolve();
  // Run `op` after `prev` settles, ignoring prev's outcome — a failed
  // attach must not block subsequent acquire / detach calls.
  const result: Promise<T> = prev.then(op, op);
  // Tail of the chain absorbs success / failure so the next `prev` we
  // chain onto resolves cleanly regardless.
  const tail = result.then(
    () => {},
    () => {},
  );
  tabOpQueue.set(tabId, tail);
  // Cleanup once tail settles AND we're still the current chain head.
  void tail.then(() => {
    if (tabOpQueue.get(tabId) === tail) tabOpQueue.delete(tabId);
  });
  return result;
}

export function getSessionByTabId(tabId: number): CdpSession | undefined {
  return sessionMap.get(tabId);
}

export function activeSessions(): CdpSession[] {
  return [...sessionMap.values()];
}

function chromeAttach(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, PROTOCOL_VERSION, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        const msg = err.message || "chrome.debugger.attach failed";
        const kind = msg.includes("Another debugger") ? "conflict" : "other";
        reject(new CdpAttachError(msg, kind));
        return;
      }
      resolve();
    });
  });
}

function chromeDetach(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      // Swallow lastError — may already be detached, that's fine.
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function chromeSendCommand(
  tabId: number,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message || `${method} failed`));
      else resolve(result);
    });
  });
}

/**
 * Acquire (or reuse) a CdpSession for the given tabId.
 *
 * - If no session exists for tabId: attach + create + register abort
 *   listener + write to sessionMap.
 * - If a session exists for tabId AND owner matches: return existing.
 * - If a session exists for tabId AND owner differs: throw — refuses to
 *   share across owners (multi-Side-Panel collateral kill prevention).
 *
 * The returned promise rejects with CdpAttachError on attach failure
 * (DevTools conflict, abort race, or other Chrome errors).
 */
export interface AcquireOptions {
  /** Caller's abort signal — when fired, session auto-detaches. */
  signal: AbortSignal;
  /**
   * Identifier for the owning agent task. Same owner can reuse an
   * existing session; different owner attempting same tabId fails fast.
   *
   * M3-U3 — structured `{sessionId, tabId}` so the conflict path can
   * emit a session-named error and so the SW can later fan out a per-
   * session kill-switch (e.g. "tear down sessionA's CDP only") without
   * touching siblings.
   */
  ownerToken: CdpOwnerToken;
  /**
   * Called when the session is torn down by an EXTERNAL event (yellow
   * bar cancel, storage kill switch). Caller should respond by aborting
   * its abortController so the agent task ends cleanly.
   *
   * NOT called for caller-initiated detach() — the caller already knows.
   * NOT called when the abort signal fires — the caller already aborted.
   */
  onExternalDetach: (reason: DetachReason) => void;
}

export async function acquireCdpSession(
  tabId: number,
  options: AcquireOptions,
): Promise<CdpSession> {
  const { signal, ownerToken, onExternalDetach } = options;
  if (signal.aborted) {
    throw new CdpAttachError("Aborted before attach", "race");
  }

  // M3-U3 — serialize attach/detach on this tabId so a sibling session's
  // finally-detach completes (at the Chrome layer) before our chromeAttach
  // call goes out. Without this lock, sessionMap state would be consistent
  // but Chrome would still reject our attach with "Another debugger" until
  // the detach roundtrip lands. ADV-9.
  return queueTabOp(tabId, async () => {
    const existing = sessionMap.get(tabId);
    if (existing) {
      // M3-U3 — sessionId-based conflict check. tabId is already the map
      // key (so they always match by construction); compare sessionId to
      // tell sibling-Side-Panel sessions apart.
      if (existing.ownerToken.sessionId !== ownerToken.sessionId) {
        throw new CdpAttachError(
          `Another agent task (session ${existing.ownerToken.sessionId}) already controls tab ${tabId} via debugger; close the other Side Panel first`,
          "conflict",
        );
      }
      if (!existing.alive) {
        throw new CdpAttachError(
          `Existing session for tab ${tabId} is no longer alive (${existing.reason ?? "unknown"})`,
          "other",
        );
      }
      return existing;
    }

    // Fresh attach.
    await chromeAttach(tabId);

    // Race guard — if abort fired during the attach roundtrip, the
    // would-be listener doesn't exist yet, so detach immediately and
    // reject without ever exposing the session.
    if (signal.aborted) {
      await chromeDetach(tabId);
      throw new CdpAttachError(
        "Abort signal fired during attach; detached before exposure",
        "race",
      );
    }

    const generationId = nextGenerationId++;
    const session: InternalSession = {
      tabId,
      ownerToken,
      generationId,
      alive: true,
      reason: null,
      signalListener: null,
      onExternalDetach,
      get isAlive() {
        return this.alive;
      },
      get detachedReason() {
        return this.reason;
      },
      async send(method: string, params: Record<string, unknown> = {}) {
        if (!this.alive) {
          throw new Error(
            `CdpSession[tab=${this.tabId}, gen=${this.generationId}, session=${this.ownerToken.sessionId}] is not alive (${this.reason ?? "unknown"})`,
          );
        }
        return chromeSendCommand(this.tabId, method, params);
      },
      async detach(reason: DetachReason = "explicit-detach") {
        await detachInternal(this, reason, /* external */ false);
      },
    };

    // Register abort listener to auto-detach when caller's signal fires
    // (chat-abort, port disconnect, or any externally-triggered abort).
    // This is the "session is going away because caller aborted" path —
    // we don't fire onExternalDetach because the caller already knows.
    const listener = () => {
      void detachInternal(session, "abort-signal", /* external */ false);
    };
    session.signalListener = listener;
    signal.addEventListener("abort", listener, { once: true });

    sessionMap.set(tabId, session);
    return session;
  });
}

async function detachInternal(
  session: InternalSession,
  reason: DetachReason,
  external: boolean,
): Promise<void> {
  if (!session.alive) return; // idempotent

  // Mark dead BEFORE the async detach, so any concurrent send() rejects
  // and any racing detach call short-circuits.
  session.alive = false;
  session.reason = reason;

  // Remove from sessionMap so onDetach event lookups by tabId stop
  // resolving to this session (sessionMap.delete = implicit generation
  // boundary; the generationId double-check in onDetach handler is
  // still required because Chrome's onDetach delivery vs sessionMap.delete
  // ordering is not contractually guaranteed).
  if (sessionMap.get(session.tabId) === session) {
    sessionMap.delete(session.tabId);
  }

  // Notify the owning task BEFORE we make the actual chromeDetach call —
  // external aborts (yellow bar / kill switch) must propagate to the
  // task even if the chromeDetach call below throws.
  if (external && session.onExternalDetach) {
    try {
      session.onExternalDetach(reason);
    } catch {
      // swallow — caller's abort callback shouldn't break our cleanup
    }
  }

  // M3-U3 — serialize the chromeDetach roundtrip on this tabId so a
  // racing acquire() running in queueTabOp doesn't see a still-attached
  // Chrome state (sessionMap entry already removed but chrome.debugger
  // hasn't yet replied to our detach).
  await queueTabOp(session.tabId, () => chromeDetach(session.tabId));
}

/**
 * Called by the SW-top-level chrome.debugger.onDetach handler when the
 * user clicks the yellow bar's Cancel button (or Chrome detaches for
 * any other reason — tab closed, target crashed, idle timeout).
 *
 * Looks up the session by tabId. sessionMap.delete on the caller's own
 * detach() path forms an implicit generation boundary — stale events
 * for a previous session find no entry and return. The
 * `expectedGenerationId` parameter (when provided) adds a defensive
 * double-check in case Chrome ever delivers onDetach out of order.
 *
 * Marks the session dead, removes from map, and fires the owning task's
 * onExternalDetach callback so the agent loop can abort with a proper
 * "user cancelled" summary.
 */
export function handleExternalDetach(
  tabId: number,
  reason: DetachReason = "user-cancelled-via-yellow-bar",
): void {
  const session = sessionMap.get(tabId);
  if (!session) return;
  if (!session.alive) return;
  void detachInternal(
    session as InternalSession,
    reason,
    /* external */ true,
  );
}

/**
 * Tear down all live sessions (used by storage kill-switch in
 * background/index.ts when user toggles keyboard simulation OFF
 * mid-task). Each session's onExternalDetach fires, propagating the
 * abort to its owning agent task.
 */
export async function detachAllSessions(reason: DetachReason): Promise<void> {
  const all = [...sessionMap.values()] as InternalSession[];
  await Promise.all(
    all.map((s) => detachInternal(s, reason, /* external */ true)),
  );
}
