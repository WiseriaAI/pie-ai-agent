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
import { resolveModelMeta } from "../model-router/providers/registry";
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
 * Phase 5 HARD GATE — image blocks must NOT be JSON.stringified into the
 * extracted text (a 2 MB base64 image inflates by ~3 M chars). Image
 * surcharge is added separately via `estimateImageSurchargeForMessage`.
 *
 * Block-by-block extraction:
 *   - text → push the text
 *   - tool_use → JSON.stringify(input) (tool args contribute)
 *   - tool_result → push the content
 *   - image → SKIP (surcharge counted elsewhere)
 */
function extractText(msg: AgentMessage): string {
  if (typeof msg.content === "string") return msg.content;
  const parts: string[] = [];
  for (const b of msg.content as ContentBlock[]) {
    if (b.type === "image") continue;
    if (b.type === "text") parts.push(b.text);
    else if (b.type === "thinking") parts.push(b.thinking);
    else if (b.type === "tool_use") parts.push(JSON.stringify(b.input));
    else if (b.type === "tool_result") parts.push(b.content);
  }
  return parts.join("");
}

function countImages(msg: AgentMessage): number {
  if (typeof msg.content === "string") return 0;
  let n = 0;
  for (const b of msg.content as ContentBlock[]) if (b.type === "image") n++;
  return n;
}

/**
 * Per-provider image surcharge. Brainstorm note:
 *   - Anthropic ~1568 tokens per image (Claude vision tier high)
 *   - OpenAI detail-high ~765 tokens (default tier)
 *   - OpenRouter inherits OpenAI default
 *   - others (non-vision providers) — no images should ever reach here in v1, but conservatism: 0
 */
function estimateImageSurchargeForMessage(msg: AgentMessage, provider: string): number {
  const n = countImages(msg);
  if (n === 0) return 0;
  if (provider === "anthropic") return n * 1568;
  if (provider === "openai" || provider === "openrouter") return n * 765;
  return 0;
}

/**
 * Estimate the token count for an array of messages.
 *
 * CJK detection is computed over the *entire* combined text so that mixed
 * conversations get a single consistent divisor per call.
 *
 * @param messages — full message history
 * @param provider — optional provider id for vision surcharge accounting.
 *                   When omitted, image blocks are skipped from text count
 *                   but contribute 0 surcharge tokens (legacy callers).
 */
export function estimateTokens(messages: AgentMessage[], provider?: string): number {
  const combined = messages.map(extractText).join("");
  const totalChars = combined.length;
  let textTokens = 0;
  if (totalChars > 0) {
    const cjkMatches = combined.match(CJK_REGEX);
    const cjkChars = cjkMatches ? cjkMatches.length : 0;
    const cjkRatio = cjkChars / totalChars;
    const divisor = cjkRatio > 0.5 ? 1.5 : 4;
    textTokens = Math.ceil(totalChars / divisor);
  }
  const imageTokens = provider
    ? messages.reduce((s, m) => s + estimateImageSurchargeForMessage(m, provider), 0)
    : 0;
  return textTokens + imageTokens;
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
 * @param provider  Provider ID string, used together with `model` to look up
 *                  the per-model context window.
 * @param model     Provider-native model id. Required because `maxContextTokens`
 *                  lives on `ModelMeta`, not `ProviderMeta` (issue #76).
 *                  Unknown ids (e.g. lazily-fetched OpenRouter models) fall
 *                  back to {@link FALLBACK_MAX_CONTEXT_TOKENS}.
 */
export async function applyTokenBudget(
  messages: AgentMessage[],
  provider: string,
  model: string,
): Promise<AgentMessage[]> {
  // Resolve per-model context window limit (issue #76).
  const meta = await resolveModelMeta(provider, model);
  const maxContextTokens = meta?.maxContextTokens ?? FALLBACK_MAX_CONTEXT_TOKENS;
  const threshold = maxContextTokens * 0.8;

  // Fast path — within budget.
  if (estimateTokens(messages, provider) <= threshold) return messages;

  // Find the react segment start (first assistant ContentBlock[] turn).
  const reactStartIdx = findReactStartIdx(messages);

  // head is everything before the react segment (or all messages if no react).
  const headEnd = reactStartIdx === -1 ? messages.length : reactStartIdx;

  // Work on a mutable copy.
  let result = [...messages];

  // Drop loop: remove oldest droppable (user, assistant) pair from head.
  while (estimateTokens(result, provider) > threshold) {
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
          `estimatedTokens=${estimateTokens(result, provider)} threshold=${threshold}`,
      );
      break;
    }
  }

  return result;
}
