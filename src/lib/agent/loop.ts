import type { ModelConfig, AgentMessage, ContentBlock, ToolDefinition } from "../model-router/types";
import type { ChatMessage } from "../model-router";
import { streamChat } from "../model-router";
import { addImage, evictSession } from "../../background/image-cache";
import { resetTaskBudget, dispatchCaptureVisibleTab, dispatchCaptureFullPageTab, type CdpAcquirer } from "./tools/screenshot";
import { hydrateAttachments } from "./image-hydration";
import { snapshotInteractiveElements } from "../dom-actions/snapshot";
import type { PageSnapshot } from "../dom-actions/types";
import {
  BUILT_IN_TOOLS,
  getKeyboardTools,
  isKeyboardToolName,
  isSkillMetaToolName,
} from "./tools";
import type { Tool } from "./types";
import { getToolClass } from "./tool-names";
import { escapeUntrustedWrappers } from "./untrusted-wrappers";
import { buildAgentSystemPrompt, buildObservationMessage } from "./prompt";
import { applySlidingWindow } from "./window";
import { applyTokenBudget } from "./window-token-budget";
import {
  validateAndRepairAdjacentRoles,
  type RoleViolation,
} from "./history-validation";
import { isKeyboardSimulationEnabled } from "../keyboard-simulation";
import { getEnabledSkills, type SkillDefinition } from "../skills";
import {
  acquireCdpSession,
  type CdpSession,
} from "../../background/cdp-session";
import type {
  AgentStepMessage,
  AgentDoneTaskMessage,
  ResolvedElement,
} from "../../types/messages";
import type { SessionAgentState } from "../sessions/types";
import {
  getSessionMeta,
  setSessionMeta,
  getSessionAgent,
  setSessionAgent,
} from "../sessions/storage";
import { addPinToMeta } from "../sessions/pin-state";
import { synthesizeAgentTurnText, type TerminationReason } from "./synthesize-agent-turn";
// setLastTaskSynth removed from emitDone — lastTaskSynth is now folded into
// the tombstone write by buildSessionAgentTombstone(synth) to prevent the
// two-write race on the agent key (AD1 fix). No import needed.

const MAX_STEPS = 30;

/**
 * Phase 2.6 — Skill scope.
 *
 * Active scope when the agent has invoked a skill-resolved tool. While active:
 *   - R3 anti-nest: any further skill-resolved tool_call is rejected.
 *   - R2 enforce: when allowedTools is non-null, any tool_call whose name is
 *     not in the whitelist is rejected with an observation describing the
 *     allowed set. allowedTools=null (legacy skills) keeps scope active for
 *     R3 enforcement but does not gate other tool calls.
 *
 * Lifecycle: in-memory only, task-scoped. Discarded when runAgentLoop returns
 * (done / fail / abort / max-steps). Replaced — not stacked — when a new
 * skill tool_call succeeds; in practice unreachable because R3 already
 * rejects nesting attempts.
 */

