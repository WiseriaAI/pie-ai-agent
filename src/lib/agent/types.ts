import type { ActionResult } from "../dom-actions/types";

/**
 * Phase 3 — confirm-time TabTarget snapshot injected into the handler context
 * for cross-tab tools. K-8 confirm-time origin re-verify: handlers compare
 * the live tab origin (chrome.tabs.get inside the handler) against this
 * map's origin (which the user saw on the confirm card), NOT against
 * pinnedOrigin. If a tab navigated to another origin between dispatch
 * time and the handler reading its live origin, the handler skips it (stale).
 *
 * The loop passes this as undefined (confirm layer removed); tab tools
 * that use it handle undefined gracefully.
 */
export interface ConfirmedTabTarget {
  origin: string;
  title: string;
}

/**
 * Phase 3 P3-U / SEC-2 — handler-side cache of content the SW already
 * fetched during the confirm pre-compute phase. get_tab_content is a "fetch
 * before confirm" tool: the SW runs executeScript before the user even sees
 * the confirm card so the content preview can show what's about to be sent
 * to the LLM. After approval, the handler reuses this cache to avoid a
 * second executeScript (which could race against page navigation between
 * approval and dispatch — same K-8 logic, applied to content).
 */
export interface PreFetchedTabContent {
  fullText: string;
  totalBytes: number;
}

export interface ToolHandlerContext {
  tabId: number;
  confirmedTabTargets?: Map<number, ConfirmedTabTarget>;
  preFetchedContent?: Map<number, PreFetchedTabContent>;
  /**
   * M5 — current session's pin mode. Frozen at chat-start (SW dispatcher
   * computes via getEffectivePinMode from meta+agent and passes through
   * AgentLoopContext.pinMode → ctx.pinMode here).
   *
   * Used by close_tabs K-9: only 'user' mode protects the pinned tab from
   * agent-initiated close (user explicitly chose this tab; we shouldn't
   * let the agent yank it). 'task' / 'auto' / undefined modes allow close
   * (high-risk confirm has already gathered explicit user consent; the
   * loop's per-iteration origin check will gracefully abort if the tab
   * disappears).
   */
  pinMode?: "auto" | "task" | "user";
  /**
   * v1.5 — full pinnedTabs array carried into the handler. focus_tab uses
   * this to validate target tabId; close_tabs K-9 (Task 9) checks intersection;
   * open_url (Task 7) pushes new entries via the writer below.
   */
  pinnedTabs?: ReadonlyArray<{ tabId: number; origin: string }>;
  /**
   * v1.5 — write-side hook for tools that mutate pinnedTabs (open_url).
   * Loop installs this; tools that don't write the array (most) ignore it.
   * Tests pass undefined and the tools handle it gracefully.
   *
   * NOTE: Task 7 (open_url) may want to batch writes rather than issuing
   * a full setSessionMeta per pin append — acceptable for scaffold; optimize
   * in Task 7 if needed.
   *
   * WARNING: SessionMeta has TWO writers — SW (this writer +
   * clearTaskPinAtSessionEnd) and panel (useSession.ts first-message pin
   * patch around lines 805-840). The RMW pattern here is safe within a
   * single SW step (sequential dispatch) but NOT cross-tier-safe. Task 7's
   * open_url should NOT assume mutually-exclusive access to SessionMeta
   * with the panel.
   */
  appendPinnedTab?: (pin: { tabId: number; origin: string }) => Promise<void>;
  /**
   * v1.5 — write-side hook for focus_tab (Task 6). Updates
   * SessionAgentState.currentFocusTabId; the new focus takes effect on the
   * NEXT iteration's snapshot.
   */
  setCurrentFocusTabId?: (tabId: number) => Promise<void>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
  handler: (args: unknown, ctx: ToolHandlerContext) => Promise<ActionResult>;
}
