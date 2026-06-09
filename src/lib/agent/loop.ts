import type { AgentMessage, ContentBlock, ToolDefinition, StreamEvent } from "../model-router/types";
import type { ModelConfig } from "../model-router";
import type { ChatMessage } from "../model-router";
import { streamChat } from "../model-router";
import { addImage, evictSession } from "../../background/image-cache";
import { putArtifact } from "../files/output-store";
import { resetTaskBudget, dispatchCaptureVisibleTab, dispatchCaptureFullPageTab, type CdpAcquirer } from "./tools/screenshot";
import { hydrateAttachments } from "./image-hydration";
import {
  BUILT_IN_TOOLS,
  getKeyboardTools,
  getMouseTools,
  getEditorTools,
  isKeyboardToolName,
} from "./tools";
import type { Tool } from "./types";
import { getToolClass, SCREENSHOT_TOOL_NAMES } from "./tool-names";
import { escapeUntrustedWrappers } from "./untrusted-wrappers";
import { classifyStreamCompletion } from "./stream-completion";
import { buildAgentSystemPrompt, buildObservationMessage } from "./prompt";
import { applySlidingWindow } from "./window";
import { elideStaleObservations } from "./elide-stale-observations";
import { applyTokenBudget } from "./window-token-budget";
import { compactReactWindow, createDefaultSummarizer } from "./compact-react-window";
import { resolveModelMeta } from "../model-router/providers/registry";
import {
  validateAndRepairAdjacentRoles,
  dropEmptyMessages,
  type RoleViolation,
} from "./history-validation";
import { isCdpInputEnabled } from "../cdp-input-enabled";
import { requestCdpInputConsent } from "../cdp-input-onboarding";
import { requestLocalFileFromPanel } from "../local-file-request";
import { buildRequestLocalFileTool, buildOutputFileTool } from "./tools/files";
import { buildScratchpadTools } from "./tools/scratchpad";
import {
  saveRecords as svcSaveRecords,
  updateNotes as svcUpdateNotes,
  readScratchpadRecords as svcReadRecords,
  clearScratchpadCollections as svcClearScratchpad,
  getOverview as svcGetOverview,
} from "../scratchpad/service";
import { queryScratchpad as svcQueryScratchpad } from "../scratchpad/sql-bridge";
import { getEnabledSkillPackages } from "../skills";
import { isFilePdfUrl } from "../pdf/detect";
import {
  acquireCdpSession,
  type CdpSession,
} from "../../background/cdp-session";
import type {
  AgentStepMessage,
  AgentDoneTaskMessage,
} from "../../types/messages";
import type { SessionAgentState } from "../sessions/types";
import {
  getSessionMeta,
  setSessionMeta,
  getSessionAgent,
  setSessionAgent,
} from "../sessions/storage";
import { addPinToMeta, removePinFromMeta } from "../sessions/pin-state";
import { drainPending } from "../sessions/pending-instructions";
import { buildMidTaskUserMessage } from "./loop-drain";
import { broadcastInstructionState } from "@/background/instruction-broadcast";
import { synthesizeAgentTurnText, type TerminationReason } from "./synthesize-agent-turn";
import { waitForUrlSettle, type UrlSettleResult } from "./wait-for-url-settle";
import { assembleAssistantBlocks, type ThinkingContentBlock } from "./assistant-blocks";
import { parseTextToolInvocations } from "./text-tool-invocation";
// setLastTaskSynth removed from emitDone — lastTaskSynth is now folded into
// the tombstone write by buildSessionAgentTombstone(synth) to prevent the
// two-write race on the agent key (AD1 fix). No import needed.

// Soft step budget. The loop is NOT bounded by this — termination is the
// LLM's call (done/fail or a plain-text reply) or a user abort. Once a task
// runs past this many steps the loop starts injecting an escalating budget
// nudge so the model self-paces; there is deliberately no absolute hard
// ceiling (a stuck model burns tokens until the user aborts — accepted
// tradeoff for full LLM-controlled termination).
const SOFT_STEP_BUDGET = 30;

/** #58 — react 段 sliding-window 放宽后的兜底上限。正常由 token 阈值先触发 compaction。 */
const REACT_BIG_CAP = 60;
/** #58 — provider 元数据缺失时的回退上下文窗口(与 window-token-budget 一致)。 */
const COMPACTION_FALLBACK_MAX_TOKENS = 32_000;

