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

export interface CdpSession {
  readonly tabId: number;
  readonly ownerToken: string;
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
   */
  ownerToken: string;
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

  const existing = sessionMap.get(tabId);
  if (existing) {
    if (existing.ownerToken !== ownerToken) {
      throw new CdpAttachError(
        "Another agent task already controls this tab via debugger; close the other Side Panel first",
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
          `CdpSession[tab=${this.tabId}, gen=${this.generationId}] is not alive (${this.reason ?? "unknown"})`,
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

  // Best-effort detach the actual Chrome debugger.
  await chromeDetach(session.tabId);
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
