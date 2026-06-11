// src/lib/schedules/schedule-logic.test.ts
//
// TDD tests for the pure scheduling functions (Task 4.1 + Task 5.1). These
// carry NO chrome dependency and take time via parameters (never Date.now())
// so firing/anchor math is deterministic.

import { describe, expect, it } from "vitest";
import type { ScheduleSpec, ScheduleRecord } from "./types";
import { FAILURE_PAUSE_THRESHOLD } from "./types";
import { computeFirstFireAt, computeNextFireAt, applyOutcome } from "./schedule-logic";

// A fixed wall-clock anchor: 2026-06-12 09:00:00 UTC.
const NINE_AM = Date.UTC(2026, 5, 12, 9, 0, 0);
const TEN_AM = Date.UTC(2026, 5, 12, 10, 0, 0);
const MIN = 60_000;

describe("computeFirstFireAt", () => {
  it("uses spec.startAt when present", () => {
    const spec: ScheduleSpec = { startAt: NINE_AM, intervalMinutes: 60 };
    expect(computeFirstFireAt(spec, TEN_AM)).toBe(NINE_AM);
  });

  it("falls back to `now` when startAt is absent", () => {
    const spec: ScheduleSpec = { intervalMinutes: 60 };
    expect(computeFirstFireAt(spec, NINE_AM)).toBe(NINE_AM);
  });

  it("falls back to `now` for a one-shot (no interval) with no startAt", () => {
    const spec: ScheduleSpec = {};
    expect(computeFirstFireAt(spec, NINE_AM)).toBe(NINE_AM);
  });
});

describe("computeNextFireAt", () => {
  it("returns null for a one-shot (no intervalMinutes)", () => {
    const spec: ScheduleSpec = {};
    expect(computeNextFireAt({ anchor: NINE_AM, spec, runCount: 1 })).toBeNull();
  });

  it("returns anchor + interval for a recurring schedule (anchor accumulation)", () => {
    const spec: ScheduleSpec = { intervalMinutes: 60 };
    expect(computeNextFireAt({ anchor: NINE_AM, spec, runCount: 1 })).toBe(NINE_AM + 60 * MIN);
  });

  it("anchors on the SCHEDULED time, not the (late) actual run time", () => {
    // Scheduled 09:00 but the run was dragged to 09:03; next fire must still be
    // 10:00 (anchor + interval), NOT 10:03 (now + interval) — no drift.
    const spec: ScheduleSpec = { intervalMinutes: 60 };
    const scheduledAnchor = NINE_AM;
    const next = computeNextFireAt({ anchor: scheduledAnchor, spec, runCount: 1 });
    expect(next).toBe(TEN_AM);
  });

  it("returns null once runCount reaches maxRuns", () => {
    const spec: ScheduleSpec = { intervalMinutes: 60, maxRuns: 3 };
    expect(computeNextFireAt({ anchor: NINE_AM, spec, runCount: 3 })).toBeNull();
    expect(computeNextFireAt({ anchor: NINE_AM, spec, runCount: 4 })).toBeNull();
  });

  it("still schedules the next fire while runCount < maxRuns", () => {
    const spec: ScheduleSpec = { intervalMinutes: 60, maxRuns: 3 };
    expect(computeNextFireAt({ anchor: NINE_AM, spec, runCount: 2 })).toBe(NINE_AM + 60 * MIN);
  });

  it("treats maxRuns == null as unlimited", () => {
    const spec: ScheduleSpec = { intervalMinutes: 30 };
    expect(computeNextFireAt({ anchor: NINE_AM, spec, runCount: 999 })).toBe(NINE_AM + 30 * MIN);
  });
});

// ── Task 5.1: applyOutcome ────────────────────────────────────────────────────
//
// Pure function that computes the patch to apply to a ScheduleRecord after a
// run completes. The rules (spec §11):
//
//   success → runCount+1, consecutiveFailures=0
//   failed  → runCount+1, consecutiveFailures+1
//   skipped → no change (return original values)
//   interrupted → no change (return original values)
//
// Status determination (failure pause priority over cap):
//   1. consecutiveFailures >= FAILURE_PAUSE_THRESHOLD(3) → "paused"
//   2. maxRuns != null && runCount >= maxRuns             → "completed"
//   3. else                                               → "active"

function makeSched(
  overrides: Partial<ScheduleRecord> & { id: string },
): ScheduleRecord {
  return {
    title: "Test",
    prompt: "do things",
    spec: { intervalMinutes: 60 },
    instanceId: "inst_1",
    enabled: true,
    status: "active",
    createdAt: 1000,
    runCount: 0,
    consecutiveFailures: 0,
    runIds: [],
    ...overrides,
  };
}