export interface AgentLoopContext {
  port: chrome.runtime.Port;
  task: string;
  modelConfig: ModelConfig;
  signal: AbortSignal;
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

const SCREENSHOT_TOOL_NAME_SET = new Set<string>(SCREENSHOT_TOOL_NAMES);

// #62 — fail-closed vision gating for the tool table offered to the LLM.
// Screenshot tools attach an image block to the next turn; a model that
// can't ingest images either wastes a step on the runtime guard
// (`vision === false`) or makes the provider API hard-reject the request
// (`vision === undefined`, e.g. custom provider / unknown OpenRouter id).
// So only models KNOWN to support vision (`vision === true`) get them
// offered; both `false` and `undefined` are excluded. "Can't see the
// tool" beats "calls it then errors". The runtime guard at the screenshot
// dispatch stays as defense-in-depth against mid-task model switches.
export function filterToolsByVision<T extends { name: string }>(
  tools: T[],
  vision: boolean | undefined,
): T[] {
  if (vision === true) return tools;
  return tools.filter((t) => !SCREENSHOT_TOOL_NAME_SET.has(t.name));
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
  if (isFilePdfUrl(url)) return false;
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
  // For file://*.pdf, use the URL itself as pin identity since the parsed
  // `origin` is "null" (opaque). Per-iteration `origin === pinnedOrigin`
  // becomes URL-equality, which is correct: if the user navigates the tab
  // away from this exact PDF the gate trips.
  if (isFilePdfUrl(url)) return url;
  try {
    const origin = new URL(url).origin;
    // Opaque origins parse to the literal string "null"; treat them as unresolvable.
    if (!origin || origin === "null") return null;
    return origin;
  } catch {
    return null;
  }
}

export type InterpretPinnedTabUrlResult =
  | { kind: "ok"; url: string }
  | {
      // The focused pinned tab diverged from its expected state (origin
      // changed, restricted scheme, still-navigating, or gone). We do NOT
      // terminate the task — the loop injects `notice` as a trusted
      // <system_notice> observation and lets the LLM decide what to do next
      // (continue, recover via focus_tab/open_url, or call fail). `url` is the
      // best-effort current URL for the observation header (empty when the tab
      // is gone / unsettled). `noticeKey` is a stable dedup key so the loop
      // surfaces each distinct divergence only once.
      kind: "notice";
      url: string;
      notice: string;
      noticeKey: string;
    };

// Shared closing sentence — every navigation notice reminds the LLM that the
// runtime will NOT stop the task; termination is the model's call (done/fail
// or a plain-text reply).
const NOTICE_TAIL =
  "The task was NOT stopped — decide whether to continue here, recover " +
  "(focus_tab to another pinned tab, open_url, or navigate back), or call " +
  "`fail` to stop and explain to the user.";

function originChangedNotice(pinnedOrigin: string, observed: string): string {
  return `The focused tab navigated from ${pinnedOrigin} to ${observed}. ${NOTICE_TAIL}`;
}

export interface InterpretPinnedTabUrlArgs {
  tab: chrome.tabs.Tab;
  pinnedOrigin: string;
  awaitSettle: (
    tabId: number,
    expectedOrigin: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<UrlSettleResult>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Issue #50 / advisory-navigation rework — per-iteration pinned-tab origin
 * gate. The gate is now ADVISORY: it never terminates the task. When the
 * focused tab diverges from its expected state it returns a `notice` that the
 * loop surfaces to the LLM as a trusted <system_notice> observation; the LLM
 * decides whether to continue, recover, or call `fail`. (Previously this
 * hard-stopped the loop — a benign cross-origin redirect chain, e.g.
 * picrew.github.io → github.com → back, could be sampled mid-flight and kill
 * the task. The transient-redirect false-positive is gone with the stop.)
 *
 * Branches:
 *   1. tab.url is a non-transient URL → restricted / unparseable / origin-
 *      mismatch each map to a distinct notice; an exact origin match is `ok`.
 *   2. tab.url is transient ("" / "about:blank") → await awaitSettle for the
 *      true destination (no pendingUrl fast-fail — a redirect chain may still
 *      land back on the pinned origin), then translate the UrlSettleResult
 *      into ok / notice. `timeout` becomes a "still navigating" notice.
 */
export async function interpretPinnedTabUrl(
  args: InterpretPinnedTabUrlArgs,
): Promise<InterpretPinnedTabUrlResult> {
  const { tab, pinnedOrigin, awaitSettle, signal, timeoutMs = 5000 } = args;
  const url = tab.url ?? "";
  const isTransient = url === "" || url === "about:blank";

  if (!isTransient) {
    if (isRestrictedUrl(url)) {
      return {
        kind: "notice",
        url,
        notice:
          `The focused tab is now at a restricted page (${url}) that cannot ` +
          `be read or operated on. ${NOTICE_TAIL}`,
        noticeKey: `restricted:${url}`,
      };
    }
    const origin = safeParseOrigin(url);
    if (!origin) {
      return {
        kind: "notice",
        url,
        notice:
          `The focused tab is at a URL with no usable origin (${url}). ` +
          `${NOTICE_TAIL}`,
        noticeKey: `unparseable:${url}`,
      };
    }
    if (origin !== pinnedOrigin) {
      return {
        kind: "notice",
        url,
        notice: originChangedNotice(pinnedOrigin, origin),
        noticeKey: `origin:${origin}`,
      };
    }
    return { kind: "ok", url };
  }

  // Transient branch — always await settle for the true destination. We no
  // longer fast-fail on pendingUrl: a multi-hop redirect can pass through a
  // foreign origin and still land back on the pinned one.
  if (typeof tab.id !== "number" || tab.id < 0) {
    return {
      kind: "notice",
      url: "",
      notice: `The focused tab is no longer available (closed). ${NOTICE_TAIL}`,
      noticeKey: "tab-closed",
    };
  }

  const r = await awaitSettle(tab.id, pinnedOrigin, timeoutMs, signal);
  if (r.committed) {
    return { kind: "ok", url: r.url };
  }
  if (r.reason === "origin-mismatch") {
    const observed = r.observedUrl
      ? safeParseOrigin(r.observedUrl) ?? "unknown"
      : "unknown";
    return {
      kind: "notice",
      url: r.observedUrl ?? "",
      notice: originChangedNotice(pinnedOrigin, observed),
      noticeKey: `origin:${observed}`,
    };
  }
  if (r.reason === "tab-gone") {
    return {
      kind: "notice",
      url: "",
      notice: `The focused tab (id ${tab.id}) is no longer available (closed). ${NOTICE_TAIL}`,
      noticeKey: "tab-closed",
    };
  }
  // reason === "timeout" — the page is still navigating and hasn't settled.
  return {
    kind: "notice",
    url: "",
    notice:
      `The focused tab is still navigating and its URL has not settled. ` +
      `${NOTICE_TAIL}`,
    noticeKey: "navigating",
  };
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
 *
 * Issue #59 invariant: this snapshot MUST NOT include `contextUsage`.
 * The per-step merge (`mergeSessionAgentSnapshot`) is a spread, so any
 * field present in the snapshot wins; including `contextUsage` here
 * would clobber the value the usage block (~loop.ts:1491) just wrote.
 */
export function buildSessionAgentSnapshot(
  history: AgentMessage[],
  stepIndex: number,
  hasImageContent: boolean = false,
): SessionAgentState {
  // pendingInstructions is intentionally omitted: mergeSessionAgentSnapshot (non-tombstone
  // path) spreads existing first so storage's pendingInstructions value is preserved.
  // The cast satisfies SessionAgentState's type while keeping the field absent at runtime.
  return {
    agentMessages: structuredClone(history),
    stepIndex,
    hasImageContent,
  } as SessionAgentState;
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
export function buildSessionAgentTombstone(
  lastTaskSynth?: string | null,
  carryUsage?: SessionAgentState["contextUsage"],
): SessionAgentState {
  const base: SessionAgentState = {
    agentMessages: [],
    pendingInstructions: [],
    stepIndex: 0,
    hasImageContent: false,
  };
  if (lastTaskSynth != null) {
    base.lastTaskSynth = lastTaskSynth;
  }
  if (carryUsage != null) {
    base.contextUsage = carryUsage;
  }
  return base;
}

/**
 * B（abort 保留历史）— 决定一次任务终止应写入 `session_${id}_agent` 的快照。（plan: docs/plans/2026-06-06-abort-preserve-history.md Task 1）
 *
 * - abort 且非 image 任务 → 返回 null：emitDone 跳过写入，保留最后一次
 *   per-step snapshot（完整 round-trip history + stepIndex>0），供下次
 *   chat-start 以 resume 风格续接（见 planAbortResumeSeed）。
 * - 其它（success / fail / max-steps，或 abort 但 hasImageContent）→ 写
 *   tombstone 清空历史 + 折叠 synth 摘要，维持既有压缩行为。R14：image-bearing
 *   in-flight 不可 resume（字节不在 storage），故 abort+image 仍走压缩。
 *
 * 纯函数，便于单测（emitDone 闭包本身耦合 Chrome 不可单测）。
 */
export function buildDoneSnapshot(
  terminationReason: TerminationReason,
  hasImageContent: boolean,
  synth: string | null,
  carryUsage: SessionAgentState["contextUsage"] | undefined,
): SessionAgentState | null {
  if (terminationReason === "abort" && !hasImageContent) return null;
  return buildSessionAgentTombstone(synth ?? undefined, carryUsage);
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
 * `buildSessionAgentTombstone` produces and bypass the merge — full replace,
 * EXCEPT `pendingInstructions`: instructions the user submitted during the
 * final step's execution window must survive the tombstone write so they can
 * be drained at the next chat-start (P-MTI-9 carry-over invariant).
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
  if (isTombstone) {
    // Preserve pendingInstructions from storage — the user may have submitted
    // an instruction during the last step's execution window (T2 < task-end T3).
    // buildSessionAgentTombstone initialises the field to [] but the storage
    // value (written by addPending) is the authoritative one.
    return { ...snapshot, pendingInstructions: existing.pendingInstructions };
  }
  return { ...existing, ...snapshot };
}

/**
 * Issue #59 — fold one step's real LLM usage into a session's running totals.
 * Pure function — no I/O. Caller persists the result via setSessionAgent.
 *
 * If `prev` is undefined, treats the step as the first LLM call for this
 * session (zeros baseline). `lastInputTokens` / `lastOutputTokens` always
 * reflect just-this-step (the ring's numerator + popover's "most recent").
 *
 * Exported for unit testing.
 */
export function mergeContextUsage(
  prev: SessionAgentState["contextUsage"] | undefined,
  step: { inputTokens: number; outputTokens: number },
): NonNullable<SessionAgentState["contextUsage"]> {
  return {
    totalInputTokens: (prev?.totalInputTokens ?? 0) + step.inputTokens,
    totalOutputTokens: (prev?.totalOutputTokens ?? 0) + step.outputTokens,
    lastInputTokens: step.inputTokens,
    lastOutputTokens: step.outputTokens,
  };
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
 * Task 3.3 — first-turn read_page nudge.
 *
 * Returns a short reminder string to append to the iteration-0 observation
 * when a pinned tab is present. The system prompt's READ_PAGE_GUIDANCE
 * already contains this instruction, but a per-turn nudge placed right
 * before the LLM's first decision ensures it isn't lost when the context
 * window is nearly full and the system prompt is implicitly compressed.
 *
 * Exported as a pure helper so unit tests can verify the text without
 * exercising the full Chrome-coupled runAgentLoop.
 *
 * Callers MUST only emit this on the first iteration of a fresh task (not
 * on resume and not on iterations > startStepIndex).
 */
export function buildFirstTurnReadPageHint(pinnedTabId: number): string {
  return `You haven't called read_page yet. If the task involves the active page, call read_page({tabId: ${pinnedTabId}}) first to get element indices and frame versions.`;
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

export interface StepPinView {
  /** Live pin list — read fresh by each tool handler's ctx.pinnedTabs. */
  readonly pins: ReadonlyArray<{ tabId: number; origin: string }>;
  /** Persist the removal AND drop it from `pins` synchronously. */
  removePinnedTab: (tabId: number) => Promise<void>;
}

/**
 * Issue #110 follow-up — per-step pin view shared by the batched tool handlers
 * of a single assistant turn.
 *
 * The loop's `currentPinnedTabs` is a snapshot taken once per step (from
 * readFocusFromStorage). close_tabs decides "is this pinned?" from
 * ctx.pinnedTabs, which points at that snapshot. unpin_tab persists its
 * removal to storage (SessionMeta) — but storage isn't re-read until the NEXT
 * step. So a model that batches `[unpin_tab(N), close_tabs([N])]` in ONE turn
 * would have close_tabs still see N as pinned and refuse, forcing a wasted
 * extra turn.
 *
 * This view fixes that: removePinnedTab updates `pins` in the same tick it
 * persists, so a later tool call in the same batch (reading view.pins via its
 * ctx) sees the unpin immediately. Storage stays the source of truth (the next
 * step's readFocusFromStorage refresh is unaffected); the view only collapses
 * the within-turn latency. Unlike focus_tab / open_url — which must defer to
 * the next iteration (they need a fresh page snapshot / tab commit) — unpin
 * has no reason to defer, so reflecting it immediately is strictly better.
 */
export function createStepPinView(
  initial: ReadonlyArray<{ tabId: number; origin: string }>,
  persistRemove: (tabId: number) => Promise<void>,
): StepPinView {
  let pins = initial;
  return {
    get pins() {
      return pins;
    },
    removePinnedTab: async (tabId: number) => {
      await persistRemove(tabId);
      pins = pins.filter((p) => p.tabId !== tabId);
    },
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
  const { port, task, modelConfig } = ctx;
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
    // B — abort 保留 task-mode pin，使续接落在原任务 tab。其它终止照常降级。
    // Skip applies to every abort flavor (in-flight cancel AND pre-pin early-exit); neither should downgrade a pin.
    if (ctx.onTaskDone && terminationReason !== "abort") {
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
      const prev = await getSessionAgent(sessionId);
      // B — abort（非 image）返回 null：跳过写入，保留最后 step snapshot 的
      // 完整 history，供续接。其它返回 tombstone（清空 + synth 折叠）。
      const doneSnapshot = buildDoneSnapshot(
        terminationReason,
        hasImageContent,
        synth,
        prev?.contextUsage,
      );
      if (doneSnapshot) {
        ctx.onStepSnapshot(doneSnapshot).catch((e) => {
          console.warn(`[agent] done snapshot failed for session=${ctx.sessionId}:`, e);
        });
      }
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
  //
  // Skill catalog — advertise enabled skill packages in the system prompt.
  // Fetched once at task start; the agent discovers + reads skills at runtime
  // via the built-in use_skill / read_skill_file mediation tools.
  const enabledPkgs = await getEnabledSkillPackages();
  const skillCatalog = enabledPkgs.map((p) => ({
    id: p.id,
    name: p.frontmatter.name,
    description: p.frontmatter.description,
  }));

  const systemMsg: AgentMessage = {
    role: "system",
    content: buildAgentSystemPrompt(
      task,
      // CDP tools are always offered (calling while disabled prompts the user
      // to enable), so always include the keyboard/editor usage guidance.
      /* hasKeyboardTools */ true,
      /* hasMetaTools */ true,
      // v1.5 M3-U2 — pass the full pinnedTabs array + initial focus.
      // Single-entry: back-compat phrasing ("a specific browser tab").
      // Multi-entry: lists all tabs with "← current focus" marker and
      // explains focus_tab. The LLM can call read_page({tabId})
      // directly for read tasks; the focus marker reflects task-start
      // focus only (system prompt is static per task; see focus_tab
      // handler for per-iteration refresh semantics).
      ctx.pinnedTabs ?? [],
      pinnedTabId,
      skillCatalog,
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

  // #58 — provider 在整个 loop 期间不变(task-start snapshot),故 maxContextTokens 与 summarizer 在循环外解析一次。
  const compactionModelMeta = await resolveModelMeta(modelConfig.provider, modelConfig.model);
  const compactionMaxTokens = compactionModelMeta?.maxContextTokens ?? COMPACTION_FALLBACK_MAX_TOKENS;
  const compactionSummarizer = createDefaultSummarizer(modelConfig);

  // Advisory-navigation warn-once tracker. The per-iteration origin gate is
  // advisory (never terminates); to avoid re-injecting the same notice every
  // step while the page sits on a diverged origin, we surface each distinct
  // divergence (keyed by noticeKey) only once. Reset to null on any `ok` so a
  // later divergence — or a return to the pinned origin then away again — is
  // surfaced afresh.
  let lastNoticeKey: string | null = null;

  try {
    // M1-U5 — resume path starts the counter at the next step beyond
    // what was persisted.
    const startStepIndex = (ctx.resumedFromStep ?? 0) + 1;
    // Unbounded — only an LLM termination (done/fail/plain-text) or a user
    // abort exits this loop. The soft budget nudge (SOFT_STEP_BUDGET) steers
    // the model to wrap up; there is no absolute step ceiling by design.
    for (let stepIndex = startStepIndex; !signal.aborted; stepIndex++) {
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

      // Issue #110 follow-up — per-step pin view. unpin_tab removes through
      // this so a same-turn close_tabs (reading view.pins via its ctx) sees
      // the unpin immediately, rather than only after the next step's
      // storage refresh. Storage stays the source of truth.
      const stepPinView = createStepPinView(currentPinnedTabs, async (tabId) => {
        const meta = await getSessionMeta(sessionId);
        if (!meta) return;
        await setSessionMeta(removePinFromMeta(meta, tabId));
      });

      // Issue #34 — drain any mid-task instructions submitted during the
      // previous step. Atomic read+clear (drainPending writes session agent
      // state). The push into history happens here, in-memory; the next
      // step-boundary writeAtomic will include this user message in the
      // persisted agentMessages snapshot.
      const pendingDrained = await drainPending(sessionId);
      const midTaskMsg = buildMidTaskUserMessage(pendingDrained);
      if (midTaskMsg) {
        history.push(midTaskMsg);
        // Broadcast empty pending so panel updates UI immediately
        // (without waiting for next step write).
        await broadcastInstructionState(port, sessionId);
      }

      // Advisory origin check. interpretPinnedTabUrl NEVER terminates the
      // task — a divergence (origin change / restricted / still-navigating /
      // tab gone) comes back as a `notice` we surface to the LLM as a trusted
      // <system_notice> block; the LLM decides whether to continue, recover
      // (focus_tab/open_url), or call `fail`. A raw chrome.tabs.get throw
      // (tab truly gone) is handled the same way — a tab-closed notice — so
      // every navigation outcome flows back to the model rather than killing
      // the loop.
      let currentUrl: string;
      let pageTitle: string;
      // Trusted runtime notices for this step (navigation divergence + soft
      // budget nudge). Joined into a single <system_notice> block below.
      const sysNotices: string[] = [];
      try {
        const currentTab = await chrome.tabs.get(pinnedTabId);
        const decision = await interpretPinnedTabUrl({
          tab: currentTab,
          pinnedOrigin,
          awaitSettle: waitForUrlSettle,
          signal,
        });
        if (decision.kind === "notice") {
          currentUrl = decision.url || "(focused tab unavailable)";
          pageTitle = currentTab.title ?? "";
          if (decision.noticeKey !== lastNoticeKey) {
            sysNotices.push(decision.notice);
            lastNoticeKey = decision.noticeKey;
          }
        } else {
          currentUrl = decision.url;
          pageTitle = currentTab.title ?? "";
          lastNoticeKey = null;
        }
      } catch {
        if (signal.aborted) return;
        // chrome.tabs.get throws → the focused tab is genuinely gone.
        currentUrl = "(focused tab unavailable)";
        pageTitle = "";
        if (lastNoticeKey !== "tab-closed") {
          sysNotices.push(
            `The focused tab (id ${pinnedTabId}) is no longer available ` +
              `(closed). ${NOTICE_TAIL}`,
          );
          lastNoticeKey = "tab-closed";
        }
      }

      // Soft budget nudge — no hard step ceiling, so once past the soft
      // budget we escalate pressure to self-terminate. Re-emitted each step
      // with the live count so the model sees the cost climbing.
      if (stepIndex >= SOFT_STEP_BUDGET) {
        sysNotices.push(
          `You've taken ${stepIndex} steps (soft budget ${SOFT_STEP_BUDGET}). ` +
            `The runtime will not stop you, but long tasks burn the user's ` +
            `tokens — wrap up now: finish with \`done\`, or call \`fail\` if ` +
            `you're blocked. If you're accumulating data, make sure it's in the ` +
            `scratchpad via \`save_records\` — don't hold it in your reply.`,
        );
      }

      console.log(`[loop] step=${stepIndex} url=${currentUrl}`);

      // Build observation text
      let observationText = buildObservationMessage(pageTitle, currentUrl);
      // Advisory runtime notices (trusted block, NOT untrusted page data).
      // Navigation divergence is surfaced once per distinct change; the budget
      // nudge re-appears past the soft budget.
      if (sysNotices.length > 0) {
        observationText += `\n\n<system_notice>\n${sysNotices.join("\n\n")}\n</system_notice>`;
      }
      // Scratchpad overview — bounded, rides the trailing observation so the
      // sliding-window/compaction/token-budget passes never trim it. Empty
      // string when the scratchpad is unused (no cost for non-extraction tasks).
      // Fail-soft: the overview is an enhancement, so an IDB read failure
      // (tx abort / blocked / corrupt record / quota) must NOT unwind the step
      // loop's outer try (which has no catch) and kill the in-flight task —
      // degrade to advisory, mirroring the chrome.tabs.get guard above.
      let scratchpadOverview = "";
      try {
        scratchpadOverview = await svcGetOverview(sessionId);
      } catch (e) {
        console.warn("[loop] scratchpad overview read failed; continuing without it", e);
      }
      if (scratchpadOverview) {
        observationText += `\n\n${scratchpadOverview}`;
      }
      // Task 3.3 — first-turn read_page nudge. Appended to the iteration-0
      // observation only when a pinned tab is present and this is NOT a
      // resumed loop (resumed loops already have context from prior steps).
      // The hint reinforces READ_PAGE_GUIDANCE at the natural decision point
      // so the LLM doesn't miss it when the context window is filling up.
      if (stepIndex === startStepIndex && !isResumedFirstIteration && currentPinnedTabs.length > 0) {
        observationText += `\n\n${buildFirstTurnReadPageHint(pinnedTabId)}`;
      }
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

      // #58 — 任务内 react 段 LLM compaction(IN-PLACE 改 history,持久化随 onStepSnapshot)。
      // 在 wire-time 整形之前:超 provider token 阈值时把最旧步骤摘成合成对,保住早期发现。
      await compactReactWindow(history, compactionMaxTokens, compactionSummarizer, signal);

      // Apply sliding window（react cap 放宽为 BIG_CAP，react 段长度主要由 compaction 控制）
      const windowedHistorySlid = applySlidingWindow(history, REACT_BIG_CAP);

      // #61(c) — stale-snapshot elision. Replace the bulky interactive-element
      // list of every observation EXCEPT the most recent with a short marker
      // (semantic header kept). Runs on the windowed COPY only — at-rest
      // history.agentMessages stay RAW (R28 v2). Placed BEFORE applyTokenBudget
      // so the budget sees the post-elision (true) size and rarely needs to
      // drop head pairs (#61 注意/联动). Elision is unconditional, so order vs
      // budget does not change the final content sent to the LLM — only the
      // budget's drop decision becomes more accurate.
      const windowedHistoryElided = elideStaleObservations(windowedHistorySlid);

      // U5 — Token budget guard: drop oldest head pairs if estimated token
      // count exceeds 80% of the provider's context window. CJK-aware divisor
      // prevents 4× undercount for Chinese/Japanese/Korean conversations.
      const windowedHistoryRaw = await applyTokenBudget(
        windowedHistoryElided,
        modelConfig.provider,
        modelConfig.model,
      );

      // Drop wire-empty non-system messages before the LLM call. A
      // reasoning-model turn that emitted thinking but no visible text (then a
      // tool call) makes the panel persist an assistant bubble with content ""
      // (buildAssistant only skips when BOTH text AND thinking are empty); on
      // the next task that empty assistant string is replayed here and strict
      // providers (Moonshot/Kimi) reject it with a 400. The thinking was
      // already stripped before it reached the history, so the message carries
      // no information and removing it is loss-free. Runs BEFORE the
      // adjacent-role repair so any same-role adjacency the removal creates is
      // healed by the sentinel pass below.
      const windowedHistoryNonEmpty = dropEmptyMessages(windowedHistoryRaw);

      // U4 — Defense-in-depth: validate role alternation and auto-repair
      // adjacent same-role messages. Normal paths (D2 SW-side synth + U2
      // wrapping) already ensure alternation; this is the last resort for
      // wire-format bugs or future refactor gaps. system-system pairs are
      // not counted (anthropic.ts joins them). Violations are repaired
      // silently — no error surfaced to the user.
      const { repaired: windowedHistory, violations: historyViolations } =
        validateAndRepairAdjacentRoles(windowedHistoryNonEmpty);
      if (historyViolations.length > 0 && ctx.onHistoryRepaired) {
        ctx.onHistoryRepaired(historyViolations, windowedHistoryNonEmpty);
      }

      // Resolve tools — re-read keyboard sim flag every iteration so
      // mid-task ON adds tools next round (mid-task OFF is handled by
      // the kill-switch in background/index.ts which detaches + aborts).
      // Skills are NOT tools: they live in IndexedDB and are reached via the
      // built-in use_skill / read_skill_file mediation tools (already in
      // BUILT_IN_TOOLS), advertised through the system-prompt skill catalog.
      const currentCdpInput = await isCdpInputEnabled();
      // CDP tools (mouse/keyboard/editor) are ALWAYS offered, even when CDP
      // input is disabled. Calling one while disabled (or never-configured)
      // triggers the consent prompt via requireCdpInput → the user can
      // authorize on the spot. `cdpAvailable` is kept only for the type-tool
      // IME hint below; it no longer gates tool availability.
      const cdpAvailable = currentCdpInput !== false;

      const mouseDeps: import("./tools").MouseToolDeps = {
        acquireSession: acquireSessionForTask,
        sessionId,
        requestConsent: requestCdpInputConsent,
      };
      const mouseTools = getMouseTools(mouseDeps);

      const keyboardTools = getKeyboardTools({
        acquireSession: acquireSessionForTask,
        pinnedOrigin,
        sessionId,
        requestConsent: requestCdpInputConsent,
      });
      const editorTools = getEditorTools({
        acquireSession: acquireSessionForTask,
        sessionId,
        requestConsent: requestCdpInputConsent,
      });
      // #62 — fail-closed vision gating (see filterToolsByVision). Screenshot
      // tools are only offered to models KNOWN to support vision; non-vision
      // and unknown-vision models never see them.
      const requestLocalFileTool = buildRequestLocalFileTool({
        sessionId,
        requestFile: requestLocalFileFromPanel,
      });
      const outputFileTool = buildOutputFileTool({
        sessionId,
        store: (a) => putArtifact(a),
      });
      const scratchpadTools = buildScratchpadTools({
        saveRecords: (collection, records, opts) => svcSaveRecords(sessionId, collection, records, opts),
        updateNotes: (notes) => svcUpdateNotes(sessionId, notes),
        readRecords: (collection, opts) => svcReadRecords(sessionId, collection, opts),
        clearScratchpad: (collection) => svcClearScratchpad(sessionId, collection),
        queryScratchpad: (args) => svcQueryScratchpad(sessionId, args),
      });
      const allTools = filterToolsByVision(
        [...BUILT_IN_TOOLS, ...mouseTools, ...keyboardTools, ...editorTools, requestLocalFileTool, outputFileTool, ...scratchpadTools],
        modelConfig.vision,
      );
      const toolDefinitions = toolsToDefinitions(allTools);

      // Stream from LLM
      let accumulatedText = "";
      let thinkingAccum = "";
      let thinkingReplay = false;
      const thinkingBlocks: ThinkingContentBlock[] = [];
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
      let lastStepUsage: { inputTokens: number; outputTokens: number } | null = null;
      let lastStopReason: Extract<StreamEvent, { type: "done" }>["stopReason"];
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
        } else if (event.type === "thinking-start") {
          thinkingAccum = "";
          thinkingReplay = event.replay;
        } else if (event.type === "thinking-delta") {
          thinkingAccum += event.text;
          port.postMessage(withSession({ type: "thinking-chunk", text: event.text }, sessionId));
        } else if (event.type === "thinking-end") {
          if (thinkingReplay && thinkingAccum) {
            thinkingBlocks.push({
              type: "thinking",
              thinking: thinkingAccum,
              ...(event.signature ? { signature: event.signature } : {}),
            });
          }
          thinkingAccum = "";
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
        } else if (event.type === "done") {
          lastStopReason = event.stopReason;
          // Issue #59 — capture real provider-reported usage for the ring.
          // Stored to a local and applied after the stream finishes; abort
          // and error paths skip the apply.
          if (event.usage && event.usage.inputTokens > 0) {
            lastStepUsage = event.usage;
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

      // Issue #59 — persist & announce step usage. Done before the abort
      // check intentionally: if the provider emitted done with usage,
      // the LLM round-trip really happened and the tokens were really
      // spent; we should account for them even if the user aborted right
      // after. Storage failure is non-fatal (warn-only) — the loop must
      // not die over a metric write; the panel will catch up on the next
      // successful step.
      if (lastStepUsage) {
        try {
          const cur = await getSessionAgent(sessionId);
          const nextUsage = mergeContextUsage(cur?.contextUsage, lastStepUsage);
          const base: SessionAgentState = cur ?? {
            agentMessages: [],
            pendingInstructions: [],
            stepIndex: 0,
            hasImageContent: false,
          };
          await setSessionAgent(sessionId, { ...base, contextUsage: nextUsage });
          try {
            port.postMessage(
              withSession(
                {
                  type: "agent-usage",
                  lastInputTokens: nextUsage.lastInputTokens,
                  lastOutputTokens: nextUsage.lastOutputTokens,
                  totalInputTokens: nextUsage.totalInputTokens,
                  totalOutputTokens: nextUsage.totalOutputTokens,
                },
                sessionId,
              ),
            );
          } catch (e) {
            // Port disconnected mid-step — panel will rehydrate from
            // SessionAgentState on next mount via useSession.setActive.
            console.warn(
              `[agent] post agent-usage failed for session=${sessionId}:`,
              e,
            );
          }
        } catch (e) {
          console.warn(
            `[agent] persist contextUsage failed for session=${sessionId}:`,
            e,
          );
        }
      }

      // If abort fired during streaming, providers silently return from
      // the generator (no throw). Detect that here BEFORE treating an
      // empty completedToolCalls as a normal pure-text reply — otherwise
      // an aborted stream looks like "LLM ended cleanly" and finally
      // skips its done emit (because normalTextReply gates it).
      if (signal.aborted) return; // → finally with reason-based summary

      // 截断兜底（factor 2）：max_tokens 触顶时不静默当作"任务完成"。
      const completion = classifyStreamCompletion({
        stopReason: lastStopReason,
        hasToolCalls: completedToolCalls.length > 0,
        hasText: accumulatedText.trim().length > 0,
      });
      if (completion === "truncated-empty") {
        // 思考/输出在产出任何可用内容前就触顶——与 LLM-stream-error 同路失败，
        // 不走 chat-done（否则 loop 会假装任务完成）。
        const msg =
          "模型在产出任何回复前就触达输出 token 上限（stop_reason=length），" +
          "通常是长推理吃光了输出预算。请在该 instance 调高最大输出（maxTokens），" +
          "或简化任务后重试。";
        port.postMessage(withSession({ type: "chat-error", error: msg }, sessionId));
        await emitDone({
          type: "agent-done-task",
          success: false,
          summary: msg,
          stepCount: stepIndex,
        }, "fail");
        return;
      }
      if (completion === "truncated-partial") {
        // 部分答案已流式发出但不完整——追加可见提示，再走正常 pure-text 收尾。
        port.postMessage(
          withSession(
            { type: "chat-chunk", text: "\n\n⚠️ [回复被输出 token 上限截断，未必完整。可在该 instance 调高最大输出后重试。]" },
            sessionId,
          ),
        );
        // 不 return，自然落入下面的 completedToolCalls.length === 0 纯文本分支收尾。
      }

      if (completedToolCalls.length === 0 && accumulatedText.trim().length > 0) {
        const textToolCalls = parseTextToolInvocations(accumulatedText);
        if (textToolCalls.length > 0) {
          completedToolCalls.push(...textToolCalls);
          accumulatedText = "";
        }
      }

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
        // Issue #59 — carry over contextUsage to preserve token counts.
        if (ctx.onStepSnapshot) {
          const prev = await getSessionAgent(sessionId);
          ctx.onStepSnapshot(buildSessionAgentTombstone(undefined, prev?.contextUsage)).catch((e) => {
            console.warn(
              `[agent] tombstone (pure-text) failed for session=${ctx.sessionId}:`,
              e,
            );
          });
        }
        return;
      }

      // Build the assistant message with all tool_use blocks (+ optional text + thinking blocks)
      const assistantBlocks: ContentBlock[] = assembleAssistantBlocks(
        thinkingBlocks,
        accumulatedText,
        completedToolCalls,
      );

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
        // One IDB session_index read (via listSessionIndex), fully amortized
        // by the surrounding LLM call. Errors degrade to "no conflicts known"
        // so a transient storage hiccup never falsely blocks a write.
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
          });
          continue;
        }

        // Element resolution is no longer available (pull-mode: read_page stamps
        // data-pie-idx; the loop no longer maintains a frame snapshot).
        const resolvedElement = undefined;

        // Send pending step
        emitStep({
          type: "agent-step",
          stepIndex,
          tool: tc.name,
          args: redactArgsForPanel(tc.name, tc.args),
          resolvedElement,
          status: "pending",
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
          });
          continue;
        }

        // Execute tool
        let result;
        try {
          result = await tool.handler(tc.args, {
            tabId: pinnedTabId,
            confirmedTabTargets: undefined,
            // M5 — frozen at chat-start (passed via AgentLoopContext.pinMode);
            // close_tabs K-9 reads this to refuse closing user-locked pins.
            pinMode: ctx.pinMode,
            // v1.5 — full pinnedTabs array for validation + mutation by
            // focus_tab (Task 6) and open_url (Task 7). Issue #33 —
            // currentPinnedTabs is the per-iteration refreshed array, so
            // focus_tab(newPinId) sees pins appended by open_url in
            // earlier iterations of the same task. Issue #110 follow-up —
            // routed through stepPinView so a same-turn unpin_tab is visible
            // to a later close_tabs in the SAME batch (the getter returns the
            // live, post-unpin list at ctx-build time).
            pinnedTabs: stepPinView.pins,
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
            // Issue #110 — unpin_tab removes a tab from SessionMeta.pinnedTabs[]
            // (persisted) AND from the live stepPinView (so a same-turn
            // close_tabs sees it gone). The storage write is also observed on
            // the next iteration's readFocusFromStorage refresh.
            removePinnedTab: stepPinView.removePinnedTab,
          });
        } catch (e) {
          result = {
            success: false,
            error: e instanceof Error ? e.message : "Tool execution failed",
          };
        }

        let observation = result.observation ?? result.error ?? "";

        // Phase 2.5: when type tool reports IME buffer error and CDP
        // input simulation is OFF, append a hint pointing user to
        // Settings. Skipped when CDP is ON (LLM should retry via
        // dispatch_keyboard_input on its own per system prompt).
        if (
          tc.name === "type" &&
          !result.success &&
          observation.includes("hidden IME / keyboard capture buffer") &&
          !cdpAvailable
        ) {
          observation +=
            "\n(Tip: enable 'Browser input simulation (CDP)' in Settings to handle this case via CDP.)";
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
        });

        // output_file — hand the panel a download card. The agent-step above
        // keeps the call visible in the step stream; this drives the card.
        if (result.fileOutput) {
          port.postMessage(
            withSession(
              {
                type: "file-output",
                artifactId: result.fileOutput.id,
                filename: result.fileOutput.filename,
                mime: result.fileOutput.mime,
                size: result.fileOutput.size,
              },
              sessionId,
            ),
          );
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

    // The loop only exits here when signal.aborted flipped between the step
    // increment and the condition check (the in-body `if (signal.aborted)
    // return` is the usual abort exit). The finally block emits the abort
    // done — there is no "max steps" terminal path anymore.
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
      // TypeScript 6 narrows cdpSession to never in this finally block due to control-flow
      // analysis of the inner async closure assignment; cast through unknown to recover type.
      const reason = (cdpSession as CdpSession | null)?.detachedReason ?? null;
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
