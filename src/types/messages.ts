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

/**
 * Phase 3 — multi-tab target descriptor used in confirm cards for
 * close_tabs / group_tabs / activate_tab / etc. SW pre-computes these
 * (chrome.tabs.get + URL parsing + sanitize) before sending the confirm
 * request so the panel renders read-only and consistent informed-approval
 * payload (Phase 3 invariant P3-E).
 *
 * favIconUrl is filtered to https:// or data:image/ only (SEC-5); other
 * protocols are stripped to undefined and the UI falls back to a default
 * icon — never trust a page-controlled favicon URL with anything else.
 *
 * title is sanitized via the same line-break / control-char / wrapper-escape
 * pipeline as wrapTabMetadata so panel rendering can't be subverted by a
 * page-controlled title (P3-G).
 */
export interface TabTarget {
  id: number;
  title: string;
  url: string;
  origin: string;
  favIconUrl?: string;
  /** True when this tab.origin differs from the agent's pinned origin —
   *  drives the cross-origin tag in the confirm card row. */
  crossOrigin: boolean;
  /** True when the tab no longer exists (chrome.tabs.get rejected) at the
   *  time tabTargets was built. The card renders this row as "(closed)" but
   *  the handler will skip it during dispatch. */
  stale?: boolean;
}

/**
 * Phase 3 — get_tab_content content preview (P3-U / R12 / SEC-2).
 * SW pre-fetches the tab content via executeScript before the confirm
 * request, applies escapeUntrustedWrappers + light strip, and ships the
 * first ~200 chars to the panel so the user can see what they're approving
 * before clicking through. Mirrors Phase 2.5 keyboard "confirm shows raw,
 * agent-step redacts" informed-approval invariant.
 */
export interface TabContentPreview {
  tabId: number;
  origin: string;
  /** First ~200 chars of the extracted content (after light strip). The
   *  full content goes to the LLM only after the user approves. */
  previewText: string;
  /** Total bytes the handler will return on approval (preview-truncated
   *  view of). Lets the UI label "showing X of Y bytes". */
  totalBytes: number;
  truncatedAtBytes: number;
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
  /** Phase 3 — for cross-tab tools (close_tabs / group_tabs / activate_tab /
   *  list_tabs allWindows / etc.) the SW pre-computes a TabTarget per tabId
   *  in args. The card renders an `<TabTargetsList>` instead of the legacy
   *  ResolvedElement single-element block. Origin summary is computed in
   *  the panel from this array. (P3-E.) */
  tabTargets?: TabTarget[];
  /** Phase 3 — for `get_tab_content` confirm cards (P3-U). The SW pre-fetches
   *  the tab content (executeScript), applies escapeUntrustedWrappers +
   *  credential light-strip, and ships the first chunk to the panel for
   *  informed approval. Handler reuses this cache on dispatch. */
  contentPreview?: TabContentPreview;
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
