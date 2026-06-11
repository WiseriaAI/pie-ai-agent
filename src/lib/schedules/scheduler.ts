// src/lib/schedules/scheduler.ts
//
// chrome.alarms wrapper for the Schedule feature. Translates ScheduleRecords
// into MV3 alarms (name = "schedule:<id>") and routes alarm fires back into
// runSchedule. The pure firing math lives in schedule-logic.ts; this module only
// touches chrome.alarms + the store.
//
// runSchedule is injected via SchedulerDeps so this module is testable without a
// real agent loop or extension runtime. The SW (background/index.ts) wires the
// real runSchedule (with RunDeps baked in) + Date.now.
//
// Dispatch is FIRE-AND-FORGET: alarm handlers must not block on a (possibly
// long-running) agent loop, so the run dispatch is not awaited where it would
// stall the alarm pipeline. handleAlarm DOES await the run so it can re-arm the
// next fire using the post-run schedule state (runCount may have advanced).

import { getSchedule, listSchedules, patchSchedule } from "./store";
import type { ScheduleRecord } from "./types";
import { MAX_CONCURRENT_SCHEDULE_RUNS, CONCURRENCY_DEFER_MS } from "./types";
import { computeFirstFireAt, computeNextFireAt } from "./schedule-logic";

const ALARM_PREFIX = "schedule:";

export interface SchedulerDeps {
  /** Bound runSchedule(scheduleId) — RunDeps are baked in by the caller (SW). */
  runSchedule: (scheduleId: string) => Promise<void>;
  /** Wall-clock provider (override in tests). */
  now?: () => number;
  /**
   * Current number of scheduled runs in flight (the SW's runningScheduleIds.size).
   * Optional: when absent, the concurrency cap is not enforced (back-compat for
   * arm/reconcile call sites + tests that don't simulate concurrency). When
   * present and >= MAX_CONCURRENT_SCHEDULE_RUNS, handleAlarm staggers the alarm
   * instead of starting a concurrent run.
   */
  runningCount?: () => number;
}

function alarmName(id: string): string {
  return ALARM_PREFIX + id;
}

function idFromAlarmName(name: string): string | null {
  if (!name.startsWith(ALARM_PREFIX)) return null;
  const id = name.slice(ALARM_PREFIX.length);
  return id.length > 0 ? id : null;
}

/** Fire-and-forget dispatch; swallow + log so an alarm pipeline never rejects. */
function dispatchRun(deps: SchedulerDeps, id: string): void {
  void Promise.resolve(deps.runSchedule(id)).catch((e) => {
    console.warn(`[scheduler] runSchedule(${id}) rejected:`, e);
  });
}

/**
 * Concurrency cap (spec §7) — shared by BOTH fire paths (handleAlarm's live
 * alarm + reconcileAlarms' overdue batch). When N schedules share a fire minute
 * (or many overdue alarms fire at once after a long SW outage), don't spin up an
 * unbounded fleet of headless agent loops.
 *
 * If we're already at MAX_CONCURRENT_SCHEDULE_RUNS, this STAGGERS the fire —
 * re-arm the alarm at `now + CONCURRENCY_DEFER_MS` and return `true` (caller must
 * bail without dispatching). This is a load-shed, NOT a skip/failure — no outcome
 * is counted, nextRunAt is left at its scheduled value (the defer retries the
 * SAME fire). An in-flight run finishing frees a slot, so the re-armed alarm gets
 * in shortly after (no starvation). The cap is enforced only when the caller
 * supplies `runningCount` (the SW does; arm tests don't); absent it, returns
 * `false` (proceed to dispatch).
 *
 * Returns `true` when the fire was staggered (caller must NOT dispatch), `false`
 * when there's a free slot (caller dispatches in its own style — fire-and-forget
 * in reconcile, awaited in handleAlarm). Both paths share this so the cap policy
 * can never diverge.
 */
function staggerIfAtCap(deps: SchedulerDeps, id: string, now: number): boolean {
  const running = deps.runningCount?.();
  if (running != null && running >= MAX_CONCURRENT_SCHEDULE_RUNS) {
    chrome.alarms.create(alarmName(id), { when: now + CONCURRENCY_DEFER_MS });
    return true;
  }
  return false;
}

/**
 * Arm a schedule's FIRST fire. The first-fire timestamp comes from the pure
 * computeFirstFireAt (= spec.startAt ?? now), then:
 *   - fireAt in the future  → chrome.alarms.create({ when: fireAt }); patch nextRunAt.
 *   - fireAt now / already past (no startAt, or startAt elapsed) → dispatch the
 *     first run now (fire-and-forget) and patch nextRunAt = fireAt. handleAlarm/
 *     Task-5 re-arms the recurring fires after the run completes.
 */
export async function armSchedule(
  rec: ScheduleRecord,
  deps: SchedulerDeps,
): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  const fireAt = computeFirstFireAt(rec.spec, now);

  if (fireAt > now) {
    chrome.alarms.create(alarmName(rec.id), { when: fireAt });
    await patchSchedule(rec.id, { nextRunAt: fireAt });
    return;
  }

  // Immediate first fire — dispatch now, don't wait on an alarm tick.
  await patchSchedule(rec.id, { nextRunAt: fireAt });
  dispatchRun(deps, rec.id);
}

