// src/lib/schedules/notify.ts
//
// Task 8 — chrome.notifications helpers for schedule run completions and
// schedule lifecycle transitions.
//
// Design:
//   - notifyRunDone: called at end of a success/failed run in run.ts. Per-run
//     semantics ("this run succeeded/failed").
//   - notifyScheduleStatusChange: called in run.ts when a run's outcome
//     transitions the SCHEDULE itself (active → paused on consecutiveFailures
//     ≥ threshold, or active → completed on runCount ≥ maxRuns). Distinct from
//     per-run: "the whole schedule was auto-paused / finished all runs" (spec
//     §9/§11). Coexists with notifyRunDone for the same terminal run.
//   - notifySchedulePaused: called in cascadeInstanceDelete (instances.ts)
//     when an active schedule is auto-paused because its bound instance was
//     deleted (a different cause than consecutive-failure auto-pause).
//   - handleScheduleNotificationClick: called from the SW's
//     chrome.notifications.onClicked listener in background/index.ts.
//     Tries chrome.sidePanel.open (requires user gesture — may throw under
//     the Chrome user-gesture constraint). If it throws, falls back to
//     marking the run `unread: true` so Task 9 UI can highlight it.
//
// All exported notify functions wrap their chrome API calls in try/catch so a
// broken notifications API never crashes the schedule run or the cascade delete.

import { getRun, updateRun } from "./store";

// ── Notification ID prefixes ────────────────────────────────────────────────

export const RUN_NOTIF_PREFIX = "schedule-run:";
export const PAUSED_NOTIF_PREFIX = "schedule-paused:";
export const COMPLETED_NOTIF_PREFIX = "schedule-completed:";

// ── Icon ───────────────────────────────────────────────────────────────────

// chrome.runtime.getURL resolves the extension-relative path to an absolute
// extension URL. Used for the notification iconUrl. @crxjs emits public/ assets
// to the dist root, so the canonical path is "icons/icon-48.png" (no public/
// prefix) — matching Settings.tsx / ProviderIcon.tsx usage.
function iconUrl(): string {
  try {
    return chrome.runtime.getURL("icons/icon-48.png");
  } catch {
    return "";
  }
}

// ── Shared create helper ─────────────────────────────────────────────────────

/**
 * Create a basic notification. Wrapped in try/catch so a broken / unpermissioned
 * notifications API is non-fatal for every caller (run accounting, cascade
 * delete, status transitions all stay correct even when notifications fail).
 */
async function createNotification(
  notificationId: string,
  title: string,
  message: string,
): Promise<void> {
  try {
    await new Promise<void>((resolve) => {
      chrome.notifications.create(
        notificationId,
        { type: "basic", iconUrl: iconUrl(), title, message },
        () => resolve(),
      );
    });
  } catch {
    // Notifications API unavailable or permission not granted — non-fatal.
  }
}

// ── notifyRunDone ───────────────────────────────────────────────────────────

export interface NotifyRunDoneOpts {
  recordId: string;
  sessionId: string;
  status: "success" | "failed";
  summary: string;
  scheduleTitle: string;
}

/**
 * Show a system notification when a schedule run ends (success or failed).
 * Never throws — wrapped in try/catch so a notifications API failure cannot
 * affect the run record's outcome counters in run.ts.
 */
export async function notifyRunDone(opts: NotifyRunDoneOpts): Promise<void> {
  const { recordId, status, summary, scheduleTitle } = opts;
  const succeeded = status === "success";

  const title = succeeded
    ? `✓ ${scheduleTitle}`
    : `✗ ${scheduleTitle} — Failed`;

  // Truncate summary so it fits in the notification message area (Chrome
  // clips long notification messages; 100 chars is a comfortable visible limit).
  const message = summary.slice(0, 100) || (succeeded ? "Run completed." : "Run failed.");

  await createNotification(`${RUN_NOTIF_PREFIX}${recordId}`, title, message);
}

// ── notifySchedulePaused ────────────────────────────────────────────────────

export interface NotifySchedulePausedOpts {
  scheduleId: string;
  scheduleTitle: string;
  reason: "instance_deleted";
}

/**
 * Show a system notification when a schedule is auto-paused due to its bound
 * instance being deleted. Called from cascadeInstanceDelete in instances.ts.
 * Distinct cause from consecutive-failure auto-pause (notifyScheduleStatusChange
 * with reason "auto_pause_failures"). Never throws.
 */
