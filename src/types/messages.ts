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

// --- Agent: resolved element info (from snapshot, not LLM) ---

export interface ResolvedElement {
  text: string;
  ariaLabel?: string;
  tag: string;
  type?: string;
  href?: string;
}

// --- Agent: Service Worker → Side Panel ---

export interface AgentStepMessage {
  type: "agent-step";
  stepIndex: number;
  tool: string;
  args: unknown;
  resolvedElement?: ResolvedElement;
  status: "pending" | "ok" | "error";
  observation?: string;
}

export interface AgentConfirmRequestMessage {
  type: "agent-confirm-request";
  confirmationId: string;
  tool: string;
  args: unknown;
  resolvedElement: ResolvedElement;
  riskReason: string;
}

export interface AgentDoneTaskMessage {
  type: "agent-done-task";
  success: boolean;
  summary: string;
  stepCount: number;
}

// --- Agent: Side Panel → Service Worker ---

export interface AgentConfirmResponseMessage {
  type: "agent-confirm-response";
  confirmationId: string;
  approved: boolean;
}

// --- Discriminated Unions ---

export type PortMessageToWorker =
  | ChatStartMessage
  | ChatAbortMessage
  | AgentConfirmResponseMessage;

export type PortMessageToPanel =
  | ChatChunkMessage
  | ChatDoneMessage
  | ChatErrorMessage
  | AgentStepMessage
  | AgentConfirmRequestMessage
  | AgentDoneTaskMessage;
