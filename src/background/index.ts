// Service Worker — background script for Pie

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
import { getActiveInstance, resolveInstanceToModelConfig } from "@/lib/instances";
import {
  runAgentLoop,
  safeParseOrigin,
  mergeSessionAgentSnapshot,
} from "@/lib/agent/loop";
import type { RoleViolation } from "@/lib/agent/history-validation";
import { logHistoryRepaired } from "@/lib/agent/history-validation-telemetry";
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
  clearLastTaskSynth,
  migrateLastTaskSynthFromMeta,
  clearTaskPinAtSessionEnd,
  upgradeAutoToTaskAtChatStart,
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
import { isSkipPermissionsEnabled } from "@/lib/skip-permissions";
import { runSessionMigrations } from "@/lib/sessions/migration";
import { getCrossSessionPinnedTabIds } from "@/lib/sessions/pinned-tab-registry";
import { getEffectivePinMode, getPrimaryPin } from "@/lib/sessions/pin-state";
import { chat } from "@/lib/model-router";
import { generateTitle, maybeUpgradeFallbackTitle } from "@/lib/sessions/title-generator";
// Phase 5 — image cache lifecycle + pre-capture (Task 12 wiring)
import {
  evictAllOnSWStartup,
  evictOnSetActive,
  evictByInFlightSet,
} from "./image-cache";
import {
  setPreCapture,
  consumePreCapture,
  discardPreCapture,
} from "./screenshot-precapture";
import {
  dispatchCaptureVisibleTab,
  dispatchCaptureFullPageTab,
} from "@/lib/agent/tools/screenshot";
import { makeCdpAdapterForScreenshot } from "./cdp-adapter";
import { makeResolveEffectivePinned } from "./effective-pinned";
import type { ScreenshotConfirmExtras, OpenUrlConfirmExtras } from "@/types";
import type { ImageAttachment } from "@/lib/images";
import {
  handleRecordingStart,
  handleRecordingAction,
  handleRecordingFinish,
  handleRecordingDiscard,
  handleRecordingTabClosed,
  handleRecordingNavCommitted,
  handleRecordingHistoryStateUpdated,
  abortRecordingForSession,
  recordingState,
} from "./recording-orchestrator";
import type { RecordingSession } from "@/lib/recording/types";
import { migrateV1toV2 } from "@/lib/migration-v2";
import {
  createAbortRotation,
  rotateAbortController,
} from "./abort-rotation";

// Run V1→V2 migration once on SW load (idempotent via schema_version sentinel).
migrateV1toV2().catch((e) => console.error("migration v2 failed", e));

// Phase 5 follow-up — shared resolver for the screenshot first-task pin race
// (see effective-pinned.ts for the three-tier fallback rationale).
const resolveEffectivePinned = makeResolveEffectivePinned(getSessionMeta);

// Recording v1 — per-sessionId → port registry. Used by the chrome.runtime.onMessage
// handler (capture inject sends sendMessage with no port reference) to find a port
// for broadcasting recording-action-broadcast back to the panel.
const portsBySession = new Map<string, chrome.runtime.Port>();

function findRecordingSessionByTabId(tabId: number | undefined): RecordingSession | null {
  if (tabId === undefined) return null;
  for (const sess of recordingState.values()) {
    if (sess.tabId === tabId) return sess;
  }
  return null;
}

// M5 — SW-side captureActivePinned, mirrors useSession.ts:93-112. Used by
// upgradeAutoToTaskAtChatStart to capture the send-time active tab.
// Restricted-URL prefix list matches the panel-side helper exactly so both
// paths converge on the same eligibility decision (any divergence would
// produce a session whose pin slipped past one filter but not the other).
const SW_RESTRICTED_PIN_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "about:",
  "edge://",
  "file://",
  "data:",
  "javascript:",
  "blob:",
];
async function captureSwActivePinned(): Promise<
  { tabId: number; origin: string } | null
> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) return null;
    if (!Number.isInteger(tab.id) || tab.id < 0) return null;
    if (SW_RESTRICTED_PIN_PREFIXES.some((p) => tab.url!.startsWith(p))) return null;
    const origin = new URL(tab.url).origin;
    if (!origin || origin === "null") return null;
    return { tabId: tab.id, origin };
  } catch {
    return null;
  }
}

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
  .then(() => {
    // R13(b) — clear ALL in-memory image bytes on SW restart. Must run before
    // detectAndMarkPaused so R14 can safely mark image-bearing sessions as
    // `failed` knowing bytes are already gone.
    evictAllOnSWStartup();
    return detectAndMarkPaused();
  })
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
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Recording v1 — capture inject 函数 → SW（不走 port）
  if (message?.type === "recording-action") {
    const sess = findRecordingSessionByTabId(sender.tab?.id);
    if (sess) {
      const port = portsBySession.get(sess.sessionId);
      if (port) handleRecordingAction(sender, message, port);
    }
    return; // no async response
  }

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
  pendingConfirmations: Map<string, (result: { approved: boolean; reason?: "user-reject" | "aborted" | "pre-capture-failed"; screenshotResult?: ImageAttachment; stale?: boolean; failureReason?: string }) => void>,
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
  meta: { pinnedTabs?: Array<{ tabId: number; origin: string }>; messages: DisplayMessage[] },
  agentStepIndex: number,
): Promise<PinnedTabDriftPayload | null> {
  // Pull the original task from the first user message if available.
  const firstUser = meta.messages.find((m) => m.role === "user");
  const rawTask = firstUser && firstUser.role === "user" ? firstUser.content : "";
  const originalTask = escapeUntrustedWrappers(rawTask);

  // v1.5 — Walk all pinnedTabs[] entries. Return on first drift detected.
  const pins = meta.pinnedTabs ?? [];

  if (pins.length === 0) {
    // M1 sessions don't have pinned anchored at creation (M3-U2
    // ships that). No drift can be detected — treat as drift=null
    // and let the loop's per-round origin check pick up real drift
    // mid-resume.
    return null;
  }

  for (const pin of pins) {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(pin.tabId);
    } catch {
      return {
        reason: "tab-closed",
        originalTask,
        lastPinnedTabTitle: "",
        pinnedOrigin: pin.origin,
        lastStepIndex: agentStepIndex,
      };
    }

    const currentUrl = tab.url ?? "";
    const currentOrigin = safeParseOrigin(currentUrl);
    const lastPinnedTabTitle = escapeUntrustedWrappers(tab.title ?? "");

    if (!currentOrigin || currentOrigin !== pin.origin) {
      return {
        reason: "origin-changed",
        originalTask,
        lastPinnedTabTitle,
        pinnedOrigin: pin.origin,
        currentOrigin: currentOrigin ?? undefined,
        lastStepIndex: agentStepIndex,
      };
    }
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
  abortController: AbortController,
  pendingConfirmations: Map<string, (result: { approved: boolean; reason?: "user-reject" | "aborted" | "pre-capture-failed"; screenshotResult?: ImageAttachment; stale?: boolean; failureReason?: string }) => void>,
  pendingConfirmationsBySession: Map<string, string>,
): Promise<void> {
  const signal = abortController.signal;
  const meta = await getSessionMeta(sessionId);
  if (!meta || meta.status !== "paused") {
    // Multi-sidepanel scenario: a sibling sidepanel may have already resumed
    // this session (status=active or finished), so this resume-task is racy.
    // Emit chat-error so the panel can reset streaming=true (set synchronously
    // by useSession.resumeTask before posting). Without this the panel is
    // stuck spinning forever AND M3 setActive/createAndActivate refuse to
    // switch sessions while streaming=true — locking the user out of the
    // multi-session UI until manual close/reopen.
    console.warn(
      `[sw] resume-task ignored — session=${sessionId} not in paused state`,
    );
    port.postMessage({
      type: "chat-error",
      error: "Resume rejected — session is no longer paused (it may have been resumed in another sidepanel).",
      sessionId,
    });
    return;
  }
  const agent = await getSessionAgent(sessionId);
  if (!agent || agent.stepIndex === 0) {
    console.warn(
      `[sw] resume-task ignored — session=${sessionId} has no in-flight agent state`,
    );
    port.postMessage({
      type: "chat-error",
      error: "Resume rejected — no in-flight agent state to resume.",
      sessionId,
    });
    return;
  }

  // M5 — drift card only fires for 'task' mode (the loop captured the pin
  // automatically; if it changed since chat-start the user wasn't expecting
  // it). 'user' mode pins were chosen explicitly by the user; if the page
  // navigated, that's their decision — resume directly. 'auto' mode has no
  // pin so checkPinnedDrift would short-circuit anyway.
  const driftEligibleMode = getEffectivePinMode(meta, agent) === "task";
  const drift = driftEligibleMode
    ? await checkPinnedDrift(meta, agent.stepIndex)
    : null;
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

  // Drift OK — resolve instance config, then flip the session back to `active`.
  const resumeInstanceId = meta.instanceId ?? (await getActiveInstance());
  if (!resumeInstanceId) {
    port.postMessage({
      type: "chat-error",
      error: "No config selected. Open Settings to create one.",
      sessionId,
    });
    return;
  }
  const resumeModelConfig = await resolveInstanceToModelConfig(resumeInstanceId);
  if (!resumeModelConfig) {
    port.postMessage({
      type: "chat-error",
      error: "Selected config was deleted. Pick another in the chat header.",
      sessionId,
    });
    return;
  }
  const modelConfig: ModelConfig = resumeModelConfig;

  // Flip session back to `active`, and if we fell back to global active, pin
  // the instanceId so future resumes don't depend on the global active changing.
  await setSessionMeta({
    ...meta,
    status: "active",
    ...(meta.instanceId ? {} : { instanceId: resumeInstanceId }),
  });

  // Phase 5 — Task 12: mint a fresh taskId for the resumed loop so the
  // per-task screenshot budget and pre-capture keys are fresh.
  const resumeTaskId = crypto.randomUUID();

  // M3-U2 — same pin injection as chat-start path. checkPinnedDrift
  // already validated the pin against current tab state above; the loop
  // itself will re-check on every iteration.
  // v1.5 — use getPrimaryPin to read from pinnedTabs[] (falls back to legacy fields via storage shim).
  const pinned = getPrimaryPin(meta);

  // Reuse the chat-stream sendConfirmRequest pattern. Same persist +
  // scrub flow applies to confirms during the resumed task.
  const skipPermissionsAtStart = await isSkipPermissionsEnabled();
  const sendConfirmRequest = async (
    confirmationId: string,
    payload: Omit<AgentConfirmRequestMessage, "type" | "confirmationId">,
  ): Promise<{
    approved: boolean;
    reason?: "flood-limit" | "user-reject" | "aborted" | "pre-capture-failed";
    screenshotResult?: ImageAttachment;
    stale?: boolean;
    failureReason?: string;
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

    // Phase 5 — pre-capture for screenshot tools (R5/R6, K-1 informed-approval).
    // Dispatch the capture BEFORE posting the confirm card so the user sees the
    // EXACT bytes the LLM will receive. If capture fails, short-circuit with
    // `pre-capture-failed` so loop.ts feeds a failure observation.
    let screenshotPreview: ScreenshotConfirmExtras | undefined;
    const isScreenshotTool =
      payload.tool === "capture_visible_tab" ||
      payload.tool === "capture_fullpage_tab";
    if (isScreenshotTool) {
      // Phase 5 follow-up — first-task pin race fallback. The panel-side
      // captureActivePinned + setSessionMeta on first send is fire-and-forget
      // (useSession.ts:760-790); SW may read sessionMeta before that patch
      // lands, so closure-captured `pinned` may be undefined on the very first
      // chat-start. Mirror the loop's active-tab fallback via three-tier
      // resolveEffectivePinned (closure → re-read meta → active-tab query).
      const effectivePinned = await resolveEffectivePinned(pinned, sessionId);
      if (!effectivePinned) {
        // I-4 — no pinned tab available (e.g. chrome:// or unpinnable session).
        return {
          approved: false,
          reason: "pre-capture-failed",
          failureReason: "no-pinned-tab",
        };
      }
      const captureCtx = {
        sessionId,
        taskId: resumeTaskId,
        pinnedTabId: effectivePinned.tabId,
      };
      let outcome;
      if (payload.tool === "capture_visible_tab") {
        outcome = await dispatchCaptureVisibleTab(captureCtx);
      } else {
        outcome = await dispatchCaptureFullPageTab(
          captureCtx,
          makeCdpAdapterForScreenshot(abortController),
        );
      }
      if (outcome.ok) {
        // S-2 — setPreCapture only on success so a failed capture never
        // enters the cache (removing the redundant discard-after-set pattern).
        setPreCapture(confirmationId, outcome);
        const img = outcome.value;
        screenshotPreview = {
          thumbnail: img.data,
          mediaType: img.mediaType,
          width: img.width,
          height: img.height,
          capturedAt: Date.now(),
        };
      } else {
        // Pre-capture failed — skip the confirm card entirely; return failure.
        return {
          approved: false,
          reason: "pre-capture-failed",
          failureReason: outcome.reason,
        };
      }
    }

    // v1.5 — pre-parse URL for open_url confirm card (K-1 informed-approval).
    // URL.host returns punycode for IDN — defense against homograph attacks.
    // Small text: safe to persist in storage (unlike screenshotPreview bytes).
    let openUrlPreview: OpenUrlConfirmExtras | undefined;
    if (payload.tool === "open_url") {
      const args = payload.args as { url?: string; active?: boolean };
      let host = "(invalid)";
      let origin = "(invalid)";
      try {
        const u = new URL(args.url ?? "");
        host = u.host;
        origin = u.origin;
      } catch {
        // Shouldn't happen — handler validates upstream; defensive fallback.
      }
      openUrlPreview = {
        url: args.url ?? "",
        host,
        origin,
        active: args.active === true,
      };
    }

    // R2.3 — global skip-permissions short-circuit. After pre-capture
    // (screenshot) and URL pre-parse (open_url) so LLM-fed bytes / typed
    // origin payloads are still produced, but the panel confirm card is
    // never shown and the agent-confirm-response wait is bypassed.
    if (skipPermissionsAtStart) {
      if (isScreenshotTool) {
        const consumed = consumePreCapture(confirmationId);
        if (!consumed?.image) {
          return {
            approved: false,
            reason: "pre-capture-failed",
            failureReason: "pre-capture cache miss (skip-permissions auto-approve path)",
          };
        }
        return {
          approved: true,
          screenshotResult: consumed.image,
        };
      }
      return { approved: true };
    }

    try {
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
          // screenshotPreview intentionally omitted from storage — bytes must
          // not reach chrome.storage (8 MB quota). Panel renders from wire only.
          // openUrlPreview is small text — safe to persist for R4 re-emit.
          ...(openUrlPreview ? { openUrlPreview } : {}),
        },
      });
    } catch (e) {
      // Storage failure after setPreCapture — discard bytes before re-throwing
      // to avoid a memory leak in the screenshot-precapture cache.
      if (isScreenshotTool) discardPreCapture(confirmationId);
      throw e;
    }
    try {
      return await new Promise<{
        approved: boolean;
        reason?: "user-reject" | "aborted";
        screenshotResult?: ImageAttachment;
        stale?: boolean;
        failureReason?: string;
      }>((resolve) => {
        // Bug-fix-D — resolver receives a structured result so abort drain
        // can supply reason='aborted' (vs user-reject for a real panel
        // response). loop.ts only counts reason==='user-reject' toward K-10
        // fatigue, so a panel close → abort no longer poisons the
        // "User repeatedly rejected" auto-terminate counter.
        pendingConfirmations.set(confirmationId, (panelResult) => {
          if (!panelResult.approved || !isScreenshotTool) {
            resolve(panelResult);
            return;
          }
          // User approved a screenshot tool — consume the pre-captured image.
          const consumed = consumePreCapture(confirmationId);
          if (!consumed.hit) {
            // No pre-capture entry (cleared by abort/disconnect already).
            resolve({ approved: false, reason: "pre-capture-failed", failureReason: "pre-capture cache miss" });
            return;
          }
          resolve({
            approved: !consumed.stale,
            stale: consumed.stale,
            screenshotResult: consumed.image ?? undefined,
          });
        });
        // P1-4 — register session ownership for response verification.
        pendingConfirmationsBySession.set(confirmationId, sessionId);
        port.postMessage({
          type: "agent-confirm-request",
          confirmationId,
          ...payload,
          ...(screenshotPreview ? { screenshotPreview } : {}),
          ...(openUrlPreview ? { openUrlPreview } : {}),
          sessionId,
        } satisfies AgentConfirmRequestMessage);
      });
    } finally {
      pendingConfirmationsBySession.delete(confirmationId);
      // Discard pre-capture if still in cache (stale reject, abort drain, etc.)
      if (isScreenshotTool) discardPreCapture(confirmationId);
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
    // Phase 5 — propagate prior hasImageContent flag across resume.
    resumedHasImageContent: agent.hasImageContent,
    // v1.5 multi-pin: replace single `pinned` with the full array.
    // Resume path restores currentFocusTabId from persisted agent state.
    pinnedTabs: meta.pinnedTabs ?? [],
    initialFocusTabId: agent.currentFocusTabId ?? meta.pinnedTabs?.[0]?.tabId,
    // Phase 5 — per-task screenshot budget key.
    taskId: resumeTaskId,
    skipPermissions: skipPermissionsAtStart,
    // M3-U4 (TOCTOU fix) — refresh per dispatch; see chat-start twin.
    refreshCrossSessionPinnedTabIds: () => getCrossSessionPinnedTabIds(sessionId),
    // M5 — pin mode frozen at chat-start (here: resume start). close_tabs K-9
    // reads this through ToolHandlerContext to refuse user-locked pin closes.
    pinMode: getEffectivePinMode(meta, agent),
    // M5 — auto-unpin task-mode pin at task end (resume path).
    onTaskDone: () => clearTaskPinAtSessionEnd(sessionId),
    // U4 — same telemetry hook as chat-start path.
    onHistoryRepaired: (violations, rawMessages) => {
      logHistoryRepaired(violations, rawMessages).catch((e) => {
        console.warn("[agent] logHistoryRepaired error:", e);
      });
    },
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
  pendingConfirmations: Map<string, (result: { approved: boolean; reason?: "user-reject" | "aborted" | "pre-capture-failed"; screenshotResult?: ImageAttachment; stale?: boolean; failureReason?: string }) => void>,
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
  // v1.5 — use getPrimaryPin to read primary pinned tab from pinnedTabs[].
  const primaryPinForRecap = getPrimaryPin(meta);
  if (primaryPinForRecap !== undefined) {
    try {
      const tab = await chrome.tabs.get(primaryPinForRecap.tabId);
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
    // v1.5: merge with existing state so fields written between snapshots
    // (e.g., currentFocusTabId via setCurrentFocusTabId, pendingConfirm via
    // setPendingConfirm) are preserved across the per-step boundary. The
    // snapshot helper only carries history/stepIndex/skillStack/hasImageContent;
    // any field the loop writes via a separate writer must survive the
    // setSessionAgent full-key REPLACE that powers the snapshot path.
    //
    // Side effect: pendingConfirm now stays in storage even if a snapshot
    // lands AFTER setPendingConfirm. Previous behavior was correct only by
    // luck (the loop is suspended during user-confirm wait so no snapshot
    // fired); the merge makes the invariant explicit.
    const existing = await getSessionAgent(sessionId);
    const merged = mergeSessionAgentSnapshot(existing, snapshot);
    await setSessionAgent(sessionId, merged);
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
  abortController: AbortController,
  pendingConfirmations: Map<string, (result: { approved: boolean; reason?: "user-reject" | "aborted" | "pre-capture-failed"; screenshotResult?: ImageAttachment; stale?: boolean; failureReason?: string }) => void>,
  pendingConfirmationsBySession: Map<string, string>,
) {
  const signal = abortController.signal;
  try {
    // Resolve instance config for this session (per-session pin → global fallback).
    const chatSessionMeta = await getSessionMeta(sessionId);
    const chatInstanceId = chatSessionMeta?.instanceId ?? (await getActiveInstance());
    if (!chatInstanceId) {
      port.postMessage({
        type: "chat-error",
        error: "No config selected. Open Settings to create one.",
        sessionId,
      });
      return;
    }
    const chatModelConfig = await resolveInstanceToModelConfig(chatInstanceId);
    if (!chatModelConfig) {
      port.postMessage({
        type: "chat-error",
        error: "Selected config was deleted. Pick another in the chat header.",
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
        ) => chat(chatModelConfig, msgs as ChatMessage[]).then((r) => r.content);

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

    // U2 — validate messages array is non-empty (panel always sends at
    // least the current user message; empty array is a wire bug).
    if (messages.length === 0) {
      port.postMessage({
        type: "chat-error",
        error: "对话历史为空，请重新发送",
        sessionId,
      });
      return;
    }

    // U2 — task is always the last message (panel sendMessage puts the
    // current user prompt last; this replaces the old reverse-find).
    const task = messages[messages.length - 1]!.content;

    // U2 — lastTaskSynth injection (Half B SW-side synth).
    // AD1 fix: lastTaskSynth was moved from SessionMeta to SessionAgentState
    // to eliminate the lost-update race with the panel's persistMessages
    // (both were read-modify-write on the same meta key at chat-done
    // boundary). Now reads from agent state only — SW-only key, no race.
    //
    // Step 1: idempotent migration for sessions written before AD1 fix.
    // Awaited (not fire-and-forget) so the migrated value is immediately
    // visible in the agent-state read that follows.
    await migrateLastTaskSynthFromMeta(sessionId).catch((e) => {
      console.warn(
        `[sw] migrateLastTaskSynthFromMeta failed for session=${sessionId}:`,
        e,
      );
    });

    // M5 — chat-start auto→task pin upgrade. Idempotent: if the session is
    // already 'task' or 'user', this is a no-op. For 'auto' sessions we
    // capture the send-time active tab as the task pin (frozen for this
    // task; emitDone will downgrade back to auto). Runs BEFORE synthMeta
    // load so the subsequent meta read sees the upgraded pinMode.
    //
    // Panel-side fire-and-forget capture (useSession.ts:783) may race with
    // this; both paths set pinMode='task', so the second write is a no-op
    // (idempotent invariant). SW-side path is the authoritative backstop.
    await upgradeAutoToTaskAtChatStart(sessionId, captureSwActivePinned).catch(
      (e) => {
        console.warn(
          `[sw] upgradeAutoToTaskAtChatStart failed for session=${sessionId}:`,
          e,
        );
      },
    );

    // Step 2: read lastTaskSynth from agent state (post-AD1 location).
    // AD1 fix: fetch synthMeta in parallel with synthAgent here, AFTER
    // upgradeAutoToTaskAtChatStart has run above. The early chatSessionMeta
    // (line ~1016) is stale for auto-mode sessions: upgradeAutoToTaskAtChatStart
    // writes pinMode='task' + pinnedTabs[] AFTER chatSessionMeta was loaded,
    // so reusing it would cause getPrimaryPin/getEffectivePinMode to miss the
    // freshly-captured pin — regression of M5 invariants.
    // Note: title generation (above) uses messages.length === 1 which
    // is evaluated BEFORE this injection, so the injected synth never
    // accidentally counts as a second message for title-gen purposes.
    const [synthAgent, synthMeta] = await Promise.all([
      getSessionAgent(sessionId),
      getSessionMeta(sessionId),
    ]);

    // Per-session pin: if we fell back to global active, persist instanceId so
    // future chat-starts for this session don't depend on global active changing.
    // Placed AFTER upgradeAutoToTaskAtChatStart to avoid clobbering the
    // upgraded pinMode='task' + pinnedTabs[] (lost-update fix).
    if (synthMeta && !synthMeta.instanceId && chatInstanceId) {
      await setSessionMeta({ ...synthMeta, instanceId: chatInstanceId }).catch((e) => {
        console.warn(`[sw] instanceId pin failed for session=${sessionId}:`, e);
      });
    }

    const lastTaskSynth = synthAgent?.lastTaskSynth ?? null;

    let effectiveMessages = messages;
    if (lastTaskSynth) {
      // Insert the synth assistant turn before the last user message.
      // Build a new array — never mutate the input.
      effectiveMessages = [
        ...messages.slice(0, -1),
        { role: "assistant" as const, content: lastTaskSynth },
        messages[messages.length - 1]!,
      ];
      // One-shot consume: clear so the next chat-start starts fresh.
      clearLastTaskSynth(sessionId).catch((e) => {
        console.warn(
          `[sw] clearLastTaskSynth failed for session=${sessionId}:`,
          e,
        );
      });
    }

    const modelConfig: ModelConfig = chatModelConfig;

    // M3-U2 — read the panel-captured pinned tab/origin from meta and
    // inject into the loop context. Legacy sessions without a pin fall
    // through to the loop's active-tab fallback (already handled there).
    // AD1 fix: synthMeta was fetched in parallel with synthAgent above
    // (Promise.all) — reuse it here for pinnedTabs[].
    const sessionMeta = synthMeta;
    // v1.5 — use getPrimaryPin to read primary pin from pinnedTabs[] (storage
    // shim maintains legacy field back-compat for older sessions).
    const pinned = sessionMeta != null ? getPrimaryPin(sessionMeta) : undefined;
    // M5 — pin mode at chat-start. Frozen for the loop's lifetime; downstream
    // close_tabs K-9 reads this to refuse user-locked pin closes. Defaults
    // to 'auto' when meta is missing (M1 cold-start corner cases).
    const pinModeAtStart =
      sessionMeta != null
        ? getEffectivePinMode(sessionMeta, synthAgent ?? null)
        : ("auto" as const);

    // Phase 5 — Task 12: mint a fresh taskId for the per-task screenshot
    // budget and pre-capture keys.
    const chatTaskId = crypto.randomUUID();

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
    //
    // Phase 5 — screenshotPreview bytes MUST NOT land in storage either
    // (8 MB quota — same rule as preFetchedContent). The wire-only path
    // carries them to the panel; storage carries only the metadata fields.
    const skipPermissionsAtStart = await isSkipPermissionsEnabled();
    const sendConfirmRequest = async (
      confirmationId: string,
      payload: Omit<AgentConfirmRequestMessage, "type" | "confirmationId">,
    ): Promise<{
      approved: boolean;
      reason?: "flood-limit" | "user-reject" | "aborted" | "pre-capture-failed";
      screenshotResult?: ImageAttachment;
      stale?: boolean;
      failureReason?: string;
    }> => {
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
        return { approved: false, reason: "flood-limit" };
      }

      // Phase 5 — pre-capture for screenshot tools (R5/R6, K-1 informed-approval).
      // Dispatch the capture BEFORE posting the confirm card so the user sees the
      // EXACT bytes the LLM will receive. If capture fails, short-circuit with
      // `pre-capture-failed` so loop.ts feeds a failure observation.
      let screenshotPreview: ScreenshotConfirmExtras | undefined;
      const isScreenshotTool =
        payload.tool === "capture_visible_tab" ||
        payload.tool === "capture_fullpage_tab";
      if (isScreenshotTool) {
        // Phase 5 follow-up — first-task pin race fallback. The panel-side
        // captureActivePinned + setSessionMeta on first send is fire-and-forget
        // (useSession.ts:760-790); SW may read sessionMeta before that patch
        // lands, so closure-captured `pinned` may be undefined on the very first
        // chat-start. Mirror the loop's active-tab fallback via three-tier
        // resolveEffectivePinned (closure → re-read meta → active-tab query).
        const effectivePinned = await resolveEffectivePinned(pinned, sessionId);
        if (!effectivePinned) {
          // I-4 — no pinned tab available (e.g. chrome:// or unpinnable session).
          return {
            approved: false,
            reason: "pre-capture-failed",
            failureReason: "no-pinned-tab",
          };
        }
        const captureCtx = {
          sessionId,
          taskId: chatTaskId,
          pinnedTabId: effectivePinned.tabId,
        };
        let outcome;
        if (payload.tool === "capture_visible_tab") {
          outcome = await dispatchCaptureVisibleTab(captureCtx);
        } else {
          outcome = await dispatchCaptureFullPageTab(
            captureCtx,
            makeCdpAdapterForScreenshot(abortController),
          );
        }
        if (outcome.ok) {
          // S-2 — setPreCapture only on success so a failed capture never
          // enters the cache (removing the redundant discard-after-set pattern).
          setPreCapture(confirmationId, outcome);
          const img = outcome.value;
          screenshotPreview = {
            thumbnail: img.data,
            mediaType: img.mediaType,
            width: img.width,
            height: img.height,
            capturedAt: Date.now(),
          };
        } else {
          // Pre-capture failed — skip the confirm card entirely; return failure.
          return {
            approved: false,
            reason: "pre-capture-failed",
            failureReason: outcome.reason,
          };
        }
      }

      // v1.5 — pre-parse URL for open_url confirm card (K-1 informed-approval).
      // URL.host returns punycode for IDN — defense against homograph attacks.
      // Small text: safe to persist in storage (unlike screenshotPreview bytes).
      let openUrlPreview: OpenUrlConfirmExtras | undefined;
      if (payload.tool === "open_url") {
        const args = payload.args as { url?: string; active?: boolean };
        let host = "(invalid)";
        let origin = "(invalid)";
        try {
          const u = new URL(args.url ?? "");
          host = u.host;
          origin = u.origin;
        } catch {
          // Shouldn't happen — handler validates upstream; defensive fallback.
        }
        openUrlPreview = {
          url: args.url ?? "",
          host,
          origin,
          active: args.active === true,
        };
      }

      // R2.3 — global skip-permissions short-circuit. After pre-capture
      // (screenshot) and URL pre-parse (open_url) so LLM-fed bytes / typed
      // origin payloads are still produced, but the panel confirm card is
      // never shown and the agent-confirm-response wait is bypassed.
      if (skipPermissionsAtStart) {
        if (isScreenshotTool) {
          const consumed = consumePreCapture(confirmationId);
          if (!consumed?.image) {
            return {
              approved: false,
              reason: "pre-capture-failed",
              failureReason: "pre-capture cache miss (skip-permissions auto-approve path)",
            };
          }
          return {
            approved: true,
            screenshotResult: consumed.image,
          };
        }
        return { approved: true };
      }

      try {
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
            // screenshotPreview intentionally omitted from storage — bytes must
            // not reach chrome.storage (8 MB quota). Panel renders from wire only.
            // openUrlPreview is small text — safe to persist for R4 re-emit.
            ...(openUrlPreview ? { openUrlPreview } : {}),
          },
        });
      } catch (e) {
        // Storage failure after setPreCapture — discard bytes before re-throwing
        // to avoid a memory leak in the screenshot-precapture cache.
        if (isScreenshotTool) discardPreCapture(confirmationId);
        throw e;
      }

      try {
        return await new Promise<{
          approved: boolean;
          reason?: "user-reject" | "aborted";
          screenshotResult?: ImageAttachment;
          stale?: boolean;
          failureReason?: string;
        }>((resolve) => {
          // Bug-fix-D — see resume-path twin for rationale.
          pendingConfirmations.set(confirmationId, (panelResult) => {
            if (!panelResult.approved || !isScreenshotTool) {
              resolve(panelResult);
              return;
            }
            // User approved a screenshot tool — consume the pre-captured image.
            const consumed = consumePreCapture(confirmationId);
            if (!consumed.hit) {
              // No pre-capture entry (cleared by abort/disconnect already).
              resolve({ approved: false, reason: "pre-capture-failed", failureReason: "pre-capture cache miss" });
              return;
            }
            resolve({
              approved: !consumed.stale,
              stale: consumed.stale,
              screenshotResult: consumed.image ?? undefined,
            });
          });
          // P1-4 — register session ownership so agent-confirm-response
          // handler can verify the approval came from the right session.
          pendingConfirmationsBySession.set(confirmationId, sessionId);
          port.postMessage({
            type: "agent-confirm-request",
            confirmationId,
            ...payload,
            ...(screenshotPreview ? { screenshotPreview } : {}),
            ...(openUrlPreview ? { openUrlPreview } : {}),
            sessionId,
          } satisfies AgentConfirmRequestMessage);
        });
      } finally {
        pendingConfirmationsBySession.delete(confirmationId);
        // Discard pre-capture if still in cache (stale reject, abort drain, etc.)
        if (isScreenshotTool) discardPreCapture(confirmationId);
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
      // v1.5 multi-pin: replace single `pinned` with the full array.
      // synthMeta is post-upgradeAutoToTaskAtChatStart (fetched after the
      // upgrade at line 1035), so pinnedTabs[] reflects the upgraded state.
      pinnedTabs: sessionMeta?.pinnedTabs ?? [],
      initialFocusTabId: sessionMeta?.pinnedTabs?.[0]?.tabId,
      // Phase 5 — per-task screenshot budget key.
      taskId: chatTaskId,
      skipPermissions: skipPermissionsAtStart,
      // M3-U4 (TOCTOU fix) — refresh the cross-session pinned-tab
      // registry per tool dispatch. The frozen snapshot here would miss
      // sessions created mid-loop.
      refreshCrossSessionPinnedTabIds: () => getCrossSessionPinnedTabIds(sessionId),
      // M5 — pin mode frozen at chat-start. close_tabs K-9 reads this
      // through ToolHandlerContext to refuse user-locked pin closes.
      pinMode: pinModeAtStart,
      // M5 — auto-unpin task-mode pin at task end (chat-start path).
      onTaskDone: () => clearTaskPinAtSessionEnd(sessionId),
      // U2 — pass the full (possibly synth-injected) messages array so
      // runAgentLoop can seed a proper multi-turn history instead of the
      // bare [system, user(task)] two-entry seed.
      messages: effectiveMessages,
      // U4 — telemetry: fire-and-forget; crypto.subtle may be async but
      // must not stall the LLM call.
      onHistoryRepaired: (violations, rawMessages) => {
        logHistoryRepaired(violations, rawMessages).catch((e) => {
          console.warn("[agent] logHistoryRepaired error:", e);
        });
      },
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

// M3-U1 — port name encodes sessionId: `chat-stream-${sessionId}`. Each
// connect creates an independent `abortRotation` + pendingConfirmations
// closure (per-port sandbox). Within a port, the abort controller is
// rotated per task (chat-start / resume-task) per Issue #24. The SW
// supports multiple concurrent ports (e.g. two sidepanels in two Chrome
// windows, each pinned to its own session); single-panel concurrent task
// switch remains gated by the M2-U2 streaming guard for now (deferred to
// a future M3-U6+).
const CHAT_STREAM_PREFIX = "chat-stream-";

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith(CHAT_STREAM_PREFIX)) return;
  const portSessionId = port.name.slice(CHAT_STREAM_PREFIX.length);
  if (!portSessionId) {
    // Reject malformed port name — defense against an extension peer
    // (or a bug in the panel) opening a port with an empty session id.
    console.warn(`[sw] rejecting port with empty sessionId: name="${port.name}"`);
    port.disconnect();
    return;
  }

  // R13(c) — session switch: useSession.connectPortFor opens a new port
  // with the newly-activated sessionId on every setActive / createAndActivate
  // call in the panel. Evict all sessions OTHER than the one this port is
  // bound to so the active session keeps its warm cache.
  evictOnSetActive(portSessionId);

  // Issue #24 (Bug 1) — abort controller is per-task, NOT per-port. An
  // AbortSignal is one-shot: once `chat-abort` aborts it, the next
  // chat-start on the same port would inherit an already-aborted signal
  // and runAgentLoop would bail at line 887 ("任务已取消"), making Stop
  // permanently lock the session. The rotation helper hands back a fresh
  // controller before each task dispatch.
  const abortRotation = createAbortRotation();

  // Per-port pending confirmation map.
  // Phase 5 — widened to carry screenshot pre-capture extras so the SW can
  // pass back `screenshotResult`, `stale`, `failureReason` after consuming
  // the pre-capture cache (Task 12). Non-screenshot confirms leave these
  // fields absent; loop.ts reads them only for capture_*_tab resolves.
  const pendingConfirmations = new Map<
    string,
    (result: {
      approved: boolean;
      reason?: "user-reject" | "aborted" | "pre-capture-failed";
      screenshotResult?: ImageAttachment;
      stale?: boolean;
      failureReason?: string;
    }) => void
  >();
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
  // (Stop button, port disconnect, rotation-on-stacked-chat-start). Without
  // this, sendConfirmRequest's promise never resolves and runAgentLoop hangs
  // — finally never runs, no agent-done-task is emitted, the panel just
  // sees streaming stop with no AgentSummary.
  //
  // Bug-fix-D — drain with reason='aborted'. Without this, the resolver
  // would receive the structural-default and loop.ts would treat the
  // hanging confirm as a user-reject, polluting the K-10 fatigue counter
  // (3 panel-close-mid-confirm events would auto-terminate the task with
  // "User repeatedly rejected").
  //
  // Issue #24 — previously this lived as `abortController.signal.addEventListener
  // ("abort", ..., {once:true})`, which fires automatically on any abort. After
  // the rotation refactor (per-task controllers), explicit call sites are
  // simpler than re-attaching a listener on every rotation. Only chat-abort
  // and onDisconnect actually originate aborts that warrant draining; loop-
  // internal aborts use a separate `internalController` (loop.ts:884) that
  // doesn't bubble back to ctx.signal.
  const drainPendingConfirms = () => {
    for (const [confirmId, resolve] of pendingConfirmations) {
      // Phase 5 — discard any pending pre-capture (bytes would leak in
      // memory if not cleaned up).
      discardPreCapture(confirmId);
      resolve({ approved: false, reason: "aborted" });
    }
    pendingConfirmations.clear();
    pendingConfirmationsBySession.clear();
  };

  // Keep-alive: reset Service Worker idle timer while streaming
  const keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo();
  }, 25_000);

  // M3-U1 — every panel→SW message carrying a `sessionId` must match the
  // sessionId encoded in the port name. Mismatch indicates a wire bug
  // (panel constructed a wrong-id message on a port that's bound to a
  // different session) or a tampering attempt. We post a session-toast back
  // so the panel can surface it, then drop the message rather than
  // silently routing it to a foreign session's resolver.
  const verifyPortSession = (msgSessionId: string, kind: string): boolean => {
    if (msgSessionId !== portSessionId) {
      console.warn(
        `[sw] port-session mismatch on ${kind}: portSession=${portSessionId} msgSession=${msgSessionId} — dropping`,
      );
      return false;
    }
    return true;
  };

  port.onMessage.addListener((message: PortMessageToWorker) => {
    if (message.type === "chat-start") {
      if (!verifyPortSession(message.sessionId, "chat-start")) return;
      // Issue #24 (Bug 1) — rotate to a fresh AbortController for the new
      // task. If a prior task was still running (panel-state desync), the
      // rotate helper aborts it and drains its pending confirms first.
      rotateAbortController(abortRotation, drainPendingConfirms);
      inFlightSessionIds.add(message.sessionId);
      handleChatStream(
        port,
        message.messages,
        message.sessionId,
        abortRotation.current,
        pendingConfirmations,
        pendingConfirmationsBySession,
      );
    } else if (message.type === "chat-abort") {
      abortRotation.current.abort();
      drainPendingConfirms();
    } else if (message.type === "agent-confirm-response") {
      if (!verifyPortSession(message.sessionId, "agent-confirm-response")) return;
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
      if (!verifyPortSession(message.sessionId, "panel-mounted")) return;
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
      if (!verifyPortSession(message.sessionId, "resume-task")) return;
      // Issue #24 (Bug 1) — same rotation as chat-start; resume is a
      // task-start equivalent and must not inherit a prior task's aborted
      // signal.
      rotateAbortController(abortRotation, drainPendingConfirms);
      inFlightSessionIds.add(message.sessionId);
      handleResumeRequest(
        port,
        message.sessionId,
        abortRotation.current,
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
      if (!verifyPortSession(message.sessionId, "discard-task")) return;
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
    } else if (message.type === "recording-start") {
      if (!verifyPortSession(message.sessionId, "recording-start")) return;
      portsBySession.set(message.sessionId, port);
      handleRecordingStart(port, message, (sid) => inFlightSessionIds.has(sid)).catch((e) => {
        console.warn(`[sw] recording-start failed for session=${message.sessionId}:`, e);
      });
    } else if (message.type === "recording-finish") {
      if (!verifyPortSession(message.sessionId, "recording-finish")) return;
      handleRecordingFinish(port, message).catch((e) => {
        console.warn(`[sw] recording-finish failed for session=${message.sessionId}:`, e);
      });
    } else if (message.type === "recording-discard") {
      if (!verifyPortSession(message.sessionId, "recording-discard")) return;
      handleRecordingDiscard(port, message).catch((e) => {
        console.warn(`[sw] recording-discard failed for session=${message.sessionId}:`, e);
      });
    }
  });

  port.onDisconnect.addListener(() => {
    // Recording v1 — panel disconnect aborts any active recording for this session.
    abortRecordingForSession(port, portSessionId, "panel-disconnect");
    portsBySession.delete(portSessionId);

    abortRotation.current.abort();
    clearInterval(keepAliveInterval);
    // Drain pending confirmations with reason='aborted' (Bug-fix-D — see
    // drainPendingConfirms JSDoc for K-10 fatigue rationale). Phase 5 —
    // discardPreCapture inside drainPendingConfirms cleans up pre-capture
    // bytes before resolving so they don't leak.
    drainPendingConfirms();

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
    //   2. else stepIndex>0 → markPaused (in-flight, resumable). R14: if
    //      hasImageContent, mark failed instead (image bytes gone with port).
    //   3. else (tombstone) → no-op (task finished cleanly).
    //
    // Fire-and-forget: MV3 SW stays alive for pending storage promises so
    // the markPaused write completes before the SW idles out.
    const sessionsToClose = Array.from(inFlightSessionIds);
    inFlightSessionIds.clear();
    // R13(d) — evict image cache for all sessions this port was tracking.
    evictByInFlightSet(sessionsToClose);
    transitionPortInFlightSessionsToPaused(sessionsToClose).catch((e) => {
      console.warn("[sw] panel-disconnect cleanup failed:", e);
    });
  });
});

// Recording v1 — webNavigation hooks for hard-nav re-inject + SPA route record.
if (chrome.webNavigation) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    const sess = findRecordingSessionByTabId(details.tabId);
    if (!sess) return;
    const port = portsBySession.get(sess.sessionId);
    if (!port) return;
    handleRecordingNavCommitted(port, details).catch((e) => {
      console.warn("[sw] recording-nav-committed failed:", e);
    });
  });
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    const sess = findRecordingSessionByTabId(details.tabId);
    if (!sess) return;
    const port = portsBySession.get(sess.sessionId);
    if (!port) return;
    handleRecordingHistoryStateUpdated(port, details).catch((e) => {
      console.warn("[sw] recording-history-state-updated failed:", e);
    });
  });
}

// Recording v1 — abort recording when the recorded tab closes.
chrome.tabs.onRemoved.addListener((closedTabId) => {
  for (const sess of Array.from(recordingState.values())) {
    if (sess.tabId !== closedTabId) continue;
    const port = portsBySession.get(sess.sessionId);
    if (port) handleRecordingTabClosed(port, closedTabId);
    else recordingState.delete(sess.sessionId);
  }
});

console.log("[Pie] Service worker started");
