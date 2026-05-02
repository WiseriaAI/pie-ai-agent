// Service Worker — background script for Chrome AI Agent

import type {
  PageContent,
  ExtractPageResponse,
  PortMessageToWorker,
  AgentConfirmRequestMessage,
  PinnedTabDriftPayload,
  SessionConfirmRequestMessage,
  AgentDoneTaskMessage,
  DisplayMessage,
} from "@/types";
import type {
  AgentMessage,
  ChatMessage,
  ContentBlock,
  ModelConfig,
} from "@/lib/model-router";
import { getActiveProvider, getProviderConfig } from "@/lib/storage";
import { runAgentLoop, safeParseOrigin } from "@/lib/agent/loop";
import { getEnabledSkills, resolveSkillToTools } from "@/lib/skills";
import {
  setSessionAgent,
  setPendingConfirm,
  scrubPendingConfirm,
  getSessionAgent,
  getSessionMeta,
  setSessionMeta,
  markFailedAndScrub,
  updateLastAccessed,
  isPendingConfirmFloodLimited,
} from "@/lib/sessions/storage";
import { escapeUntrustedWrappers } from "@/lib/agent/untrusted-wrappers";
import {
  detectAndMarkPaused,
  transitionPortInFlightSessionsToPaused,
} from "./session-recovery";
import {
  handleExternalDetach,
  detachAllSessions,
} from "./cdp-session";
import { KEYBOARD_SIMULATION_STORAGE_KEY } from "@/lib/keyboard-simulation";
import { runSessionMigrations } from "@/lib/sessions/migration";
import { chat } from "@/lib/model-router";
import { generateTitle, maybeUpgradeFallbackTitle } from "@/lib/sessions/title-generator";

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
});

// Set side panel behavior: open on action click
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// M2-U1 — migration + recovery pipeline.
//
// `recoveryReady` is a module-level promise that sequentially:
//   1. Runs idempotent storage migrations (rename/drop any 'default' id
//      residue from early M1 development) — must finish before step 2
//      so `detectAndMarkPaused` sees only UUID-keyed sessions.
//   2. Runs M1-U5 paused-session cold-start detection.
//
// The promise is reused across the three SW startup entry points
// (top-level, onStartup, onInstalled) so all three go through the same
// ordered pipeline rather than each calling detectAndMarkPaused
// independently. The 30s `recoveryGuard` inside detectAndMarkPaused
// deduplicates repeated calls.
const recoveryReady: Promise<void> = runSessionMigrations()
  .catch((e) => {
    console.warn("[sw] session migrations failed:", e);
  })
  .then(() => detectAndMarkPaused())
  .catch((e) => {
    console.warn("[sw] recovery on top-level failed:", e);
  }) as Promise<void>;

// First install handler
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.storage.local.set({ firstRun: true });
  }
  // Belt-and-suspenders: also chain recovery for install events.
  // recoveryReady deduplicates via 30s guard.
  recoveryReady.catch((e) => {
    console.warn("[sw] recovery on onInstalled failed:", e);
  });
});

// M1-U5 — Chrome process startup recovery. NOTE: in MV3 this fires
// only on Chrome launch, NOT on SW wake-up after 30s idle. The
// top-level recoveryReady covers wake-ups. Fire-and-forget.
chrome.runtime.onStartup.addListener(() => {
  recoveryReady.catch((e) => {
    console.warn("[sw] recovery on onStartup failed:", e);
  });
});

// --- Phase 2.5 — CDP keyboard simulation lifecycle hooks ---
// These listeners must be registered at the SW top level so they
// re-register on every SW restart. Both routes converge on the same
// teardown path inside cdp-session.ts (idempotent detach + caller
// abort propagation).

// User clicks "Cancel" on the yellow debug bar (or Chrome detaches
// for any other reason — tab closed, target crashed, 5-min idle
// timeout). Routes to handleExternalDetach which marks the session
// dead and fires the owning agent task's abort callback.
chrome.debugger.onDetach.addListener((source, reason) => {
  if (typeof source.tabId !== "number") return;
  // reason values per CDP docs: "target_closed" | "canceled_by_user"
  // and a few others. We map all to user-cancelled-via-yellow-bar
  // unless we can distinguish — the agent task's response is the same
  // (abort with summary), only the summary text differs.
  if (reason === "target_closed") {
    handleExternalDetach(source.tabId, "tab-closed");
  } else {
    handleExternalDetach(source.tabId, "user-cancelled-via-yellow-bar");
  }
});

// User toggles "Keyboard simulation" OFF in Settings while a task is
// running. Tear down every live session immediately + propagate abort
// to each owning task. Toggle ON is a no-op here (next acquire creates
// the session lazily).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const change = changes[KEYBOARD_SIMULATION_STORAGE_KEY];
  if (!change) return;
  if (change.newValue === false || change.newValue === undefined) {
    void detachAllSessions("kill-switch");
  }
});

