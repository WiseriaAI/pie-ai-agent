// src/lib/schedules/run.ts
//
// Headless schedule executor. Reads a ScheduleRecord, resolves the bound
// instance's current model, mints a fresh Session + ScheduleRunRecord, drives
// runAgentLoop, then marks the run success/failed by consuming the loop's
// terminal signal (NOT by "the promise resolved").
//
// All heavy deps (getInstance, firstModelForProvider, resolveModelConfig,
// runAgentLoop) are injected via RunDeps so this module stays unit-testable
// without a real Chrome extension runtime.
//
// Task 6 wired the startUrl background-tab lifecycle (open via
// chrome.tabs.create({active:false}) before the loop, close via
// chrome.tabs.remove in finally). Those two calls reach the ambient
// `chrome.tabs` global directly — NOT through RunDeps — and are the ONLY part
// of this module that does so (matching session-recovery's pragmatic choice).
// Tests therefore mock `globalThis.chrome.tabs` rather than injecting it.

import type { runAgentLoop as RunAgentLoopType } from "@/lib/agent/loop";
import { mergeSessionAgentSnapshot } from "@/lib/agent/loop";
import { isRestrictedScheduleUrl } from "./url-guard";
import type {
  getInstance as GetInstanceType,
  firstModelForProvider as FirstModelForProviderType,
  resolveModelConfig as ResolveModelConfigType,
} from "@/lib/instances";
import type { AgentDoneTaskMessage } from "@/types/messages";
import { getSchedule, appendRun, updateRun, listRunningRuns, patchSchedule } from "./store";
import { newRunId } from "./types";
import { applyOutcome } from "./schedule-logic";
import { notifyRunDone, notifyScheduleStatusChange } from "./notify";
import { HeadlessTranscript } from "./headless-transcript";
import {
  createSession,
  setSessionMeta,
  getSessionMeta,
  setSessionAgent,
  getSessionAgent,
} from "@/lib/sessions/storage";
import { deriveTitleFromMessages } from "@/lib/sessions/title";

// ── Task 7: Headless destructive-action prevention ────────────────────────────
//
// Headless runs run unattended and are a prompt-injection surface, so they must
// not be able to perform ANY write-class schedule-meta operation: an injected
// page could otherwise make the scheduled agent create, modify, or permanently
// delete schedules (delete_schedule wipes the schedule + its entire run history,
// irreversibly). All three write-class tools are excluded from the agent's tool
// set via AgentLoopContext.excludeToolNames for every headless schedule run.
//
// list_schedules (read-class) is intentionally NOT excluded: observing the
// schedule list is harmless and may be useful (e.g. "am I already scheduled for
// X?"). One-shot self-cleanup needs no delete permission — a one-shot schedule
// auto-completes via maxRuns.
export const HEADLESS_EXCLUDE_TOOL_NAMES = [
  "create_schedule",
  "update_schedule",
  "delete_schedule",
] as const;

// ── Injectable deps ──────────────────────────────────────────────────────────

export interface RunDeps {
  runAgentLoop: typeof RunAgentLoopType;
  /** Resolve the bound instance (ADR 0001 — model comes from the instance). */
  getInstance: typeof GetInstanceType;
  /** Resolve the instance's current model id (firstModelForProvider). */
  firstModelForProvider: typeof FirstModelForProviderType;
  resolveModelConfig: typeof ResolveModelConfigType;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Task 5.2 — count a completed run outcome onto the schedule's counters/status.
 * Re-reads the schedule first so the merge sees the latest runIds (mutated by
 * the preceding appendRun in the same txMulti), then applies the atomic patch
 * via applyOutcome. No-ops if the schedule was deleted mid-run.
 *
 * Task 8 (transition notifications, spec §9/§11) — when applyOutcome flips the
 * schedule's status (active → paused on consecutiveFailures ≥ threshold, or
 * active → completed on runCount ≥ maxRuns), fire a one-shot status-change
 * notification. This is SEPARATE from the per-run notifyRunDone in runSchedule:
 * the user learns both "this run failed" AND "the schedule itself was
 * auto-paused/completed". Compared before/after so it fires exactly once on the
 * transition, not on every counted run. Fire-and-forget; never affects counting.
 */
