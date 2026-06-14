// src/lib/schedules/schedule-ops.ts
//
// Task 9 — shared schedule operations core. The SINGLE source of truth for the
// mutating schedule operations (create / update / delete / toggle / run-now),
// called by BOTH:
//   - the schedule-meta agent tools (src/lib/agent/tools/schedule-meta.ts), and
//   - the SW message handler that backs the management-UI write channel
//     (background/index.ts `schedule-action`).
//
// Why a shared module (DRY): Task 7's schedule-meta tool already implemented the
// store + scheduler call sequences (put + arm, patch + re-arm, delete + disarm).
// Re-implementing them in the SW message handler would be two copies of the same
// arm/disarm logic that must stay in lock-step. Centralizing here keeps a single
// validated sequence both callers reuse.
//
// runSchedule injection (same reasoning as schedule-meta's setScheduleRunDep):
// armSchedule needs a real, deps-bound runSchedule so a schedule with no startAt
// (= run immediately) dispatches its first run through the real agent loop rather
// than dropping it. The SW injects it once at boot via setScheduleOpsRunDep.

import {
  getSchedule,
  listSchedules,
  putSchedule,
  patchSchedule,
  deleteSchedule,
} from "./store";
import { armSchedule, disarmSchedule } from "./scheduler";
import { isRestrictedScheduleUrl } from "./url-guard";
import {
  newScheduleId,
  MIN_INTERVAL_MINUTES,
  MAX_SCHEDULES,
  type ScheduleRecord,
  type ScheduleSpec,
} from "./types";

// ── Result type ───────────────────────────────────────────────────────────────

export type OpResult =
  | { ok: true; id?: string }
  | { ok: false; error: string };

