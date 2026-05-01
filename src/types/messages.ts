import type { ChatMessage } from "@/lib/model-router";
import type { SkillDefinition } from "@/lib/skills";

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
  /** Set when `tool` resolves to a skill (built-in or user-stored). Allows
   *  Chat UI to badge agent-authored skill calls and audit logs to filter
   *  by origin. Absent for non-skill tools (built-in BUILT_IN_TOOLS, keyboard,
   *  meta tools). Phase 2.6 — see plan R17. */
  skillAuthor?: "user" | "agent" | "builtIn";
}

export interface AgentConfirmRequestMessage {
  type: "agent-confirm-request";
  confirmationId: string;
  tool: string;
  args: unknown;
  resolvedElement: ResolvedElement;
  riskReason: string;
  /** Phase 2.6 — for create_skill / update_skill confirm cards, the SW
   *  pre-computes the effective skill that will be persisted on approval
   *  (and, for update_skill, the existing pre-update content). The confirm
   *  card uses this to render the FULL merged content rather than only the
   *  patch — without this, an update_skill that only patches `promptTemplate`
   *  would hide the persistent `allowedTools` / `parameters` / etc. that
   *  the user is implicitly re-approving (P0-D bypass closure).
   *
   *  `existing` is null for create_skill (no prior state) and the current
   *  SkillDefinition for update_skill. */
  metaSkillPreview?: {
    existing: SkillDefinition | null;
    effective: SkillDefinition;
  };
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
