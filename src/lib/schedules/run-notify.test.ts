// src/lib/schedules/run-notify.test.ts
//
// TDD tests for Task 8.3: run.ts wires notifyRunDone after run completion.
//
// success / failed → notifyRunDone called
// skipped / interrupted → notifyRunDone NOT called
// notifyRunDone throwing does NOT affect run counters / outcome

import { describe, it, expect, vi, beforeEach } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import type { ScheduleRecord } from "./types";
import type { ModelConfig } from "@/lib/model-router";
import type { AgentLoopContext } from "@/lib/agent/loop";
import type { DecryptedInstance } from "@/lib/instances";
import type { RunDeps } from "./run";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSched(overrides: Partial<ScheduleRecord> & { id: string }): ScheduleRecord {
  const defaults: ScheduleRecord = {
    id: overrides.id,
    title: "Notify Test Schedule",
    prompt: "do something",
    spec: { intervalMinutes: 60 },
    instanceId: "inst_1",
    enabled: true,
    status: "active",
    createdAt: 1000,
    runCount: 0,
    consecutiveFailures: 0,
    runIds: [],
  };
  return { ...defaults, ...overrides };
}

const FAKE_CFG: ModelConfig = {
  provider: "anthropic",
  model: "claude-3-5-haiku-20241022",
  apiKey: "test-key",
  providerName: "Anthropic",
};

const FAKE_INSTANCE: DecryptedInstance = {
  id: "inst_1",
  provider: "anthropic",
  nickname: "Test",
  apiKey: "test-key",
  createdAt: 1000,
};

function doneLoop(opts: { success: boolean; summary: string }) {
  return vi.fn(async (ctx: AgentLoopContext) => {
    ctx.emit({
      type: "agent-done-task",
      success: opts.success,
      summary: opts.summary,
      stepCount: 1,
      sessionId: ctx.sessionId,
    });
  });
}

function okDeps(overrides: Partial<RunDeps> = {}): RunDeps {
  return {
    runAgentLoop: doneLoop({ success: true, summary: "done" }),
    getInstance: vi.fn(async () => FAKE_INSTANCE),
    firstModelForProvider: vi.fn(async () => "claude-3-5-haiku-20241022"),
    resolveModelConfig: vi.fn(async () => FAKE_CFG),
    ...overrides,
  };
}

// ── chrome.notifications mock ─────────────────────────────────────────────────

function makeNotificationsMock() {
  return {
    create: vi.fn((_id: string, _opts: object, callback?: () => void) => {
      callback?.();
    }),
    clear: vi.fn(),
    onClicked: { addListener: vi.fn() },
  };
}

beforeEach(async () => {
  await _resetForTests();
  // Reset notifications mock between tests (same pattern as chrome.tabs in run.test.ts)
  (globalThis as unknown as { chrome: { notifications: ReturnType<typeof makeNotificationsMock> } })
    .chrome.notifications = makeNotificationsMock();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runSchedule + notifyRunDone integration (Task 8.3)", () => {
  it("success → notifyRunDone が呼ばれる（notifications.create に schedule-run:recordId）", async () => {
    const { putSchedule, getSchedule } = await import("./store");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({ id: "sched_notify_ok" }));

    await runSchedule("sched_notify_ok", okDeps());

    const s = await getSchedule("sched_notify_ok");
    expect(s!.runIds.length).toBe(1);
    const recordId = s!.runIds[0]!;

    const mock = (globalThis as unknown as { chrome: { notifications: ReturnType<typeof makeNotificationsMock> } })
      .chrome.notifications;
    expect(mock.create).toHaveBeenCalledOnce();
    expect(mock.create.mock.calls[0]![0]).toBe(`schedule-run:${recordId}`);
  });

  it("failed → notifyRunDone が呼ばれる", async () => {
    const { putSchedule, getSchedule } = await import("./store");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({ id: "sched_notify_fail" }));

    await runSchedule(
      "sched_notify_fail",
      okDeps({ runAgentLoop: doneLoop({ success: false, summary: "task failed" }) }),
    );

    const s = await getSchedule("sched_notify_fail");
    const recordId = s!.runIds[0]!;

    const mock = (globalThis as unknown as { chrome: { notifications: ReturnType<typeof makeNotificationsMock> } })
      .chrome.notifications;
    expect(mock.create).toHaveBeenCalledOnce();
    expect(mock.create.mock.calls[0]![0]).toBe(`schedule-run:${recordId}`);
  });

  it("skipped → notifyRunDone が呼ばれない", async () => {
    const { putSchedule, appendRun } = await import("./store");
    const { newRunId } = await import("./types");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({ id: "sched_skip_notify" }));
    // Seed a running run to trigger skip-if-running
    const existingRunId = newRunId();
    await appendRun("sched_skip_notify", {
      recordId: existingRunId,
      scheduleId: "sched_skip_notify",
      runIndex: 1,
      startedAt: Date.now(),
      status: "running",
    });

    await runSchedule("sched_skip_notify", okDeps());

    const mock = (globalThis as unknown as { chrome: { notifications: ReturnType<typeof makeNotificationsMock> } })
      .chrome.notifications;
    expect(mock.create).not.toHaveBeenCalled();
  });

  it("notifyRunDone が例外を throw しても run counters は正しく更新される", async () => {
    const { putSchedule, getSchedule } = await import("./store");
    const { runSchedule } = await import("./run");

    // Make notifications.create throw
    (globalThis as unknown as { chrome: { notifications: ReturnType<typeof makeNotificationsMock> } })
      .chrome.notifications.create = vi.fn(() => { throw new Error("notifications unavailable"); });

    await putSchedule(makeSched({ id: "sched_notify_err", runCount: 0, consecutiveFailures: 0 }));

    await runSchedule("sched_notify_err", okDeps());

    const s = await getSchedule("sched_notify_err");
    // Run should still have been counted (notification failure is non-fatal)
    expect(s!.runCount).toBe(1);
    expect(s!.runIds.length).toBe(1);
  });

  it("early-fail (instance unavailable) → notifyRunDone(failed) が呼ばれる", async () => {
    const { putSchedule } = await import("./store");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({ id: "sched_earlyfail_notify" }));

    // getInstance → null triggers the early-fail path (no session, no loop).
    await runSchedule("sched_earlyfail_notify", okDeps({ getInstance: async () => null }));

    const mock = (globalThis as unknown as { chrome: { notifications: ReturnType<typeof makeNotificationsMock> } })
      .chrome.notifications;
    // One per-run failed notification (schedule-run:); no transition (cf only 1).
    const runCalls = mock.create.mock.calls.filter((c) => String(c[0]).startsWith("schedule-run:"));
    expect(runCalls.length).toBe(1);
  });
});