function ok(id?: string): OpResult {
  return id !== undefined ? { ok: true, id } : { ok: true };
}
function fail(error: string): OpResult {
  return { ok: false, error };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function validateSpec(spec: Partial<ScheduleSpec>): string | null {
  if (
    spec.intervalMinutes !== undefined &&
    spec.intervalMinutes < MIN_INTERVAL_MINUTES
  ) {
    return `intervalMinutes must be >= ${MIN_INTERVAL_MINUTES} (got ${spec.intervalMinutes})`;
  }
  return null;
}

// ── Injected runSchedule dispatcher ───────────────────────────────────────────

type RunScheduleDispatcher = (scheduleId: string) => Promise<void>;

let runScheduleDep: RunScheduleDispatcher = async (id) => {
  console.warn(
    `[schedule-ops] runScheduleDep not injected — run for ${id} dropped. ` +
      `setScheduleOpsRunDep() must be called at SW boot.`,
  );
};

/** Inject the SW's deps-bound runSchedule (RunDeps + keep-alive baked in). */
export function setScheduleOpsRunDep(fn: RunScheduleDispatcher): void {
  runScheduleDep = fn;
}

/** Read the currently-injected dispatcher (used by callers that arm directly). */
export function getScheduleOpsRunDep(): RunScheduleDispatcher {
  return runScheduleDep;
}

// ── create ────────────────────────────────────────────────────────────────────

export interface CreateScheduleInput {
  title: string;
  prompt: string;
  instanceId: string;
  model?: string;
  spec?: ScheduleSpec;
  startUrl?: string;
  maxStepsPerRun?: number;
  maxRunMs?: number;
}

export async function createScheduleOp(input: CreateScheduleInput): Promise<OpResult> {
  if (!isNonEmptyString(input.title)) return fail("title is required");
  if (!isNonEmptyString(input.prompt)) return fail("prompt is required");
  if (!isNonEmptyString(input.instanceId)) return fail("instanceId is required");

  const spec: ScheduleSpec = {};
  if (input.spec) {
    if (input.spec.startAt !== undefined) spec.startAt = input.spec.startAt;
    if (input.spec.intervalMinutes !== undefined) spec.intervalMinutes = input.spec.intervalMinutes;
    if (input.spec.maxRuns !== undefined) spec.maxRuns = input.spec.maxRuns;
  }

  const specErr = validateSpec(spec);
  if (specErr) return fail(specErr);

  if (isNonEmptyString(input.startUrl) && isRestrictedScheduleUrl(input.startUrl)) {
    return fail(
      `startUrl "${input.startUrl}" is a restricted page (chrome://, about:, chrome-extension://, Web Store) and cannot be used.`,
    );
  }

  const existing = await listSchedules();
  if (existing.length >= MAX_SCHEDULES) {
    return fail(`schedule quota exceeded (max ${MAX_SCHEDULES}). Delete unused schedules first.`);
  }

  const id = newScheduleId();
  const rec: ScheduleRecord = {
    id,
    title: input.title.trim(),
    prompt: input.prompt.trim(),
    spec,
    ...(isNonEmptyString(input.startUrl) ? { startUrl: input.startUrl } : {}),
    instanceId: input.instanceId,
    ...(isNonEmptyString(input.model) ? { model: input.model } : {}),
    enabled: true,
    status: "active",
    ...(input.maxStepsPerRun !== undefined ? { maxStepsPerRun: input.maxStepsPerRun } : {}),
    ...(input.maxRunMs !== undefined ? { maxRunMs: input.maxRunMs } : {}),
    runCount: 0,
    consecutiveFailures: 0,
    runIds: [],
    createdAt: Date.now(),
  };

  await putSchedule(rec);
  await armSchedule(rec, { runSchedule: runScheduleDep });
  return ok(id);
}

// ── update ────────────────────────────────────────────────────────────────────

export interface UpdateScheduleInput {
  id: string;
  instanceId?: string;
  model?: string;
  title?: string;
  prompt?: string;
  spec?: Partial<ScheduleSpec>;
  startUrl?: string; // empty string clears it
  maxStepsPerRun?: number;
  maxRunMs?: number;
}

export async function updateScheduleOp(input: UpdateScheduleInput): Promise<OpResult> {
  if (!isNonEmptyString(input.id)) return fail("id is required");
  const id = input.id;

  const existing = await getSchedule(id);
  if (!existing) return fail(`schedule not found: ${id}`);

  const patch: Partial<Omit<ScheduleRecord, "id">> = {};
  if (input.title !== undefined) {
    if (!isNonEmptyString(input.title)) return fail("title must be a non-empty string");
    patch.title = input.title.trim();
  }
  if (input.prompt !== undefined) {
    if (!isNonEmptyString(input.prompt)) return fail("prompt must be a non-empty string");
    patch.prompt = input.prompt.trim();
  }

  // Re-arm only when the timing (startAt / intervalMinutes) changes.
  let specChanged = false;
  if (input.spec) {
    const newSpec: ScheduleSpec = { ...existing.spec };
    if ("startAt" in input.spec) { newSpec.startAt = input.spec.startAt; specChanged = true; }
    if ("intervalMinutes" in input.spec) { newSpec.intervalMinutes = input.spec.intervalMinutes; specChanged = true; }
    if ("maxRuns" in input.spec) { newSpec.maxRuns = input.spec.maxRuns; }
    const specErr = validateSpec(newSpec);
    if (specErr) return fail(specErr);
    patch.spec = newSpec;
  }

  if (input.startUrl !== undefined) {
    if (isNonEmptyString(input.startUrl) && isRestrictedScheduleUrl(input.startUrl)) {
      return fail(`startUrl "${input.startUrl}" is restricted and cannot be used.`);
    }
    patch.startUrl = input.startUrl === "" ? undefined : input.startUrl;
  }
  if (input.maxStepsPerRun !== undefined) patch.maxStepsPerRun = input.maxStepsPerRun;
  if (input.maxRunMs !== undefined) patch.maxRunMs = input.maxRunMs;
  if (input.instanceId !== undefined) {
    if (!isNonEmptyString(input.instanceId)) return fail("instanceId must be a non-empty string");
    patch.instanceId = input.instanceId;
  }
  // empty string clears the binding → runtime falls back to firstModelForProvider
  if (input.model !== undefined) {
    patch.model = isNonEmptyString(input.model) ? input.model : undefined;
  }

  await patchSchedule(id, patch);

  if (specChanged) {
    await disarmSchedule(id);
    const updated = await getSchedule(id);
    // 9.4 — only an active + enabled schedule re-arms; disabled stays disarmed.
    if (updated && updated.status === "active" && updated.enabled) {
      await armSchedule(updated, { runSchedule: runScheduleDep });
    }
  }

  return ok();
}

// ── delete ────────────────────────────────────────────────────────────────────

export async function deleteScheduleOp(id: string): Promise<OpResult> {
  if (!isNonEmptyString(id)) return fail("id is required");
  const existing = await getSchedule(id);
  if (!existing) return fail(`schedule not found: ${id}`);
  await deleteSchedule(id);
  await disarmSchedule(id);
  return ok();
}

// ── toggle (9.1 enabled wire) ──────────────────────────────────────────────────

/**
 * Flip a schedule's `enabled` flag and (dis)arm accordingly.
 *   enabled=false → patch + disarm (clear the alarm; reconcile/handleAlarm also
 *                   respect `enabled` defensively so it can't be revived).
 *   enabled=true  → patch + re-arm IF status === "active" (a completed/paused
 *                   schedule has no future fires to arm).
 */
export async function toggleScheduleOp(id: string, enabled: boolean): Promise<OpResult> {
  if (!isNonEmptyString(id)) return fail("id is required");
  const existing = await getSchedule(id);
  if (!existing) return fail(`schedule not found: ${id}`);

  await patchSchedule(id, { enabled });

  if (!enabled) {
    await disarmSchedule(id);
    return ok();
  }

  // Re-enabled — re-arm only an active schedule.
  const updated = await getSchedule(id);
  if (updated && updated.status === "active") {
    await armSchedule(updated, { runSchedule: runScheduleDep });
  }
  return ok();
}

// ── run-now ─────────────────────────────────────────────────────────────────--

/**
 * Manually trigger an immediate run via the injected, deps-bound runSchedule.
 * The run's own skip-if-running guard still applies (Task 5), so a manual run
 * while one is already in flight is a no-op skip rather than a double run.
 */
export async function runScheduleNowOp(id: string): Promise<OpResult> {
  if (!isNonEmptyString(id)) return fail("id is required");
  const existing = await getSchedule(id);
  if (!existing) return fail(`schedule not found: ${id}`);
  // Fire-and-forget through the real loop; do not await the (possibly long)
  // agent run here — the keep-alive wrapper in the SW owns its lifetime.
  void Promise.resolve(runScheduleDep(id)).catch((e) => {
    console.warn(`[schedule-ops] runScheduleNow(${id}) rejected:`, e);
  });
  return ok();
}
