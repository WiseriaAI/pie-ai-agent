// src/lib/schedules/notify.test.ts
//
// TDD tests for Task 8: chrome.notifications-based run-done + schedule-paused
// notifications. All chrome.notifications calls reach the ambient chrome global
// (same pattern as run.ts → chrome.tabs); tests mock globalThis.chrome.
//
// Covers:
//   8.2 — notifyRunDone: success / failed → notifications.create called with
//         correct notificationId encoding + title + message snippets.
//   8.5 — notifySchedulePaused: notifications.create called for paused schedule.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { _resetForTests } from "@/lib/idb/db";

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
  // Reset notifications mock between tests
  (globalThis as unknown as { chrome: { notifications: ReturnType<typeof makeNotificationsMock> } })
    .chrome.notifications = makeNotificationsMock();
});

// ── notifyRunDone ──────────────────────────────────────────────────────────────

describe("notifyRunDone", () => {
  it("success: notifications.create 呼ばれる、notificationId に recordId を含む", async () => {
    const { notifyRunDone } = await import("./notify");

    await notifyRunDone({
      recordId: "run_abc123",
      sessionId: "sess_1",
      status: "success",
      summary: "Task completed successfully",
      scheduleTitle: "Daily Report",
    });

    const mock = (globalThis as unknown as { chrome: { notifications: ReturnType<typeof makeNotificationsMock> } })
      .chrome.notifications;
    expect(mock.create).toHaveBeenCalledOnce();
    const [notifId, opts] = mock.create.mock.calls[0]!;
    expect(notifId).toBe("schedule-run:run_abc123");
    expect((opts as { title: string }).title).toContain("Daily Report");
    expect((opts as { message: string }).message).toContain("Task completed successfully");
  });

  it("failed: notifications.create 呼ばれる、title に失敗を示す文字列を含む", async () => {
    const { notifyRunDone } = await import("./notify");

    await notifyRunDone({
      recordId: "run_fail1",
      sessionId: "sess_2",
      status: "failed",
      summary: "Something went wrong",
      scheduleTitle: "My Schedule",
    });

    const mock = (globalThis as unknown as { chrome: { notifications: ReturnType<typeof makeNotificationsMock> } })
      .chrome.notifications;
    expect(mock.create).toHaveBeenCalledOnce();
    const [notifId, opts] = mock.create.mock.calls[0]!;
    expect(notifId).toBe("schedule-run:run_fail1");
    // title should indicate failure
    const title = (opts as { title: string }).title;
    expect(title).toMatch(/fail|失败|错误|Error/i);
  });

  it("summary が長い場合は truncate される", async () => {
    const { notifyRunDone } = await import("./notify");

    const longSummary = "x".repeat(300);
    await notifyRunDone({
      recordId: "run_long",
      sessionId: "sess_3",
      status: "success",
      summary: longSummary,
      scheduleTitle: "Long Summary Schedule",
    });

    const mock = (globalThis as unknown as { chrome: { notifications: ReturnType<typeof makeNotificationsMock> } })
      .chrome.notifications;
    const [, opts] = mock.create.mock.calls[0]!;
    // message should be shorter than the raw summary
    expect((opts as { message: string }).message.length).toBeLessThan(300);
  });

  it("notifications.create が例外を throw しても runSchedule 全体を壊さない（try/catch 済み）", async () => {
    const { notifyRunDone } = await import("./notify");

    (globalThis as unknown as { chrome: { notifications: ReturnType<typeof makeNotificationsMock> } })
      .chrome.notifications.create = vi.fn(() => { throw new Error("notifications API unavailable"); });

    // Should NOT throw
    await expect(notifyRunDone({
      recordId: "run_err",
      sessionId: "sess_4",
      status: "success",
      summary: "done",
      scheduleTitle: "Test",
    })).resolves.not.toThrow();
  });
});

// ── notifySchedulePaused ───────────────────────────────────────────────────────

describe("notifySchedulePaused", () => {
  it("notifications.create 呼ばれる、notificationId に scheduleId を含む", async () => {
    const { notifySchedulePaused } = await import("./notify");

    await notifySchedulePaused({
      scheduleId: "sched_xyz",
      scheduleTitle: "Hourly Backup",
      reason: "instance_deleted",
    });

    const mock = (globalThis as unknown as { chrome: { notifications: ReturnType<typeof makeNotificationsMock> } })
      .chrome.notifications;
    expect(mock.create).toHaveBeenCalledOnce();
    const [notifId, opts] = mock.create.mock.calls[0]!;
    expect(notifId).toBe("schedule-paused:sched_xyz");
    expect((opts as { title: string; message: string }).title + (opts as { title: string; message: string }).message)
      .toContain("Hourly Backup");
  });

  it("例外でも throw しない（try/catch 済み）", async () => {
    const { notifySchedulePaused } = await import("./notify");

    (globalThis as unknown as { chrome: { notifications: ReturnType<typeof makeNotificationsMock> } })
      .chrome.notifications.create = vi.fn(() => { throw new Error("no notifications"); });

    await expect(notifySchedulePaused({
      scheduleId: "sched_err",
      scheduleTitle: "Test",
      reason: "instance_deleted",
    })).resolves.not.toThrow();
  });
});

// ── notifyScheduleStatusChange (Task 8.1 transition notifications) ─────────────

describe("notifyScheduleStatusChange", () => {
  it("paused (auto_pause_failures) → schedule-paused:<id> + 失敗回数を含む", async () => {
    const { notifyScheduleStatusChange } = await import("./notify");

    await notifyScheduleStatusChange({
      scheduleId: "sched_p",
      scheduleTitle: "Flaky Job",
      status: "paused",
      reason: "auto_pause_failures",
      count: 3,
    });

    const mock = (globalThis as unknown as { chrome: { notifications: ReturnType<typeof makeNotificationsMock> } })
      .chrome.notifications;
    expect(mock.create).toHaveBeenCalledOnce();
    const [notifId, opts] = mock.create.mock.calls[0]!;
    expect(notifId).toBe("schedule-paused:sched_p");
    const text = (opts as { title: string; message: string }).title + (opts as { title: string; message: string }).message;
    expect(text).toContain("Flaky Job");
    expect(text).toContain("3");
  });

  it("completed (max_runs_reached) → schedule-completed:<id> + 実行回数を含む", async () => {
    const { notifyScheduleStatusChange } = await import("./notify");

    await notifyScheduleStatusChange({
      scheduleId: "sched_c",
      scheduleTitle: "Daily Digest",
      status: "completed",
      reason: "max_runs_reached",
      count: 5,
    });

    const mock = (globalThis as unknown as { chrome: { notifications: ReturnType<typeof makeNotificationsMock> } })
      .chrome.notifications;
    expect(mock.create).toHaveBeenCalledOnce();
    const [notifId, opts] = mock.create.mock.calls[0]!;
    expect(notifId).toBe("schedule-completed:sched_c");
    const text = (opts as { title: string; message: string }).title + (opts as { title: string; message: string }).message;
    expect(text).toContain("Daily Digest");
    expect(text).toContain("5");
  });

  it("例外でも throw しない（try/catch 済み）", async () => {
    const { notifyScheduleStatusChange } = await import("./notify");

    (globalThis as unknown as { chrome: { notifications: ReturnType<typeof makeNotificationsMock> } })
      .chrome.notifications.create = vi.fn(() => { throw new Error("no notifications"); });

    await expect(notifyScheduleStatusChange({
      scheduleId: "sched_err",
      scheduleTitle: "Test",
      status: "completed",
      reason: "max_runs_reached",
      count: 1,
    })).resolves.not.toThrow();
  });
});
