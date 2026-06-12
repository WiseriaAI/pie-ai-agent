// src/lib/schedules/notify-onclick.test.ts
//
// TDD tests for Task 8.4: notification click routing + user-gesture fallback.
//
// handleScheduleNotificationClick(notificationId):
//   - sidePanel.open succeeds → unread NOT set
//   - sidePanel.open throws (user-gesture constraint) → updateRun(unread:true)
//   - non "schedule-run:" prefix → no-op
//
// Also tests Task 8.5 cascade: instances.ts cascadeInstanceDelete
// → notifySchedulePaused called for each affected active schedule.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import type { ScheduleRecord } from "./types";

// ── chrome mocks ──────────────────────────────────────────────────────────────

function makeNotificationsMock() {
  return {
    create: vi.fn((_id: string, _opts: object, callback?: () => void) => { callback?.(); }),
    clear: vi.fn(),
    onClicked: { addListener: vi.fn() },
  };
}

beforeEach(async () => {
  await _resetForTests();
  (globalThis as unknown as { chrome: { notifications: ReturnType<typeof makeNotificationsMock>; sidePanel: { open: ReturnType<typeof vi.fn> }; windows: { getCurrent: ReturnType<typeof vi.fn> }; alarms: { clear: ReturnType<typeof vi.fn> } } })
    .chrome.notifications = makeNotificationsMock();
  // Default: sidePanel.open resolves (success)
  (globalThis as unknown as { chrome: { sidePanel: { open: ReturnType<typeof vi.fn> } } })
    .chrome.sidePanel = { open: vi.fn().mockResolvedValue(undefined) };
  // chrome.windows.getCurrent mock — returns a window with id=1
  (globalThis as unknown as { chrome: { windows: { getCurrent: ReturnType<typeof vi.fn> } } })
    .chrome.windows = { getCurrent: vi.fn().mockResolvedValue({ id: 1 }) };
  // chrome.alarms.clear mock — needed by disarmSchedule in cascadeInstanceDelete
  (globalThis as unknown as { chrome: { alarms: { clear: ReturnType<typeof vi.fn> } } })
    .chrome.alarms = { clear: vi.fn().mockResolvedValue(undefined) };
});

// ── handleScheduleNotificationClick ───────────────────────────────────────────

describe("handleScheduleNotificationClick (Task 8.4)", () => {
  it("sidePanel.open 成功 → unread フラグ設定されない", async () => {
    const { putSchedule, appendRun, getRun } = await import("./store");
    const { newRunId } = await import("./types");
    const { handleScheduleNotificationClick } = await import("./notify");

    // Seed a schedule + run
    const schedId = "sched_click_ok";
    const recordId = newRunId();
    await putSchedule({
      id: schedId,
      title: "Test",
      prompt: "p",
      spec: {},
      instanceId: "inst_1",
      enabled: true,
      status: "active",
      createdAt: 1000,
      runCount: 1,
      consecutiveFailures: 0,
      runIds: [recordId],
    });
    await appendRun(schedId, {
      recordId,
      scheduleId: schedId,
      runIndex: 1,
      sessionId: "sess_ok",
      startedAt: 1000,
      status: "success",
    });

    // sidePanel.open resolves — no error
    const spOpen = vi.fn().mockResolvedValue(undefined);
    (globalThis as unknown as { chrome: { sidePanel: { open: ReturnType<typeof vi.fn> } } })
      .chrome.sidePanel.open = spOpen;

    await handleScheduleNotificationClick(`schedule-run:${recordId}`);

    // sidePanel.open must actually have been attempted with the current window id
    // (windows.getCurrent mock returns { id: 1 } in beforeEach).
    expect(spOpen).toHaveBeenCalledWith({ windowId: 1 });

    const run = await getRun(recordId);
    // unread should NOT be set (or remain falsy)
    expect(run!.unread).toBeFalsy();
  });

  it("sidePanel.open 例外 → updateRun(unread:true) が呼ばれる", async () => {
    const { putSchedule, appendRun, getRun } = await import("./store");
    const { newRunId } = await import("./types");
    const { handleScheduleNotificationClick } = await import("./notify");

    const schedId = "sched_click_fail";
    const recordId = newRunId();
    await putSchedule({
      id: schedId,
      title: "Test",
      prompt: "p",
      spec: {},
      instanceId: "inst_1",
      enabled: true,
      status: "active",
      createdAt: 1000,
      runCount: 1,
      consecutiveFailures: 0,
      runIds: [recordId],
    });
    await appendRun(schedId, {
      recordId,
      scheduleId: schedId,
      runIndex: 1,
      sessionId: "sess_fail",
      startedAt: 1000,
      status: "success",
    });

    // sidePanel.open throws — simulating user-gesture constraint
    (globalThis as unknown as { chrome: { sidePanel: { open: ReturnType<typeof vi.fn> } } })
      .chrome.sidePanel.open = vi.fn().mockRejectedValue(
        new Error("sidePanel.open requires user gesture"),
      );

    await handleScheduleNotificationClick(`schedule-run:${recordId}`);

    const run = await getRun(recordId);
    expect(run!.unread).toBe(true);
  });

  it("getCurrent が numeric id を返さない → unread:true（降級でも黙って吞まない）", async () => {
    const { putSchedule, appendRun, getRun } = await import("./store");
    const { newRunId } = await import("./types");
    const { handleScheduleNotificationClick } = await import("./notify");

    const schedId = "sched_no_winid";
    const recordId = newRunId();
    await putSchedule({
      id: schedId,
      title: "Test",
      prompt: "p",
      spec: {},
      instanceId: "inst_1",
      enabled: true,
      status: "active",
      createdAt: 1000,
      runCount: 1,
      consecutiveFailures: 0,
      runIds: [recordId],
    });
    await appendRun(schedId, {
      recordId,
      scheduleId: schedId,
      runIndex: 1,
      sessionId: "sess_no_winid",
      startedAt: 1000,
      status: "success",
    });

    // getCurrent returns a window without a numeric id — sidePanel.open can't run.
    (globalThis as unknown as { chrome: { windows: { getCurrent: ReturnType<typeof vi.fn> } } })
      .chrome.windows.getCurrent = vi.fn().mockResolvedValue({ id: undefined });
    const spOpen = vi.fn().mockResolvedValue(undefined);
    (globalThis as unknown as { chrome: { sidePanel: { open: ReturnType<typeof vi.fn> } } })
      .chrome.sidePanel.open = spOpen;

    await handleScheduleNotificationClick(`schedule-run:${recordId}`);

    // sidePanel.open must NOT have been called (no window id to target) ...
    expect(spOpen).not.toHaveBeenCalled();
    // ... but the click must still leave a trace: unread set.
    const run = await getRun(recordId);
    expect(run!.unread).toBe(true);
  });

  it("非 schedule-run: プレフィックス → 何もしない（エラーも出さない）", async () => {
    const { handleScheduleNotificationClick } = await import("./notify");

    // Should not throw
    await expect(
      handleScheduleNotificationClick("some-other-notification"),
    ).resolves.not.toThrow();

    // sidePanel.open should NOT have been called
    const spOpen = (globalThis as unknown as { chrome: { sidePanel: { open: ReturnType<typeof vi.fn> } } })
      .chrome.sidePanel.open;
    expect(spOpen).not.toHaveBeenCalled();
  });

  it("recordId が存在しない run → エラーなくリターン", async () => {
    const { handleScheduleNotificationClick } = await import("./notify");

    await expect(
      handleScheduleNotificationClick("schedule-run:run_nonexistent"),
    ).resolves.not.toThrow();
  });
});

