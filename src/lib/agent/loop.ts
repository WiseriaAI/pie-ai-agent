import type { ModelConfig, AgentMessage, ContentBlock, ToolDefinition } from "../model-router/types";
import { streamChat } from "../model-router";
import { snapshotInteractiveElements } from "../dom-actions/snapshot";
import type { PageSnapshot } from "../dom-actions/types";
import {
  BUILT_IN_TOOLS,
  getKeyboardTools,
  isKeyboardToolName,
  isSkillMetaToolName,
} from "./tools";
import { previewMetaSkillCall } from "./tools/skill-meta";
import type { Tool, PreFetchedTabContent } from "./types";
import { classifyRisk, type RiskClassifyContext } from "./risk";
import { TAB_TOOL_NAMES } from "./tool-names";
import { escapeUntrustedWrappers } from "./untrusted-wrappers";
import {
  extractPageContentHardened,
  GET_TAB_CONTENT_PREVIEW_BYTES,
} from "./tools/tabs";
import { buildAgentSystemPrompt, buildObservationMessage } from "./prompt";
import { applySlidingWindow } from "./window";
import { isKeyboardSimulationEnabled } from "../keyboard-simulation";
import { getEnabledSkills, markSkillFirstRun, type SkillDefinition } from "../skills";
import {
  acquireCdpSession,
  type CdpSession,
} from "../../background/cdp-session";
import type {
  AgentStepMessage,
  AgentConfirmRequestMessage,
  AgentDoneTaskMessage,
  ResolvedElement,
  TabTarget,
  TabContentPreview,
} from "../../types/messages";
import type { SessionAgentState } from "../sessions/types";

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
interface SkillScope {
  skillId: string;
  allowedTools: string[] | null;
}

export interface AgentLoopContext {
  port: chrome.runtime.Port;
  task: string;
  modelConfig: ModelConfig;
  signal: AbortSignal;
  sendConfirmRequest: (
    confirmationId: string,
    payload: Omit<AgentConfirmRequestMessage, "type" | "confirmationId">,
  ) => Promise<boolean>;
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
   * `sendAgentStep` / `sendConfirmRequest` paths only.
   *
   * Errors thrown by the handler are logged with sessionId + stepIndex
   * and otherwise swallowed — a quota / IO failure must not abort an
   * in-flight task. M2-U4 will introduce LRU archive on quota
   * pressure; for now we just keep going.
   */
  onStepSnapshot?: (snapshot: SessionAgentState) => Promise<void>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function isRestrictedUrl(url: string): boolean {
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

// ── Phase 3 — Tab target pre-compute for confirm cards ─────────────────────

/** Sanitize a chrome.tabs.Tab title for confirm-card display. Same pipeline
 *  as wrapTabMetadata: strip line breaks → strip control chars → cap length
 *  → escape wrapper-tag literals (P3-G / P3-O). Kept inline (not exported
 *  from tabs.ts) because the panel is the consumer and we want a single
 *  caller-controlled cap for confirm UX. */
const TAB_TITLE_CAP = 100;
const TAB_URL_CAP = 200;
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const LINE_BREAK_RE = /[\n\r\v\f]/g;

function sanitizeTitleForConfirm(title: string | undefined): string {
  if (!title) return "(untitled)";
  let cleaned = title.replace(LINE_BREAK_RE, " ").replace(CONTROL_CHARS_RE, "");
  if (cleaned.length > TAB_TITLE_CAP) {
    cleaned = cleaned.slice(0, TAB_TITLE_CAP) + "…";
  }
  return escapeUntrustedWrappers(cleaned);
}

function sanitizeUrlForConfirm(url: string | undefined): string {
  if (!url) return "";
  // URLs are not free-form text — control chars are protocol-violating, but
  // we still cap length and escape any wrapper-tag literal that could appear
  // in a query string.
  const cleaned = url.replace(CONTROL_CHARS_RE, "").slice(0, TAB_URL_CAP);
  return escapeUntrustedWrappers(cleaned);
}

/** Phase 3 SEC-5 — only accept https:// or data:image/ favicon URLs.
 *  Other protocols (javascript:, http:, chrome://favicon proxy, etc.) are
 *  page-controlled vectors that AgentConfirmCard would render via <img src>.
 *  When stripped, the panel falls back to a default icon. */
function safeFavIconUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith("https://") || raw.startsWith("data:image/")) {
    return raw;
  }
  return undefined;
}

