// src/lib/schedules/types.ts
//
// Types for the Schedule feature: recurring agent task plans (ScheduleRecord)
// and individual run records (ScheduleRunRecord). Both live in the `schedules`
// IDB store, differentiated by key prefix.

export interface ScheduleSpec {
  /** First run timestamp (ms). Defaults to "run immediately" when absent. */
  startAt?: number;
  /** Repeat interval in minutes. Absent = one-shot (maxRuns forced to 1). */
  intervalMinutes?: number;
  /** Total run count cap. Absent = unlimited (only meaningful with intervalMinutes). */
  maxRuns?: number;
}

export interface ScheduleRecord {
  id: string;                           // "sched_<uuid>"
  title: string;
  prompt: string;
  spec: ScheduleSpec;
  startUrl?: string;                    // optional: headless tab open URL
  instanceId: string;                   // bound at creation (ADR 0001)
  enabled: boolean;
  status: "active" | "paused" | "completed";
  maxStepsPerRun?: number;
  maxRunMs?: number;
  createdAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  runCount: number;
  consecutiveFailures: number;
  runIds: string[];                     // circular buffer, most-recent N recordIds
}

export interface ScheduleRunRecord {
  recordId: string;                     // "run_<uuid>"  — primary key in IDB
  scheduleId: string;
  runIndex: number;                     // 1-based ordinal
  sessionId?: string;                   // 1:1 session; absent on skip/early-fail
  ownedTabId?: number;                  // headless tab for orphan cleanup
  startedAt: number;
  endedAt?: number;
  status: "running" | "success" | "failed" | "interrupted" | "skipped";
  summary?: string;
  error?: string;
  outputs?: unknown;
  /** Task 8 — set true when a notification click could not open the side panel
   *  (user-gesture constraint). Task 9 UI reads this to highlight the run. */
  unread?: boolean;
}

// ── Key helpers ────────────────────────────────────────────────────────────────

export const SCHEDULE_KEY_PREFIX = "sched_";
export const RUN_KEY_PREFIX = "run_";

/** Max run-history entries kept per ScheduleRecord.runIds (circular). */
export const DEFAULT_RUN_HISTORY = 50;

/** Hard cap on concurrent schedules per extension install. */
export const MAX_SCHEDULES = 20;

/** Consecutive-failure threshold before auto-pausing a schedule. */
export const FAILURE_PAUSE_THRESHOLD = 3;

/** Minimum allowed intervalMinutes. 1 = chrome.alarms 的硬下限（packed 扩展的
 *  最小 alarm delay 是 1 分钟，更短会被 Chrome 钳到 1 分钟）。one-shot（省略
 *  intervalMinutes）不受此限。 */
export const MIN_INTERVAL_MINUTES = 1;

/**
 * Max number of scheduled agent runs allowed to execute CONCURRENTLY (spec §7 —
 * bound the batch-wakeup spike when N schedules share the same fire minute).
 * When the cap is hit, the extra alarm is short-delayed (staggered), not run.
 */
export const MAX_CONCURRENT_SCHEDULE_RUNS = 3;

/**
 * Stagger delay applied to an alarm whose dispatch was deferred because the
 * concurrency cap was full. Re-armed at `now + this` so it retries shortly after
 * (other in-flight runs release slots). Kept short so a deferred run isn't
 * starved, but long enough to actually let a slot free up.
 */
export const CONCURRENCY_DEFER_MS = 90_000;

export function newScheduleId(): string {
  return SCHEDULE_KEY_PREFIX + crypto.randomUUID();
}

export function newRunId(): string {
  return RUN_KEY_PREFIX + crypto.randomUUID();
}
