import type { SessionStatus } from "./types";

/**
 * All valid session status transitions, per the plan state machine
 * (docs/plans/2026-05-02-001-feat-session-persistent-layer-plan.md,
 * mermaid stateDiagram-v2 lines 254–271).
 *
 * The `running` and `pending_confirm` intermediate states from the
 * mermaid diagram are **task-level** concepts, not session-level status
 * values — they are absorbed into `active`. `done` is also intentionally
 * absent: task completion leaves the session `active` with the completed
 * task as history.
 *
 * Self-transitions (e.g. active → active) are allowed for defensive
 * idempotency: helpers like `markPaused` already return early if the
 * session is already paused; permitting self-transitions in
 * `canTransition` means a guard-at-the-call-site check also succeeds
 * for no-ops rather than throwing a false-positive illegal-transition
 * error.
 */
export const ALL_TRANSITIONS: ReadonlyArray<[SessionStatus, SessionStatus]> = [
  // Self-transitions (idempotent)
  ["active", "active"],
  ["paused", "paused"],
  ["failed", "failed"],
  ["archived", "archived"],

  // active exits
  ["active", "failed"],    // task error / cross-origin abort
  ["active", "paused"],    // SW restart (no pending confirm) — R10(session-resume) cold-start gate
  ["active", "archived"],  // LRU eviction OR user soft-delete

  // paused exits
  ["paused", "active"],    // user clicks 'Resume task' (R11 drift check passes)
  ["paused", "failed"],    // user clicks 'Discard' on R11 drift card
  ["paused", "archived"],  // LRU eviction — paused doesn't protect from LRU

  // failed exits
  ["failed", "archived"],  // LRU eviction OR user soft-delete

  // archived exits
  ["archived", "active"],  // user manually unarchives (within 30d window)
] as const;

/**
 * Determine whether a transition from `from` to `to` is legal.
 *
 * Intended for defensive guard use: callers can call this before
 * applying any status change, and log / throw on an unexpected path
 * rather than silently writing a bad status.
 *
 * All same-state self-transitions return `true` (idempotency).
 */
export function canTransition(from: SessionStatus, to: SessionStatus): boolean {
  return ALL_TRANSITIONS.some(([f, t]) => f === from && t === to);
}
