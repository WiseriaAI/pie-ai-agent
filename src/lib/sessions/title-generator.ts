/**
 * M2-U3: LLM async title generation + R29 sanitize wrapper.
 *
 * R29 invariant — prompt-injection defense for title generation:
 *  - Input (user's first message) is wrapped in <untrusted_user_message> tags.
 *  - escapeUntrustedWrappers is called on the input BEFORE wrapping so
 *    closing-tag injection attempts cannot break out of the wrapper.
 *  - Output from LLM is also passed through escapeUntrustedWrappers +
 *    emoji strip + 30-char truncation before being stored.
 *  - "untrusted_user_message" is registered in both:
 *      UNTRUSTED_WRAPPER_TAGS (untrusted-wrappers.ts)  ← escape helper
 *      sanitizeText inline replace chain (snapshot.ts)  ← executeScript path
 *    This dual-list coherence is enforced by untrusted-wrappers.test.ts.
 */

import { escapeUntrustedWrappers } from "@/lib/agent/untrusted-wrappers";
import { updateSessionMeta } from "./storage";

/**
 * Emoji Unicode range strip regex.
 * Covers:
 *  U+2300–U+27BF  Misc Technical / Symbols / Dingbats (includes ✨ U+2728)
 *  U+1F300–U+1FAFF  Main emoji blocks (faces, objects, flags, etc.)
 */
const EMOJI_RE = /[\u{2300}-\u{27BF}\u{1F300}-\u{1FAFF}]/gu;

/**
 * Dependency-injected chat function type.
 * Caller wraps the actual model-router.chat() to extract .content:
 *   callChat = (msgs) => chat(modelConfig, msgs).then(r => r.content)
 *
 * Using DI makes the function fully unit-testable without mocking imports.
 */
export type CallChat = (
  msgs: Array<{ role: "system" | "user" | "assistant"; content: string }>,
) => Promise<string>;

/**
 * Generates a short LLM title (5-10 chars Chinese) for a session.
 *
 * @param firstMessage - The user's first message (raw, untrusted).
 * @param callChat     - DI: injected function to call the LLM.
 * @returns Sanitized title string (≤ 30 chars, no emoji, no wrapper tags).
 * @throws if LLM fails or returns empty/whitespace (caller should fallback
 *         to deriveTitleFromMessages result already in storage).
 */
export async function generateTitle(
  firstMessage: string,
  callChat: CallChat,
): Promise<string> {
  // Escape any wrapper-tag injection in the user's message before wrapping.
  const escapedInput = escapeUntrustedWrappers(firstMessage);

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    {
      role: "system",
      content:
        "你是会话标题生成器。输入是用户消息，输出 5-10 字中文短标题，不带标点。只输出标题本身，不要有任何其他内容。",
    },
    {
      role: "user",
      content: `<untrusted_user_message>${escapedInput}</untrusted_user_message>`,
    },
  ];

  const raw = await callChat(messages);

  // Sanitize LLM output:
  // 1. Escape any wrapper tags in the output (defensive — LLM may hallucinate tags)
  const escaped = escapeUntrustedWrappers(raw);
  // 2. Strip emoji
  const noEmoji = escaped.replace(EMOJI_RE, "");
  // 3. Truncate to max 30 chars
  const truncated = noEmoji.slice(0, 30);
  // 4. Trim whitespace
  const result = truncated.trim();

  if (!result) {
    throw new Error("generateTitle: LLM returned empty or whitespace-only title");
  }

  return result;
}

/**
 * Race-guard: atomically upgrades the session title only if it still matches
 * the expected fallback string. Protects against user manually changing the
 * title between LLM fire and LLM return.
 *
 * @param sessionId       - The session to update.
 * @param expectedFallback - The fallback string computed at chat-start time.
 * @param newTitle         - The LLM-generated title to write.
 * @returns true if the title was upgraded, false if the guard blocked it.
 */
export async function maybeUpgradeFallbackTitle(
  sessionId: string,
  expectedFallback: string,
  newTitle: string,
): Promise<boolean> {
  // Single-transaction conditional patch: the guard check and the write happen
  // atomically, and the LLM-latency-stale snapshot can no longer clobber
  // fields written meanwhile (e.g. the chat-start task pin).
  return updateSessionMeta(sessionId, (current) => {
    if (current.title !== expectedFallback) return null;
    return { ...current, title: newTitle };
  });
}
