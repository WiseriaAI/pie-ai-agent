// Service Worker — background script for Chrome AI Agent

import type { PageContent, ExtractPageResponse, PortMessageToWorker } from "@/types";
import type { ChatMessage } from "@/lib/model-router";
import { streamChat } from "@/lib/model-router";
import { getActiveProvider, getProviderConfig } from "@/lib/storage";

// Allow Side Panel to access session storage (for encryption key)
chrome.storage.session.setAccessLevel({
  accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS",
});

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

// --- Chat Stream via Port ---

function buildSystemPrompt(pageContent: PageContent | null): string {
  if (!pageContent?.content) {
    return "You are a helpful browser AI assistant.";
  }
  return `You are a helpful browser AI assistant. The user is currently viewing the following page:

Title: ${pageContent.title}
URL: ${pageContent.url}

Page content:
${pageContent.content}

Answer the user's questions based on the page content when relevant. If the question is unrelated to the page, answer normally.`;
}

async function handleChatStream(
  port: chrome.runtime.Port,
  messages: ChatMessage[],
  signal: AbortSignal,
) {
  try {
    // 1. Extract page content
    const pageResponse = await handleExtractPage();
    const pageContent = pageResponse.data;

    // 2. Get active provider config
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

    // 3. Build system prompt with page content
    const systemPrompt = buildSystemPrompt(pageContent);
    const fullMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...messages,
    ];

    // 4. Stream chat
    for await (const event of streamChat(config, fullMessages, signal)) {
      if (signal.aborted) return;

      if (event.type === "text-delta") {
        port.postMessage({ type: "chat-chunk", text: event.text });
      } else if (event.type === "done") {
        port.postMessage({ type: "chat-done", usage: event.usage });
        return;
      } else if (event.type === "error") {
        port.postMessage({ type: "chat-error", error: event.error });
        return;
      }
    }
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

  // Keep-alive: reset Service Worker idle timer while streaming
  const keepAliveInterval = setInterval(() => {
    chrome.runtime.getPlatformInfo();
  }, 25_000);

  port.onMessage.addListener((message: PortMessageToWorker) => {
    if (message.type === "chat-start") {
      handleChatStream(port, message.messages, abortController.signal);
    } else if (message.type === "chat-abort") {
      abortController.abort();
    }
  });

  port.onDisconnect.addListener(() => {
    abortController.abort();
    clearInterval(keepAliveInterval);
  });
});

console.log("[Chrome AI Agent] Service worker started");
