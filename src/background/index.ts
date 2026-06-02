// Service Worker — background script for Pie

import type {
  PageContent,
  ExtractPageResponse,
  PortMessageToWorker,
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
// Eval harness (dev-only). STATIC import is required: MV3 service workers do
// NOT support runtime dynamic import(), so the bridge must be in the static
// module graph (loaded at SW registration). Prod build sets __PIE_EVAL__=false,
// making `mountEvalBridge()` dead code → tree-shaken out along with this import
// (verified by scripts/assert-no-eval-bridge.mjs).
import { mountEvalBridge } from "./eval-bridge";
import type { RoleViolation } from "@/lib/agent/history-validation";
import { logHistoryRepaired } from "@/lib/agent/history-validation-telemetry";
import {
  setSessionAgent,
  setPendingConfirm,
  getSessionAgent,
  getSessionMeta,
  setSessionMeta,
  markFailedAndScrub,
  updateLastAccessed,
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
import {
  registerOnboardingPort,
  unregisterOnboardingPort,
  handleOnboardingResponse,
  onStorageChanged as onCdpInputStorageChanged,
} from "@/lib/cdp-input-onboarding";
import {
  registerLocalFilePort,
  unregisterLocalFilePort,
  handleLocalFileResponse,
} from "@/lib/local-file-request";
import { CDP_INPUT_ENABLED_STORAGE_KEY } from "@/lib/cdp-input-enabled";

import { runSessionMigrations } from "@/lib/sessions/migration";
import { migrateLegacyKeyboardFlag } from "@/lib/cdp-input-enabled";
import { getCrossSessionPinnedTabIds } from "@/lib/sessions/pinned-tab-registry";
import { getEffectivePinMode, getPrimaryPin } from "@/lib/sessions/pin-state";
import { chat } from "@/lib/model-router";
import { generateTitle, maybeUpgradeFallbackTitle } from "@/lib/sessions/title-generator";
import {
  evictAllOnSWStartup,
  evictByInFlightSet,
} from "./image-cache";
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
import { createKeepAlive, type KeepAlive } from "./keep-alive";
import { cleanupLegacySkipPermissions } from "./cleanup-migration";
import { reinjectAllTabs } from "./content-reinject";
import { dispatchQuoteAdded, drainPendingQuotesToPort } from "./quote-dispatch";
import { cleanupThinShellSkills } from "@/lib/skills/migration-cleanup-thinshell";
import { migrateSkillsToPackages } from "@/lib/skills/migration-packages";
import {
  handleQuoteTextCaptured,
  handleQuoteElementCaptured,
  broadcastPickerEnter,
  broadcastPickerExit,
} from "./quote-bridge";
import { addPending, cancelPending, drainPending } from "@/lib/sessions/pending-instructions";
import { broadcastInstructionState } from "./instruction-broadcast";
import { mergeCarryoverIntoMessages } from "@/lib/agent/loop-drain";
import type { ChatInstructionRejectedMessage } from "@/types/messages";
import { isFilePdfUrl } from "@/lib/pdf/detect";

// Run V1→V2 migration once on SW load (idempotent via schema_version sentinel).
migrateV1toV2().catch((e) => console.error("migration v2 failed", e));
cleanupLegacySkipPermissions().catch((e) =>
  console.error("legacy skip-permissions cleanup failed", e),
);
cleanupThinShellSkills().catch((e) =>
  console.error("thin-shell skills cleanup failed", e),
);
// Migrate legacy `skill_*` SkillDefinition records → IndexedDB SkillPackages
// (idempotent: removes legacy keys after a successful put, so re-runs no-op).
migrateSkillsToPackages().catch((e) =>
  console.error("skill→package migration failed", e),
);

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
// Run cdp-input flag migration on every SW startup (idempotent).
void migrateLegacyKeyboardFlag();

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
  void migrateLegacyKeyboardFlag();
  // ROADMAP §14 v1.1 — re-inject content scripts into already-open tabs so
  // they get a live runtime after extension reload/update. Without this,
  // previously-open tabs would orphan and silently fail every sendMessage
  // until the user manually refreshes the tab. Fire-and-forget; failures
  // (restricted URLs, tab discarded) are counted in the result and
  // surfaced via console.
  reinjectAllTabs()
    .then((res) => {
      console.info(
        `[sw] content reinject: ${res.injected} ok / ${res.skipped} skipped / ${res.failed} failed`,
      );
    })
    .catch((e) => {
      console.warn("[sw] content reinject failed:", e);
    });
});