/** Clear the alarm for a schedule (idempotent — clears nothing if absent). */
export async function disarmSchedule(id: string): Promise<void> {
  await chrome.alarms.clear(alarmName(id));
}

/**
 * Re-arm any active schedule whose alarm was lost (SW reinstall/upgrade clears
 * all alarms; a mid-flight re-arm chain can also break if the SW died between
 * "run done" and "create next alarm"). For each active schedule with no live
 * alarm:
 *   - nextRunAt already past (or missing) → dispatch now, UNLESS the concurrency
 *     cap is full (then stagger — same load-shed as handleAlarm). This matters
 *     most here: after a long SW outage many schedules can be overdue at once,
 *     so an uncapped overdue branch would dispatch the whole batch concurrently.
 *   - nextRunAt in the future → re-create the alarm at that time.
 *
 * Paused / completed schedules are skipped — only `status === "active"`.
 */
export async function reconcileAlarms(
  now: number,
  deps: SchedulerDeps,
): Promise<void> {
  const all = await listSchedules();
  for (const rec of all) {
    if (rec.status !== "active") continue;
    // 9.1 — respect `enabled`. A disabled schedule keeps status "active" (the
    // two fields are orthogonal) but must never be re-armed or dispatched.
    // Defensive: toggle already disarms it, but reconcile must not revive it.
    if (rec.enabled === false) continue;
    const existing = await chrome.alarms.get(alarmName(rec.id));
    if (existing) continue; // already armed — leave it

    const when = rec.nextRunAt;
    if (when == null || when <= now) {
      // Overdue (or no recorded next time) — fire immediately, but honor the
      // concurrency cap. staggerIfAtCap re-arms (defers) when full so a batch of
      // overdue alarms can't all dispatch at once; otherwise dispatch now
      // (fire-and-forget). Both fire paths share staggerIfAtCap → no divergence.
      if (!staggerIfAtCap(deps, rec.id, now)) {
        dispatchRun(deps, rec.id);
      }
    } else {
      // Future — re-create the lost alarm.
      chrome.alarms.create(alarmName(rec.id), { when });
    }
  }
}

/**
 * Handle a fired alarm. Parses "schedule:<id>", dispatches the run, then re-arms
 * the next fire (or disarms for one-shots / cap reached).
 *
 * NOTE — Task 4 vs Task 5 boundary: this re-arm uses the schedule's CURRENT
 * `runCount` + `spec` via computeNextFireAt. Task 5 owns the full run-outcome
 * accounting (incrementing runCount, flipping status→completed, consecutive-
 * failure auto-pause). When Task 5 lands, the post-run schedule it persists is
 * read here (we re-read AFTER awaiting the run), so the re-arm naturally honors
 * the updated runCount/status. The anchor is the SCHEDULED fire time
 * (pre-run nextRunAt) so recurring fires don't drift when a run runs late.
 */
export async function handleAlarm(
  name: string,
  deps: SchedulerDeps,
): Promise<void> {
  const id = idFromAlarmName(name);
  if (!id) return;

  // Anchor = the time this fire was scheduled for (pre-run), so the next fire is
  // anchor + interval — no drift if the run itself runs late.
  const before = await getSchedule(id);

  // 9.1 — respect `enabled`. If a stray alarm fires for a disabled schedule
  // (e.g. raced a disarm), do NOT dispatch the run and clear the alarm so it
  // can't fire again. `enabled` is orthogonal to `status` (a disabled schedule
  // may still be status "active").
  if (before && before.enabled === false) {
    await disarmSchedule(id);
    return;
  }

  const now = deps.now?.() ?? Date.now();
  const anchor = before?.nextRunAt ?? now;

  // Concurrency cap (spec §7) — shared with reconcile's overdue branch via
  // staggerIfAtCap. If we're already at the cap it re-arms (defers) this alarm
  // and we bail WITHOUT dispatching (load-shed: no outcome counted, nextRunAt
  // untouched, in-flight runs free a slot so the deferred alarm retries soon).
  if (staggerIfAtCap(deps, id, now)) return;

  // Await the run so the re-arm below sees Task 5's post-run schedule state
  // (runCount / status). runSchedule never throws on soft failures, but guard
  // anyway so a thrown exception still lets us re-arm.
  try {
    await deps.runSchedule(id);
  } catch (e) {
    console.warn(`[scheduler] runSchedule(${id}) threw:`, e);
  }

  // Re-read post-run: Task 5 may have bumped runCount or flipped status.
  const after = await getSchedule(id);
  if (!after) return; // schedule deleted during the run — nothing to re-arm
  if (after.status !== "active") {
    // Task 5 auto-paused/completed it — no further fires.
    await disarmSchedule(id);
    return;
  }

  const next = computeNextFireAt({
    anchor,
    spec: after.spec,
    runCount: after.runCount,
  });
  if (next == null) {
    // One-shot or run cap reached — no further fires.
    await disarmSchedule(id);
    return;
  }

  chrome.alarms.create(alarmName(id), { when: next });
  await patchSchedule(id, { nextRunAt: next });
}
