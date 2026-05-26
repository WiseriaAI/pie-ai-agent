import type { PendingInstruction } from "@/lib/sessions/types";
import { escapeUntrustedWrappers } from "./untrusted-wrappers";
import type { AgentMessage, ChatMessage } from "@/lib/model-router";

/**
 * Issue #34 — build the merged user-message that gets injected at the top of
 * the next ReAct iteration when the pending queue is non-empty.
 *
 * - Wraps content in <untrusted_user_message source="mid_task"> (NEVER system).
 * - Escapes embedded untrusted-wrapper tags in user text (prompt-injection
 *   defense; sibling of the normal user-message path).
 * - Prefers expandedForLLM (slash-expanded skills) over raw content, matching
 *   the sendMessage pipeline.
 * - Numbered list preserves user-visible order; double newline keeps each
 *   instruction readable as a distinct paragraph.
 *
 * Returns null for empty input so callers can skip the push.
 */
export function buildMidTaskUserMessage(
  pending: PendingInstruction[],
): AgentMessage | null {
  if (pending.length === 0) return null;
  const merged = pending
    .map((p, i) => {
      const text = p.expandedForLLM ?? p.content;
      return `${i + 1}. ${escapeUntrustedWrappers(text)}`;
    })
    .join("\n\n");
  return {
    role: "user",
    content: `<untrusted_user_message source="mid_task">\n${merged}\n</untrusted_user_message>`,
  };
}

/**
 * Issue #34 — merge post-abort pending instructions into the last user
 * message of a new chat-start payload. Uses [Earlier mid-task additions]
 * marker so the LLM can distinguish the new task from the carried-over
 * pending. If the last message is not a user string, returns messages
 * unchanged (caller is expected to log).
 */
export function mergeCarryoverIntoMessages(
  messages: ChatMessage[],
  carryover: PendingInstruction[],
): ChatMessage[] {
  if (carryover.length === 0) return messages;
  const lastIdx = messages.length - 1;
  const last = messages[lastIdx];
  if (!last || last.role !== "user" || typeof last.content !== "string") {
    return messages;
  }
  const merged = carryover
    .map((p, i) => `${i + 1}. ${escapeUntrustedWrappers(p.expandedForLLM ?? p.content)}`)
    .join("\n\n");
  return [
    ...messages.slice(0, lastIdx),
    {
      ...last,
      content: `${last.content}\n\n[Earlier mid-task additions]\n${merged}`,
    },
  ];
}
