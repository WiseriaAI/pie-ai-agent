import { describe, it, expect } from "vitest";
import {
  defaultEngagement,
  todayLocal,
  bumpEngagementState,
  thresholdMet,
  shouldShow,
  markDone,
  applyDismiss,
  SNOOZE_MS,
  THRESHOLD_ACTIVE_DAYS,
  THRESHOLD_MESSAGE_COUNT,
  type Engagement,
} from "./engagement";

// A fixed instant: 2026-07-01 12:00 local.
const T0 = new Date(2026, 6, 1, 12, 0, 0).getTime();
const NEXT_DAY = new Date(2026, 6, 2, 9, 0, 0).getTime();

function atThreshold(overrides: Partial<Engagement> = {}): Engagement {
  return {
    ...defaultEngagement(),
    activeDays: THRESHOLD_ACTIVE_DAYS,
    messageCount: THRESHOLD_MESSAGE_COUNT,
    ...overrides,
  };
}

describe("todayLocal", () => {
  it("formats YYYY-MM-DD in local time", () => {
    expect(todayLocal(T0)).toBe("2026-07-01");
    expect(todayLocal(NEXT_DAY)).toBe("2026-07-02");
  });
});

describe("bumpEngagementState", () => {
  it("increments messageCount every call", () => {
    const e0 = defaultEngagement();
    const e1 = bumpEngagementState(e0, "2026-07-01");
    expect(e1.messageCount).toBe(1);
    const e2 = bumpEngagementState(e1, "2026-07-01");
    expect(e2.messageCount).toBe(2);
  });

  it("increments activeDays and updates lastActiveDay on a day rollover", () => {
    const e1 = bumpEngagementState(defaultEngagement(), "2026-07-01");
    expect(e1.activeDays).toBe(1);
    expect(e1.lastActiveDay).toBe("2026-07-01");
    const e2 = bumpEngagementState(e1, "2026-07-02");
    expect(e2.activeDays).toBe(2);
    expect(e2.lastActiveDay).toBe("2026-07-02");
  });

  it("does not increment activeDays within the same day", () => {
    const e1 = bumpEngagementState(defaultEngagement(), "2026-07-01");
    const e2 = bumpEngagementState(e1, "2026-07-01");
    expect(e2.activeDays).toBe(1);
    expect(e2.messageCount).toBe(2);
  });
});

describe("thresholdMet / shouldShow gating", () => {
  it("is false below either threshold", () => {
    expect(thresholdMet(atThreshold({ activeDays: 1 }))).toBe(false);
    expect(thresholdMet(atThreshold({ messageCount: 7 }))).toBe(false);
    expect(shouldShow(atThreshold({ activeDays: 1 }), T0)).toBe(false);
    expect(shouldShow(atThreshold({ messageCount: 7 }), T0)).toBe(false);
  });

  it("shows when threshold met and state is pending", () => {
    expect(shouldShow(atThreshold(), T0)).toBe(true);
  });

  it("never shows once done", () => {
    expect(shouldShow(atThreshold({ promptState: "done" }), T0)).toBe(false);
  });
});

describe("dismiss / snooze state-machine", () => {
  it("first dismiss snoozes for 30 days, hidden within window, shown after", () => {
    const snoozed = applyDismiss(atThreshold({ promptState: "pending" }), T0);
    expect(snoozed.promptState).toBe("snoozed");
    expect(snoozed.timesSnoozed).toBe(1);
    expect(snoozed.snoozeUntil).toBe(T0 + SNOOZE_MS);

    // Within the snooze window → hidden.
    expect(shouldShow(snoozed, T0 + SNOOZE_MS - 1)).toBe(false);
    // After the window → shown again.
    expect(shouldShow(snoozed, T0 + SNOOZE_MS + 1)).toBe(true);
  });

  it("second dismiss flips to done permanently", () => {
    const first = applyDismiss(atThreshold(), T0);
    const second = applyDismiss(first, T0 + SNOOZE_MS + 1000);
    expect(second.promptState).toBe("done");
    expect(second.timesSnoozed).toBe(2);
    expect(shouldShow(second, second.snoozeUntil + SNOOZE_MS)).toBe(false);
  });
});

describe("markDone", () => {
  it("clicking a CTA marks done and it never shows again", () => {
    const done = markDone(atThreshold());
    expect(done.promptState).toBe("done");
    expect(shouldShow(done, T0)).toBe(false);
  });
});
