// src/lib/schedules/run.ts
//
// Headless schedule executor. Reads a ScheduleRecord, resolves the bound
// instance's current model, mints a fresh Session + ScheduleRunRecord, drives
// runAgentLoop, then marks the run success/failed by consuming the loop's
// terminal signal (NOT by "the promise resolved").
//
// NOT wired to Chrome alarms, tabs, or notifications — those are Task 4+.
// All heavy deps (getInstance, firstModelForProvider, resolveModelConfig,
// runAgentLoop) are injected so this module stays unit-testable without a
// real Chrome extension runtime.

import type { runAgentLoop as RunAgentLoopType } from "@/lib/agent/loop";
import { mergeSessionAgentSnapshot } from "@/lib/agent/loop";
import type {
  getInstance as GetInstanceType,
  firstModelForProvider as FirstModelForProviderType,
  resolveModelConfig as ResolveModelConfigType,
} from "@/lib/instances";
import type { AgentDoneTaskMessage } from "@/types/messages";
import { getSchedule, appendRun, updateRun } from "./store";
import { newRunId } from "./types";
import {
  createSession,
  setSessionMeta,
  setSessionAgent,
  getSessionAgent,
} from "@/lib/sessions/storage";

// ── Injectable deps ──────────────────────────────────────────────────────────

export interface RunDeps {
  runAgentLoop: typeof RunAgentLoopType;
  /** Resolve the bound instance (ADR 0001 — model comes from the instance). */
  getInstance: typeof GetInstanceType;
  /** Resolve the instance's current model id (firstModelForProvider). */
  firstModelForProvider: typeof FirstModelForProviderType;
  resolveModelConfig: typeof ResolveModelConfigType;
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

  const recordId = newRunId();
  const runIndex = sched.runCount + 1;

  // ── 2. Resolve ModelConfig BEFORE minting a session ──────────────────────
  // ADR 0001 — the schedule binds to an instance, and the run uses that
  // instance's *current* model. The schedule only carries instanceId, so we
  // resolve the model here (same pattern as resolveActiveInstanceModelConfig
  // in instances.ts): getInstance → firstModelForProvider(provider,
  // instanceId) → resolveModelConfig.
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
  const model = inst
    ? await deps.firstModelForProvider(inst.provider, sched.instanceId)
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
    return;
  }

  // ── 3. Mint fresh session + running run record ───────────────────────────
  const session = await createSession({ pinMode: "auto" });
  const sessionId = session.id;

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

  // ── 4. Drive headless agent loop ─────────────────────────────────────────
  // Terminal-signal capture. runAgentLoop drives these through `emit`.
  let doneMsg: Omit<AgentDoneTaskMessage, "sessionId"> | undefined;
  let chatErrorText: string | undefined;
  // Pure-text replies (no tools) end with chat-done only — no agent-done-task,
  // no synthesized summary — so their summary must come from chat-chunk text.
  let pureTextSummary = "";

  try {
    const abort = new AbortController();

    await deps.runAgentLoop({
      emit: (m) => {
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
      signal: abort.signal,
      sessionId,
      onStepSnapshot: async (snapshot) => {
        // Use the canonical merge (DRY with makeStepSnapshotHandler): it
        // preserves carry-over fields (currentFocusTabId, pendingConfirm) on
        // live steps AND applies the tombstone reset semantics + carries
        // lastTaskSynth / contextUsage from the done snapshot — exactly what
        // makes a headless run browsable in the panel.
        const existing = await getSessionAgent(sessionId);
        await setSessionAgent(sessionId, mergeSessionAgentSnapshot(existing, snapshot));
      },
      // Headless: no pinned tabs, no cross-session registry, no pin cleanup.
      pinnedTabs: [],
      refreshCrossSessionPinnedTabIds: async () => new Set<number>(),
    });

    // ── 5. Decide success/failed from the terminal signal ────────────────
    if (doneMsg) {
      // agent-done-task is the authoritative terminal signal.
      await updateRun(recordId, {
        status: doneMsg.success ? "success" : "failed",
        summary: doneMsg.summary.slice(0, 200),
        ...(doneMsg.success ? {} : { error: doneMsg.summary.slice(0, 500) }),
        endedAt: Date.now(),
      });
    } else if (chatErrorText) {
      // A chat-error without an agent-done-task still means failure.
      await updateRun(recordId, {
        status: "failed",
        error: chatErrorText.slice(0, 500),
        endedAt: Date.now(),
      });
    } else {
      // Pure-text reply path: chat-done only. Success; summary from text.
      await updateRun(recordId, {
        status: "success",
        summary: pureTextSummary.slice(0, 200),
        endedAt: Date.now(),
      });
    }
  } catch (e) {
    // Backstop for a JS exception escaping runAgentLoop (not a soft failure —
    // those go through the terminal-signal branch above).
    await updateRun(recordId, {
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
      endedAt: Date.now(),
    });
  }
}
