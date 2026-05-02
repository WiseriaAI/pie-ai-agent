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
  /**
   * M1-U3 — session this stream is bound to. The SW writes step-boundary
   * snapshots to `session_${sessionId}_agent` (D2). Required: a chat-start
   * without a sessionId is rejected; this prevents a misconfigured panel
   * from silently writing nothing instead of writing to the wrong session.
   *
   * Trust face: the panel and SW are within the same BYOK extension
   * boundary; sessionId here carries the same trust as `messages` —
   * Chrome's port API does not let a content script forge port name +
   * payload.
   */
  sessionId: string;
}

export interface ChatAbortMessage {
  type: "chat-abort";
}

// --- Service Worker → Side Panel (via Port) ---

export interface ChatChunkMessage {
  type: "chat-chunk";
  text: string;
  /** M2-U2 — session routing: every SW→panel message carries the sessionId
   *  so the panel can drop messages destined for a session that is no longer
   *  active (e.g. user opened a new session mid-stream). P1-11 / root fix
   *  for P0-1 cross-session contamination. */
  sessionId: string;
}

export interface ChatDoneMessage {
  type: "chat-done";
  usage?: { inputTokens: number; outputTokens: number };
  /** M2-U2 — session routing. See ChatChunkMessage.sessionId. */
  sessionId: string;
}

export interface ChatErrorMessage {
  type: "chat-error";
  error: string;
  /** M2-U2 — session routing. See ChatChunkMessage.sessionId. */
  sessionId: string;
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

// --- Panel-rendered chat history ---

/**
 * DisplayMessage — the panel-rendered chat history item type. Lives in
 * `src/types/messages.ts` so SessionMeta (`src/lib/sessions/types.ts`) and
 * the Chat view can share a single source of truth.
 *
 * This is a *display* type — it is what the user sees, not what the LLM
 * sees. The LLM-facing IR is `AgentMessage` from `@/lib/model-router`,
 * carried separately on `SessionAgentState.agentMessages`. The split keeps
 * agent IR (with raw tool args, redactable for panel display) out of the
 * panel-message store while still letting the panel render the agent's
 * step-by-step trace via the `agent-step` / `agent-confirm` / `agent-summary`
 * variants below.
 */
export type DisplayMessage =
  | {
      role: "user";
      content: string;
      expandedForLLM?: string;
    }
  | { role: "assistant"; content: string }
  | {
      role: "agent-step";
      stepIndex: number;
      tool: string;
      args: unknown;
      resolvedElement?: ResolvedElement;
      status: "pending" | "ok" | "error";
      observation?: string;
    }
  | {
      role: "agent-confirm";
      confirmationId: string;
      tool: string;
      args: unknown;
      resolvedElement: ResolvedElement;
      riskReason: string;
      resolved?: "approved" | "rejected";
      metaSkillPreview?: {
        existing: SkillDefinition | null;
        effective: SkillDefinition;
      };
    }
  | {
      role: "agent-summary";
      success: boolean;
      summary: string;
      stepCount: number;
    }
  | {
      /** M1-U5 — session-level confirm card (R11 drift, future paused-resume).
       *  Distinct from `agent-confirm` (per-tool confirm during a running
       *  task) — driven by `SessionConfirmRequestMessage`. */
      role: "session-confirm";
      confirmationId: string;
      kind: "pinned-tab-drift" | "paused-resume";
      payload: unknown;
      /** Set after the user clicks Discard — UI uses this to disable
       *  the button and dim the card so a duplicate click doesn't
       *  send another discard message. */
      resolved?: "discarded";
    };

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
  /** M2-U2 — session routing. See ChatChunkMessage.sessionId. */
  sessionId: string;
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
  /** M2-U2 — session routing. See ChatChunkMessage.sessionId. */
  sessionId: string;
}

export interface AgentDoneTaskMessage {
  type: "agent-done-task";
  success: boolean;
  summary: string;
  stepCount: number;
  /** M2-U2 — session routing. See ChatChunkMessage.sessionId. */
  sessionId: string;
}

// --- Agent: Side Panel → Service Worker ---

export interface AgentConfirmResponseMessage {
  type: "agent-confirm-response";
  confirmationId: string;
  approved: boolean;
  /** M2-U2 P1-4 — sessionId of the session whose confirm card the user
   *  clicked. SW verifies this matches the session that owns the
   *  confirmationId to prevent a wrong-session approval from executing
   *  a high-risk action against the wrong tab/origin. */
  sessionId: string;
}

/**
 * M1-U5 — panel → SW: user clicked the "Resume task" button on a
 * paused session. SW checks pinned-tab drift; if OK, restarts the
 * agent loop with the persisted history; if drifted, sends back a
 * `session-confirm-request` (kind='pinned-tab-drift').
 */
export interface ResumeTaskMessage {
  type: "resume-task";
  sessionId: string;
}

/**
 * M1-U5 — panel → SW: user clicked "Discard task" on the R11 drift
 * card. SW marks the session as `failed`, scrubs any leftover
 * pendingConfirm, and prepends a system message recap so the user
 * has context when they type a new prompt.
 */