// --- Page Content Extraction ---

// Self-contained function for chrome.scripting.executeScript
// MUST NOT reference any external variables, imports, or closures
function extractPageContent(): PageContent {
  const title = document.title || "";
  const url = location.href;

  // Meta description
  const metaDesc =
    document.querySelector<HTMLMetaElement>('meta[name="description"]')
      ?.content ||
    document.querySelector<HTMLMetaElement>('meta[property="og:description"]')
      ?.content ||
    "";

  // Content extraction with priority fallback
  let contentElement: Element | null =
    document.querySelector("article") ||
    document.querySelector("main") ||
    document.querySelector('[role="main"]');

  let text: string;
  if (contentElement) {
    text = contentElement.textContent || "";
  } else {
    // Fallback to body, filtering out non-content elements
    const body = document.body;
    if (!body) {
      return { title, url, description: metaDesc, content: "" };
    }
    const clone = body.cloneNode(true) as HTMLElement;
    const removeTags = [
      "script",
      "style",
      "nav",
      "footer",
      "header",
      "aside",
      "noscript",
      "svg",
    ];
    for (const tag of removeTags) {
      for (const el of clone.querySelectorAll(tag)) {
        el.remove();
      }
    }
    text = clone.textContent || "";
  }

  // Clean up whitespace
  text = text.replace(/\s+/g, " ").trim();

  // Truncate at ~50,000 chars on sentence boundary
  const MAX_LENGTH = 50_000;
  if (text.length > MAX_LENGTH) {
    const truncated = text.slice(0, MAX_LENGTH);
    const lastSentence = Math.max(
      truncated.lastIndexOf("。"),
      truncated.lastIndexOf("."),
      truncated.lastIndexOf("!"),
      truncated.lastIndexOf("?"),
      truncated.lastIndexOf("！"),
      truncated.lastIndexOf("？"),
    );
    text =
      lastSentence > MAX_LENGTH * 0.8
        ? truncated.slice(0, lastSentence + 1)
        : truncated;
  }

  return { title, url, description: metaDesc, content: text };
}

async function handleExtractPage(): Promise<ExtractPageResponse> {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab?.id) {
      return { type: "page-content", data: null, error: "No active tab" };
    }

    const url = tab.url || "";
    if (
      url.startsWith("chrome://") ||
      url.startsWith("chrome-extension://") ||
      url.startsWith("about:") ||
      url.startsWith("edge://")
    ) {
      return {
        type: "page-content",
        data: null,
        error: "Cannot access this page type",
      };
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageContent,
    });

    const data = results[0]?.result as PageContent | undefined;
    return { type: "page-content", data: data ?? null };
  } catch (e) {
    return {
      type: "page-content",
      data: null,
      error: e instanceof Error ? e.message : "Failed to extract page content",
    };
  }
}

// Message listener for page extraction requests
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "extract-page") {
    handleExtractPage().then(sendResponse);
    return true; // async response
  }
});

// --- M1-U4: panel-mounted handler ---

/**
 * Re-emit any live confirm-request to a freshly-mounted panel (R4).
 *
 * Two-source invariant: only re-push when BOTH storage has a
 * `pendingConfirm` record AND the SW still holds the corresponding
 * resolver in `pendingConfirmations`. Mismatch means the SW has
 * restarted (resolver gone) — in that case, M1-U5's cold-start
 * cleanup will mark the session failed; here we just stay silent
 * rather than render a card the user can't act on.
 *
 * Idempotent on the panel side: useSession's onMessage handler
 * de-dupes by confirmationId, so multiple panel-mounted in quick
 * succession (e.g. React strict-mode double-mount in dev) won't
 * stack duplicate cards.
 */