export interface AgentLoopContext {
  port: chrome.runtime.Port;
  task: string;
  modelConfig: ModelConfig;
  signal: AbortSignal;
  getEnabledSkillTools?: () => Promise<Tool[]>;
  /**
   * M1-U3 — session this task is bound to. Required so step-boundary
   * snapshots can write to `session_${id}_agent`. Decoupled from
   * `onStepSnapshot` (sessionId remains required even if a caller
   * doesn't wire a snapshot handler) so a missing snapshot wire does
   * not silently degrade — bug shows up at `setSessionAgent(undefined)`
   * rather than as a no-op.
   */
  sessionId: string;
  /**
   * M1-U3 — fired after each completed agent step (assistant + user
   * tool_result both pushed). The loop calls it fire-and-forget
   * (no await), so storage IO does not stall the next LLM round; the
   * passed snapshot is `structuredClone`d so subsequent in-place
   * mutations on `history` (the next round's observation merge at
   * line ~587) do not contaminate the persisted copy. R28 v2: the
   * snapshot's `agentMessages` are RAW (no redaction); panel-display
   * redaction happens via `redactArgsForPanel` on the
   * `sendAgentStep` paths only.
   *
   * Errors thrown by the handler are logged with sessionId + stepIndex
   * and otherwise swallowed — a quota / IO failure must not abort an
   * in-flight task. M2-U4 will introduce LRU archive on quota
   * pressure; for now we just keep going.
   */
  onStepSnapshot?: (snapshot: SessionAgentState) => Promise<void>;
  /**
   * M1-U5 — when resuming a paused task, the prior `agentMessages`
   * history (full LLM IR from the persisted snapshot) and the step
   * index reached. Both must be set together (or both undefined).
   *
   * When set:
   *   - `history` is initialized from `resumedAgentMessages` instead of
   *     the fresh `[system, user(task)]` seed
   *   - the loop counter starts at `resumedFromStep + 1`
   *   - **first iteration skips the observation-merge** at the top of
   *     the loop body — the prior snapshot already includes the
   *     observation that closes that step; merging again would result
   *     in double-observation in the user message and confuse the LLM.
   *     This is the single most-easily-missed correctness invariant
   *     of the resume path; see plan M1-U5 advisor note.
   */
  resumedAgentMessages?: AgentMessage[];
  resumedFromStep?: number;
  /**
   * Phase 5 — when resuming a paused session, the prior in-flight
   * snapshot's hasImageContent flag, so we don't lose the R14
   * fail-on-image precondition across restarts.
   */
  resumedHasImageContent?: boolean;
  /**
   * Phase 5 — unique identifier for this task invocation, used to key
   * the per-task screenshot budget (screenshot.ts `budgetByTask`).
   * Optional for backward compatibility; when absent, resetTaskBudget
   * is skipped (no budget was allocated).
   * Task 12 makes this required by passing a SW-generated UUID when
   * dispatching the agent loop.
   */
  taskId?: string;
  /**
   * v1.5 multi-pin — full set of pinned tabs owned by this session.
   * Index 0 is the chat-start capture; later indices are open_url
   * pushes (Task 7). The loop's per-iteration snapshot is taken on the tab
   * whose id matches `SessionAgentState.currentFocusTabId` (default =
   * pinnedTabs[0].tabId). Task 6's focus_tab tool mutates that pointer.
   *
   * Undefined (legacy sessions without pinnedTabs[]): the loop falls back
   * to the active-tab anchor — backward compatible with pre-v1.5 sessions.
   */
  pinnedTabs?: Array<{ tabId: number; origin: string }>;
  /**
   * v1.5 — initial focus on chat-start. Defaults to pinnedTabs[0].tabId.
   * Resume path passes the persisted SessionAgentState.currentFocusTabId;
   * chat-start passes pinnedTabs[0].tabId fresh.
   */
  initialFocusTabId?: number;
  /**
   * M5 — current session's pin mode at chat-start. SW dispatcher computes
   * this via getEffectivePinMode(meta, agent) and threads it through to
   * the tool handler context (close_tabs K-9 reads it). Frozen for the
   * loop's lifetime — pinMode changes mid-task (e.g. user clicks dropdown)
   * only take effect on the next chat-start.
   *
   * Undefined means "legacy caller without M5 wiring" — defaults to
   * permissive behavior (treat as 'auto'/'task'; close_tabs K-9 doesn't fire).
   */
  pinMode?: "auto" | "task" | "user";
  /**
   * M3-U4 — fetch the current set of tab ids pinned by OTHER active
   * sessions in the cross-session pinned-tab registry (`session_index`
   * derived). Called per iteration (NOT per task) so a session created
   * mid-loop is observed by the R7 lock on the very next dispatch — the
   * frozen-snapshot design (capture once at chat-start) had a TOCTOU
   * window where a sibling session that opened mid-task was invisible
   * to the lock.
   *
   * Returns an empty set when no other session is pinned (common
   * single-window case). The set excludes the caller's own pinnedTabId.
   * Implementation reads session_index — one storage round-trip,
   * negligible cost vs the LLM round-trip the loop is doing anyway.
   *
   * undefined means "no registry plumbed" (test harness, legacy code
   * paths) — equivalent to a permanently-empty set; the lock simply
   * doesn't fire.
   */
  refreshCrossSessionPinnedTabIds?: () => Promise<Set<number>>;
  /**
   * U2 — full multi-turn chat history from the panel wire. When present
   * (new-task path, not resume), the loop seeds its `history` array from
   * this array instead of the bare `[system, user(task)]` two-entry seed.
   *
   * Each user message is individually wrapped in
   * `<untrusted_user_message>…</untrusted_user_message>` with
   * `escapeUntrustedWrappers` applied first (D7 idempotent wrap).
   * Assistant messages (including the `lastTaskSynth`-injected turn,
   * already wrapped by U3 in `<untrusted_prior_task_summary>`) pass
   * through verbatim — no double-wrap.
   *
   * Optional for backward compatibility: when absent the loop falls back
   * to the `[system, user(task)]` two-entry seed (test harness + legacy
   * callers). The resume path (`resumedAgentMessages`) ignores this
   * field entirely.
   */
  messages?: ChatMessage[];
  /**
   * M5 — fired once per emitDone (idempotent at the emitDone level — only
   * the first emitDone call propagates here; subsequent emitDone calls are
   * short-circuited by `doneEmitted`). Use to clear task-mode pin from
   * session meta (downgrade pinMode='task' → 'auto', strip pinnedTabId/Origin).
   * 'user' mode pins are preserved by the SW-side handler.
   *
   * Fire-and-forget: errors logged but never fail the emitDone path; the
   * panel sees agent-done-task regardless. If the meta write fails, next
   * setSessionMeta call will normalize the pin via the lazy migration path.
   */
  onTaskDone?: () => Promise<void>;
  /**
   * U4 — called when `validateAndRepairAdjacentRoles` detects and repairs
   * one or more adjacent same-role messages in the windowed history before
   * the LLM call. Fired once per LLM iteration that has violations.
   *
   * Receives both the violations list (for routing / counting) and the
   * pre-repair `windowedHistoryRaw` array (so the handler can compute
   * content hashes without the loop needing an async crypto call).
   *
   * Optional (absent in test harness / legacy callers). Intended for SW
   * telemetry (console.warn) without importing browser-specific APIs into
   * the pure loop module.
   */
  onHistoryRepaired?: (violations: RoleViolation[], messages: AgentMessage[]) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * U2 — convert a `ChatMessage` from the panel wire to an `AgentMessage`
 * suitable for the LLM history.
 *
 * - `user` messages are wrapped in
 *   `<untrusted_user_message>…</untrusted_user_message>` with
 *   `escapeUntrustedWrappers` applied first (D7 idempotent).
 * - `assistant` messages pass through verbatim (lastTaskSynth-injected
 *   turns are already wrapped by U3 in
 *   `<untrusted_prior_task_summary>`; real chat replies are trusted
 *   LLM output and do not need additional wrapping).
 * - `system` messages pass through verbatim (edge case; system role
 *   appears only as the first entry in the history, built by
 *   `buildAgentSystemPrompt`).
 *
 * Exported for unit testing (D7 wrap invariant).
 */
export function chatMessageToAgentMessage(m: ChatMessage): AgentMessage {
  if (m.role !== "user") return { role: m.role, content: m.content };

  const wrappedText =
    m.content.length > 0
      ? `<untrusted_user_message>${escapeUntrustedWrappers(m.content)}</untrusted_user_message>`
      : "";

  if (!m.attachments?.length) {
    return { role: "user", content: wrappedText };
  }

  const blocks: ContentBlock[] = [];
  for (const a of m.attachments) {
    if (a.kind === "image") {
      blocks.push({
        type: "image",
        source: { type: "base64", mediaType: a.mediaType, data: a.data },
      });
    } else {
      blocks.push({
        type: "text",
        text: "[image released — no longer available]",
      });
    }
  }
  if (wrappedText) blocks.push({ type: "text", text: wrappedText });
  return { role: "user", content: blocks };
}

function toolsToDefinitions(tools: Tool[]): ToolDefinition[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

function resolveElement(
  snapshot: PageSnapshot,
  elementIndex: unknown,
): ResolvedElement | undefined {
  if (typeof elementIndex !== "number") return undefined;
  const el = snapshot.elements.find((e) => e.index === elementIndex);
  if (!el) return undefined;
  return {
    text: el.text,
    ariaLabel: el.ariaLabel,
    tag: el.tag,
    type: el.type,
    // ElementInfo does not have href; leave undefined
  };
}

function sendAgentStep(
  port: chrome.runtime.Port,
  msg: AgentStepMessage,
): void {
  port.postMessage(msg);
}

function sendAgentDone(
  port: chrome.runtime.Port,
  msg: AgentDoneTaskMessage,
): void {
  port.postMessage(msg);
}

/** M2-U2 P1-11 — inject sessionId onto any PortMessageToPanel variant
 *  that doesn't carry it yet. Used internally when emitting messages
 *  from inside runAgentLoop (where `ctx.sessionId` is available). */
function withSession<T extends object>(msg: T, sessionId: string): T & { sessionId: string } {
  return { ...msg, sessionId };
}

export function isRestrictedUrl(url: string): boolean {
  // Reject schemes whose origin collapses to the string "null" or that the agent
  // has no sensible way to pin: file://, data:, javascript:, blob:. Without these
  // checks, any subsequent navigation within one of these schemes would pass the
  // per-round origin comparison (`"null" === "null"`), defeating the isolation.
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("about:") ||
    url.startsWith("edge://") ||
    url.startsWith("file://") ||
    url.startsWith("data:") ||
    url.startsWith("javascript:") ||
    url.startsWith("blob:")
  );
}

export function safeParseOrigin(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    // Opaque origins parse to the literal string "null"; treat them as unresolvable.
    if (!origin || origin === "null") return null;
    return origin;
  } catch {
    return null;
  }
}

// ── Phase 2.5 helpers ────────────────────────────────────────────────────────

/**
 * M1-U3 — build a SessionAgentState snapshot for one step boundary.
 *
 * Pure function (no IO, no globals). Extracted from the agent-loop body
 * so it can be unit tested without the full loop's Chrome / model
 * harness. Two invariants live here:
 *
 *   1. `structuredClone(history)` — the next loop iteration mutates
 *      `history` in place (observation merge into the trailing user
 *      message). Without the clone, the persisted reference would be
 *      mutated post-write and the snapshot we hand to storage would
 *      diverge from the step it claims to represent (D4).
 *
 *   2. `agentMessages` is RAW. No call to `redactArgsForPanel` here.
 *      R28 v2 storage trust face: panel-display redaction is for shoulder-
 *      surf protection on the visible step bubble; the LLM resume path
 *      (M1-U5) needs the raw tool_use args to plan the next step. Two
 *      different consumers, two different shapes.
 */
export function buildSessionAgentSnapshot(
  history: AgentMessage[],
  stepIndex: number,
  hasImageContent: boolean = false,
): SessionAgentState {
  return {
    agentMessages: structuredClone(history),
    stepIndex,
    hasImageContent,
  };
}

/**
 * M1-U3 v2 — "no in-flight task" tombstone marker, written to
 * `session_${id}_agent` when a task reaches done (success / fail /
 * abort / max-steps).
 *
 * Without this, `stepIndex` from the just-completed task lingers in
 * storage. M1-U5's cold-start detector reads `stepIndex > 0` as the
 * signal that a task was running when the SW died — it would see
 * stale data from a long-completed task and falsely transition the
 * session to `paused`, presenting the user with a misleading
 * "Resume task" button.
 *
 * The tombstone is `(agentMessages=[], stepIndex=0)`. Idempotent — re-writing on top of
 * an existing tombstone is a no-op for any consumer.
 *
 * AD1 fix: accepts an optional `lastTaskSynth` parameter so `emitDone`
 * can fold the synthesized assistant turn into the same single atomic
 * write rather than issuing two separate read-modify-write calls to the
 * agent key. When `lastTaskSynth` is present it is included in the
 * returned state; when absent / undefined the field is omitted entirely
 * (no `undefined` property in the persisted object).
 */