export interface DiscardTaskMessage {
  type: "discard-task";
  sessionId: string;
  /** confirmationId from the SessionConfirmRequestMessage that
   *  surfaced this drift card. SW uses it to clear the matching
   *  resolver in `pendingConfirmations`. */
  confirmationId: string;
}

/**
 * M1-U4 — fired by the panel right after `chrome.runtime.connect` so
 * the SW knows which session this new port belongs to AND whether
 * there's any state to recover (e.g. a pending agent-confirm card the
 * user hasn't responded to yet).
 *
 * Two roles:
 *   1. Identity: tells the SW the sessionId for this port (M3-U1 will
 *      replace this by encoding sessionId into port.name; until then
 *      this message is the wire-level identity carrier).
 *   2. R4 trigger: signals "panel re-mounted, please re-emit any
 *      live confirm-request for this session". The SW checks
 *      `pendingConfirmations.has(confirmationId)` against the
 *      `SessionAgentState.pendingConfirm` record in storage; if both
 *      sides agree the confirm is still live, the SW re-pushes the
 *      `agent-confirm-request` (or `session-confirm-request`) to the
 *      newly-mounted panel.
 */
export interface PanelMountedMessage {
  type: "panel-mounted";
  sessionId: string;
}

/**
 * M1-U5 — concrete payload for `kind='pinned-tab-drift'`. The drift
 * card needs to render the original task summary, the last step
 * the agent reached, and which kind of drift triggered the gate
 * (so the user can act with full context: did the tab close, or
 * just navigate to a different origin?).
 *
 * `originalTask` and `lastPinnedTabTitle` are user-controlled /
 * page-controlled strings; the SW must run them through
 * `escapeUntrustedWrappers` before persisting + sending so panel
 * rendering can't be hijacked (P3-G / R29 family).
 */
export interface PinnedTabDriftPayload {
  reason: "tab-closed" | "origin-changed";
  /** First user message of the task — what the user originally
   *  asked the agent to do. Sanitized. */
  originalTask: string;
  /** Title of the pinned tab at task start. May be empty if the
   *  agent never observed a title. Sanitized. */
  lastPinnedTabTitle: string;
  /** Origin captured at task start (e.g. "https://docs.google.com").
   *  For 'origin-changed', also the current origin. */
  pinnedOrigin: string;
  currentOrigin?: string;
  /** stepIndex reached before SW death. For UI context only. */
  lastStepIndex: number;
}

/**
 * M1-U4 — non-tool confirm request. Distinct variant from
 * `AgentConfirmRequestMessage` to keep the existing tool-call confirm
 * channel uncluttered. `kind` discriminates between scenarios:
 *
 *   - `"pinned-tab-drift"` — fired by M1-U5's resume flow when the
 *      user clicks 'Resume task' but the pinned tab is gone or the
 *      origin has changed. Single 'Discard task' button (R11).
 *   - `"paused-resume"` — currently unused; reserved for the case
 *      where M1-U5 wants to surface a paused task with a non-trivial
 *      drift summary. Default-deferred for now.
 *
 * `payload` is intentionally `unknown` here — each kind defines its
 * own concrete shape, validated at the consumer (SessionConfirmCard).
 * Keeping the wire type discriminated rather than typed-by-kind lets
 * future kinds land without re-shaping every consumer.
 *
 * NOTE: M1-U4 ships the protocol slot ONLY — no SW emitter writes
 * this message yet. M1-U5 introduces the `pinned-tab-drift` emitter.
 * See plan D5.
 */
export interface SessionConfirmRequestMessage {
  type: "session-confirm-request";
  confirmationId: string;
  kind: "pinned-tab-drift" | "paused-resume";
  payload: unknown;
  /** M2-U2 — session routing. See ChatChunkMessage.sessionId. */
  sessionId: string;
}

/**
 * SEC-PLAN-009 — emitted by the SW when a new confirm request is rejected
 * because the pending-confirm flood limit (>5 concurrent) is exceeded. The
 * panel renders this as a transient warning banner. Unlike `chat-error`, this
 * does NOT terminate the stream — it is advisory only.
 */
export interface SessionToastMessage {
  type: "session-toast";
  level: "warn" | "error" | "info";
  text: string;
  /** M2-U2 — session routing. See ChatChunkMessage.sessionId. */
  sessionId: string;
}

// --- Discriminated Unions ---

export type PortMessageToWorker =
  | ChatStartMessage
  | ChatAbortMessage
  | AgentConfirmResponseMessage
  | PanelMountedMessage
  | ResumeTaskMessage
  | DiscardTaskMessage;

export type PortMessageToPanel =
  | ChatChunkMessage
  | ChatDoneMessage
  | ChatErrorMessage
  | AgentStepMessage
  | AgentConfirmRequestMessage
  | AgentDoneTaskMessage
  | SessionConfirmRequestMessage
  | SessionToastMessage;