/** Build a TabTarget array for a tool call. Returns undefined when the args
 *  don't reference any specific tabs (or any tabs at all — no pre-fetch is
 *  meaningful). The handler still receives the cached origins via ctx so the
 *  risk classifier can do cross-origin introspection (P3-A).
 *
 *  Inputs:
 *   - tabIds: number[]   — close_tabs / group_tabs / ungroup_tabs / move_tabs
 *   - tabId: number      — activate_tab / get_tab_content
 *   - scope: "allWindows" — list_tabs allWindows (we pre-fetch all tabs as
 *                            informed-approval payload)
 *
 *  All three branches share the same chrome.tabs.get / query → TabTarget[]
 *  pipeline. Stale tabs (chrome.tabs.get rejects) are still emitted with
 *  stale: true so the user sees them in the card and the handler can skip
 *  them at dispatch time (K-8 confirm-time origin re-verify).
 */
async function buildTabTargets(
  toolName: string,
  args: Record<string, unknown>,
  pinnedOrigin: string,
): Promise<TabTarget[] | undefined> {
  let candidates: chrome.tabs.Tab[] = [];
  if (toolName === "list_tabs" && args.scope === "allWindows") {
    // SEC-3: surface all tabs across windows in the confirm card so the user
    // can see exactly what is being exposed to the BYOK provider.
    try {
      const all = await chrome.tabs.query({});
      // Cap at 50 — wrapTabMetadata will report total + truncated to the LLM
      // post-approval; the confirm card just needs the informed-approval set.
      candidates = all.slice(0, 50);
    } catch {
      return undefined;
    }
  } else {
    const ids: number[] = [];
    if (Array.isArray(args.tabIds)) {
      for (const v of args.tabIds) {
        if (typeof v === "number") ids.push(v);
      }
    }
    if (typeof args.tabId === "number") {
      ids.push(args.tabId);
    }
    if (ids.length === 0) return undefined;
    // Parallel chrome.tabs.get; reject → stale TabTarget placeholder.
    const settled = await Promise.allSettled(ids.map((id) => chrome.tabs.get(id)));
    settled.forEach((r, i) => {
      const id = ids[i];
      if (r.status === "fulfilled") {
        candidates.push(r.value);
      } else {
        // Push a synthetic stale tab entry so the card row exists with
        // (closed) marker.
        candidates.push({
          id,
          url: "",
          title: "(closed or inaccessible)",
          active: false,
          pinned: false,
          highlighted: false,
          incognito: false,
          windowId: -1,
          discarded: false,
          autoDiscardable: true,
          groupId: -1,
          index: -1,
          favIconUrl: undefined,
          // We use _stale as a marker on the chrome.tabs.Tab shape and pick it
          // up below; chrome's type doesn't include it, so cast.
        } as unknown as chrome.tabs.Tab);
      }
    });
  }

  return candidates.map((t): TabTarget => {
    const id = typeof t.id === "number" ? t.id : -1;
    const url = t.url ?? "";
    const origin = safeParseOrigin(url) ?? "";
    const stale = !url || id === -1 || t.title === "(closed or inaccessible)";
    return {
      id,
      title: sanitizeTitleForConfirm(t.title),
      url: sanitizeUrlForConfirm(url),
      origin,
      favIconUrl: safeFavIconUrl(t.favIconUrl),
      crossOrigin: !stale && origin !== pinnedOrigin,
      stale: stale || undefined,
    };
  });
}

/** Build a Map<tabId, {origin}> from a TabTarget array for risk classifier
 *  ctx. Stale entries are intentionally absent so hasCrossOriginTab treats
 *  them as conservative-fail-high (which is the right call — if we don't
 *  know the origin we shouldn't assume same-origin). */
function tabTargetsToOriginCache(
  targets: TabTarget[] | undefined,
): Map<number, { origin: string }> | undefined {
  if (!targets || targets.length === 0) return undefined;
  const m = new Map<number, { origin: string }>();
  for (const t of targets) {
    if (t.stale) continue;
    if (!t.origin) continue;
    m.set(t.id, { origin: t.origin });
  }
  return m;
}