export function buildSessionAgentTombstone(lastTaskSynth?: string | null): SessionAgentState {
  const base: SessionAgentState = {
    agentMessages: [],
    stepIndex: 0,
    hasImageContent: false,
  };
  if (lastTaskSynth != null) {
    base.lastTaskSynth = lastTaskSynth;
  }
  return base;
}

/**
 * v1.5 — pure helper: merge a fresh per-step snapshot with the existing
 * persisted SessionAgentState so fields written between snapshots survive
 * the per-step boundary.
 *
 * Background: `buildSessionAgentSnapshot` constructs a fresh state with
 * only `agentMessages / stepIndex /
 * hasImageContent`. Tools that mutate other fields via separate writers
 * (e.g. `setCurrentFocusTabId` from focus_tab in Task 6, `pendingConfirm`
 * from setPendingConfirm) would have their writes silently overwritten
 * if the snapshot were applied as a full key REPLACE (`writeAtomic` is
 * a key-level atomic replace in `setSessionAgent`).
 *
 * Merge strategy: spread `existing` first, then `snapshot`, so snapshot
 * fields always win for the four fields it carries — but any field
 * present on `existing` but NOT on `snapshot` (currentFocusTabId,
 * pendingConfirm) is preserved.
 *
 * Tombstone exception: a tombstone is the explicit "no in-flight task"
 * marker (`stepIndex === 0 && agentMessages.length === 0`). On tombstone
 * we MUST clear carry-over fields so a fresh task starts with fresh focus
 * (currentFocusTabId reset, pendingConfirm cleared). Detect by the shape
 * `buildSessionAgentTombstone` produces and bypass the merge — full replace.
 *
 * Exported for unit testing.
 */
export function mergeSessionAgentSnapshot(
  existing: SessionAgentState | null,
  snapshot: SessionAgentState,
): SessionAgentState {
  if (!existing) return snapshot;
  // Tombstone signature: stepIndex 0 AND empty agentMessages. This is the
  // unambiguous "fresh task reset" shape produced by buildSessionAgentTombstone.
  // (A live task at stepIndex 1+ never has an empty agentMessages array.)
  const isTombstone = snapshot.stepIndex === 0 && snapshot.agentMessages.length === 0;
  if (isTombstone) return snapshot;
  return { ...existing, ...snapshot };
}

/**
 * v1.5 — pure helper: given pinnedTabs[] and a currentFocusTabId, resolve
 * which tab the loop should snapshot and operate on this iteration.
 *
 * Semantics:
 *   - pinnedTabs empty / undefined → returns undefined (loop will fall back
 *     to legacy active-tab anchor).
 *   - currentFocusTabId undefined → returns pinnedTabs[0] (primary).
 *   - currentFocusTabId set → returns the matching entry, falling back to
 *     pinnedTabs[0] if not found (stale focus pointer; graceful degradation).
 *
 * Exported for unit testing.
 */
export function resolveFocusedPin(
  pinnedTabs: ReadonlyArray<{ tabId: number; origin: string }> | undefined,
  currentFocusTabId: number | undefined,
): { tabId: number; origin: string } | undefined {
  if (!pinnedTabs || pinnedTabs.length === 0) return undefined;
  const primary = pinnedTabs[0]!;
  if (currentFocusTabId === undefined) return primary;
  return pinnedTabs.find((p) => p.tabId === currentFocusTabId) ?? primary;
}

/**
 * v1.5 Task 6+7 — per-iteration focus refresh helper.
 *
 * Re-reads storage so that:
 *   - (Task 6) a focus_tab call in the previous iteration takes effect here
 *     (currentFocusTabId lives on SessionAgentState; mutated by focus_tab
 *     via setCurrentFocusTabId).
 *   - (Task 7) a new pin appended by open_url is observable in the very
 *     next iteration (pinnedTabs lives on SessionMeta; mutated by open_url
 *     via addPinToMeta + setSessionMeta). ctx.pinnedTabs is captured at
 *     task-start and is FROZEN inside the loop closure, so we re-read meta
 *     to pick up newly opened pins.
 *
 * resolveFocusedPin falls back to pinnedTabs[0] when currentFocusTabId is
 * undefined (auto/legacy mode) or stale (target pin was removed).
 *
 * Returns `{ focused, pinnedTabs }` so callers can rebroadcast the
 * refreshed array — not just the focused pin — into per-iteration
 * `riskCtx.pinnedTabs` and handler `ctx.pinnedTabs`. Issue #33 was a
 * direct consequence of returning only `focused` here: focus_tab and
 * other handlers kept validating against the frozen task-start snapshot,
 * so a pin appended mid-task by `open_url` was never accepted as a
 * legitimate `focus_tab` target. `focused` is undefined when no pin is
 * resolvable (legacy active-tab fallback path).
 *
 * IMPORTANT field-path constraint (regression guard):
 *   - currentFocusTabId lives on SessionAgentState, NOT SessionMeta
 *   - pinnedTabs       lives on SessionMeta,       NOT SessionAgentState
 * Both Promises MUST be awaited; the historical bug was reading
 * `getSessionAgent(...).currentFocusTabId` (Promise without await → always
 * undefined → focus_tab silently no-ops on every iteration).
 *
 * Exported so the integration regression tests can exercise the exact
 * storage round-trip the loop uses.
 */
export async function readFocusFromStorage(
  sessionId: string,
  ctxPinnedTabs: ReadonlyArray<{ tabId: number; origin: string }> | undefined,
): Promise<{
  focused: { tabId: number; origin: string } | undefined;
  pinnedTabs: ReadonlyArray<{ tabId: number; origin: string }>;
}> {
  const [agentSnap, metaSnap] = await Promise.all([
    getSessionAgent(sessionId),
    getSessionMeta(sessionId),
  ]);
  const refreshedPins = metaSnap?.pinnedTabs ?? ctxPinnedTabs ?? [];
  return {
    focused: resolveFocusedPin(refreshedPins, agentSnap?.currentFocusTabId),
    pinnedTabs: refreshedPins,
  };
}

/**
 * M3-U4 — pure helper: collect tab ids that this tool call would write
 * to AND that are pinned by another active session. Returns an empty
 * array when the tool is read-class, has no explicit cross-session
 * targets, or no other session is pinned.
 *
 * Called from the loop dispatch path between tool resolution and
 * tool.handler invocation. Pure so it can be unit-tested without
 * spinning up the whole loop.
 *
 * Scope: ONLY explicit args.tabIds / args.tabId targets are checked.
 * The earlier design folded `pinnedTabId` (= ctx.tabId at handler time,
 * the calling session's own pin) into the conflict check whenever the
 * tool wasn't a tab tool — so two sessions that happened to share a
 * pinned tab would deadlock symmetrically: every click / type / select
 * / keyboard / skill-meta call from EITHER session would be R7-rejected
 * because the OTHER session's pin matched their own. That collapsed
 * the entire M3 multi-session feature into "no operations possible
 * when sessions share a pin" — a regression with no offsetting safety
 * benefit, since the per-iteration origin re-check (loop body ~line 705)
 * already catches the case where the calling session's pin diverges
 * from the user's intent. Non-tab tools (Phase 2 DOM, keyboard, skill
 * meta) implicitly target the calling session's own pin, which is
 * never in the cross-session registry by construction; the fold added
 * no new safety, only false positives.
 *
 * Tab tools (close_tabs / group_tabs / etc.) still check args.tabIds /
 * args.tabId against the registry — that's the legitimate cross-session
 * intent the LLM expresses by naming a specific target.
 */
export function collectCrossSessionConflicts(
  toolName: string,
  args: Record<string, unknown>,
  _pinnedTabId: number,
  crossSessionPinnedTabIds: ReadonlySet<number> | undefined,
): number[] {
  if (!crossSessionPinnedTabIds || crossSessionPinnedTabIds.size === 0) {
    return [];
  }
  if (getToolClass(toolName) !== "write") return [];

  const conflicts: number[] = [];
  if (Array.isArray(args.tabIds)) {
    for (const v of args.tabIds) {
      if (typeof v === "number" && crossSessionPinnedTabIds.has(v)) {
        conflicts.push(v);
      }
    }
  }
  if (typeof args.tabId === "number" && crossSessionPinnedTabIds.has(args.tabId)) {
    conflicts.push(args.tabId);
  }
  return Array.from(new Set(conflicts));
}

