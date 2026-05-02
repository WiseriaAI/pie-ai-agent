// Service Worker — background script for Chrome AI Agent

import type {
  PageContent,
  ExtractPageResponse,
  PortMessageToWorker,
  AgentConfirmRequestMessage,
} from "@/types";
import type { ChatMessage, ModelConfig } from "@/lib/model-router";
import { getActiveProvider, getProviderConfig } from "@/lib/storage";
import { runAgentLoop } from "@/lib/agent/loop";
import { getEnabledSkills, resolveSkillToTools } from "@/lib/skills";
import {
  setSessionAgent,
  setPendingConfirm,
  scrubPendingConfirm,
  getSessionAgent,
} from "@/lib/sessions/storage";
import {
  handleExternalDetach,
  detachAllSessions,
} from "./cdp-session";
import { KEYBOARD_SIMULATION_STORAGE_KEY } from "@/lib/keyboard-simulation";

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id) {
    await chrome.sidePanel.open({ tabId: tab.id });
  }
});

// Set side panel behavior: open on action click
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// First install handler
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.storage.local.set({ firstRun: true });
  }
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
  pendingConfirmations: Map<string, (approved: boolean) => void>,
): Promise<void> {
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
    } satisfies AgentConfirmRequestMessage);
  }
  // M1-U5 will add re-emit paths for kind='pinned-tab-drift' /
  // 'paused-resume' via SessionConfirmRequestMessage. M1-U4 ships the
  // protocol slot only — no emitter sets those kinds yet, so this
  // path is unreachable until M1-U5.
}

// --- Agent Loop via Port ---

async function handleChatStream(
  port: chrome.runtime.Port,
  messages: ChatMessage[],
  sessionId: string,
  signal: AbortSignal,
  pendingConfirmations: Map<string, (approved: boolean) => void>,
) {
  try {
    // Get active provider config
    const activeProvider = await getActiveProvider();
    if (!activeProvider) {
      port.postMessage({
        type: "chat-error",
        error: "No active provider configured. Please set up an API key in Settings.",
      });
      return;
    }

    const config = await getProviderConfig(activeProvider);
    if (!config) {
      port.postMessage({
        type: "chat-error",
        error: `No API key configured for ${activeProvider}. Please check Settings.`,
      });
      return;
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
        return await new Promise<boolean>((resolve) => {
          pendingConfirmations.set(confirmationId, resolve);
          port.postMessage({
            type: "agent-confirm-request",
            confirmationId,
            ...payload,
          } satisfies AgentConfirmRequestMessage);
        });
      } finally {
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
      // M1-U3 — persist agent state at every step boundary so SW
      // restart can transition the task to `paused` (M1-U5) instead of
      // silently dropping it. Errors here are caught + logged inside
      // runAgentLoop; this wrapper only does the storage call.
      onStepSnapshot: async (snapshot) => {
        await setSessionAgent(sessionId, snapshot);
      },
    });
  } catch (e) {
    if (signal.aborted) return;
    port.postMessage({
      type: "chat-error",
      error: e instanceof Error ? e.message : "An unexpected error occurred",
    });
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "chat-stream") return;

  const abortController = new AbortController();

  // Per-port pending confirmation map
  const pendingConfirmations = new Map<string, (approved: boolean) => void>();

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
      for (const [, resolve] of pendingConfirmations) {
        resolve(false);
      }
      pendingConfirmations.clear();
    },
    { once: true },
  );

  // Keep-alive: reset Service Worker idle timer while streaming
  const keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo();
  }, 25_000);

  port.onMessage.addListener((message: PortMessageToWorker) => {
    if (message.type === "chat-start") {
      handleChatStream(
        port,
        message.messages,
        message.sessionId,
        abortController.signal,
        pendingConfirmations,
      );
    } else if (message.type === "chat-abort") {
      abortController.abort();
    } else if (message.type === "agent-confirm-response") {
      const resolver = pendingConfirmations.get(message.confirmationId);
      if (resolver) {
        resolver(message.approved);
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
    }
  });

  port.onDisconnect.addListener(() => {
    abortController.abort();
    clearInterval(keepAliveInterval);
    // Drain pending confirmations to prevent hanging promises
    for (const [, resolve] of pendingConfirmations) {
      resolve(false);
    }
    pendingConfirmations.clear();
  });
});

console.log("[Chrome AI Agent] Service worker started");