async function handlePanelMounted(
  port: chrome.runtime.Port,
  sessionId: string,
  pendingConfirmations: Map<string, (result: { approved: boolean; reason?: "user-reject" | "aborted" }) => void>,
): Promise<void> {
  // M1-U5 — panel mounting is a strong signal that the SW has just
  // woken up (panel open ⇒ SW kept alive ⇒ guaranteed wake-up event).
  // Await the module-level recoveryReady (migration → detectAndMarkPaused
  // pipeline) so storage is clean before we read pendingConfirm below.
  // Guard window dedupes repeated calls. M2-U1: recoveryReady includes
  // migrations so a 'default' id residue is cleaned before the panel
  // can observe stale state.
  await recoveryReady.catch((e) => {
    console.warn(
      `[sw] recovery during panel-mounted failed for session=${sessionId}:`,
      e,
    );
  });

  const agent = await getSessionAgent(sessionId);
  if (!agent?.pendingConfirm) return;
  const { confirmationId, kind, payload } = agent.pendingConfirm;

  // Only re-push if the SW resolver is still alive — otherwise the user
  // would see a card they can't act on (clicking approve/reject would
  // post to a Map that's been cleared by SW restart).
  if (!pendingConfirmations.has(confirmationId)) return;

  if (kind === "agent-tool") {
    // Re-emit the original AgentConfirmRequestMessage shape. The
    // payload was persisted with explicit field listing in
    // sendConfirmRequest, so it carries the right shape verbatim.
    const p = payload as Omit<
      AgentConfirmRequestMessage,
      "type" | "confirmationId"
    >;
    port.postMessage({
      type: "agent-confirm-request",
      confirmationId,
      ...p,
      sessionId,
    } satisfies AgentConfirmRequestMessage);
  } else if (kind === "pinned-tab-drift" || kind === "paused-resume") {
    // M1-U5 — re-emit the SessionConfirmRequestMessage shape. The
    // panel's useSession listener routes this to a SessionConfirmCard
    // render path independent of agent-tool confirm cards.
    port.postMessage({
      type: "session-confirm-request",
      confirmationId,
      kind,
      payload,
      sessionId,
    } satisfies SessionConfirmRequestMessage);
  }
}

// --- M1-U5: Resume + Discard handlers ---

/**
 * Detect whether the pinned tab is still usable for resuming a paused
 * task. Returns null if no drift (tab present + origin unchanged), or
 * a `PinnedTabDriftPayload` describing the kind of drift detected.
 *
 * Sanitization: `lastPinnedTabTitle` and `originalTask` are
 * user/page-controlled strings; both run through
 * `escapeUntrustedWrappers` before they reach the panel (P3-G family).
 */
async function checkPinnedDrift(
  meta: { pinnedTabId?: number; pinnedOrigin?: string; messages: DisplayMessage[] },
  agentStepIndex: number,
): Promise<PinnedTabDriftPayload | null> {
  // Pull the original task from the first user message if available.
  const firstUser = meta.messages.find((m) => m.role === "user");
  const rawTask = firstUser && firstUser.role === "user" ? firstUser.content : "";
  const originalTask = escapeUntrustedWrappers(rawTask);

  if (meta.pinnedTabId === undefined || !meta.pinnedOrigin) {
    // M1 sessions don't have pinned anchored at creation (M3-U2
    // ships that). No drift can be detected — treat as drift=null
    // and let the loop's per-round origin check pick up real drift
    // mid-resume.
    return null;
  }

  let tab: chrome.tabs.Tab | null = null;
  try {
    tab = await chrome.tabs.get(meta.pinnedTabId);
  } catch {
    return {
      reason: "tab-closed",
      originalTask,
      lastPinnedTabTitle: "",
      pinnedOrigin: meta.pinnedOrigin,
      lastStepIndex: agentStepIndex,
    };
  }

  const currentUrl = tab.url ?? "";
  const currentOrigin = safeParseOrigin(currentUrl);
  const lastPinnedTabTitle = escapeUntrustedWrappers(tab.title ?? "");

  if (!currentOrigin || currentOrigin !== meta.pinnedOrigin) {
    return {
      reason: "origin-changed",
      originalTask,
      lastPinnedTabTitle,
      pinnedOrigin: meta.pinnedOrigin,
      currentOrigin: currentOrigin ?? undefined,
      lastStepIndex: agentStepIndex,
    };
  }

  return null;
}

/**
 * M1-U5 — handle a `resume-task` message from the panel. Two paths:
 *   1. drift OK → flip session back to `active` + restart runAgentLoop
 *      with `resumedAgentMessages` + `resumedFromStep`
 *   2. drift detected → push a `session-confirm-request` (kind=
 *      pinned-tab-drift) to the panel; the user's only choice is
 *      Discard. The drift payload carries enough context for the
 *      panel to render an informed-approval card.
 *
 * No-op (with a console.warn) if the session is not in `paused` state
 * or has no in-flight agent state.
 */