/**
 * Redact `text` from keyboard tool args before emitting via agent-step
 * (event-card path). Confirm-request keeps the raw text — see plan
 * Key Technical Decisions on the redaction split.
 */
function redactArgsForPanel(toolName: string, args: unknown): unknown {
  if (!isKeyboardToolName(toolName)) return args;
  if (!args || typeof args !== "object") return args;
  const a = args as Record<string, unknown>;
  if (typeof a.text !== "string") return args;
  return {
    ...a,
    text: undefined,
    _redactedTextLength: (a.text as string).length,
  };
}

// ── Main loop ─────────────────────────────────────────────────────────────────

export async function runAgentLoop(ctx: AgentLoopContext): Promise<void> {
  const { port, task, modelConfig, getEnabledSkillTools } = ctx;
  const sessionId = ctx.sessionId;

  // Phase 2.5 lifecycle plumbing.
  //
  // We chain the caller's signal to a fresh internal AbortController so
  // we can abort the loop programmatically (yellow-bar cancel, storage
  // kill-switch). The caller's signal still controls — its abort fires
  // ours via the listener; our abort doesn't bubble back.
  const internalController = new AbortController();
  if (ctx.signal.aborted) {
    internalController.abort();
  } else {
    ctx.signal.addEventListener(
      "abort",
      () => internalController.abort(),
      { once: true },
    );
  }
  const signal = internalController.signal;

  // M3-U3 — ownerToken is now structured `{sessionId, tabId}` so
  // multi-Side-Panel collateral checks can name the offending session
  // in error messages. tabId here is the post-anchor pinnedTabId
  // (anchored just below). The token is constructed AFTER the anchor
  // step so the tabId is real; declared as `let` to avoid a TDZ on
  // the shape-construction line.
  let ownerToken: import("../../background/cdp-session").CdpOwnerToken;
  let cdpSession: CdpSession | null = null;
  let doneEmitted = false;
  let lastStepIndex = 0;
  let normalTextReply = false; // pure-text reply uses chat-done, not agent-done-task
  // Pre-initialized to [] so emitDone closures that fire before history is
  // seeded (legacy fallback paths at lines ~819/829/840 — before the
  // `history = ctx.resumedAgentMessages…` assignment) read an empty array
  // instead of hitting a TDZ ReferenceError (Fix 1 / C1).
  let history: AgentMessage[] = [];

  // Idempotent done emit — every runAgentLoop exit path (success, abort,
  // error, finally) calls this; first one wins, the rest are no-ops.
  //
  // M1-U3 v2: also writes a tombstone snapshot so M1-U5 cold-start can
  // distinguish "task in flight at SW death" (stepIndex > 0) from "task
  // already finished, no resume needed" (stepIndex = 0). Without this,
  // a long-completed task's stepIndex would linger in storage and
  // M1-U5 would falsely flag the session as paused. Fire-and-forget,
  // matching the per-step snapshot pattern.
  // M2-U2 P1-11 — emitDone auto-injects sessionId so every exit path
  // carries the routing field without requiring each call site to repeat it.
  //
  // U3 — each emitDone call site passes `terminationReason` so
  // synthesizeAgentTurnText can discriminate the 5 paths. The synth is
  // fired fire-and-forget (no await) after sendAgentDone and before the
  // tombstone snapshot, matching the step-snapshot fire-and-forget pattern.
  const emitDone = async (
    msg: Omit<AgentDoneTaskMessage, "sessionId">,
    terminationReason: TerminationReason = "abort",
  ): Promise<void> => {
    if (doneEmitted) return;
    doneEmitted = true;

    // M5 — clear task-mode pin BEFORE sendAgentDone. Lost-update race fix:
    // the panel's chat-done handler triggers `persistMessages` → RMW on
    // session_${id}_meta. If pin-clear was fire-and-forget after sendAgentDone,
    // the panel's RMW (read at T0, write at T2) could resurrect a stale
    // pin field that the SW had cleared mid-window (T1). Awaiting here
    // forces the SW write to land first; panel's chat-done arrives via
    // chrome.runtime IPC after this returns, so its persistMessages reads
    // the already-cleared meta.
    if (ctx.onTaskDone) {
      try {
        await ctx.onTaskDone();
      } catch (e) {
        console.warn(
          `[agent] onTaskDone (task-pin clear) failed for session=${ctx.sessionId}:`,
          e,
        );
      }
    }

    sendAgentDone(port, { ...msg, sessionId });

    // Phase 5 — R13 path (a): evict image cache on any terminal state.
    // Also free the per-task screenshot budget so a future task on the
    // same session starts with a fresh 5/task quota.
    evictSession(sessionId);
    if (ctx.taskId) {
      resetTaskBudget(ctx.taskId);
    }

    // U3 / AD1 fix — synthesize assistant turn and fold it into the tombstone
    // write so both changes land in ONE atomic write to session_${id}_agent.
    // Previously setLastTaskSynth and onStepSnapshot(tombstone) were two
    // independent fire-and-forget RMW calls on the same key, creating a
    // write-race window where stepIndex could be resurrected (M1-U5 would
    // falsely flag the session as paused on next SW restart).
    const synth = synthesizeAgentTurnText({
      terminationReason,
      summary: msg.summary,
      stepCount: msg.stepCount,
      history,
    });

    if (ctx.onStepSnapshot) {
      // Pass the synth (may be null) into the tombstone builder.
      // buildSessionAgentTombstone omits the field when null, ensuring the
      // next chat-start's "is lastTaskSynth present?" check is unambiguous.
      ctx.onStepSnapshot(buildSessionAgentTombstone(synth)).catch((e) => {
        console.warn(
          `[agent] tombstone snapshot failed for session=${ctx.sessionId}:`,
          e,
        );
      });
    }
  };
  // M2-U2 P1-11 — session-bound sendAgentStep that auto-injects sessionId.
  const emitStep = (msg: Omit<AgentStepMessage, "sessionId">): void => {
    sendAgentStep(port, { ...msg, sessionId });
  };

  // 1. Anchor tab + origin at task start.
  //
  // v1.5 multi-pin — preferred path: ctx carries the panel-captured pinnedTabs[].
  // resolveFocusedPin selects the focused tab (per initialFocusTabId, defaulting
  // to pinnedTabs[0]). The per-iteration origin re-check (loop body) handles any
  // drift between session creation and chat-start.
  //
  // Task 6 note: currentFocusTabId is read once at task-start here. Task 6's
  // focus_tab tool will need to reassign pinnedTabId/pinnedOrigin mid-loop
  // (or refresh from agent state at the top of each iteration) — that's Task 6
  // territory. The scaffold wires the storage writer via ToolHandlerContext.
  //
  // Legacy fallback: sessions without pinnedTabs[] fall through to the
  // historical active-tab anchor — backward compatible with pre-v1.5 sessions.
  let pinnedTabId: number;
  let pinnedOrigin: string;

  const focusedAtStart = resolveFocusedPin(ctx.pinnedTabs, ctx.initialFocusTabId);
  if (focusedAtStart) {
    pinnedTabId = focusedAtStart.tabId;
    pinnedOrigin = focusedAtStart.origin;
  } else {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url || isRestrictedUrl(tab.url)) {
        await emitDone({
          type: "agent-done-task",
          success: false,
          summary: "Cannot run agent on this page type",
          stepCount: 0,
        }, "abort");
        return;
      }
      const origin = safeParseOrigin(tab.url);
      if (!origin) {
        await emitDone({
          type: "agent-done-task",
          success: false,
          summary: "Cannot run agent on this page (unresolvable origin)",
          stepCount: 0,
        }, "abort");
        return;
      }
      pinnedTabId = tab.id;
      pinnedOrigin = origin;
    } catch {
      await emitDone({
        type: "agent-done-task",
        success: false,
        summary: "Failed to get active tab",
        stepCount: 0,
      }, "abort");
      return;
    }
  }

  // M3-U3 — bind ownerToken now that pinnedTabId is final. acquireSessionForTask
  // (defined below) closes over this; first invocation happens inside the
  // for-loop after this assignment, so the timing is safe.
  //
  // Note: ownerToken.tabId is captured once at task-start. After focus_tab
  // mutates the focused tab, keyboard tools (dispatch_keyboard_input /
  // press_key) ROUTE CORRECTLY to the new focused tab — they read ctx.tabId,
  // not ownerToken.tabId. The ownerToken's tabId only drives the cdp-session
  // sessionMap key (metadata for the M3-U3 owner-attached invariant); routing
  // to the live focused tab is unchanged. The "ownerToken.tabId === ctx.tabId"
  // invariant is now relaxed in multi-pin mode, but no security-critical path
  // depends on it. v1.5.1 backlog: refresh ownerToken on focus_tab as
  // defense-in-depth.
  ownerToken = { sessionId, tabId: pinnedTabId };

  // Curried CdpSession factory — passed to keyboard tools via closure.
  // INVARIANT: defined ONCE here, BEFORE the for-loop, so all per-iteration
  // tool builds share the same outer cdpSession variable. Moving this
  // inside the loop would make each round's handler closures capture a
  // fresh local, breaking lazy-attach semantics (every keyboard call
  // would re-attach → yellow bar flicker + leaks).
  const acquireSessionForTask = async (
    tabId: number,
  ): Promise<CdpSession> => {
    const session = await acquireCdpSession(tabId, {
      signal,
      ownerToken,
      onExternalDetach: () => {
        // Yellow bar cancel / storage kill-switch — propagate the abort
        // so the loop exits via signal.aborted check, falls through to
        // finally, which emits agent-done-task with reason-based summary.
        internalController.abort();
      },
    });
    if (!cdpSession) cdpSession = session;
    return session;
  };

  // Read keyboard sim flag at task start. Tool list is re-resolved each
  // iteration (so toggling ON mid-task adds tools next round; toggling
  // OFF triggers kill-switch + abort).
  const keyboardSimEnabledAtStart = await isKeyboardSimulationEnabled();

  // 2. Initial history
  // Structure: [system, user(initial-task)]
  // Per turn: assistant(tool_use blocks) + user([tool_result blocks..., text(observation)])
  // The observation is MERGED into the same user message as the prior turn's tool_results
  // to avoid adjacent user messages (which Anthropic rejects with 400).
  //
  // M1-U5 — resume path: when `resumedAgentMessages` is provided, use
  // it directly instead of seeding fresh. structuredClone defends
  // against subsequent in-place mutations of the input (the caller
  // owns it but we want to be defensive). See `isResumedFirstIteration`
  // below for the related observation-merge skip.
  //
  // U2 — multi-turn path: when `ctx.messages` is provided (new task,
  // not resume), seed history from the full chat prefix. Each user
  // message is wrapped in <untrusted_user_message>…</untrusted_user_message>
  // with escapeUntrustedWrappers applied first (D7 idempotent).
  // Assistant messages pass through verbatim (lastTaskSynth-injected
  // turns are already wrapped by U3 in <untrusted_prior_task_summary>).
  const systemMsg: AgentMessage = {
    role: "system",
    content: buildAgentSystemPrompt(
      task,
      keyboardSimEnabledAtStart,
      /* hasMetaTools */ true,
      // v1.5 M3-U2 — pass the full pinnedTabs array + initial focus.
      // Single-entry: back-compat phrasing ("a specific browser tab").
      // Multi-entry: lists all tabs with "← current focus" marker and
      // explains focus_tab. The LLM can call get_tab_content({tabId})
      // directly for read tasks; the focus marker reflects task-start
      // focus only (system prompt is static per task; see focus_tab
      // handler for per-iteration refresh semantics).
      ctx.pinnedTabs ?? [],
      pinnedTabId,
    ),
  };

  // Phase 5 — hydrate user attachments into per-session image cache.
  // Fresh ImageAttachment bytes are stored; ImagePlaceholder entries are
  // re-inflated from the cache if present (cross-turn follow-up support).
  // Run BEFORE history seed so chatMessageToAgentMessage sees hydrated bytes.
  // Skip on resume path — agentMessages already contain the expanded IR.
  let hasImageContent: boolean = ctx.resumedHasImageContent ?? false;
  if (!ctx.resumedAgentMessages && ctx.messages && ctx.messages.length > 0) {
    const hydration = hydrateAttachments(ctx.sessionId, ctx.messages);
    ctx.messages = hydration.messages;
    hasImageContent = hydration.hasImageContent || hasImageContent;
  }

  history = ctx.resumedAgentMessages
    ? structuredClone(ctx.resumedAgentMessages)
    : ctx.messages && ctx.messages.length > 0
      ? [systemMsg, ...ctx.messages.map(chatMessageToAgentMessage)]
      : [systemMsg, { role: "user", content: task }];

  // M1-U5 — flag that the first iteration of the loop should skip the
  // observation merge. The prior step's snapshot already contains an
  // observation in the trailing user message; merging again would
  // produce a duplicate observation and confuse the LLM.
  let isResumedFirstIteration = !!ctx.resumedAgentMessages;

  // v1.5 Task 6+7 / Issue #33 — per-iteration refreshed pinnedTabs.
  // ctx.pinnedTabs is captured at task-start and frozen inside the loop
  // closure. open_url writes new pins to SessionMeta (storage), so each
  // iteration's readFocusFromStorage rebroadcasts the up-to-date array
  // here; downstream handler ctx reads this instead of
  // ctx.pinnedTabs to see open_url's mid-task additions.
  let currentPinnedTabs: ReadonlyArray<{ tabId: number; origin: string }> =
    ctx.pinnedTabs ?? [];

  try {
    // M1-U5 — resume path starts the counter at the next step beyond
    // what was persisted. The MAX_STEPS bound still applies as the
    // absolute task ceiling; resume does not reset it.
    const startStepIndex = (ctx.resumedFromStep ?? 0) + 1;
    for (let stepIndex = startStepIndex; stepIndex <= MAX_STEPS; stepIndex++) {
      lastStepIndex = stepIndex;
      if (signal.aborted) return; // → finally

      // v1.5 Task 6+7 — per-iteration focus + pinnedTabs refresh.
      const refreshed = await readFocusFromStorage(
        sessionId,
        ctx.pinnedTabs,
      );
      currentPinnedTabs = refreshed.pinnedTabs;
      if (refreshed.focused) {
        pinnedTabId = refreshed.focused.tabId;
        pinnedOrigin = refreshed.focused.origin;
      }

      // Origin check
      let currentUrl: string;
      try {
        const currentTab = await chrome.tabs.get(pinnedTabId);
        if (!currentTab.url || isRestrictedUrl(currentTab.url)) {
          // Restricted URLs (chrome://, chrome-extension://, file:// etc.)
          // are an absolute hard stop — no confirm path, the agent simply
          // can't run there.
          await emitDone({
            type: "agent-done-task",
            success: false,
            summary: "Page navigated to a restricted URL, agent stopped",
            stepCount: stepIndex - 1,
          }, "abort");
          return;
        }
        const currentOrigin = safeParseOrigin(currentTab.url);
        if (!currentOrigin) {
          // Unparseable URL on a non-restricted scheme — treat as a hard
          // stop (we have nothing meaningful to show in a confirm card).
          await emitDone({
            type: "agent-done-task",
            success: false,
            summary: "Page origin changed, agent stopped for safety",
            stepCount: stepIndex - 1,
          }, "abort");
          return;
        }
        if (currentOrigin !== pinnedOrigin) {
          await emitDone({
            type: "agent-done-task",
            success: false,
            summary: `Page origin changed from ${pinnedOrigin} to ${currentOrigin}, agent stopped`,
            stepCount: stepIndex - 1,
          }, "abort");
          return;
        }
        currentUrl = currentTab.url;
      } catch {
        await emitDone({
          type: "agent-done-task",
          success: false,
          summary: "Tab was closed, agent stopped",
          stepCount: stepIndex - 1,
        }, "abort");
        return;
      }

      // Snapshot the page
      let snapshot: PageSnapshot;
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: pinnedTabId },
          func: snapshotInteractiveElements,
        });
        snapshot = (results[0]?.result as PageSnapshot) ?? {
          url: currentUrl,
          title: "",
          elements: [],
          semantic: { headings: [], alerts: [], status: [] },
        };
      } catch {
        await emitDone({
          type: "agent-done-task",
          success: false,
          summary: "Failed to snapshot page. The page may have navigated.",
          stepCount: stepIndex - 1,
        }, "abort");
        return;
      }

      // Build observation text
      const observationText = buildObservationMessage(snapshot, currentUrl);
      const observationBlock: ContentBlock = { type: "text", text: observationText };

      // Merge the observation into the last user message to avoid adjacent same-role messages.
      // Anthropic's Messages API requires strict user/assistant alternation (400 on violation).
      //
      // Cases:
      //  Step 1: history = [system, user(task-string)]
      //    → convert trailing user to array: user([text(task), obs])
      //  Step N>1: history = [..., assistant(tool_use), user([tool_results...])]
      //    → append obs block: user([tool_results..., obs])
      //
      // M1-U5 RESUME EXCEPTION: when this is the first iteration of a
      // resumed loop, the trailing user message in `history` is the
      // persisted snapshot — which already contains an observation
      // block from the step that completed before SW death. Merging
      // a fresh observation here would produce *two* observations in
      // the same user turn, confusing the LLM. So skip the merge for
      // the first iteration of a resume; subsequent iterations behave
      // normally.
      if (isResumedFirstIteration) {
        isResumedFirstIteration = false;
      } else {
        const lastMsg = history[history.length - 1];
        if (lastMsg && lastMsg.role === "user") {
          if (typeof lastMsg.content === "string") {
            // Convert string content to block array, prepend task text, append observation
            const taskText = lastMsg.content;
            lastMsg.content = [
              { type: "text", text: taskText },
              observationBlock,
            ] as ContentBlock[];
          } else {
            // Already an array (tool_result blocks from prior step) — append observation
            (lastMsg.content as ContentBlock[]).push(observationBlock);
          }
        } else {
          // Shouldn't happen in normal flow, but guard just in case
          history.push({ role: "user", content: [observationBlock] });
        }
      }

      // Apply sliding window
      const windowedHistorySlid = applySlidingWindow(history);

      // U5 — Token budget guard: drop oldest head pairs if estimated token
      // count exceeds 80% of the provider's context window. CJK-aware divisor
      // prevents 4× undercount for Chinese/Japanese/Korean conversations.
      const windowedHistoryRaw = await applyTokenBudget(
        windowedHistorySlid,
        modelConfig.provider,
      );

      // U4 — Defense-in-depth: validate role alternation and auto-repair
      // adjacent same-role messages. Normal paths (D2 SW-side synth + U2
      // wrapping) already ensure alternation; this is the last resort for
      // wire-format bugs or future refactor gaps. system-system pairs are
      // not counted (anthropic.ts joins them). Violations are repaired
      // silently — no error surfaced to the user.
      const { repaired: windowedHistory, violations: historyViolations } =
        validateAndRepairAdjacentRoles(windowedHistoryRaw);
      if (historyViolations.length > 0 && ctx.onHistoryRepaired) {
        ctx.onHistoryRepaired(historyViolations, windowedHistoryRaw);
      }

      // Resolve tools — re-read keyboard sim flag every iteration so
      // mid-task ON adds tools next round (mid-task OFF is handled by
      // the kill-switch in background/index.ts which detaches + aborts).
      const skillTools = getEnabledSkillTools ? await getEnabledSkillTools() : [];
      const currentKeyboardEnabled = await isKeyboardSimulationEnabled();
      const keyboardTools = currentKeyboardEnabled
        ? getKeyboardTools({
            acquireSession: acquireSessionForTask,
            pinnedOrigin,
          })
        : [];
      const allTools = [...BUILT_IN_TOOLS, ...skillTools, ...keyboardTools];
      // Phase 2.6 — skill-resolved tool name set, used by R3 anti-nest and
      // by scope-transition recognition. Rebuilt each iteration because
      // enabled skills can change mid-task (CRUD via meta tools).
      const skillResolvedNames = new Set(skillTools.map((t) => t.name));
      // Phase 2.6 — fetch SkillDefinition metadata for the same iteration so
      // we can sync-lookup author / allowedTools / firstRunConfirmedAt during
      // dispatch (R10 first-run gate, scope transition, agent-step skillAuthor).
      // Mutable: in-step updates (e.g. firstRunConfirmedAt after gate approval)
      // patch this map so a re-call within the same step doesn't re-gate.
      const enabledSkillDefs = await getEnabledSkills();
      const skillDefByName = new Map<string, SkillDefinition>(
        enabledSkillDefs.map((s) => [s.id, s]),
      );
      const toolDefinitions = toolsToDefinitions(allTools);

      // Stream from LLM
      let accumulatedText = "";
      const openToolCalls = new Map<
        number,
        { id: string; name: string; argsAccum: string }
      >();
      const completedToolCalls: Array<{ id: string; name: string; args: unknown }> = [];

      console.log("[sw][debug] streamChat entering", {
        provider: modelConfig.provider,
        model: modelConfig.model,
        stepIndex,
        sessionId,
        historyLen: windowedHistory.length,
        toolCount: toolDefinitions.length,
      });
      let __sawAnyEvent = false;
      for await (const event of streamChat(modelConfig, windowedHistory, signal, toolDefinitions)) {
        if (!__sawAnyEvent) {
          __sawAnyEvent = true;
          console.log("[sw][debug] streamChat first event", { type: event.type });
        }
        if (signal.aborted) return; // → finally

        if (event.type === "text-delta") {
          accumulatedText += event.text;
          // Stream text to panel as it arrives (Phase 1 compatible)
          port.postMessage(withSession({ type: "chat-chunk", text: event.text }, sessionId));
        } else if (event.type === "tool-call-start") {
          openToolCalls.set(event.index, {
            id: event.id,
            name: event.name,
            argsAccum: "",
          });
        } else if (event.type === "tool-call-delta") {
          const pending = openToolCalls.get(event.index);
          if (pending) {
            pending.argsAccum += event.argsDelta;
          }
        } else if (event.type === "tool-call-end") {
          const pending = openToolCalls.get(event.index);
          if (pending) {
            let parsedArgs: unknown = {};
            try {
              parsedArgs = pending.argsAccum ? JSON.parse(pending.argsAccum) : {};
            } catch {
              parsedArgs = {};
            }
            completedToolCalls.push({
              id: pending.id,
              name: pending.name,
              args: parsedArgs,
            });
            openToolCalls.delete(event.index);
          }
        } else if (event.type === "error") {
          port.postMessage(withSession({ type: "chat-error", error: event.error }, sessionId));
          await emitDone({
            type: "agent-done-task",
            success: false,
            summary: `LLM stream error: ${event.error}`,
            stepCount: stepIndex,
          }, "fail");
          return;
        }
      }
      console.log("[sw][debug] streamChat exited", {
        sawAnyEvent: __sawAnyEvent,
        stepIndex,
        sessionId,
        accumulatedTextLen: accumulatedText.length,
        toolCallCount: completedToolCalls.length,
      });

      // If abort fired during streaming, providers silently return from
      // the generator (no throw). Detect that here BEFORE treating an
      // empty completedToolCalls as a normal pure-text reply — otherwise
      // an aborted stream looks like "LLM ended cleanly" and finally
      // skips its done emit (because normalTextReply gates it).
      if (signal.aborted) return; // → finally with reason-based summary

      // Pure text response (no tool calls) — finish as normal chat.
      //
      // M5 fix — pure-text replies skip emitDone (they use chat-done
      // instead), so the onTaskDone hook would never fire and any
      // task-mode pin captured at chat-start would persist forever.
      // The user-reported bug: "任务已经结束了，但是 pinned tab 没有
      // 释放，并且下拉列表里提示 task is currently running" — exactly
      // this path. Mirror the emitDone task-pin clear here so every
      // path that ends a task converges on the same auto-unpin.
      //
      // ORDER MATTERS: clear pin BEFORE postMessage(chat-done). The
      // panel's chat-done handler invokes `persistMessages` which is a
      // read-modify-write on session meta — if it reads before SW
      // setSessionMeta(pinMode='auto') lands, it would write back the
      // stale pinMode='task'. Awaiting onTaskDone first forces the SW
      // write to land synchronously before panel ever sees chat-done.
      if (completedToolCalls.length === 0) {
        if (ctx.onTaskDone) {
          try {
            await ctx.onTaskDone();
          } catch (e) {
            console.warn(
              `[agent] onTaskDone (pure-text path) failed for session=${ctx.sessionId}:`,
              e,
            );
          }
        }
        port.postMessage(withSession({ type: "chat-done" }, sessionId));
        normalTextReply = true;
        // M1-U3 v2 — pure-text replies don't push history, so no
        // per-step snapshot has fired this turn. But a prior task's
        // stale (stepIndex > 0) snapshot might still be in storage.
        // Write a tombstone here so a chat-only round following a
        // completed agent task also clears in-flight markers.
        if (ctx.onStepSnapshot) {
          ctx.onStepSnapshot(buildSessionAgentTombstone()).catch((e) => {
            console.warn(
              `[agent] tombstone (pure-text) failed for session=${ctx.sessionId}:`,
              e,
            );
          });
        }
        return;
      }

      // Build the assistant message with all tool_use blocks (+ optional text block)
      const assistantBlocks: ContentBlock[] = [];
      if (accumulatedText) {
        assistantBlocks.push({ type: "text", text: accumulatedText });
      }
      for (const tc of completedToolCalls) {
        assistantBlocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.args,
        });
      }

      // Collect tool_result blocks for the user turn
      const toolResultBlocks: ContentBlock[] = [];
      let shouldTerminate = false;
      let terminationResult: { success: boolean; summary: string } | null = null;

      // Process each tool call in order
      for (const tc of completedToolCalls) {
        const args = tc.args as Record<string, unknown>;
        const tool = allTools.find((t) => t.name === tc.name);

        if (!tool) {
          const errorMsg = `Unknown tool: ${tc.name}`;
          toolResultBlocks.push({
            type: "tool_result",
            toolUseId: tc.id,
            content: errorMsg,
            isError: true,
          });
          emitStep({
            type: "agent-step",
            stepIndex,
            tool: tc.name,
            args: redactArgsForPanel(tc.name, tc.args),
            status: "error",
            observation: errorMsg,
          });
          continue;
        }

        // Phase 2.6 — derive skillAuthor metadata for this step's agent-step
        // events. Sync lookup against the per-iteration skill-def cache.
        // undefined for non-skill tools (BUILT_IN_TOOLS, keyboard, meta tools).
        const skillDefForStep = skillDefByName.get(tc.name);
        const skillAuthorForStep: "user" | "agent" | "builtIn" | undefined =
          skillDefForStep
            ? skillDefForStep.builtIn
              ? "builtIn"
              : skillDefForStep.author ?? "user"
            : undefined;

        // M3-U4 — R7 lock: cross-session pinned-tab conflict guard.
        //
        // For write-class tools we collect the tab ids the call would
        // affect (args.tabIds / args.tabId for tab tools; ctx.tabId
        // (= pinnedTabId) for Phase 2 DOM + keyboard tools — those
        // operate on the calling session's pin) and reject if any of
        // them is in `crossSessionPinnedTabIds` (= tabs pinned by
        // OTHER active sessions, computed at chat-start by the SW
        // dispatcher via getCrossSessionPinnedTabIds — which excludes
        // the calling session's own pin).
        //
        // Read-class tools are not gated: the user has already
        // informed-approved cross-tab read exposure at the confirm
        // card (P3-S / P3-T), and read concurrency does not corrupt
        // page state (K2 read/write split).
        //
        // Rejection emits an observation (so the LLM sees it and can
        // re-plan), an agent-step (so the user sees what was blocked),
        // and continues to the next tool call — does NOT terminate
        // the task. This matches the partial-completion semantic the
        // tab tools already use for stale targets.
        // M3-U4 (TOCTOU fix) — re-read the cross-session registry per
        // tool dispatch so a sibling session created mid-loop is visible.
        // One chrome.storage.local.get round-trip, fully amortized by the
        // surrounding LLM call. Errors degrade to "no conflicts known" so
        // a transient storage hiccup never falsely blocks a write.
        let crossSessionPinnedTabIds: Set<number> | undefined;
        if (ctx.refreshCrossSessionPinnedTabIds) {
          try {
            crossSessionPinnedTabIds = await ctx.refreshCrossSessionPinnedTabIds();
          } catch (e) {
            console.warn(
              `[agent] refreshCrossSessionPinnedTabIds failed for session=${ctx.sessionId}; treating as empty:`,
              e,
            );
          }
        }
        const r7Conflicts = collectCrossSessionConflicts(
          tc.name,
          args,
          pinnedTabId,
          crossSessionPinnedTabIds,
        );
        if (r7Conflicts.length > 0) {
          // Drop the "or wait for it to finish" suggestion — even with the
          // per-iteration registry refresh (M3-U4 TOCTOU fix), the LLM has
          // no autonomous way to know when the other session frees the tab,
          // and the previous "wait" framing trained agents to retry the
          // same call against the same tab in a fixed-point loop. Now the
          // observation has a single deterministic recovery: target a
          // different tab or stop and explain.
          const lockMsg = `Tab(s) ${r7Conflicts.join(", ")} are reserved by another active session; this write is refused. Pick a different tab or stop and explain to the user.`;
          toolResultBlocks.push({
            type: "tool_result",
            toolUseId: tc.id,
            content: lockMsg,
            isError: true,
          });
          emitStep({
            type: "agent-step",
            stepIndex,
            tool: tc.name,
            args: redactArgsForPanel(tc.name, tc.args),
            status: "error",
            observation: lockMsg,
            skillAuthor: skillAuthorForStep,
          });
          continue;
        }

        // Resolve element for confirmation / display
        const resolvedElement = resolveElement(snapshot, args.elementIndex);

        // Send pending step
        emitStep({
          type: "agent-step",
          stepIndex,
          tool: tc.name,
          args: redactArgsForPanel(tc.name, tc.args),
          resolvedElement,
          status: "pending",
          skillAuthor: skillAuthorForStep,
        });

        // Screenshot tool dispatch (R5/R6) — direct capture without confirm.
        if (
          tc.name === "capture_visible_tab" ||
          tc.name === "capture_fullpage_tab"
        ) {
          if (modelConfig.vision === false) {
            const noVisionObs = `screenshot ${tc.name} unavailable: current model (${modelConfig.model}) does not support vision. Switch to a vision-capable model or remove the screenshot tool.`;
            toolResultBlocks.push({
              type: "tool_result",
              toolUseId: tc.id,
              isError: true,
              content: noVisionObs,
            });
            emitStep({
              type: "agent-step",
              stepIndex,
              tool: tc.name,
              args: redactArgsForPanel(tc.name, tc.args),
              resolvedElement,
              status: "error",
              observation: noVisionObs,
              skillAuthor: skillAuthorForStep,
            });
            continue;
          }

          const captureCtx = { sessionId, taskId: ctx.taskId ?? sessionId, pinnedTabId };
          const outcome = tc.name === "capture_visible_tab"
            ? await dispatchCaptureVisibleTab(captureCtx)
            : await dispatchCaptureFullPageTab(captureCtx, {
                acquireSession: async ({ tabId }) => acquireSessionForTask(tabId),
              });

          if (!outcome.ok) {
            const rejectObs = `screenshot failed: ${outcome.reason}`;
            toolResultBlocks.push({
              type: "tool_result",
              toolUseId: tc.id,
              isError: true,
              content: rejectObs,
            });
            emitStep({
              type: "agent-step",
              stepIndex,
              tool: tc.name,
              args: redactArgsForPanel(tc.name, tc.args),
              resolvedElement,
              status: "error",
              observation: rejectObs,
              skillAuthor: skillAuthorForStep,
            });
            continue;
          }

          const img = outcome.value;
          addImage(ctx.sessionId, {
            id: img.id,
            userTurnId: `turn_screenshot_${stepIndex}`,
            mediaType: img.mediaType,
            data: img.data,
            width: img.width,
            height: img.height,
            byteLength: img.byteLength,
            addedAt: Date.now(),
          });
          hasImageContent = true;

          const screenshotObs = `screenshot captured: ${img.width}x${img.height} jpeg`;
          toolResultBlocks.push({
            type: "tool_result",
            toolUseId: tc.id,
            content: screenshotObs,
          });
          toolResultBlocks.push({
            type: "image",
            source: {
              type: "base64",
              mediaType: img.mediaType,
              data: img.data,
            },
          });
          emitStep({
            type: "agent-step",
            stepIndex,
            tool: tc.name,
            args: redactArgsForPanel(tc.name, tc.args),
            resolvedElement,
            status: "ok",
            observation: screenshotObs,
            skillAuthor: skillAuthorForStep,
          });
          continue;
        }

        // Execute tool
        let result;
        try {
          result = await tool.handler(tc.args, {
            tabId: pinnedTabId,
            snapshot,
            confirmedTabTargets: undefined,
            preFetchedContent: undefined,
            // M5 — frozen at chat-start (passed via AgentLoopContext.pinMode);
            // close_tabs K-9 reads this to refuse closing user-locked pins.
            pinMode: ctx.pinMode,
            // v1.5 — full pinnedTabs array for validation + mutation by
            // focus_tab (Task 6) and open_url (Task 7). Issue #33 —
            // currentPinnedTabs is the per-iteration refreshed array, so
            // focus_tab(newPinId) sees pins appended by open_url in
            // earlier iterations of the same task.
            pinnedTabs: currentPinnedTabs,
            appendPinnedTab: async (pin) => {
              const meta = await getSessionMeta(sessionId);
              if (!meta) return;
              await setSessionMeta(addPinToMeta(meta, pin));
            },
            setCurrentFocusTabId: async (tabId) => {
              const cur = await getSessionAgent(sessionId);
              if (!cur) return;
              await setSessionAgent(sessionId, { ...cur, currentFocusTabId: tabId });
            },
          });
        } catch (e) {
          result = {
            success: false,
            error: e instanceof Error ? e.message : "Tool execution failed",
          };
        }

        let observation = result.observation ?? result.error ?? "";

        // Phase 2.5: when type tool reports IME buffer error and
        // keyboard simulation is OFF, append a hint pointing user to
        // Settings. Skipped when sim is ON (LLM should retry via
        // dispatch_keyboard_input on its own per system prompt).
        if (
          tc.name === "type" &&
          !result.success &&
          observation.includes("hidden IME / keyboard capture buffer") &&
          !currentKeyboardEnabled
        ) {
          observation +=
            "\n(Tip: enable 'Keyboard simulation' in Settings to handle this case via CDP.)";
        }

        toolResultBlocks.push({
          type: "tool_result",
          toolUseId: tc.id,
          content: observation,
          isError: !result.success,
        });

        emitStep({
          type: "agent-step",
          stepIndex,
          tool: tc.name,
          args: redactArgsForPanel(tc.name, tc.args),
          resolvedElement,
          status: result.success ? "ok" : "error",
          observation,
          skillAuthor: skillAuthorForStep,
        });

        // Phase 2.6 — Skill cache invalidation after a successful meta-tool
        // mutation, so a within-step sequence like [update_skill X, X] sees
        // the post-update skill state on the second tc (R10 first-run gate
        // and the resolveSkillToTools observation both depend on a fresh
        // skillDefByName / skillResolvedNames). Without this, a stale cache
        // would silently bypass R10 even though chrome.storage holds the new
        // state — adversarial review adv-2.
        if (isSkillMetaToolName(tc.name) && result.success) {
          const refreshedSkills = await getEnabledSkills();
          skillDefByName.clear();
          for (const s of refreshedSkills) skillDefByName.set(s.id, s);
          // skillResolvedNames is `const`-bound to this iteration's skillTools
          // and `allTools` is also fixed for the iteration; we cannot resolve
          // a brand-new skill into a callable Tool mid-iteration without
          // re-running getEnabledSkillTools. That's deliberate — the agent
          // will see the new skill in the NEXT iteration's tool list, after
          // observation is digested. The cache invalidation here only
          // ensures R10 / scope transition see fresh metadata for skills
          // that already existed (i.e. the update_skill / delete_skill
          // paths); brand-new create_skill outputs become callable next
          // turn, which is the correct UX (one round-trip lets the user
          // see the result).
        }

        // Check for terminal tools
        if (tc.name === "done" && result.success) {
          shouldTerminate = true;
          terminationResult = { success: true, summary: observation };
        } else if (tc.name === "fail") {
          shouldTerminate = true;
          terminationResult = { success: false, summary: result.error ?? observation };
        }
      }

      // Push assistant message + user tool_result message into history.
      // The observation for the NEXT step will be appended to this user message
      // at the start of the next iteration (avoids adjacent user messages).
      history.push({ role: "assistant", content: assistantBlocks });
      history.push({ role: "user", content: toolResultBlocks });

      // M1-U3 — step-boundary snapshot. Both assistant + user(tool_result)
      // are pushed at this point, so the persisted state is a complete
      // round-trip (LLM resume after SW restart can re-feed the
      // tool_result back to the model without confusion). `history` is
      // structuredClone'd so the next iteration's in-place observation
      // merge (loop body around line ~587) does not contaminate the
      // already-persisted copy (D4 deep clone invariant).
      //
      // Fire-and-forget: a slow / failing storage write must not stall
      // the next LLM call. R28 v2: agentMessages are persisted RAW; the
      // panel-display redaction happens via redactArgsForPanel on the
      // sendAgentStep path, which is a separate code path.
      if (ctx.onStepSnapshot) {
        const snapshot = buildSessionAgentSnapshot(history, stepIndex, hasImageContent);
        ctx.onStepSnapshot(snapshot).catch((e) => {
          console.warn(
            `[agent] snapshot failed for session=${ctx.sessionId} step=${stepIndex}:`,
            e,
          );
        });
      }

      // Terminal tool check
      if (shouldTerminate && terminationResult) {
        await emitDone({
          type: "agent-done-task",
          success: terminationResult.success,
          summary: terminationResult.summary,
          stepCount: stepIndex,
        }, terminationResult.success ? "success" : "fail");
        return;
      }
    }

    // Max steps exceeded
    await emitDone({
      type: "agent-done-task",
      success: false,
      summary: "Max steps reached",
      stepCount: MAX_STEPS,
    }, "max-steps");
  } finally {
    // Always tear down any CDP session this task acquired. Idempotent —
    // signal abort listener inside cdp-session.ts may have already done
    // it, but calling again is a no-op.
    if (cdpSession) {
      try {
        await cdpSession.detach();
      } catch {
        // best-effort cleanup; nothing useful to do on detach failure
      }
    }

    // If we exited without emitting agent-done-task (signal-abort path,
    // or unexpected throw before any emit), emit one with a reason-based
    // summary. Pure-text replies skip this — they use chat-done.
    if (!doneEmitted && !normalTextReply) {
      const reason = cdpSession?.detachedReason ?? null;
      let summary: string;
      switch (reason) {
        case "user-cancelled-via-yellow-bar":
          summary = "用户取消了调试授权";
          break;
        case "kill-switch":
          summary = "用户在 Settings 关闭了键盘模拟";
          break;
        case "tab-closed":
          summary = "标签页已关闭";
          break;
        default:
          summary = "任务已取消";
          break;
      }
      await emitDone({
        type: "agent-done-task",
        success: false,
        summary,
        stepCount: lastStepIndex,
      }, "abort");
    }
  }
}