/**
 * Phase 3 P3-U / SEC-2 — pre-fetch get_tab_content before the confirm card,
 * with timeout-guard for frozen tabs (W3C WebExtensions #527).
 *
 * Returns:
 *   - { ok: true, fullText, totalBytes } when extract succeeded
 *   - { ok: false, reason } for restricted URL / discarded tab / timeout /
 *     extract failure
 *
 * The full text goes into ctx.preFetchedContent so the handler doesn't
 * re-run executeScript after approval (avoids race with page navigation).
 * Only the first GET_TAB_CONTENT_PREVIEW_BYTES are shown in the confirm
 * card — the user sees enough to spot credentials before approving.
 */
async function preFetchTabContent(
  tabId: number,
): Promise<
  | { ok: true; fullText: string; totalBytes: number; origin: string }
  | { ok: false; reason: string }
> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (!tab.url || isRestrictedUrl(tab.url)) {
    return { ok: false, reason: "restrictedUrl" };
  }
  if (tab.discarded) {
    return { ok: false, reason: "discardedTabRequiresActivation" };
  }
  const origin = safeParseOrigin(tab.url);
  if (!origin) {
    return { ok: false, reason: "unresolvableOrigin" };
  }

  const FROZEN_TIMEOUT_MS = 5000;
  try {
    const fetchPromise = chrome.scripting.executeScript({
      target: { tabId },
      func: extractPageContentHardened,
    });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("extractTimeout")), FROZEN_TIMEOUT_MS),
    );
    const results = (await Promise.race([
      fetchPromise,
      timeoutPromise,
    ])) as chrome.scripting.InjectionResult<{
      text: string;
      totalBytes: number;
    }>[];
    const r = results[0]?.result;
    if (!r) {
      return { ok: false, reason: "extractFailed" };
    }
    return {
      ok: true,
      fullText: r.text,
      totalBytes: r.totalBytes,
      origin,
    };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : "extractFailed",
    };
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
 *
 * `skillExecutionScopeStack` is empty in M1 — the in-memory
 * `currentSkillScope` carries Phase 2.6 R3 anti-nest enforcement. M2-U1
 * will wire the stack so a paused-and-resumed task can re-enter the
 * scope it was in.
 */
