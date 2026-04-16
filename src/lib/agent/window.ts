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
 * Always preserved:
 *   messages[0] — system prompt
 *   messages[1] — initial user task
 *
 * The rest is scanned for (assistant tool_use + user tool_result) pairs.
 * Only the most recent `maxSteps` pairs are kept, plus any trailing messages
 * after the last complete pair (e.g. a pending page observation).
 */
export function applySlidingWindow(
  messages: AgentMessage[],
  maxSteps: number = 12,
): AgentMessage[] {
  // Not enough to window yet
  if (messages.length <= 2) return messages;

  const preserved = messages.slice(0, 2); // [system, initial-user-task]
  const rest = messages.slice(2);

  // Identify (assistant tool_use + user tool_result) pair start indices in `rest`
  const pairStarts: number[] = [];

  let i = 0;
  while (i < rest.length - 1) {
    if (isAssistantToolUseTurn(rest[i]) && isUserToolResultTurn(rest[i + 1])) {
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

  // rest.slice(earliestIdx) includes the kept pairs AND any trailing messages
  return [...preserved, ...rest.slice(earliestIdx)];
}