// ── Task 8.1 (transition notifications, spec §9/§11) ─────────────────────────

describe("runSchedule transition notifications (Task 8.1 §9/§11)", () => {
  function notifMock() {
    return (globalThis as unknown as { chrome: { notifications: ReturnType<typeof makeNotificationsMock> } })
      .chrome.notifications;
  }
  function notifIds(): string[] {
    return notifMock().create.mock.calls.map((c) => String(c[0]));
  }

  it("auto-pause 転移 (cf 2→3) → schedule-paused 通知 + per-run 通知 が両方発火", async () => {
    const { putSchedule, getSchedule } = await import("./store");
    const { runSchedule } = await import("./run");

    // cf=2 → one more failure pushes cf to 3 → status active → paused.
    await putSchedule(makeSched({ id: "sched_trans_pause", runCount: 2, consecutiveFailures: 2 }));

    await runSchedule(
      "sched_trans_pause",
      okDeps({ runAgentLoop: doneLoop({ success: false, summary: "fail again" }) }),
    );

    const s = await getSchedule("sched_trans_pause");
    expect(s!.status).toBe("paused");

    const ids = notifIds();
    // Per-run failure notification.
    expect(ids.some((id) => id.startsWith("schedule-run:"))).toBe(true);
    // Schedule auto-pause transition notification.
    expect(ids).toContain("schedule-paused:sched_trans_pause");
  });

  it("completed 転移 (runCount 4→5 maxRuns=5) → schedule-completed 通知 + per-run 通知", async () => {
    const { putSchedule, getSchedule } = await import("./store");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({
      id: "sched_trans_complete",
      runCount: 4,
      consecutiveFailures: 0,
      spec: { intervalMinutes: 60, maxRuns: 5 },
    }));

    await runSchedule("sched_trans_complete", okDeps());

    const s = await getSchedule("sched_trans_complete");
    expect(s!.status).toBe("completed");

    const ids = notifIds();
    expect(ids.some((id) => id.startsWith("schedule-run:"))).toBe(true);
    expect(ids).toContain("schedule-completed:sched_trans_complete");
  });

  it("status 転移なし (普通の failed, cf 0→1) → 転移通知は発火しない（per-run のみ）", async () => {
    const { putSchedule, getSchedule } = await import("./store");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({ id: "sched_notrans", runCount: 0, consecutiveFailures: 0 }));

    await runSchedule(
      "sched_notrans",
      okDeps({ runAgentLoop: doneLoop({ success: false, summary: "one fail" }) }),
    );

    const s = await getSchedule("sched_notrans");
    expect(s!.status).toBe("active");

    const ids = notifIds();
    // Only the per-run notification; no paused/completed transition.
    expect(ids.some((id) => id.startsWith("schedule-run:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("schedule-paused:"))).toBe(false);
    expect(ids.some((id) => id.startsWith("schedule-completed:"))).toBe(false);
  });

  it("success 転移なし (active のまま) → 転移通知なし", async () => {
    const { putSchedule, getSchedule } = await import("./store");
    const { runSchedule } = await import("./run");

    await putSchedule(makeSched({ id: "sched_succ_notrans", runCount: 0, consecutiveFailures: 0 }));

    await runSchedule("sched_succ_notrans", okDeps());

    const s = await getSchedule("sched_succ_notrans");
    expect(s!.status).toBe("active");

    const ids = notifIds();
    expect(ids.some((id) => id.startsWith("schedule-paused:"))).toBe(false);
    expect(ids.some((id) => id.startsWith("schedule-completed:"))).toBe(false);
  });
});