// M1-U5 — Chrome process startup recovery. NOTE: in MV3 this fires
// only on Chrome launch, NOT on SW wake-up after 30s idle. The
// top-level recoveryReady covers wake-ups. Fire-and-forget.
chrome.runtime.onStartup.addListener(() => {
  recoveryReady.catch((e) => {
    console.warn("[sw] recovery on onStartup failed:", e);
  });
  void migrateLegacyKeyboardFlag();
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
  onCdpInputStorageChanged(changes);
  const change = changes[CDP_INPUT_ENABLED_STORAGE_KEY];
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

    // iframe spec §6: allFrames fan-out + merge.
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: extractPageContent,
    });

    type RawContent = { title: string; url: string; description: string; content: string };
    const injections = results.map((r) => ({
      frameId: r.frameId,
      result: r.result as RawContent | undefined,
    }));

    const tree = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    if (!tree) {
      return {
        type: "page-content",
        data: { title: "", url, description: "", content: "", frames: [] },
      };
    }

    const top = tree.find((f) => f.frameId === 0);
    const topUrl = top?.url ?? url;
    let topOrigin: string | null = null;
    try { topOrigin = new URL(topUrl).origin; } catch { topOrigin = null; }

    const injectionMap = new Map<number, RawContent | undefined>();
    for (const inj of injections) injectionMap.set(inj.frameId, inj.result);

    const TOTAL_BUDGET = 50_000;
    let usedBudget = 0;

    const frames: ExtractedFrameContent[] = [];
    for (const entry of tree) {
      let origin: string | null = null;
      try { origin = new URL(entry.url).origin; if (origin === "null") origin = null; } catch { origin = null; }
      const crossOrigin = topOrigin !== null && origin !== null && origin !== topOrigin;
      const parentFrameId = entry.frameId === 0 ? null : entry.parentFrameId;

      const raw = injectionMap.get(entry.frameId);
      if (!raw) {
        const reason = entry.url.startsWith("chrome-extension://") ? "extension-child"
          : entry.url === "about:blank" && !entry.errorOccurred ? "about-blank"
          : entry.errorOccurred ? "frame-error"
          : "sandbox";
        frames.push({
          frameId: entry.frameId,
          frameUrl: entry.url,
          origin,
          crossOrigin,
          parentFrameId,
          content: "",
          unreachable: true,
          reason,
        });
        continue;
      }

      const remaining = TOTAL_BUDGET - usedBudget;
      let content = raw.content;
      let truncated: true | undefined;
      if (content.length > remaining) {
        if (remaining > 0) {
          content = content.slice(0, remaining);
          truncated = true;
        } else {
          content = "";
          truncated = true;
        }
      }
      usedBudget += content.length;

      frames.push({
        frameId: entry.frameId,
        frameUrl: entry.url,
        origin: origin ?? "",
        crossOrigin,
        parentFrameId,
        content,
        ...(truncated ? { truncated: true as const } : {}),
      });
    }

    const topResult = injectionMap.get(0);

    const data: PageContent = {
      title: topResult?.title ?? "",
      url: topResult?.url ?? url,
      description: topResult?.description ?? "",
      content: topResult?.content ?? "",
      frames,
    };

    return { type: "page-content", data };
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

  if (message.type === "quote-text-captured" || message.type === "quote-element-captured") {
    // ROADMAP §14 v1.1 #4 — auto-open side panel on bubble click. Must run
    // synchronously inside the onMessage handler to preserve the trusted
    // user-gesture chain (bubble click → content sendMessage → here). Any
    // await before this would invalidate the gesture and Chrome would reject
    // sidePanel.open with "must be called in response to a user gesture".
    const senderTabId = sender.tab?.id;
    if (typeof senderTabId === "number") {
      chrome.sidePanel.open({ tabId: senderTabId }).catch((e) => {
        console.warn("[sw] sidePanel.open from quote bubble failed:", e);
      });
    }
    void (async () => {
      let out;
      if (message.type === "quote-text-captured") {
        out = await handleQuoteTextCaptured(sender, message.payload);
      } else {
        out = await handleQuoteElementCaptured(sender, message.payload);
      }
      if (!out) return;
      // 每个 port 绑定一个 sessionId（port name = chat-stream-${sessionId}）。
      // 派发时为每个 port 注入它自己的 sessionId，panel 的 port handler 才能
      // 路由到对应 slot。如果 ports 为空（bubble click 触发 sidePanel.open
      // 但 panel 还在 mount），dispatchQuoteAdded 会 stash，onConnect 时 drain。
      dispatchQuoteAdded(out, portsBySession);
    })();
    return;
  }
});

