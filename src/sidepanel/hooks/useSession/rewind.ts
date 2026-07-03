import type { DisplayMessage, Quote } from "@/types";
import type { FileAttachment } from "@/lib/files/types";
import type { SessionAgentState } from "@/lib/sessions/types";

/** A user DisplayMessage — the only kind a rewind can target. */
type UserMsg = Extract<DisplayMessage, { role: "user" }>;

/**
 * Issue #245 — the SendMessageInput subset a rewind resend produces. Images
 * (`attachments`) are intentionally absent: their bytes are never persisted
 * (R10 scrubber) so a historical turn cannot replay them.
 */
export interface RewindResendInput {
  content: string;
  expandedForLLM?: string;
  quotes?: Quote[];
  fileAttachments?: FileAttachment[];
}

/**
 * Build the `SendMessageInput` for a rewind resend.
 *
 * - **edit mode** (`editedContent` provided): send the new text. Carry the
 *   structured `quotes` / `fileAttachments` so the re-rendered bubble keeps its
 *   chips, but DROP `expandedForLLM` — it is the slash-expansion of the *old*
 *   text and is now stale (the edited plain text is sent to the LLM verbatim).
 * - **resend-as-is** (`editedContent` undefined): replay the original `content`
 *   and `expandedForLLM` verbatim so a slash-command turn re-expands identically.
 *
 * `attachments` (images) are never carried — see {@link RewindResendInput}.
 */
export function buildRewindInput(
  msg: UserMsg,
  editedContent?: string,
): RewindResendInput {
  const out: RewindResendInput = {
    content: editedContent !== undefined ? editedContent : msg.content,
  };
  // Only replay the LLM-facing slash expansion when NOT editing: an edit
  // changes the raw text, so the old expansion no longer corresponds to it.
  if (editedContent === undefined && msg.expandedForLLM !== undefined) {
    out.expandedForLLM = msg.expandedForLLM;
  }
  if (msg.quotes?.length) out.quotes = msg.quotes;
  if (msg.fileAttachments?.length) out.fileAttachments = msg.fileAttachments;
  return out;
}

/**
 * A fresh "no in-flight task" agent-state tombstone.
 *
 * Mirrors `buildSessionAgentTombstone` (loop.ts) but re-declared here so the
 * panel bundle stays free of the SW-only agent-loop dependency graph. Writing
 * this over the session's agent record at rewind time stops the next
 * chat-start from resurrecting the discarded branch via either the abort-resume
 * seed (`planAbortResumeSeed`, which replays preserved raw `agentMessages`) or
 * the `lastTaskSynth` synth-bridge (which injects a summary of prior tasks).
 */
export function buildRewindAgentTombstone(): SessionAgentState {
  return {
    agentMessages: [],
    pendingInstructions: [],
    stepIndex: 0,
    hasImageContent: false,
  };
}