async function handleResumeRequest(
  port: chrome.runtime.Port,
  sessionId: string,
  signal: AbortSignal,
  pendingConfirmations: Map<string, (result: { approved: boolean; reason?: "user-reject" | "aborted" }) => void>,
  pendingConfirmationsBySession: Map<string, string>,
): Promise<void> {
  const meta = await getSessionMeta(sessionId);
  if (!meta || meta.status !== "paused") {
    console.warn(
      `[sw] resume-task ignored — session=${sessionId} not in paused state`,
    );
    return;
  }
  const agent = await getSessionAgent(sessionId);
  if (!agent || agent.stepIndex === 0) {
    console.warn(
      `[sw] resume-task ignored — session=${sessionId} has no in-flight agent state`,
    );
    return;
  }

  const drift = await checkPinnedDrift(meta, agent.stepIndex);
  if (drift !== null) {
    // Push the drift card. Register a resolver entry so
    // panel-mounted re-emit + discard-task wire up correctly.
    const confirmationId = crypto.randomUUID();
    const card: SessionConfirmRequestMessage = {
      type: "session-confirm-request",
      confirmationId,
      kind: "pinned-tab-drift",
      payload: drift,
      sessionId,
    };
    // Persist + register resolver so a panel re-mount can recover the
    // card via the existing M1-U4 R4 path. The resolver here is a
    // no-op-on-true (drift card has only a Discard button); approve
    // is intentionally unreachable.
    await setPendingConfirm(sessionId, {
      confirmationId,
      kind: "pinned-tab-drift",
      payload: drift,
    });
    pendingConfirmations.set(confirmationId, (_approved) => {
      // No-op resolver — discard-task handles the actual cleanup
      // path. We register here only to satisfy the M1-U4 two-source
      // invariant (storage record + live resolver).
    });
    port.postMessage(card);
    return;
  }

  // Drift OK — flip the session back to `active` and restart the loop.
  await setSessionMeta({ ...meta, status: "active" });

  const activeProvider = await getActiveProvider();
  if (!activeProvider) {
    port.postMessage({
      type: "chat-error",
      error: "No active provider configured.",
      sessionId,
    });
    return;
  }
  const config = await getProviderConfig(activeProvider);
  if (!config) {
    port.postMessage({
      type: "chat-error",
      error: `No API key configured for ${activeProvider}.`,
      sessionId,
    });
    return;
  }
  const modelConfig: ModelConfig = config;

  // Reuse the chat-stream sendConfirmRequest pattern. Same persist +
  // scrub flow applies to confirms during the resumed task.
  const sendConfirmRequest = async (
    confirmationId: string,
    payload: Omit<AgentConfirmRequestMessage, "type" | "confirmationId">,
  ): Promise<{
    approved: boolean;
    reason?: "flood-limit" | "user-reject" | "aborted";
  }> => {
    // SEC-PLAN-009 — flood-limit guard (same as chat-stream path)
    const flooded = await isPendingConfirmFloodLimited();
    if (flooded) {
      port.postMessage({
        type: "session-toast",
        level: "warn",
        text: "Too many concurrent confirms. Please resolve pending sessions first.",
        sessionId,
      });
      return { approved: false, reason: "flood-limit" };
    }

    await setPendingConfirm(sessionId, {
      confirmationId,
      kind: "agent-tool",
      payload: {
        tool: payload.tool,
        args: payload.args,
        resolvedElement: payload.resolvedElement,
        riskReason: payload.riskReason,
        ...(payload.metaSkillPreview
          ? { metaSkillPreview: payload.metaSkillPreview }
          : {}),
        ...(payload.tabTargets ? { tabTargets: payload.tabTargets } : {}),
        ...(payload.contentPreview
          ? { contentPreview: payload.contentPreview }
          : {}),
      },
    });
    try {
      return await new Promise<{
        approved: boolean;
        reason?: "user-reject" | "aborted";
      }>((resolve) => {
        // Bug-fix-D — resolver receives a structured result so abort drain
        // can supply reason='aborted' (vs user-reject for a real panel
        // response). loop.ts only counts reason==='user-reject' toward K-10
        // fatigue, so a panel close → abort no longer poisons the
        // "User repeatedly rejected" auto-terminate counter.
        pendingConfirmations.set(confirmationId, (result) => {
          resolve(result);
        });
        // P1-4 — register session ownership for response verification.
        pendingConfirmationsBySession.set(confirmationId, sessionId);
        port.postMessage({
          type: "agent-confirm-request",
          confirmationId,
          ...payload,
          sessionId,
        } satisfies AgentConfirmRequestMessage);
      });
    } finally {
      pendingConfirmationsBySession.delete(confirmationId);
      scrubPendingConfirm(sessionId).catch((e) => {
        console.warn(
          `[agent] resume scrub pendingConfirm failed for session=${sessionId}:`,
          e,
        );
      });
    }
  };

  // task string for prompt header — pull from the snapshot's first
  // user message. resume path doesn't really use this except as a
  // human-readable label.
  let taskForPrompt = "(resumed task)";
  const firstUser = agent.agentMessages.find((m) => m.role === "user");
  if (firstUser) {
    const c = firstUser.content;
    taskForPrompt = typeof c === "string" ? c : "(resumed task)";
  }

  await runAgentLoop({
    port,
    task: taskForPrompt,
    modelConfig,
    signal,
    sendConfirmRequest,
    getEnabledSkillTools: async () => {
      const skills = await getEnabledSkills();
      return resolveSkillToTools(skills);
    },
    sessionId,
    // M2-U1: shared handler that also throttles lastAccessedAt bumps.
    onStepSnapshot: makeStepSnapshotHandler(sessionId),
    resumedAgentMessages: agent.agentMessages,
    resumedFromStep: agent.stepIndex,
    // M2-U1: restore the skill-scope stack so R2/R3 enforcement picks
    // up where it left off if the task was paused mid-skill.
    resumedSkillScopeStack: agent.skillExecutionScopeStack,
  });
}

