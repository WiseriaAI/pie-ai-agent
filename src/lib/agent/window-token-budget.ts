/**
 * U5 — Token budget guard for multi-turn conversation context.
 *
 * Estimates the token count of the message history using char-count with a
 * CJK-aware divisor, then drops the oldest (user, assistant) pairs from the
 * chat-prefix segment (head) when the estimate exceeds 80% of the provider's
 * context window.
 *
 * Key decisions (D5 in the plan):
 *   - No tokenizer dependency: char-count only.
 *   - CJK detector: if >50% of chars are CJK (Chinese/Japanese/Korean), use
 *     divisor 1.5 (≈ 1 token per 1.5 chars); otherwise use 4 (English BPE).
 *   - Drop order: oldest user-assistant pair in the head segment first.
 *   - Never drop: system message (messages[0]) or the trailing user turn.
 *   - Never drop: the react segment (sliding window already handles that).
 *   - Oversize single user message: log warn but return as-is.
 */

import type { AgentMessage, ContentBlock } from "../model-router/types";
import { getProviderMeta } from "../model-router/providers/registry";
import type { Provider } from "../model-router";
import { findReactStartIdx } from "./window";

/** Fallback context window when provider metadata is missing. */
const FALLBACK_MAX_CONTEXT_TOKENS = 32_000;

/**
 * CJK Unicode ranges covered:
 *   U+4E00–U+9FFF  CJK Unified Ideographs (一–鿿)
 *   U+3040–U+30FF  Hiragana / Katakana (぀–ヿ)
 *   U+3400–U+4DBF  CJK Extension A (㐀–䶿)
 *   U+AC00–U+D7AF  Hangul Syllables (가–힯)
 */
const CJK_REGEX = /[一-鿿぀-ヿ㐀-䶿가-힯]/g;

/**
 * Extract the total text content from a message for token estimation.
 * Strings are taken as-is; ContentBlock[] are JSON-stringified so that
 * embedded text/args are counted (though JSON overhead slightly inflates
 * the estimate — acceptable conservatism).
 */
function extractText(msg: AgentMessage): string {
  if (typeof msg.content === "string") return msg.content;
  return JSON.stringify(msg.content as ContentBlock[]);
}

/**
 * Estimate the token count for an array of messages.
 *
 * CJK detection is computed over the *entire* combined text so that mixed
 * conversations get a single consistent divisor per call.
 */
export function estimateTokens(messages: AgentMessage[]): number {
  const combined = messages.map(extractText).join("");
  const totalChars = combined.length;

  if (totalChars === 0) return 0;

  const cjkMatches = combined.match(CJK_REGEX);
  const cjkChars = cjkMatches ? cjkMatches.length : 0;
  const cjkRatio = cjkChars / totalChars;

  // Strict > 0.5 — exactly 50% stays on the English divisor (4).
  const divisor = cjkRatio > 0.5 ? 1.5 : 4;

  return Math.ceil(totalChars / divisor);
}

/**
 * Applies the token-budget guard to a message history.
 *
 * The algorithm:
 *  1. Resolve the provider's maxContextTokens (fallback 32k).
 *  2. Estimate tokens for the whole history.
 *  3. If within 80% threshold, return unchanged.
 *  4. Otherwise, identify the "head" segment (messages before the first
 *     assistant ContentBlock[] turn — the react start).
 *  5. Drop the oldest (user, assistant) pair from within the head that is
 *     NOT messages[0] (system) and NOT the trailing user message.
 *  6. Repeat until under threshold or no more pairs to drop.
 *  7. If still over threshold because a single user message alone is too
 *     big, emit a console.warn and return as-is (let provider truncate).
 *
 * @param messages  Full message history (output of applySlidingWindow).
 * @param provider  Provider ID string, used to look up maxContextTokens.
 */
export function applyTokenBudget(
  messages: AgentMessage[],
  provider: string,
): AgentMessage[] {
  // Resolve context window limit.
  const meta = getProviderMeta(provider as Provider);
  const maxContextTokens = meta?.maxContextTokens ?? FALLBACK_MAX_CONTEXT_TOKENS;
  const threshold = maxContextTokens * 0.8;

  // Fast path — within budget.
  if (estimateTokens(messages) <= threshold) return messages;

  // Find the react segment start (first assistant ContentBlock[] turn).
  const reactStartIdx = findReactStartIdx(messages);

  // head is everything before the react segment (or all messages if no react).
  const headEnd = reactStartIdx === -1 ? messages.length : reactStartIdx;

  // Work on a mutable copy.
  let result = [...messages];

  // Drop loop: remove oldest droppable (user, assistant) pair from head.
  while (estimateTokens(result) > threshold) {
    const currentHeadEnd = reactStartIdx === -1 ? result.length : findReactStartIdx(result);

    // Find the first droppable pair inside the head.
    // Constraints:
    //   - Never drop index 0 (system / first message).
    //   - Never drop the last message in the full array (current user turn).
    //   - Only drop a consecutive (user at i, assistant at i+1) pair where
    //     both indices are within [1, currentHeadEnd - 1] (i+1 must be < currentHeadEnd)
    //     and i+1 !== result.length - 1 (don't drop the trailing user turn's assistant).
    //
    // We also want to avoid dropping the very last user in the head since that
    // is the "current user task" that must not be removed.
    let dropped = false;
    for (let i = 1; i < currentHeadEnd - 1; i++) {
      const msg = result[i];
      const next = result[i + 1];
      // Pair must be user → assistant and not overlap into the last message.
      if (
        msg.role === "user" &&
        next.role === "assistant" &&
        i + 1 < result.length - 1 &&
        i + 1 < currentHeadEnd
      ) {
        // Drop both messages in-place.
        result.splice(i, 2);
        dropped = true;
        break;
      }
    }

    if (!dropped) {
      // No more droppable pairs. If still over budget, the history is
      // dominated by a single over-size message — warn and return as-is.
      console.warn(
        "[window-token-budget] Cannot reduce token count further: " +
          "no droppable user-assistant pairs remain in the head segment. " +
          `estimatedTokens=${estimateTokens(result)} threshold=${threshold}`,
      );
      break;
    }
  }

  return result;
}