// ── Task 8.5: cascadeInstanceDelete → notifySchedulePaused ───────────────────

describe("cascadeInstanceDelete → notifySchedulePaused (Task 8.5)", () => {
  function makeSched(overrides: Partial<ScheduleRecord> & { id: string }): ScheduleRecord {
    const defaults: ScheduleRecord = {
      id: overrides.id,
      title: "Test Schedule",
      prompt: "p",
      spec: {},
      instanceId: "inst_cascade",
      enabled: true,
      status: "active",
      createdAt: 1000,
      runCount: 0,
      consecutiveFailures: 0,
      runIds: [],
    };
    return { ...defaults, ...overrides };
  }

  it("active schedule がある instance を削除 → notifySchedulePaused が呼ばれる", async () => {
    const { putSchedule } = await import("./store");
    const { cascadeInstanceDelete } = await import("@/lib/instances");

    await putSchedule(makeSched({ id: "sched_casc_1", title: "Cascade Test", instanceId: "inst_cascade" }));

    await cascadeInstanceDelete("inst_cascade");

    const mock = (globalThis as unknown as { chrome: { notifications: ReturnType<typeof makeNotificationsMock> } })
      .chrome.notifications;
    expect(mock.create).toHaveBeenCalledOnce();
    const [notifId, opts] = mock.create.mock.calls[0]!;
    expect(notifId).toBe("schedule-paused:sched_casc_1");
    expect((opts as { title: string; message: string }).title + (opts as { title: string; message: string }).message)
      .toContain("Cascade Test");
  });

  it("paused schedule は通知対象外", async () => {
    const { putSchedule } = await import("./store");
    const { cascadeInstanceDelete } = await import("@/lib/instances");

    await putSchedule(makeSched({ id: "sched_casc_already_paused", instanceId: "inst_casc2", status: "paused" }));

    await cascadeInstanceDelete("inst_casc2");

    const mock = (globalThis as unknown as { chrome: { notifications: ReturnType<typeof makeNotificationsMock> } })
      .chrome.notifications;
    expect(mock.create).not.toHaveBeenCalled();
  });

  it("複数の active schedules → それぞれ通知される", async () => {
    const { putSchedule } = await import("./store");
    const { cascadeInstanceDelete } = await import("@/lib/instances");

    await putSchedule(makeSched({ id: "sched_multi_1", title: "Schedule A", instanceId: "inst_multi" }));
    await putSchedule(makeSched({ id: "sched_multi_2", title: "Schedule B", instanceId: "inst_multi" }));

    await cascadeInstanceDelete("inst_multi");

    const mock = (globalThis as unknown as { chrome: { notifications: ReturnType<typeof makeNotificationsMock> } })
      .chrome.notifications;
    expect(mock.create).toHaveBeenCalledTimes(2);
    const ids = mock.create.mock.calls.map((c) => c[0]);
    expect(ids).toContain("schedule-paused:sched_multi_1");
    expect(ids).toContain("schedule-paused:sched_multi_2");
  });
});