/**
 * M1-U5 — user clicked 'Discard task' on the R11 drift card. Mark the
 * session failed, scrub leftover pendingConfirm, and append a recap
 * message to SessionMeta.messages so the chat scrollback shows what
 * was discarded (recovery context per plan M1-U5 design-lens F3 +
 * SEC-PLAN-005).
 *
 * Also emits an agent-done-task to the panel so useSession exits the
 * streaming state cleanly.
 */
async function handleDiscardRequest(
  port: chrome.runtime.Port,
  sessionId: string,
  confirmationId: string,
  pendingConfirmations: Map<string, (result: { approved: boolean; reason?: "user-reject" | "aborted" }) => void>,
): Promise<void> {
  // Resolve the matching pending resolver (drift card had a no-op
  // resolver registered; clear the Map entry).
  const resolver = pendingConfirmations.get(confirmationId);
  if (resolver) {
    // Discard is a user action ("I gave up on this task"); treat as a
    // user-reject so any in-flight confirm fatigue counters reflect intent.
    resolver({ approved: false, reason: "user-reject" });
    pendingConfirmations.delete(confirmationId);
  }

  const meta = await getSessionMeta(sessionId);
  const agent = await getSessionAgent(sessionId);
  if (!meta) return;

  // Compose a recap line the user sees in chat scrollback. All
  // user-/page-controlled fields are sanitized.
  const firstUser = meta.messages.find((m) => m.role === "user");
  const originalTask =
    firstUser && firstUser.role === "user"
      ? escapeUntrustedWrappers(firstUser.content)
      : "(unknown)";
  const lastStepIndex = agent?.stepIndex ?? 0;

  let recapTitle = "(unknown)";
  if (meta.pinnedTabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(meta.pinnedTabId);
      recapTitle = escapeUntrustedWrappers(tab.title ?? "");
    } catch {
      recapTitle = "(closed)";
    }
  }

  const recapText = `Task discarded — original goal: ${originalTask}. Last step: ${lastStepIndex}. Last pinned tab: ${recapTitle}.`;

  // Append the recap as an agent-summary message in the displayed chat.
  const recapMessage: DisplayMessage = {
    role: "agent-summary",
    success: false,
    summary: recapText,
    stepCount: lastStepIndex,
  };
  await setSessionMeta({
    ...meta,
    messages: [...meta.messages, recapMessage],
  });

  // Mark failed + scrub. (markFailedAndScrub handles ordering.)
  await markFailedAndScrub(sessionId);

  // Tell the panel the session-level confirm flow ended so useSession
  // can exit any streaming state.
  port.postMessage({
    type: "agent-done-task",
    success: false,
    summary: recapText,
    stepCount: lastStepIndex,
    sessionId,
  } satisfies AgentDoneTaskMessage);
}

// --- Agent Loop via Port ---

/**
 * M2-U1 — shared onStepSnapshot handler factory.
 *
 * Wraps the per-step agent-state write (`setSessionAgent`) and
 * throttles `lastAccessedAt` bumps to once every 5 steps to avoid
 * meta write churn on long-running tasks.
 *
 * Throttle logic uses `snapshot.stepIndex % 5 === 0`:
 *   - stepIndex 5, 10, 15, … → bump (live-task progress markers)
 *   - stepIndex 0 (tombstone) → `0 % 5 === 0` also bumps, ensuring
 *     the most-recently-completed task always rises to LRU top.
 *
 * Note: `setTimeout` is deliberately NOT used — MV3 Service Workers
 * can be suspended at any point, making time-based throttles
 * unreliable. The step-counter approach is always stable.
 *
 * Both `handleChatStream` and `handleResumeRequest` use this factory
 * to keep the two call sites in sync.
 */
function makeStepSnapshotHandler(sessionId: string) {
  return async (snapshot: import("@/lib/sessions/types").SessionAgentState) => {
    await setSessionAgent(sessionId, snapshot);
    if (snapshot.stepIndex % 5 === 0) {
      updateLastAccessed(sessionId).catch((e) => {
        console.warn(
          `[agent] lastAccessedAt bump failed for session=${sessionId} stepIndex=${snapshot.stepIndex}:`,
          e,
        );
      });
    }
  };
}