async function countOutcome(
  scheduleId: string,
  outcome: "success" | "failed",
): Promise<void> {
  const s = await getSchedule(scheduleId);
  if (!s) return;
  const patch = applyOutcome(s, outcome);
  await patchSchedule(scheduleId, patch);

  // Detect an actual status transition (before !== after) and notify once.
  if (patch.status !== s.status) {
    if (patch.status === "paused") {
      notifyScheduleStatusChange({
        scheduleId: s.id,
        scheduleTitle: s.title,
        status: "paused",
        reason: "auto_pause_failures",
        count: patch.consecutiveFailures,
      }).catch(() => {/* already caught inside notifyScheduleStatusChange */});
    } else if (patch.status === "completed") {
      notifyScheduleStatusChange({
        scheduleId: s.id,
        scheduleTitle: s.title,
        status: "completed",
        reason: "max_runs_reached",
        count: patch.runCount,
      }).catch(() => {/* already caught inside notifyScheduleStatusChange */});
    }
  }
}

/**
 * Persist the headless run's panel-renderable transcript onto the session's
 * `meta.messages`, so opening the run from the run history shows the same
 * conversation a foreground task would (instead of a blank page — the bug this
 * fixes). Re-reads the latest meta first and merges, because the run may have
 * patched the meta in the meantime (origin/scheduleId/pinnedTabs) and those
 * fields must survive. Derives a fallback title from the first user message
 * when the session has none yet (mirrors the foreground persistMessages path).
 * Best-effort: a missing session (deleted mid-run) is a silent no-op.
 */
async function persistTranscript(
  sessionId: string,
  transcript: HeadlessTranscript,
): Promise<void> {
  const cur = await getSessionMeta(sessionId);
  if (!cur) return;
  const messages = transcript.snapshot();
  const title =
    cur.title && cur.title.length > 0 ? cur.title : deriveTitleFromMessages(messages);
  await setSessionMeta({ ...cur, messages, ...(title != null ? { title } : {}) });
}

/**
 * Task 6.2 — Open a background (non-focused) tab for a schedule with startUrl.
 * Returns the created tab's id. Throws when chrome.tabs.create yields a tab
 * without an id (a number is required so the caller never propagates an
 * undefined into pinnedTabs / ownedTabId / chrome.tabs.remove). The caller
 * routes that throw through the normal failed-run path — honest over a silent
 * non-null assertion.
 */
async function openScheduleTab(startUrl: string): Promise<number> {
  const tab = await chrome.tabs.create({ url: startUrl, active: false });
  if (tab.id == null) {
    throw new Error("chrome.tabs.create returned a tab without an id");
  }
  return tab.id;
}

/**
 * Task 6.2 — Close the headless schedule tab (best-effort; tab may already
 * be gone if the user closed it manually).
 */
async function closeScheduleTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // Tab already gone — not an error for the run.
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Execute one run of a schedule headlessly (no side-panel port, no tab).
 *
 * Lifecycle:
 *   1. Read ScheduleRecord; bail silently when not found.
 *   2. Resolve ModelConfig FIRST (ADR 0001 — getInstance →
 *      firstModelForProvider → resolveModelConfig). If it fails (deleted
 *      instance / no model), append a single `failed` run WITHOUT a session
 *      (no orphan session left behind) and return.
 *   3. Mint a fresh Session (origin="schedule") + a `running` ScheduleRunRecord.
 *   4. Drive `deps.runAgentLoop`. The emit sink captures the loop's TERMINAL
 *      signal:
 *        - `agent-done-task` → success ← `success` field, summary ← `summary`.
 *        - `chat-error`      → failed (records the error text).
 *        - pure-text replies emit only `chat-done` (no agent-done-task); those
 *          are a success and their summary comes from accumulated chat-chunk
 *          text (the only summary source for that path).
 *      runAgentLoop does NOT throw on soft failures (agent `fail` tool, LLM /
 *      network error) — it emitDone(success:false) and returns normally — so
 *      success/failed MUST be decided by the terminal signal, not by "the
 *      promise resolved". A thrown JS exception is an extra backstop → failed.
 *   5. updateRun(success|failed + summary/error + endedAt).
 *
 * onStepSnapshot persists agent state per step (and the done tombstone) via the
 * canonical `mergeSessionAgentSnapshot`, so the session is browsable in the
 * panel even for headless runs (lastTaskSynth / contextUsage carried correctly).
 */
