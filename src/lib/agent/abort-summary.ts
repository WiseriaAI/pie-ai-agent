import type { DetachReason } from "../../background/cdp-session";

/**
 * Structured summary for the agent-loop abort path (issue #354).
 *
 * The abort summary is persisted into session history, so translating it in the
 * service worker would freeze the language at abort time. Instead we ship a
 * stable i18n `summaryKey` on the wire; the panel resolves it with `t()` at
 * render time so it follows later UI-language switches. The `summary` string is
 * an English fallback carried for non-UI consumers (headless transcript,
 * eval-bridge) and for panels that lack the key (old persisted messages).
 */
export interface AbortSummary {
  /** i18n dict key (`agentSummary.abort.*`) the panel resolves at render time. */
  summaryKey: string;
  /** English fallback string — shown when no key-aware renderer is available. */
  summary: string;
}

/**
 * Maps a CDP detach reason to the abort summary shown after a task is stopped.
 * `null` / any reason without a dedicated message falls back to the generic
 * "task stopped" case (this covers ordinary user Stop).
 */
export function abortSummaryForReason(
  reason: DetachReason | null,
): AbortSummary {
  switch (reason) {
    case "user-cancelled-via-yellow-bar":
      return {
        summaryKey: "agentSummary.abort.userCancelledDebug",
        summary: "You cancelled the debugging authorization.",
      };
    case "kill-switch":
      return {
        summaryKey: "agentSummary.abort.keyboardDisabled",
        summary: "Keyboard simulation was turned off in Settings.",
      };
    case "tab-closed":
      return {
        summaryKey: "agentSummary.abort.tabClosed",
        summary: "The tab was closed.",
      };
    default:
      return {
        summaryKey: "agentSummary.abort.stopped",
        summary: "Task stopped.",
      };
  }
}