// ROADMAP §14 v1.1 #5 — keyboard shortcut for "add selection as quote".
// manifest.commands["quote-selection"] declares the command (no
// suggested_key; user binds it at chrome://extensions/shortcuts).
// Flow: hotkey → onCommand → executeScript to read window.getSelection()
// on the active tab → reuse handleQuoteTextCaptured + dispatchQuoteAdded
// so the resulting chip and broadcast are identical to the bubble path.
// Self-contained function injected via chrome.scripting.executeScript.
// MUST NOT reference outer-scope identifiers (closures don't survive serialization).
function extractCurrentSelectionForQuote(): { text: string; sourceUrl: string } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const text = sel.toString().trim();
  if (text.length === 0) return null;
  return { text, sourceUrl: location.href };
}

chrome.commands.onCommand.addListener((command) => {
  if (command !== "quote-selection") return;
  void (async () => {
    // Open side panel first so the user-gesture window is consumed before
    // any tabs/scripting await drops it.
    try {
      const win = await chrome.windows.getCurrent();
      if (typeof win.id === "number") {
        await chrome.sidePanel.open({ windowId: win.id });
      }
    } catch (e) {
      console.warn("[sw] sidePanel.open from shortcut failed:", e);
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (typeof tab?.id !== "number") return;

    let payload: { text: string; sourceUrl: string } | null = null;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractCurrentSelectionForQuote,
      });
      payload = (results[0]?.result as typeof payload) ?? null;
    } catch (e) {
      console.warn("[sw] shortcut: selection extraction failed:", e);
      return;
    }
    if (!payload) return;

    const out = await handleQuoteTextCaptured(
      { tab: { id: tab.id } } as chrome.runtime.MessageSender,
      payload,
    );
    if (!out) return;
    dispatchQuoteAdded(out, portsBySession);
  })();
});

// --- M1-U4: panel-mounted handler ---

/**
 * Panel mounted signal handler — ensures recovery pipeline has run
 * before the panel reads storage state.
 */