export async function runSchedule(
  scheduleId: string,
  deps: RunDeps,
): Promise<void> {
  // ── 1. Read schedule ─────────────────────────────────────────────────────
  const sched = await getSchedule(scheduleId);
  if (!sched) return;

  // ── 1a. Task 5.2 — skip-if-running ──────────────────────────────────────
  // If this schedule already has a `running` run (concurrency overlap), append
  // a `skipped` run record and return immediately. Skipped runs do NOT count
  // toward runCount / consecutiveFailures (spec §11).
  const runningRuns = await listRunningRuns();
  const alreadyRunning = runningRuns.some((r) => r.scheduleId === scheduleId);
  if (alreadyRunning) {
    const skippedId = newRunId();
    await appendRun(scheduleId, {
      recordId: skippedId,
      scheduleId,
      // A skipped run intentionally shares the NEXT ordinal (runCount + 1) but
      // does NOT increment runCount — it's filler/audit, not a counted run. So
      // the real run that follows reuses this same runIndex. Don't treat
      // runIndex as a unique key in the UI (Task 9).
      runIndex: sched.runCount + 1,
      startedAt: Date.now(),
      endedAt: Date.now(),
      status: "skipped",
    });
    return;
  }

  const recordId = newRunId();
  const runIndex = sched.runCount + 1;

  // ── 2. Resolve ModelConfig BEFORE minting a session ──────────────────────
  // ADR 0001/0002 — the schedule binds to an instance, and the run prefers the
  // schedule's *bound* model (sched.model, ADR 0002) when present, otherwise
  // falls back to the instance's *current* model. We resolve the model here
  // (same pattern as resolveActiveInstanceModelConfig in instances.ts):
  // getInstance → (sched.model ?? firstModelForProvider(provider, instanceId))
  // → resolveModelConfig.
  //
  // resolveModelConfig does NOT reject an empty model — it would happily
  // produce a structurally-valid `{ model: "" }` config that slips past the
  // null guard and sends an empty model name to the LLM. So the model string
  // MUST be resolved (and non-null) before we build the config.
  //
  // Resolving first means a model failure leaves NO orphan session: we just
  // append a single `failed` run (no sessionId — the field is optional and a
  // failed record is what Task 5's failure counter needs) and return.
  const inst = await deps.getInstance(sched.instanceId);
  // ADR 0002 — 优先用 schedule 绑定的 model；缺省回退该 instance 当前第一个 model。
  const model = inst
    ? (sched.model ?? (await deps.firstModelForProvider(inst.provider, sched.instanceId)))
    : null;
  const cfg = model
    ? await deps.resolveModelConfig(sched.instanceId, model)
    : null;
  if (!cfg) {
    await appendRun(scheduleId, {
      recordId,
      scheduleId,
      runIndex,
      startedAt: Date.now(),
      status: "failed",
      error: "instance unavailable",
      endedAt: Date.now(),
    });
    // Task 5.2 — count the early-fail toward consecutiveFailures / auto-pause.
    await countOutcome(scheduleId, "failed");
    // Task 8 — early-fail is still a `failed` run; notify for consistency
    // (every success/failed run notifies). No sessionId on this path.
    notifyRunDone({
      recordId,
      sessionId: "",
      status: "failed",
      summary: "instance unavailable",
      scheduleTitle: sched.title,
    }).catch(() => {/* already caught inside notifyRunDone */});
    return;
  }

  // ── 3. Mint fresh session + running run record ───────────────────────────
  const session = await createSession({ pinMode: "auto" });
  const sessionId = session.id;

  // Build the panel-renderable transcript as the loop emits, seeded with the
  // user prompt. Persisted to meta.messages at every terminal exit so the run
  // is browsable from the run history (headless has no panel to do this).
  const transcript = new HeadlessTranscript(sched.prompt);

  // Mark this session as schedule-originated (backward-compatible fields).
  await setSessionMeta({
    ...session,
    origin: "schedule",
    scheduleId,
    recordId,
  });

  await appendRun(scheduleId, {
    recordId,
    scheduleId,
    runIndex,
    sessionId,
    startedAt: Date.now(),
    status: "running",
  });

  // ── 3a. Task 6: startUrl — restricted guard + background tab open ────────
  // If the schedule has a startUrl, validate it before opening any tab.
  // Restricted URLs (chrome://, about:, etc. — AND the Chrome Web Store, which
  // is https:// but un-injectable; see isRestrictedScheduleUrl) cannot be
  // scripted into, so we fail the run immediately without touching the tab API.
  if (sched.startUrl && isRestrictedScheduleUrl(sched.startUrl)) {
    const restrictedErr = `startUrl is a restricted page that cannot be used: ${sched.startUrl}`;
    await updateRun(recordId, {
      status: "failed",
      error: restrictedErr,
      endedAt: Date.now(),
    });
    await countOutcome(scheduleId, "failed");
    // Persist the (user-prompt-only) transcript so opening this failed run
    // shows the prompt rather than a blank page; the run row carries the error.
    await persistTranscript(sessionId, transcript);
    // Task 8 — restricted-startUrl is still a `failed` run; notify for
    // consistency (this path has a sessionId from the minted session above).
    notifyRunDone({
      recordId,
      sessionId,
      status: "failed",
      summary: restrictedErr,
      scheduleTitle: sched.title,
    }).catch(() => {/* already caught inside notifyRunDone */});
    return;
  }

  // Track the headless tab id so the finally block can close it and
  // markOrphanRunsInterrupted (Task 4) can find it on SW restart.
  let ownedTabId: number | undefined;

  // ── 4. Drive headless agent loop ─────────────────────────────────────────
  // Terminal-signal capture. runAgentLoop drives these through `emit`.
  let doneMsg: Omit<AgentDoneTaskMessage, "sessionId"> | undefined;
  let chatErrorText: string | undefined;
  // Pure-text replies (no tools) end with chat-done only — no agent-done-task,
  // no synthesized summary — so their summary must come from chat-chunk text.
  let pureTextSummary = "";

  try {
    // Task 6.2 — open a non-focused background tab when startUrl is set.
    // The tab is opened AFTER the run record exists so markOrphanRunsInterrupted
    // can close it if the SW dies between open and loop-start.
    let pinnedTabs: Array<{ tabId: number; origin: string }> = [];
    if (sched.startUrl) {
      ownedTabId = await openScheduleTab(sched.startUrl);
      // Persist ownedTabId immediately so the orphan-cleanup in Task 4 sees it
      // even if the SW is killed before the loop finishes.
      await updateRun(recordId, { ownedTabId });
      // Build the pinned-tabs context the loop needs to navigate the tab.
      const origin = new URL(sched.startUrl).origin;
      pinnedTabs = [{ tabId: ownedTabId, origin }];
      // Pin the tab into the session meta so panel / recovery tooling can link back.
      await setSessionMeta({
        ...session,
        origin: "schedule",
        scheduleId,
        recordId,
        pinnedTabs,
      });
    }

    const abort = new AbortController();

    // Task 5.2 — optional wall-clock budget: maxRunMs.
    // When the schedule sets maxRunMs, we arm a timeout that aborts the loop
    // after that many milliseconds. The abort causes the loop to emit
    // agent-done-task(success:false) via its `finally` path, which applyOutcome
    // then counts as `failed`. The timer is cleared on run completion so a
    // fast run does not leave a dangling timeout.
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    if (sched.maxRunMs != null && sched.maxRunMs > 0) {
      budgetTimer = setTimeout(() => abort.abort(), sched.maxRunMs);
    }

    try {
      await deps.runAgentLoop({
        emit: (m) => {
          // Fold every emitted message into the panel transcript (persisted to
          // meta.messages on terminal exit so the run renders in the panel).
          transcript.push(m);
          if (m.type === "agent-done-task") {
            // Canonical terminal signal for tool-using tasks, agent done/fail,
            // and LLM/stream errors. Carries success + synthesized summary.
            doneMsg = m;
          } else if (m.type === "chat-error") {
            chatErrorText = m.error;
          } else if (m.type === "chat-chunk") {
            // Only meaningful for the pure-text terminal path (see above).
            pureTextSummary += m.text;
          }
          // thinking-chunk / agent-step / agent-usage / needs-file-access /
          // chat-done → discarded in headless mode.
        },
        task: sched.prompt,
        modelConfig: cfg,
        instanceId: sched.instanceId,
        signal: abort.signal,
        sessionId,
        // Task 5.3 — optional step cap: maxStepsPerRun. Absent = no ceiling.
        ...(sched.maxStepsPerRun != null ? { maxSteps: sched.maxStepsPerRun } : {}),
        // Task 7 — recursive creation prevention: exclude create/update from
        // the agent's tool set so a scheduled run cannot spawn or modify
        // schedules on its own.
        excludeToolNames: HEADLESS_EXCLUDE_TOOL_NAMES,
        onStepSnapshot: async (snapshot) => {
          // Use the canonical merge (DRY with makeStepSnapshotHandler): it
          // preserves carry-over fields (currentFocusTabId, pendingConfirm) on
          // live steps AND applies the tombstone reset semantics + carries
          // lastTaskSynth / contextUsage from the done snapshot — exactly what
          // makes a headless run browsable in the panel.
          const existing = await getSessionAgent(sessionId);
          await setSessionAgent(sessionId, mergeSessionAgentSnapshot(existing, snapshot));
        },
        // Task 6.2 — pass pinnedTabs when a background tab was opened; empty otherwise.
        pinnedTabs,
        ...(ownedTabId != null ? { initialFocusTabId: ownedTabId } : {}),
        refreshCrossSessionPinnedTabIds: async () => new Set<number>(),
      });
    } finally {
      // Always clear the budget timer so a fast run doesn't leave a dangling
      // timeout that aborts the next run's abort controller by accident.
      // Guarded: budgetTimer is undefined when maxRunMs wasn't set.
      if (budgetTimer) clearTimeout(budgetTimer);
      // Task 6.2 — close the background tab (best-effort; tab may already be
      // gone if the user closed it or the SW was killed and Task 4 cleaned it).
      if (ownedTabId != null) await closeScheduleTab(ownedTabId);
    }

    // ── 5. Decide success/failed from the terminal signal ────────────────
    let runOutcome: "success" | "failed";
    let runSummary = "";
    if (doneMsg) {
      // agent-done-task is the authoritative terminal signal.
      runOutcome = doneMsg.success ? "success" : "failed";
      runSummary = doneMsg.summary.slice(0, 200);
      await updateRun(recordId, {
        status: runOutcome,
        summary: runSummary,
        ...(doneMsg.success ? {} : { error: doneMsg.summary.slice(0, 500) }),
        endedAt: Date.now(),
      });
    } else if (chatErrorText) {
      // A chat-error without an agent-done-task still means failure.
      runOutcome = "failed";
      runSummary = chatErrorText.slice(0, 200);
      await updateRun(recordId, {
        status: runOutcome,
        error: chatErrorText.slice(0, 500),
        endedAt: Date.now(),
      });
    } else {
      // Pure-text reply path: chat-done only. Success; summary from text.
      runOutcome = "success";
      runSummary = pureTextSummary.slice(0, 200);
      await updateRun(recordId, {
        status: runOutcome,
        summary: runSummary,
        endedAt: Date.now(),
      });
    }

    // Persist the panel transcript onto the session so the finished run opens
    // to its conversation (not a blank page) from the run history.
    await persistTranscript(sessionId, transcript);

    // Task 5.2 — apply outcome counters to the schedule (atomic patchSchedule).
    await countOutcome(scheduleId, runOutcome);

    // Task 8 — notify the user that the run completed. Fire-and-forget;
    // notifyRunDone wraps chrome.notifications in try/catch so a broken
    // notifications API never affects the run record's outcome counters.
    notifyRunDone({
      recordId,
      sessionId,
      status: runOutcome,
      summary: runSummary,
      scheduleTitle: sched.title,
    }).catch(() => {/* already caught inside notifyRunDone */});
  } catch (e) {
    // Backstop for a JS exception escaping runAgentLoop (not a soft failure —
    // those go through the terminal-signal branch above).
    const errMsg = e instanceof Error ? e.message : String(e);
    await updateRun(recordId, {
      status: "failed",
      error: errMsg,
      endedAt: Date.now(),
    });
    // Persist whatever the transcript captured before the exception so the
    // failed run is still browsable from the run history.
    await persistTranscript(sessionId, transcript);
    // Count the exception as a failed run for auto-pause purposes.
    await countOutcome(scheduleId, "failed");

    // Task 8 — notify on backstop failure too.
    notifyRunDone({
      recordId,
      sessionId,
      status: "failed",
      summary: errMsg.slice(0, 200),
      scheduleTitle: sched.title,
    }).catch(() => {/* already caught inside notifyRunDone */});
  }
}