async function handleChatStream(
  port: chrome.runtime.Port,
  messages: ChatMessage[],
  sessionId: string,
  signal: AbortSignal,
  pendingConfirmations: Map<string, (result: { approved: boolean; reason?: "user-reject" | "aborted" }) => void>,
  pendingConfirmationsBySession: Map<string, string>,
) {
  try {
    // Get active provider config
    const activeProvider = await getActiveProvider();
    if (!activeProvider) {
      port.postMessage({
        type: "chat-error",
        error: "No active provider configured. Please set up an API key in Settings.",
        sessionId,
      });
      return;
    }

    const config = await getProviderConfig(activeProvider);
    if (!config) {
      port.postMessage({
        type: "chat-error",
        error: `No API key configured for ${activeProvider}. Please check Settings.`,
        sessionId,
      });
      return;
    }

    // M2-U1 trigger (b) — bump lastAccessedAt when the SW receives a new
    // chat-start for this session. Fire-and-forget; failure is non-fatal.
    updateLastAccessed(sessionId).catch((e) => {
      console.warn(
        `[agent] lastAccessedAt bump on chat-start failed for session=${sessionId}:`,
        e,
      );
    });

    // M2-U3 — LLM async title generation (R29).
    // Trigger only on the first user message (messages.length === 1 and role=user).
    // The race-guard sentinel is whatever title the panel wrote at chat-start
    // (panel's persistMessages fires before postMessage('chat-start'), so by the
    // time SW awaits getSessionMeta the fallback string is on disk). Reading
    // from storage avoids recomputing the fallback in SW with a different
    // `messages` payload — slash skills, for example, ship the EXPANDED prompt
    // to SW, so a SW-side deriveTitleFromMessages would produce a different
    // string than the panel's, breaking the equality race-guard forever.
    if (messages.length === 1 && messages[0]?.role === "user") {
      const firstUserContent = messages[0].content;
      const sentinelMeta = await getSessionMeta(sessionId);
      const expectedFallback = sentinelMeta?.title;
      if (expectedFallback !== undefined && expectedFallback !== "") {
        const callChat = (
          msgs: Array<{ role: "system" | "user" | "assistant"; content: string }>,
        ) => chat(config, msgs as ChatMessage[]).then((r) => r.content);

        generateTitle(firstUserContent, callChat)
          .then((llmTitle) =>
            maybeUpgradeFallbackTitle(sessionId, expectedFallback, llmTitle),
          )
          .catch((e) => {
            // Fallback title is already in storage — swallow error silently.
            console.debug(
              `[sw] M2-U3 title generation failed for session=${sessionId}; keeping fallback:`,
              e,
            );
          });
      }
    }

    // Extract task from last user message
    const task =
      [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

    const modelConfig: ModelConfig = config;

    // sendConfirmRequest: posts agent-confirm-request to panel and returns a
    // Promise that resolves when panel sends agent-confirm-response.
    //
    // M1-U4 — persist the pending payload to session_${id}_agent.pendingConfirm
    // BEFORE the panel push so a panel re-mount during the confirm window
    // can recover. Scrub on resolve / reject / signal-abort via the
    // finally block — fire-and-forget catch with M1-U5 startup cleanup as
    // backstop.
    //
    // Field listing in the persisted payload is EXPLICIT (not spread) —
    // adding new AgentConfirmRequestMessage fields requires a conscious
    // decision whether they belong in storage. Plan note: preFetchedContent
    // (P3-U full content) must NEVER land here; only contentPreview (≤200
    // chars sanitized) is safe.
    const sendConfirmRequest = async (
      confirmationId: string,
      payload: Omit<AgentConfirmRequestMessage, "type" | "confirmationId">,
    ): Promise<boolean> => {
      // SEC-PLAN-009 — flood-limit guard: if > 5 sessions have a live
      // pendingConfirm, auto-reject this request and emit a toast warning
      // to the panel so the user knows to resolve existing confirms first.
      // This protects K-1 (informed-approval) + D6 (storage pressure) from
      // a runaway agent loop stacking unlimited blocking confirms.
      const flooded = await isPendingConfirmFloodLimited();
      if (flooded) {
        port.postMessage({
          type: "session-toast",
          level: "warn",
          text: "Too many concurrent confirms. Please resolve pending sessions first.",
          sessionId,
        });
        return { approved: false, reason: "flood-limit" as const };
      }

      await setPendingConfirm(sessionId, {
        confirmationId,
        kind: "agent-tool",
        payload: {
          tool: payload.tool,
          args: payload.args,
          resolvedElement: payload.resolvedElement,
          riskReason: payload.riskReason,
          ...(payload.metaSkillPreview
            ? { metaSkillPreview: payload.metaSkillPreview }
            : {}),
          ...(payload.tabTargets ? { tabTargets: payload.tabTargets } : {}),
          ...(payload.contentPreview
            ? { contentPreview: payload.contentPreview }
            : {}),
        },
      });

      try {
        return await new Promise<{
          approved: boolean;
          reason?: "user-reject" | "aborted";
        }>((resolve) => {
          // Bug-fix-D — see resume-path twin for rationale.
          pendingConfirmations.set(confirmationId, (result) => {
            resolve(result);
          });
          // P1-4 — register session ownership so agent-confirm-response
          // handler can verify the approval came from the right session.
          pendingConfirmationsBySession.set(confirmationId, sessionId);
          port.postMessage({
            type: "agent-confirm-request",
            confirmationId,
            ...payload,
            sessionId,
          } satisfies AgentConfirmRequestMessage);
        });
      } finally {
        pendingConfirmationsBySession.delete(confirmationId);
        scrubPendingConfirm(sessionId).catch((e) => {
          console.warn(
            `[agent] scrub pendingConfirm failed for session=${sessionId} confirmId=${confirmationId}:`,
            e,
          );
        });
      }
    };

    await runAgentLoop({
      port,
      task,
      modelConfig,
      signal,
      sendConfirmRequest,
      getEnabledSkillTools: async () => {
        const skills = await getEnabledSkills();
        return resolveSkillToTools(skills);
      },
      sessionId,
      // M1-U3 — persist agent state at every step boundary. M2-U1
      // upgrade: also bumps lastAccessedAt every 5 steps + on tombstone
      // (see makeStepSnapshotHandler). Errors caught + logged inside
      // runAgentLoop; this wrapper only does the storage calls.
      onStepSnapshot: makeStepSnapshotHandler(sessionId),
    });
  } catch (e) {
    if (signal.aborted) return;
    port.postMessage({
      type: "chat-error",
      error: e instanceof Error ? e.message : "An unexpected error occurred",
      sessionId,
    });
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "chat-stream") return;

  const abortController = new AbortController();

  // Per-port pending confirmation map
  const pendingConfirmations = new Map<string, (result: { approved: boolean; reason?: "user-reject" | "aborted" }) => void>();
  // P1-4 — tracks which session owns each pending confirmationId. Used to
  // verify that an agent-confirm-response came from the session whose confirm
  // card was displayed, preventing wrong-session approval (defense-in-depth
  // behind the P0-1/P0-2 streaming guards).
  const pendingConfirmationsBySession = new Map<string, string>();

  // Bug-fix-E — per-port set of session ids the SW dispatched a chat-start
  // / resume-task for through THIS port. On port.onDisconnect we use this
  // (not detectAndMarkPaused's global scan) to mark only this port's
  // abandoned in-flight sessions as paused. Global scan would mistakenly
  // mark sessions running on a sibling sidepanel as paused, breaking the
  // multi-sidepanel isolation invariant (cf. CDP owner-token / generationId
  // pattern in Phase 2.5).
  //
  // We never delete on done boundaries because:
  //   (a) chat-done / agent-done-task are emitted from inside loop.ts,
  //       so the SW would need a callback hook to observe them; and
  //   (b) the on-disconnect handler reads agent.stepIndex anyway —
  //       stepIndex===0 (tombstone, written by emitDone) means the task
  //       finished cleanly, so it's safely a no-op even if the id is
  //       still in this set. The set only grows for the lifetime of one
  //       port (=one sidepanel session) which is bounded by user behaviour.
  const inFlightSessionIds = new Set<string>();

  // Drain any pending high-risk confirm prompts when the task is aborted
  // (Stop button, kill-switch, or programmatic abort from inside the
  // loop). Without this, sendConfirmRequest's promise never resolves and
  // the whole runAgentLoop hangs — finally never runs, no
  // agent-done-task is emitted, the Panel just sees streaming stop with
  // no AgentSummary. port.onDisconnect already drains too, but Stop
  // does NOT disconnect the port; this listener covers that path.
  abortController.signal.addEventListener(
    "abort",
    () => {
      // Bug-fix-D — drain with reason='aborted'. Without this, the resolver
      // would receive the structural-default and loop.ts would treat the
      // hanging confirm as a user-reject, polluting the K-10 fatigue counter
      // (3 panel-close-mid-confirm events would auto-terminate the task with
      // "User repeatedly rejected").
      for (const [, resolve] of pendingConfirmations) {
        resolve({ approved: false, reason: "aborted" });
      }
      pendingConfirmations.clear();
      pendingConfirmationsBySession.clear();
    },
    { once: true },
  );

  // Keep-alive: reset Service Worker idle timer while streaming
  const keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo();
  }, 25_000);

  port.onMessage.addListener((message: PortMessageToWorker) => {
    if (message.type === "chat-start") {
      inFlightSessionIds.add(message.sessionId);
      handleChatStream(
        port,
        message.messages,
        message.sessionId,
        abortController.signal,
        pendingConfirmations,
        pendingConfirmationsBySession,
      );
    } else if (message.type === "chat-abort") {
      abortController.abort();
    } else if (message.type === "agent-confirm-response") {
      // P1-4 — verify the response belongs to the session that owns
      // the confirmationId. Prevents wrong-session approval (defense-
      // in-depth behind the P0-1/P0-2 streaming guards).
      const expectedSession = pendingConfirmationsBySession.get(message.confirmationId);
      if (expectedSession !== undefined && expectedSession !== message.sessionId) {
        console.warn(
          `[sw] agent-confirm-response sessionId mismatch: expected=${expectedSession} got=${message.sessionId} confirmId=${message.confirmationId} — refusing`,
        );
        port.postMessage({
          type: "session-toast",
          level: "warn",
          text: "Approval rejected — session changed since the confirm card was shown.",
          sessionId: message.sessionId,
        });
        return;
      }
      const resolver = pendingConfirmations.get(message.confirmationId);
      if (resolver) {
        resolver(
          message.approved
            ? { approved: true }
            : { approved: false, reason: "user-reject" },
        );
        pendingConfirmations.delete(message.confirmationId);
      }
    } else if (message.type === "panel-mounted") {
      // M1-U4 — R4: re-emit a live confirm to a re-mounted panel.
      // Async — fire-and-forget; failures are logged but not fatal.
      handlePanelMounted(port, message.sessionId, pendingConfirmations).catch(
        (e) => {
          console.warn(
            `[sw] panel-mounted handler failed for session=${message.sessionId}:`,
            e,
          );
        },
      );
    } else if (message.type === "resume-task") {
      inFlightSessionIds.add(message.sessionId);
      handleResumeRequest(
        port,
        message.sessionId,
        abortController.signal,
        pendingConfirmations,
        pendingConfirmationsBySession,
      ).catch((e) => {
        console.warn(
          `[sw] resume-task handler failed for session=${message.sessionId}:`,
          e,
        );
        port.postMessage({
          type: "chat-error",
          error:
            e instanceof Error
              ? `Resume failed: ${e.message}`
              : "Resume failed",
          sessionId: message.sessionId,
        });
      });
    } else if (message.type === "discard-task") {
      handleDiscardRequest(
        port,
        message.sessionId,
        message.confirmationId,
        pendingConfirmations,
      ).catch((e) => {
        console.warn(
          `[sw] discard-task handler failed for session=${message.sessionId}:`,
          e,
        );
      });
    }
  });

  port.onDisconnect.addListener(() => {
    abortController.abort();
    clearInterval(keepAliveInterval);
    // Drain pending confirmations with reason='aborted' (Bug-fix-D — see
    // abort-listener twin above for why this matters for K-10 fatigue).
    for (const [, resolve] of pendingConfirmations) {
      resolve({ approved: false, reason: "aborted" });
    }
    pendingConfirmations.clear();
    pendingConfirmationsBySession.clear();

    // Bug-fix-E — panel closed mid-task. The abort above kills the running
    // loop; before it dies the agent state is at stepIndex>0 (no tombstone
    // since emitDone never runs on abort). Walk the per-port set and
    // transition each abandoned in-flight session so the next panel mount
    // sees the R10 paused affordance instead of a silently-dead "active"
    // session. Only THIS port's sessions are touched (see inFlightSessionIds
    // JSDoc) so a sibling sidepanel running its own tasks is unaffected.
    //
    // Step ordering mirrors detectAndMarkPaused (SEC-PLAN-002):
    //   1. pendingConfirm present → markFailedAndScrub (the resolver is
    //      gone; the request is unhonorable).
    //   2. else stepIndex>0 → markPaused (in-flight, resumable).
    //   3. else (tombstone) → no-op (task finished cleanly).
    //
    // Fire-and-forget: MV3 SW stays alive for pending storage promises so
    // the markPaused write completes before the SW idles out.
    const sessionsToClose = Array.from(inFlightSessionIds);
    inFlightSessionIds.clear();
    transitionPortInFlightSessionsToPaused(sessionsToClose).catch((e) => {
      console.warn("[sw] panel-disconnect cleanup failed:", e);
    });
  });
});

console.log("[Chrome AI Agent] Service worker started");