async function handlePanelMounted(
  port: chrome.runtime.Port,
  sessionId: string,
): Promise<void> {
  // M1-U5 — panel mounting is a strong signal that the SW has just
  // woken up (panel open ⇒ SW kept alive ⇒ guaranteed wake-up event).
  // Await the module-level recoveryReady (migration → detectAndMarkPaused
  // pipeline) so storage is clean. Guard window dedupes repeated calls.
  // M2-U1: recoveryReady includes migrations so a 'default' id residue
  // is cleaned before the panel can observe stale state.
  await recoveryReady.catch((e) => {
    console.warn(
      `[sw] recovery during panel-mounted failed for session=${sessionId}:`,
      e,
    );
  });

  // Issue #34 — sync pending instructions to the panel so the reconnected
  // UI can re-decorate any pending bubbles in slot.messages.
  await broadcastInstructionState(port, sessionId);
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
  inFlightSessionIds: Set<string>,
  keepAlive: KeepAlive,
): Promise<void> {
  try {
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
    // Persist the drift card to storage so the panel can recover it.
    await setPendingConfirm(sessionId, {
      confirmationId,
      kind: "pinned-tab-drift",
      payload: drift,
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
    sessionId,
    // M2-U1: shared handler that also throttles lastAccessedAt bumps.
    onStepSnapshot: makeStepSnapshotHandler(sessionId),
    resumedAgentMessages: agent.agentMessages,
    resumedFromStep: agent.stepIndex,
    // Phase 5 — propagate prior hasImageContent flag across resume.
    resumedHasImageContent: agent.hasImageContent,
    // v1.5 multi-pin: replace single `pinned` with the full array.
    // Resume path restores currentFocusTabId from persisted agent state.
    pinnedTabs: meta.pinnedTabs ?? [],
    initialFocusTabId: agent.currentFocusTabId ?? meta.pinnedTabs?.[0]?.tabId,
    // Phase 5 — per-task screenshot budget key.
    taskId: resumeTaskId,
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
  } finally {
    inFlightSessionIds.delete(sessionId);
    keepAlive.maybeStop();
  }
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
): Promise<void> {
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
  inFlightSessionIds: Set<string>,
  keepAlive: KeepAlive,
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

    // Issue #34 — if a prior abort left pending instructions, merge them
    // into the last user message of the new task so the user's earlier
    // mid-task additions aren't lost.
    const carryover = await drainPending(sessionId);
    if (carryover.length > 0) {
      const merged = mergeCarryoverIntoMessages(messages, carryover);
      if (merged === messages) {
        // mergeCarryoverIntoMessages returns the original ref when the last
        // message isn't a user string — log and drop carryover.
        console.warn(
          `[sw] chat-start drained ${carryover.length} pending instruction(s) but ` +
          `last message is not a user string — items dropped`,
        );
      } else {
        messages = merged;
      }
      // Broadcast empty pending so panel removes pending decorations
      await broadcastInstructionState(port, sessionId);
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

    await runAgentLoop({
      port,
      task,
      modelConfig,
      signal,
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
  } finally {
    inFlightSessionIds.delete(sessionId);
    keepAlive.maybeStop();
  }
}

// M3-U1 — port name encodes sessionId: `chat-stream-${sessionId}`. Each
// connect creates an independent `abortRotation` (per-port sandbox). Within
// a port, the abort controller is rotated per task (chat-start / resume-task)
// per Issue #24. The SW supports multiple concurrent ports (e.g. two sidepanels
// in two Chrome windows, each pinned to its own session); single-panel
// concurrent task switch remains gated by the M2-U2 streaming guard for now
// (deferred to a future M3-U6+).
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

  // quote-bridge dispatch (issue #38) needs sessionId→port mapping the moment the
  // panel connects, not when a recording starts. Without this, quote-added never
  // reaches the panel because the dispatch loop iterates an empty map.
  portsBySession.set(portSessionId, port);
  registerOnboardingPort(portSessionId, port);
  registerLocalFilePort(portSessionId, port);

  // v1.1 — drain any quote-added stashed while panel was booting (bubble click
  // triggers sidePanel.open + dispatchQuoteAdded back-to-back; the dispatch
  // happens before the panel's port connects). The new port's sessionId is the
  // session the panel landed in, which is exactly where the chip belongs.
  drainPendingQuotesToPort(portSessionId, port);

  // R13(c) evictOnSetActive removed (#30) — multi-session: a new port no
  // longer means the previous active session is exiting. Image-cache 30 MB
  // per-session LRU + R13(a) emitDone + R13(b) SW restart + R13(d) port
  // disconnect remain in effect. evictOnSetActive function body retained
  // in image-cache.ts for any future explicit-clear UI surface.

  // Issue #24 (Bug 1) — abort controller is per-task, NOT per-port. An
  // AbortSignal is one-shot: once `chat-abort` aborts it, the next
  // chat-start on the same port would inherit an already-aborted signal
  // and runAgentLoop would bail at line 887 ("任务已取消"), making Stop
  // permanently lock the session. The rotation helper hands back a fresh
  // controller before each task dispatch.
  const abortRotation = createAbortRotation();

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

  // #30 — keep-alive scoped to in-flight tasks. ensure() at chat-start /
  // resume-task; maybeStop() after each task terminal state.
  const keepAlive = createKeepAlive({
    tick: () => chrome.runtime.getPlatformInfo(),
    inFlight: inFlightSessionIds,
  });

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
      // rotate helper aborts it.
      rotateAbortController(abortRotation, () => {});
      inFlightSessionIds.add(message.sessionId);
      keepAlive.ensure();
      handleChatStream(
        port,
        message.messages,
        message.sessionId,
        abortRotation.current,
        inFlightSessionIds,
        keepAlive,
      );
    } else if (message.type === "chat-abort") {
      abortRotation.current.abort();
    } else if (message.type === "chat-instruction-add") {
      if (!verifyPortSession(message.sessionId, "chat-instruction-add")) return;

      // Reject if loop has ended for this session — panel will fall back to chat-start
      if (!inFlightSessionIds.has(message.sessionId)) {
        const reply: ChatInstructionRejectedMessage = {
          type: "chat-instruction-rejected",
          sessionId: message.sessionId,
          chatMessageId: message.chatMessageId,
          reason: "not-streaming",
        };
        port.postMessage(reply);
        return;
      }

      // Append to queue then broadcast new state
      void (async () => {
        try {
          await addPending(message.sessionId, {
            chatMessageId: message.chatMessageId,
            content: message.content,
            ...(message.expandedForLLM !== undefined
              ? { expandedForLLM: message.expandedForLLM }
              : {}),
            ...(message.attachments?.length ? { attachments: message.attachments } : {}),
            ...(message.quotes?.length ? { quotes: message.quotes } : {}),
            createdAt: Date.now(),
          });
          await broadcastInstructionState(port, message.sessionId);
        } catch (e) {
          console.warn("[sw] chat-instruction-add failed:", e);
        }
      })();
    } else if (message.type === "chat-instruction-cancel") {
      if (!verifyPortSession(message.sessionId, "chat-instruction-cancel")) return;
      void (async () => {
        try {
          await cancelPending(message.sessionId, message.chatMessageId);
          await broadcastInstructionState(port, message.sessionId);
        } catch (e) {
          console.warn("[sw] chat-instruction-cancel failed:", e);
        }
      })();
    } else if (message.type === "panel-mounted") {
      if (!verifyPortSession(message.sessionId, "panel-mounted")) return;
      handlePanelMounted(port, message.sessionId).catch(
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
      rotateAbortController(abortRotation, () => {});
      inFlightSessionIds.add(message.sessionId);
      keepAlive.ensure();
      handleResumeRequest(
        port,
        message.sessionId,
        abortRotation.current,
        inFlightSessionIds,
        keepAlive,
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
    } else if (message.type === "picker:start") {
      void broadcastPickerEnter((message as { tabId: number }).tabId);
    } else if (message.type === "picker:stop") {
      void broadcastPickerExit((message as { tabId: number }).tabId);
    }
    // CDP input onboarding — panel replies with user's consent choice.
    if (
      message &&
      typeof message === "object" &&
      message.type === "cdp-onboarding-response" &&
      typeof (message as { enabled?: unknown }).enabled === "boolean"
    ) {
      void handleOnboardingResponse(
        portSessionId,
        (message as { enabled: boolean }).enabled,
      );
    }
    // request_local_file — panel replies with the user's picked file (or a
    // cancel / unsupported reason). Keyed by the trusted port-derived session.
    if (
      message &&
      typeof message === "object" &&
      (message as { type?: string }).type === "local-file-response"
    ) {
      handleLocalFileResponse(
        portSessionId,
        message as
          | { ok: true; name: string; mime: string; text: string; truncated: boolean }
          | { ok: false; reason: string },
      );
    }
  });

  port.onDisconnect.addListener(() => {
    // Recording v1 — panel disconnect aborts any active recording for this session.
    abortRecordingForSession(port, portSessionId, "panel-disconnect");
    portsBySession.delete(portSessionId);
    unregisterOnboardingPort(portSessionId);
    unregisterLocalFilePort(portSessionId);

    abortRotation.current.abort();
    keepAlive.stop();

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

// PDF agent — broadcast a prompt to all open sidepanels when the user
// navigates to a local PDF and file:// access is not yet granted.
async function broadcastPdfNeedsFileAccess(tabId: number): Promise<void> {
  // Defensive: skip if the permission API isn't available (test contexts).
  if (typeof chrome.extension?.isAllowedFileSchemeAccess !== "function") return;
  const allowed = await chrome.extension.isAllowedFileSchemeAccess();
  if (allowed) return;
  for (const port of portsBySession.values()) {
    try {
      port.postMessage({ type: "pdf:needs-file-access", tabId });
    } catch {
      // port may have disconnected concurrently
    }
  }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete") return;
  if (isFilePdfUrl(tab.url)) {
    void broadcastPdfNeedsFileAccess(tabId);
  }
});

console.log("[Pie] Service worker started");

// --- Eval harness (dev-only) ---
// __PIE_EVAL__ 由 Vite define 静态替换为字面量。prod=false → 此调用是死代码,
// 连同顶部的静态 `mountEvalBridge` import 一起被 tree-shake 出 dist/
// (由 scripts/assert-no-eval-bridge.mjs 兜底验证)。eval build=true → SW 注册时
// 同步挂载 globalThis.__pieEval(MV3 不支持运行时 dynamic import,故必须静态)。
if (__PIE_EVAL__) {
  mountEvalBridge();
}
