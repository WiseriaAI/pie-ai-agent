import type { ChatMessage } from "@/lib/model-router";

// --- Page Content ---

export interface PageContent {
  title: string;
  url: string;
  description: string;
  content: string;
}

// --- Side Panel → Service Worker (via Port) ---

export interface ChatStartMessage {
  type: "chat-start";
  messages: ChatMessage[];
}

export interface ChatAbortMessage {
  type: "chat-abort";
}

// --- Service Worker → Side Panel (via Port) ---

export interface ChatChunkMessage {
  type: "chat-chunk";
  text: string;
}

export interface ChatDoneMessage {
  type: "chat-done";
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ChatErrorMessage {
  type: "chat-error";
  error: string;
}

// --- Side Panel → Service Worker (via sendMessage) ---

export interface ExtractPageMessage {
  type: "extract-page";
}

export interface ExtractPageResponse {
  type: "page-content";
  data: PageContent | null;
  error?: string;
}

// --- Discriminated Unions ---

export type PortMessageToWorker = ChatStartMessage | ChatAbortMessage;
export type PortMessageToPanel =
  | ChatChunkMessage
  | ChatDoneMessage
  | ChatErrorMessage;