describe("applyOutcome — skipped/interrupted do not count", () => {
  it("skipped → returns original runCount + consecutiveFailures + status unchanged", () => {
    const sched = makeSched({ id: "s1", runCount: 5, consecutiveFailures: 2, status: "active" });
    const patch = applyOutcome(sched, "skipped");
    expect(patch.runCount).toBe(5);
    expect(patch.consecutiveFailures).toBe(2);
    expect(patch.status).toBe("active");
  });

  it("interrupted → returns original runCount + consecutiveFailures + status unchanged", () => {
    const sched = makeSched({ id: "s2", runCount: 3, consecutiveFailures: 1, status: "active" });
    const patch = applyOutcome(sched, "interrupted");
    expect(patch.runCount).toBe(3);
    expect(patch.consecutiveFailures).toBe(1);
    expect(patch.status).toBe("active");
  });
});

describe("applyOutcome — success increments runCount, clears consecutiveFailures", () => {
  it("success → runCount+1, consecutiveFailures=0, status=active (below cap)", () => {
    const sched = makeSched({ id: "s3", runCount: 2, consecutiveFailures: 2, spec: { intervalMinutes: 60, maxRuns: 10 } });
    const patch = applyOutcome(sched, "success");
    expect(patch.runCount).toBe(3);
    expect(patch.consecutiveFailures).toBe(0);
    expect(patch.status).toBe("active");
  });

  it("success → status=completed when runCount+1 reaches maxRuns", () => {
    const sched = makeSched({ id: "s4", runCount: 4, consecutiveFailures: 0, spec: { intervalMinutes: 60, maxRuns: 5 } });
    const patch = applyOutcome(sched, "success");
    expect(patch.runCount).toBe(5);
    expect(patch.consecutiveFailures).toBe(0);
    expect(patch.status).toBe("completed");
  });

  it("success → status=active when no maxRuns cap set", () => {
    const sched = makeSched({ id: "s5", runCount: 999, consecutiveFailures: 0, spec: { intervalMinutes: 60 } });
    const patch = applyOutcome(sched, "success");
    expect(patch.runCount).toBe(1000);
    expect(patch.status).toBe("active");
  });
});

describe("applyOutcome — failed increments both counters", () => {
  it("failed → runCount+1, consecutiveFailures+1, status=active below threshold", () => {
    const sched = makeSched({ id: "s6", runCount: 1, consecutiveFailures: 1 });
    const patch = applyOutcome(sched, "failed");
    expect(patch.runCount).toBe(2);
    expect(patch.consecutiveFailures).toBe(2);
    expect(patch.status).toBe("active");
  });

  it(`failed → status=paused when consecutiveFailures+1 reaches FAILURE_PAUSE_THRESHOLD (${FAILURE_PAUSE_THRESHOLD})`, () => {
    const sched = makeSched({
      id: "s7",
      runCount: 5,
      consecutiveFailures: FAILURE_PAUSE_THRESHOLD - 1,
    });
    const patch = applyOutcome(sched, "failed");
    expect(patch.consecutiveFailures).toBe(FAILURE_PAUSE_THRESHOLD);
    expect(patch.status).toBe("paused");
  });

  it("failed → status=paused even when runCount+1 would reach maxRuns (pause beats cap)", () => {
    // Both conditions triggered: runCount+1 === maxRuns AND cf+1 >= threshold.
    // Spec §11 rule 1 (pause) takes priority over rule 2 (completed).
    const sched = makeSched({
      id: "s8",
      runCount: 4,
      consecutiveFailures: FAILURE_PAUSE_THRESHOLD - 1,
      spec: { intervalMinutes: 60, maxRuns: 5 },
    });
    const patch = applyOutcome(sched, "failed");
    expect(patch.runCount).toBe(5);
    expect(patch.consecutiveFailures).toBe(FAILURE_PAUSE_THRESHOLD);
    // paused wins over completed — failure pause priority
    expect(patch.status).toBe("paused");
  });

  it("failed → status=completed when cap reached but cf still below threshold", () => {
    const sched = makeSched({
      id: "s9",
      runCount: 4,
      consecutiveFailures: 0,
      spec: { intervalMinutes: 60, maxRuns: 5 },
    });
    const patch = applyOutcome(sched, "failed");
    expect(patch.runCount).toBe(5);
    expect(patch.consecutiveFailures).toBe(1);
    expect(patch.status).toBe("completed");
  });
});