export function buildSessionAgentSnapshot(
  history: AgentMessage[],
  stepIndex: number,
): SessionAgentState {
  return {
    agentMessages: structuredClone(history),
    stepIndex,
    skillExecutionScopeStack: [],
  };
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
  const { port, task, modelConfig, sendConfirmRequest, getEnabledSkillTools } = ctx;

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

  const ownerToken = crypto.randomUUID();
  let cdpSession: CdpSession | null = null;
  let doneEmitted = false;
  let lastStepIndex = 0;
  let normalTextReply = false; // pure-text reply uses chat-done, not agent-done-task
  let currentSkillScope: SkillScope | null = null; // Phase 2.6 — see SkillScope JSDoc above

  // Idempotent done emit — every runAgentLoop exit path (success, abort,
  // error, finally) calls this; first one wins, the rest are no-ops.
  const emitDone = (msg: AgentDoneTaskMessage): void => {
    if (doneEmitted) return;
    doneEmitted = true;
    sendAgentDone(port, msg);
  };

  // 1. Anchor tab + origin at task start
  let pinnedTabId: number;
  let pinnedOrigin: string;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || isRestrictedUrl(tab.url)) {
      emitDone({
        type: "agent-done-task",
        success: false,
        summary: "Cannot run agent on this page type",
        stepCount: 0,
      });
      return;
    }
    const origin = safeParseOrigin(tab.url);
    if (!origin) {
      emitDone({
        type: "agent-done-task",
        success: false,
        summary: "Cannot run agent on this page (unresolvable origin)",
        stepCount: 0,
      });
      return;
    }
    pinnedTabId = tab.id;
    pinnedOrigin = origin;
  } catch {
    emitDone({
      type: "agent-done-task",
      success: false,
      summary: "Failed to get active tab",
      stepCount: 0,
    });
    return;
  }

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
  const history: AgentMessage[] = [
    {
      role: "system",
      content: buildAgentSystemPrompt(task, keyboardSimEnabledAtStart, /* hasMetaTools */ true),
    },
    { role: "user", content: task },
  ];

  // First-attach disclosure — true until the first keyboard-tool confirm
  // has been shown. After that, subsequent confirms in the same task
  // skip the debugger-activation preamble (yellow bar already visible).
  let firstKeyboardConfirmShown = false;

  // Phase 3 K-10 (reject-side) — per-task confirm-fatigue short-circuit.
  // Key is tool name (close_tabs, group_tabs, etc.); value is consecutive
  // reject count for that tool name in this task. When a tool reaches
  // CONFIRM_REJECT_THRESHOLD rejects, the loop emits agent-done with a
  // failure summary so the LLM can't keep re-issuing the same call and
  // training the user to mash approve. Counter is task-scoped (cleared
  // when runAgentLoop returns); approve does NOT reset the counter (a
  // user oscillating reject/approve/reject is still trending toward
  // fatigue). Cross-origin approve-side reflection was scoped out (see
  // plan K-10 update during document review).
  const confirmRejections = new Map<string, number>();
  const CONFIRM_REJECT_THRESHOLD = 3;

  try {
    for (let stepIndex = 1; stepIndex <= MAX_STEPS; stepIndex++) {
      lastStepIndex = stepIndex;
      if (signal.aborted) return; // → finally

      // Origin check
      let currentUrl: string;
      try {
        const currentTab = await chrome.tabs.get(pinnedTabId);
        if (!currentTab.url || isRestrictedUrl(currentTab.url)) {
          emitDone({
            type: "agent-done-task",
            success: false,
            summary: "Page navigated to a restricted URL, agent stopped",
            stepCount: stepIndex - 1,
          });
          return;
        }
        const currentOrigin = safeParseOrigin(currentTab.url);
        if (!currentOrigin || currentOrigin !== pinnedOrigin) {
          emitDone({
            type: "agent-done-task",
            success: false,
            summary: "Page origin changed, agent stopped for safety",
            stepCount: stepIndex - 1,
          });
          return;
        }
        currentUrl = currentTab.url;
      } catch {
        emitDone({
          type: "agent-done-task",
          success: false,
          summary: "Tab was closed, agent stopped",
          stepCount: stepIndex - 1,
        });
        return;
      }

      // Snapshot the page
      let snapshot: PageSnapshot;
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: pinnedTabId },
          func: snapshotInteractiveElements,
        });
        snapshot = (results[0]?.result as PageSnapshot) ?? { url: currentUrl, title: "", elements: [] };
      } catch {
        emitDone({
          type: "agent-done-task",
          success: false,
          summary: "Failed to snapshot page. The page may have navigated.",
          stepCount: stepIndex - 1,
        });
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

      // Apply sliding window
      const windowedHistory = applySlidingWindow(history);

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

      for await (const event of streamChat(modelConfig, windowedHistory, signal, toolDefinitions)) {
        if (signal.aborted) return; // → finally

        if (event.type === "text-delta") {
          accumulatedText += event.text;
          // Stream text to panel as it arrives (Phase 1 compatible)
          port.postMessage({ type: "chat-chunk", text: event.text });
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
          port.postMessage({ type: "chat-error", error: event.error });
          emitDone({
            type: "agent-done-task",
            success: false,
            summary: `LLM stream error: ${event.error}`,
            stepCount: stepIndex,
          });
          return;
        }
      }

      // If abort fired during streaming, providers silently return from
      // the generator (no throw). Detect that here BEFORE treating an
      // empty completedToolCalls as a normal pure-text reply — otherwise
      // an aborted stream looks like "LLM ended cleanly" and finally
      // skips its done emit (because normalTextReply gates it).
      if (signal.aborted) return; // → finally with reason-based summary

      // Pure text response (no tool calls) — finish as normal chat
      if (completedToolCalls.length === 0) {
        port.postMessage({ type: "chat-done" });
        normalTextReply = true;
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
          sendAgentStep(port, {
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

        // ── Phase 2.6 — Skill scope enforcement (R2 + R3 anti-nest) ────────
        // Inserted between tool-lookup and risk-classify so rejected calls
        // skip risk classification, confirm card, and handler entirely.
        if (currentSkillScope) {
          let scopeRejection: string | null = null;
          if (skillResolvedNames.has(tc.name)) {
            // R3: skills cannot call other skills (would compose into deep
            // chains the user never reviewed; also opens recursion footguns).
            scopeRejection = `Skills cannot call other skills (currently in '${currentSkillScope.skillId}' scope; '${tc.name}' is a skill).`;
          } else if (
            currentSkillScope.allowedTools !== null &&
            !currentSkillScope.allowedTools.includes(tc.name)
          ) {
            // R2: allowedTools whitelist is loop-enforced, not a prompt hint.
            const allowedList = currentSkillScope.allowedTools.join(", ");
            scopeRejection = `tool '${tc.name}' not allowed in skill '${currentSkillScope.skillId}' scope. Allowed: [${allowedList}]. Call done or fail to exit.`;
          }
          if (scopeRejection !== null) {
            toolResultBlocks.push({
              type: "tool_result",
              toolUseId: tc.id,
              content: scopeRejection,
              isError: true,
            });
            sendAgentStep(port, {
              type: "agent-step",
              stepIndex,
              tool: tc.name,
              args: redactArgsForPanel(tc.name, tc.args),
              status: "error",
              observation: scopeRejection,
              skillAuthor: skillAuthorForStep,
            });
            continue;
          }
        }

        // Resolve element for confirmation / display
        const resolvedElement = resolveElement(snapshot, args.elementIndex);

        // Send pending step
        sendAgentStep(port, {
          type: "agent-step",
          stepIndex,
          tool: tc.name,
          args: redactArgsForPanel(tc.name, tc.args),
          resolvedElement,
          status: "pending",
          skillAuthor: skillAuthorForStep,
        });

        // Phase 3 — pre-compute TabTarget[] for tab tools so the confirm card
        // can render an informed-approval payload (P3-E) AND the risk
        // classifier can do cross-origin args introspection (P3-A) using the
        // already-fetched origins (no second chrome.tabs.get round-trip).
        let tabTargets: TabTarget[] | undefined;
        const isTabTool = (TAB_TOOL_NAMES as readonly string[]).includes(tc.name);
        if (isTabTool) {
          tabTargets = await buildTabTargets(tc.name, args, pinnedOrigin);
        }

        // Phase 3 P3-U / SEC-2 — pre-fetch get_tab_content BEFORE the confirm
        // card so the user can see the actual content they're about to send
        // to the LLM. The full text is cached on ctx so the handler reuses
        // it after approval (no race with post-approval navigation).
        //
        // CRITICAL: pre-fetch failure (frozen tab, restricted URL, transient
        // executeScript timeout, etc.) MUST still emit a contentPreview —
        // otherwise the confirm card silently hides the preview block and
        // the user approves blind, defeating the SEC-2 invariant. We emit a
        // sentinel preview that explicitly says "preview unavailable" with
        // the failure reason so the user can choose to reject.
        let contentPreview: TabContentPreview | undefined;
        let preFetchedContent: Map<number, PreFetchedTabContent> | undefined;
        if (tc.name === "get_tab_content") {
          const tabIdArg = typeof args.tabId === "number" ? args.tabId : undefined;
          if (typeof tabIdArg === "number") {
            const pre = await preFetchTabContent(tabIdArg);
            if (pre.ok) {
              const previewText = escapeUntrustedWrappers(
                pre.fullText.slice(0, GET_TAB_CONTENT_PREVIEW_BYTES),
              );
              contentPreview = {
                tabId: tabIdArg,
                origin: pre.origin,
                previewText,
                truncatedAtBytes: GET_TAB_CONTENT_PREVIEW_BYTES,
                totalBytes: pre.totalBytes,
              };
              preFetchedContent = new Map();
              preFetchedContent.set(tabIdArg, {
                fullText: pre.fullText,
                totalBytes: pre.totalBytes,
              });
            } else {
              // Sentinel preview — confirm card MUST show the failure
              // explicitly. Approving blind is still possible (the user
              // may legitimately want the agent to retry), but they see
              // exactly what's missing.
              contentPreview = {
                tabId: tabIdArg,
                origin: "",
                previewText: `(preview unavailable: ${pre.reason}) — approving will let the agent fetch content fresh; fetch may still fail or expose content the preview could not show.`,
                truncatedAtBytes: 0,
                totalBytes: 0,
              };
              // preFetchedContent intentionally remains undefined so the
              // handler runs a fresh fetch (which will likely fail the
              // same way and surface the failure in the observation).
            }
          }
        }

        const riskCtx: RiskClassifyContext = {
          pinnedOrigin,
          allTabsCache: tabTargetsToOriginCache(tabTargets),
        };

        // Risk classification
        const risk = classifyRisk(
          tc.name,
          args as {
            elementIndex?: number;
            value?: string;
            tabIds?: number[];
            tabId?: number;
            scope?: string;
          },
          snapshot,
          riskCtx,
        );

        if (risk.level === "high") {
          const confirmationId = crypto.randomUUID();

          // Build confirm reason — keyboard tools' first call gets a
          // debugger-activation disclosure prepended.
          let riskReason = risk.reason ?? "High risk operation";
          if (
            isKeyboardToolName(tc.name) &&
            !firstKeyboardConfirmShown &&
            !cdpSession
          ) {
            riskReason =
              "First keyboard-simulation call — Chrome debugger will activate (yellow bar) for the rest of this task. Cancel by clicking the yellow bar, ending the task, or toggling Settings off.\n\n" +
              riskReason;
            firstKeyboardConfirmShown = true;
          }

          // Phase 2.6 — for create_skill / update_skill, pre-compute the
          // effective merged skill so AgentConfirmCard can render full
          // content instead of just the patch (P0-D / adv-1 closure).
          let metaSkillPreview: { existing: SkillDefinition | null; effective: SkillDefinition } | undefined;
          if (tc.name === "create_skill" || tc.name === "update_skill") {
            metaSkillPreview = (await previewMetaSkillCall(tc.name, tc.args)) ?? undefined;
          }

          // confirm-request keeps RAW args.text — user must see the
          // actual content to make an informed approval. agent-step
          // (above + below) uses redactArgsForPanel.
          const approved = await sendConfirmRequest(confirmationId, {
            tool: tc.name,
            args: tc.args,
            resolvedElement: resolvedElement ?? { text: "", tag: "" },
            riskReason,
            metaSkillPreview,
            tabTargets,
            contentPreview,
          });

          if (!approved) {
            const prevRejects = confirmRejections.get(tc.name) ?? 0;
            const nextRejects = prevRejects + 1;
            confirmRejections.set(tc.name, nextRejects);

            // K-10 reject-side: terminate task after threshold consecutive
            // rejects for the same tool name to break a fatigue cycle.
            if (nextRejects >= CONFIRM_REJECT_THRESHOLD) {
              const fatigueMsg = `User repeatedly rejected ${tc.name} (${nextRejects} times). Stopping task.`;
              toolResultBlocks.push({
                type: "tool_result",
                toolUseId: tc.id,
                content: fatigueMsg,
                isError: true,
              });
              sendAgentStep(port, {
                type: "agent-step",
                stepIndex,
                tool: tc.name,
                args: redactArgsForPanel(tc.name, tc.args),
                resolvedElement,
                status: "error",
                observation: fatigueMsg,
                skillAuthor: skillAuthorForStep,
              });
              emitDone({
                type: "agent-done-task",
                success: false,
                summary: fatigueMsg,
                stepCount: stepIndex,
              });
              return;
            }

            const rejectionMsg = "User rejected";
            toolResultBlocks.push({
              type: "tool_result",
              toolUseId: tc.id,
              content: rejectionMsg,
              isError: true,
            });
            sendAgentStep(port, {
              type: "agent-step",
              stepIndex,
              tool: tc.name,
              args: redactArgsForPanel(tc.name, tc.args),
              resolvedElement,
              status: "error",
              observation: rejectionMsg,
              skillAuthor: skillAuthorForStep,
            });
            continue;
          }
        }

        // ── Phase 2.6 — R10 first-run confirm for agent-authored skills ────
        // Triggers on skill-resolved tool_call when:
        //   skill.author === 'agent' (covers create_skill output AND any
        //     skill recently update_skill'd — author is tainted by P0-C)
        //   skill.firstRunConfirmedAt is absent (cleared on every update)
        // After approval we persist the timestamp; if persistence fails we
        // fail-open (proceed with handler; next run will gate again).
        if (skillResolvedNames.has(tc.name)) {
          const skillDef = skillDefByName.get(tc.name);
          if (
            skillDef &&
            skillDef.author === "agent" &&
            !skillDef.firstRunConfirmedAt
          ) {
            const firstRunConfirmId = crypto.randomUUID();
            const dateStr = skillDef.createdAt
              ? new Date(skillDef.createdAt).toLocaleString()
              : "an earlier session";
            const firstRunReason = `This skill was authored or last modified by the agent on ${dateStr}. This is its first execution since modification — review the skill in Settings if needed, then confirm to allow it to run.`;
            const approvedFirstRun = await sendConfirmRequest(firstRunConfirmId, {
              tool: tc.name,
              args: tc.args,
              resolvedElement: resolvedElement ?? { text: skillDef.name, tag: "skill" },
              riskReason: firstRunReason,
            });
            if (!approvedFirstRun) {
              const rejectionMsg = "Skill first-run not approved";
              toolResultBlocks.push({
                type: "tool_result",
                toolUseId: tc.id,
                content: rejectionMsg,
                isError: true,
              });
              sendAgentStep(port, {
                type: "agent-step",
                stepIndex,
                tool: tc.name,
                args: redactArgsForPanel(tc.name, tc.args),
                resolvedElement,
                status: "error",
                observation: rejectionMsg,
                skillAuthor: skillAuthorForStep,
              });
              continue;
            }
            const firstRunTs = Date.now();
            try {
              await markSkillFirstRun(tc.name, firstRunTs);
              // Update in-memory cache so a re-call within the same step
              // does not re-trigger the gate.
              skillDefByName.set(tc.name, { ...skillDef, firstRunConfirmedAt: firstRunTs });
            } catch (e) {
              // fail-open: proceed with handler; next call will gate again.
              console.warn(
                `[loop] markSkillFirstRun failed for ${tc.name}; first-run gate will re-fire on next execution:`,
                e,
              );
            }
          }
        }

        // Phase 3 — confirm-time TabTarget snapshot for cross-tab handlers.
        // K-8: handlers compare live tab origin against this map's origin
        // (what the user saw on the confirm card), NOT pinnedOrigin. If a
        // tab navigated between approval and dispatch, the handler skips it.
        let confirmedTabTargets:
          | Map<number, { origin: string; title: string }>
          | undefined;
        if (tabTargets && tabTargets.length > 0) {
          confirmedTabTargets = new Map();
          for (const t of tabTargets) {
            if (t.stale) continue;
            confirmedTabTargets.set(t.id, { origin: t.origin, title: t.title });
          }
        }

        // Execute tool
        let result;
        try {
          result = await tool.handler(tc.args, {
            tabId: pinnedTabId,
            snapshot,
            confirmedTabTargets,
            preFetchedContent,
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

        sendAgentStep(port, {
          type: "agent-step",
          stepIndex,
          tool: tc.name,
          args: redactArgsForPanel(tc.name, tc.args),
          resolvedElement,
          status: result.success ? "ok" : "error",
          observation,
          skillAuthor: skillAuthorForStep,
        });

        // Phase 2.6 — Skill scope transition.
        // Enter scope after a successful skill-resolved tool_call. Failed
        // skill handlers do NOT enter scope (avoid half-state). The scope
        // replaces any prior scope (R3 already rejected nested skill_calls,
        // so reaching this branch with an existing scope is unreachable in
        // practice; the assignment is still correct as overwrite).
        if (skillResolvedNames.has(tc.name) && result.success) {
          currentSkillScope = {
            skillId: tc.name,
            allowedTools: skillDefForStep?.allowedTools ?? null,
          };
        }

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
        const snapshot = buildSessionAgentSnapshot(history, stepIndex);
        ctx.onStepSnapshot(snapshot).catch((e) => {
          console.warn(
            `[agent] snapshot failed for session=${ctx.sessionId} step=${stepIndex}:`,
            e,
          );
        });
      }

      // Terminal tool check
      if (shouldTerminate && terminationResult) {
        emitDone({
          type: "agent-done-task",
          success: terminationResult.success,
          summary: terminationResult.summary,
          stepCount: stepIndex,
        });
        return;
      }
    }

    // Max steps exceeded
    emitDone({
      type: "agent-done-task",
      success: false,
      summary: "Max steps reached",
      stepCount: MAX_STEPS,
    });
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
      emitDone({
        type: "agent-done-task",
        success: false,
        summary,
        stepCount: lastStepIndex,
      });
    }
  }
}
