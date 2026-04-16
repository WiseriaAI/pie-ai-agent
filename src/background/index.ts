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

// --- Agent Loop via Port ---

async function handleChatStream(
  port: chrome.runtime.Port,
  messages: ChatMessage[],
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
    // Promise that resolves when panel sends agent-confirm-response
    const sendConfirmRequest = (
      confirmationId: string,
      payload: Omit<AgentConfirmRequestMessage, "type" | "confirmationId">,
    ): Promise<boolean> => {
      return new Promise((resolve) => {
        pendingConfirmations.set(confirmationId, resolve);
        port.postMessage({
          type: "agent-confirm-request",
          confirmationId,
          ...payload,
        } satisfies AgentConfirmRequestMessage);
      });
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

  // Keep-alive: reset Service Worker idle timer while streaming
  const keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo();
  }, 25_000);

  port.onMessage.addListener((message: PortMessageToWorker) => {
    if (message.type === "chat-start") {
      handleChatStream(
        port,
        message.messages,
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
