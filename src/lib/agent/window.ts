import type { AgentMessage, ContentBlock } from "../model-router/types";

/**
 * Returns true if a message is an assistant message that contains at least
 * one tool_use block (indicating a ReAct tool-calling turn).
 */
function isAssistantToolUseTurn(msg: AgentMessage): boolean {
  if (msg.role !== "assistant") return false;
  if (typeof msg.content === "string") return false;
  return (msg.content as ContentBlock[]).some((b) => b.type === "tool_use");
}

/**
 * Returns true if a message is a user message that contains at least one
 * tool_result block (the corresponding reply to a tool_use turn).
 */
function isUserToolResultTurn(msg: AgentMessage): boolean {
  if (msg.role !== "user") return false;
  if (typeof msg.content === "string") return false;
  return (msg.content as ContentBlock[]).some((b) => b.type === "tool_result");
}

/**
 * Applies a sliding window to the agent message history.
 *
 * The history is split into two segments:
 *
 *   head  — everything before the first assistant message with ContentBlock[]
 *           content (i.e. the ReAct loop start). In multi-turn conversations
 *           this includes the system prompt, prior chat turns, and the current
 *           user task. The head is always preserved in full.
 *
 *   react — from the first assistant tool_use turn onward. Only the most
 *           recent `maxSteps` (assistant tool_use + user tool_result) pairs
 *           are kept, plus any trailing messages after the last complete pair.
 *
 * When no assistant ContentBlock[] turn exists (e.g. pure-chat history with
 * no in-flight ReAct pairs) the entire messages array is the head and is
 * returned unchanged.
 *
 * Invariants:
 *   - head末尾永远是 user role (panel sendMessage puts user last on wire;
 *     ReAct start must be assistant tool_use so the join is always alternating)
 *   - output messages have no adjacent user-user or assistant-assistant
 *     (system runs are allowed)
 */
/**
 * Returns the index of the first assistant message whose content is a
 * ContentBlock[] array — i.e. the ReAct loop start. Returns -1 if none.
 *
 * Extracted so window-token-budget.ts and applySlidingWindow share a
 * single predicate; future IR shape changes only require one edit site.
 */
export function findReactStartIdx(messages: AgentMessage[]): number {
  return messages.findIndex(
    (m) => m.role === "assistant" && Array.isArray(m.content),
  );
}

export function applySlidingWindow(
  messages: AgentMessage[],
  maxSteps: number = 12,
): AgentMessage[] {
  // Find the first assistant message whose content is a ContentBlock[] array —
  // this is the ReAct loop start index.
  const reactStartIdx = findReactStartIdx(messages);

  // No ReAct segment — the whole history is chat prefix; return as-is.
  if (reactStartIdx === -1) return messages;

  const head = messages.slice(0, reactStartIdx);
  const react = messages.slice(reactStartIdx);

  // Not enough react messages to need windowing
  if (react.length === 0) return messages;

  // Identify (assistant tool_use + user tool_result) pair start indices in `react`
  const pairStarts: number[] = [];

  let i = 0;
  while (i < react.length - 1) {
    if (isAssistantToolUseTurn(react[i]) && isUserToolResultTurn(react[i + 1])) {
      pairStarts.push(i);
      i += 2;
    } else {
      i++;
    }
  }

  if (pairStarts.length === 0) {
    // No complete pairs yet — return everything
    return messages;
  }

  // Keep only the most recent maxSteps pairs
  const keptPairStarts = pairStarts.slice(-maxSteps);
  const earliestIdx = keptPairStarts[0];

  // react.slice(earliestIdx) includes the kept pairs AND any trailing messages
  return [...head, ...react.slice(earliestIdx)];
}
