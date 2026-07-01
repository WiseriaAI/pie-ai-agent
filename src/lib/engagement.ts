// Local-only engagement tracking for the review/star nudge (issue #244).
//
// Everything here is single-machine: the extension is BYOK, most users never
// sign in, so there is no account dimension to attach activity to. State lives
// in a single IndexedDB `config` key (`engagement`) via getConfig/setConfig.
//
// The state-machine and counter logic are pure functions (given `now` / `today`)
// so they unit-test without chrome/DOM — the same injected-env style as
// feedback.ts. The only IO wrapper is bumpEngagement(), called fire-and-forget
// from sendMessage.

import { getConfig, setConfig } from "./idb/config-store";

export const ENGAGEMENT_KEY = "engagement";

/** 30 days in milliseconds — the snooze window after the user dismisses (×). */
export const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

/** Trigger thresholds (aggressive tier, tunable). `activeDays` is the primary
 *  gate so "sent a burst on day one then never returned" users don't qualify. */
export const THRESHOLD_ACTIVE_DAYS = 2;
export const THRESHOLD_MESSAGE_COUNT = 8;

export type PromptState = "pending" | "snoozed" | "done";

export interface Engagement {
  /** Cumulative count of user-sent messages. */
  messageCount: number;
  /** Number of distinct local calendar days the user has been active. */
  activeDays: number;
  /** Last active local date "YYYY-MM-DD", used to detect a day rollover. */
  lastActiveDay: string;
  /** Nudge state-machine position. */
  promptState: PromptState;
  /** Epoch ms when a `snoozed` prompt becomes eligible again. */
  snoozeUntil: number;
  /** How many times the user clicked × (snooze). Two → forced done. */
  timesSnoozed: number;
}

export function defaultEngagement(): Engagement {
  return {
    messageCount: 0,
    activeDays: 0,
    lastActiveDay: "",
    promptState: "pending",
    snoozeUntil: 0,
    timesSnoozed: 0,
  };
}

/** Local "YYYY-MM-DD" for an epoch-ms instant. Pure given `now`. */
export function todayLocal(now: number): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Pure counter bump: +1 message always; +1 active day on a date rollover. */
export function bumpEngagementState(prev: Engagement, today: string): Engagement {
  const crossedDay = today !== prev.lastActiveDay;
  return {
    ...prev,
    messageCount: prev.messageCount + 1,
    activeDays: crossedDay ? prev.activeDays + 1 : prev.activeDays,
    lastActiveDay: crossedDay ? today : prev.lastActiveDay,
  };
}

/** Whether the activity thresholds have been met. */
export function thresholdMet(e: Engagement): boolean {
  return (
    e.activeDays >= THRESHOLD_ACTIVE_DAYS &&
    e.messageCount >= THRESHOLD_MESSAGE_COUNT
  );
}

/** Pure eligibility check. Callers still gate on `!streaming` and on there
 *  being no higher-priority card (error / file-access) before showing. */
export function shouldShow(e: Engagement, now: number): boolean {
  if (!thresholdMet(e)) return false;
  switch (e.promptState) {
    case "done":
      return false;
    case "pending":
      return true;
    case "snoozed":
      return now > e.snoozeUntil;
  }
}

/** User clicked a CTA (rate / star) → never nag again. */
export function markDone(e: Engagement): Engagement {
  return { ...e, promptState: "done" };
}

/** User clicked × ("maybe later"). First time → snooze 30 days; the second
 *  dismissal flips to done, so a user is nudged at most ~2 times. */
export function applyDismiss(e: Engagement, now: number): Engagement {
  const timesSnoozed = e.timesSnoozed + 1;
  if (timesSnoozed >= 2) {
    return { ...e, timesSnoozed, promptState: "done" };
  }
  return {
    ...e,
    timesSnoozed,
    promptState: "snoozed",
    snoozeUntil: now + SNOOZE_MS,
  };
}

// ── IO wrappers ────────────────────────────────────────────────────────────

/** Read current engagement, defaulting a missing record. */
export async function getEngagement(): Promise<Engagement> {
  const stored = await getConfig<Engagement>(ENGAGEMENT_KEY);
  return stored ?? defaultEngagement();
}

/** Fire-and-forget counter bump on each user send. Approximate counting is
 *  fine (no lock): a lost race at most delays the nudge by one message. */
export async function bumpEngagement(now: number = Date.now()): Promise<void> {
  const prev = await getEngagement();
  const next = bumpEngagementState(prev, todayLocal(now));
  await setConfig(ENGAGEMENT_KEY, next);
}

/** Persist a new engagement state (used by the popup's CTA / dismiss handlers). */
export async function saveEngagement(e: Engagement): Promise<void> {
  await setConfig(ENGAGEMENT_KEY, e);
}
