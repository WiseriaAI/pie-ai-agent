// src/lib/schedules/schedule-logic.ts
//
// Pure scheduling math — NO chrome dependency, time supplied via parameters
// (never Date.now()). Kept separate from scheduler.ts (the chrome.alarms
// wrapper) so this layer is deterministically unit-testable.

import type { ScheduleSpec } from "./types";

const MS_PER_MINUTE = 60_000;

/**
 * When should a schedule fire for the FIRST time?
 *   - `spec.startAt` if the user pinned a start time.
 *   - otherwise `now` (run immediately).
 */
export function computeFirstFireAt(spec: ScheduleSpec, now: number): number {
  return spec.startAt ?? now;
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
