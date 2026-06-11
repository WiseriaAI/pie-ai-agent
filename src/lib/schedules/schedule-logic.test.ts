// src/lib/schedules/schedule-logic.test.ts
//
// TDD tests for the pure scheduling functions (Task 4.1). These carry NO chrome
// dependency and take time via parameters (never Date.now()) so firing/anchor
// math is deterministic.

import { describe, expect, it } from "vitest";
import type { ScheduleSpec } from "./types";
import { computeFirstFireAt, computeNextFireAt } from "./schedule-logic";

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
