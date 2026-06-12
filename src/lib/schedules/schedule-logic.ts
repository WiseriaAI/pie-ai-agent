// src/lib/schedules/schedule-logic.ts
//
// Pure scheduling math — NO chrome dependency, time supplied via parameters
// (never Date.now()). Kept separate from scheduler.ts (the chrome.alarms
// wrapper) so this layer is deterministically unit-testable.

import type { ScheduleSpec, ScheduleRecord } from "./types";
import { FAILURE_PAUSE_THRESHOLD } from "./types";

const MS_PER_MINUTE = 60_000;

/**
 * When should a schedule fire for the FIRST time?
 *   - `spec.startAt` if the user pinned a start time → fire then.
 *   - else recurring (has `intervalMinutes`) → `now + interval`: wait one full
 *     interval before the first run. Creating a periodic schedule ("every N
 *     minutes / daily") should NOT ambush the user with an immediate run —
 *     especially agent-created ones, which rarely set `startAt`.
 *   - else one-shot (no interval) → `now`: immediate, which IS the meaning of a
 *     start-time-less one-shot ("run once, now").
 */
export function computeFirstFireAt(spec: ScheduleSpec, now: number): number {
  if (spec.startAt != null) return spec.startAt;
  if (spec.intervalMinutes) return now + spec.intervalMinutes * MS_PER_MINUTE;
  return now;
}

/**
 * When should a schedule fire NEXT, given the timestamp it was *scheduled* to
 * fire this time (`anchor`) and how many runs have completed (`runCount`)?
 *
 * Returns `null` (no further fire — disarm) when:
 *   - the schedule is a one-shot (`!spec.intervalMinutes`), or
 *   - a run cap is set and has been reached (`spec.maxRuns != null &&
 *     runCount >= spec.maxRuns`).
 *
 * Otherwise the next fire is `anchor + intervalMinutes` — ANCHOR ACCUMULATION,
 * not `now + interval`. Anchoring on the scheduled time means a run that was
 * dragged late (SW busy, slow LLM) does NOT push every subsequent fire later
 * (no drift): a 09:00 schedule that actually ran at 09:03 still fires next at
 * 10:00, not 10:03.
 */
export function computeNextFireAt(args: {
  anchor: number;
  spec: ScheduleSpec;
  runCount: number;
}): number | null {
  const { anchor, spec, runCount } = args;
  if (!spec.intervalMinutes) return null;
  if (spec.maxRuns != null && runCount >= spec.maxRuns) return null;
  return anchor + spec.intervalMinutes * MS_PER_MINUTE;
}

/**
 * Task 5.1 — Pure function: given a completed run outcome, compute the patch
 * to apply to the parent ScheduleRecord's counters + status.
 *
 * Count rules (spec §11):
 *   success     → runCount+1, consecutiveFailures = 0
 *   failed      → runCount+1, consecutiveFailures+1
 *   skipped     → no change (overlapping run — does not count)
 *   interrupted → no change (SW killed mid-run — does not count)
 *
 * Status determination order (failure pause priority over completion):
 *   1. consecutiveFailures >= FAILURE_PAUSE_THRESHOLD            → "paused"
 *   2. one-shot (!intervalMinutes) OR run cap reached            → "completed"
 *   3. else                                                      → "active"
 *
 * Rule 2 mirrors computeNextFireAt's terminal cases exactly (spec §4: "no
 * intervalMinutes → run once, equivalent to maxRuns=1"). A natural one-shot (no
 * interval, no maxRuns) MUST flip to "completed" after its single run; leaving
 * it "active" with a past nextRunAt and no alarm makes reconcileAlarms re-dispatch
 * it on every SW wake (unattended re-runs, burned tokens). computeNextFireAt
 * already returns null for one-shots; applyOutcome must mirror that here.
 *
 * No chrome / IDB side effects — purely a counter → patch mapper.
 */
export function applyOutcome(
  sched: ScheduleRecord,
  outcome: "success" | "failed" | "skipped" | "interrupted",
): { runCount: number; consecutiveFailures: number; status: ScheduleRecord["status"] } {
  // skipped / interrupted: no counter change, status unchanged
  if (outcome === "skipped" || outcome === "interrupted") {
    return {
      runCount: sched.runCount,
      consecutiveFailures: sched.consecutiveFailures,
      status: sched.status,
    };
  }

  const newRunCount = sched.runCount + 1;
  const newCf =
    outcome === "success" ? 0 : sched.consecutiveFailures + 1;

  // Determine new status: failure-pause priority first, then terminal-completion
  // (one-shot OR run cap reached — mirrors computeNextFireAt's null cases).
  let newStatus: ScheduleRecord["status"];
  if (newCf >= FAILURE_PAUSE_THRESHOLD) {
    newStatus = "paused";
  } else if (
    !sched.spec.intervalMinutes ||
    (sched.spec.maxRuns != null && newRunCount >= sched.spec.maxRuns)
  ) {
    newStatus = "completed";
  } else {
    newStatus = "active";
  }

  return {
    runCount: newRunCount,
    consecutiveFailures: newCf,
    status: newStatus,
  };
}