export async function notifySchedulePaused(opts: NotifySchedulePausedOpts): Promise<void> {
  const { scheduleId, scheduleTitle } = opts;
  const title = `Schedule Paused: ${scheduleTitle}`;
  const message = "The bound AI provider was removed. Re-enable it in Schedules.";
  await createNotification(`${PAUSED_NOTIF_PREFIX}${scheduleId}`, title, message);
}

// ── notifyScheduleStatusChange ───────────────────────────────────────────────

export interface NotifyScheduleStatusChangeOpts {
  scheduleId: string;
  scheduleTitle: string;
  /** The new (transitioned-into) schedule status. */
  status: "paused" | "completed";
  /** Why the transition happened — drives the message + counter context. */
  reason: "auto_pause_failures" | "max_runs_reached";
  /** consecutiveFailures (for auto_pause_failures) or runCount (for max_runs_reached). */
  count: number;
}

/**
 * Show a system notification when a run's outcome transitions the SCHEDULE
 * itself (spec §9/§11):
 *   - active → paused    when consecutiveFailures ≥ FAILURE_PAUSE_THRESHOLD
 *   - active → completed when runCount ≥ maxRuns
 *
 * Semantically distinct from notifyRunDone (per-run): the user gets BOTH a
 * "this run failed" and a "the schedule was auto-paused" notification on the
 * terminal failing run. run.ts only calls this when the status ACTUALLY
 * transitioned (before !== after), so it fires exactly once per transition.
 * Never throws.
 */
export async function notifyScheduleStatusChange(
  opts: NotifyScheduleStatusChangeOpts,
): Promise<void> {
  const { scheduleId, scheduleTitle, status, reason, count } = opts;

  let title: string;
  let message: string;
  let notificationId: string;

  if (status === "paused" || reason === "auto_pause_failures") {
    title = `Schedule Paused: ${scheduleTitle}`;
    message = `Auto-paused after ${count} consecutive failures. Re-enable it in Schedules.`;
    notificationId = `${PAUSED_NOTIF_PREFIX}${scheduleId}`;
  } else {
    title = `Schedule Completed: ${scheduleTitle}`;
    message = `Finished all ${count} scheduled runs.`;
    notificationId = `${COMPLETED_NOTIF_PREFIX}${scheduleId}`;
  }

  await createNotification(notificationId, title, message);
}

// ── handleScheduleNotificationClick ────────────────────────────────────────

/**
 * Called from the SW's chrome.notifications.onClicked listener.
 *
 * Parses "schedule-run:<recordId>" notifications. Tries to open the side
 * panel and navigate to the session (via chrome.sidePanel.open). If that
 * throws — expected under Chrome's user-gesture constraint; notifications
 * onClicked is NOT a trusted user gesture for sidePanel.open — falls back
 * to marking the run `unread: true` so Task 9 UI can highlight it when the
 * user next opens the panel manually.
 *
 * Other notification prefixes (e.g. "schedule-paused:") are silently
 * ignored — no navigation needed for paused-schedule notifications.
 *
 * Never throws.
 */
export async function handleScheduleNotificationClick(notificationId: string): Promise<void> {
  try {
    if (!notificationId.startsWith(RUN_NOTIF_PREFIX)) return;

    const recordId = notificationId.slice(RUN_NOTIF_PREFIX.length);
    const run = await getRun(recordId);
    if (!run) return;

    // Attempt to open the side panel. chrome.sidePanel.open requires a user
    // gesture — notifications.onClicked does NOT qualify as one in Chrome. So
    // this will very likely throw. The catch block handles the fallback.
    try {
      // sidePanel.open needs either a tabId or windowId. Without knowing which
      // tab/window is active we use the current focused window as a best-effort
      // attempt. The panel will show but won't auto-scroll to the session (that
      // requires Task 9 UI reading the `unread` flag).
      const win = await chrome.windows.getCurrent({ populate: false });
      if (typeof win.id !== "number") {
        // No numeric window id to target — sidePanel.open can't run. Fall
        // through to the unread fallback so the click is never silently
        // dropped (the user clicked something; it must leave a trace).
        throw new Error("no numeric window id");
      }
      await chrome.sidePanel.open({ windowId: win.id });
    } catch {
      // user-gesture constraint, no-window-id, or other sidePanel.open error —
      // mark unread so Task 9 UI can highlight this run when the panel opens next.
      await updateRun(recordId, { unread: true });
    }
  } catch {
    // Outer guard — ensures this listener never crashes the SW.
  }
}
