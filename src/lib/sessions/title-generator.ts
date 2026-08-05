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
import { LANGUAGE_LABELS, titleLengthHint, titleMaxLen } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";
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
 * Generates a short LLM title for a session in the target language.
 *
 * Issue #343 — the title language now follows `targetLang` instead of being
 * hard-coded to Chinese. The length hint and post-sanitize truncation cap are
 * locale-aware (CJK: 5-10 字 / 30-char cap; Latin: 3-6 words / 48-char cap).
 * The R29 sanitize chain (escape in/out + emoji strip + truncation) is
 * unchanged — only the prompt copy and the length parameters vary by locale.
 *
 * @param firstMessage - The user's first message (raw, untrusted).
 * @param callChat     - DI: injected function to call the LLM.
 * @param targetLang   - Locale the title should be written in.
 * @returns Sanitized title string (≤ locale cap, no emoji, no wrapper tags).
 * @throws if LLM fails or returns empty/whitespace (caller should fallback
 *         to deriveTitleFromMessages result already in storage).
 */
export async function generateTitle(
  firstMessage: string,
  callChat: CallChat,
  targetLang: Locale,
): Promise<string> {
  // Escape any wrapper-tag injection in the user's message before wrapping.
  const escapedInput = escapeUntrustedWrappers(firstMessage);

  const languageLabel = LANGUAGE_LABELS[targetLang];
  const lengthHint = titleLengthHint(targetLang);
  const systemPrompt =
    `You are a session title generator. The input is a user message. ` +
    `Output a concise title written in ${languageLabel}, ${lengthHint}, ` +
    `with no punctuation. Output only the title itself, nothing else.`;

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    {
      role: "system",
      content: systemPrompt,
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
  // 3. Truncate to the locale-aware cap (CJK 30 / Latin 48)
  const truncated = noEmoji.slice(0, titleMaxLen(targetLang));
  // 4. Trim whitespace
  const result = truncated.trim();

  if (!result) {
    throw new Error("generateTitle: LLM returned empty or whitespace-only title");
  }

  return result;
}

/**
 * Issue #353 — resolves the "expected fallback" sentinel used by the title
 * race-guard, preferring the panel-computed value carried on the chat-start
 * payload over a disk read.
 *
 * Background: the fallback title (deriveTitleFromMessages of the first user
 * message) is the sentinel that maybeUpgradeFallbackTitle compares against
 * before letting the LLM title overwrite it. The SW used to read this sentinel
 * back from disk via getSessionMeta. But the panel writes it with a
 * fire-and-forget IDB write that is NOT guaranteed to land before the SW
 * receives chat-start, so the disk read frequently returned undefined and the
 * whole title-generation branch was silently skipped (~30-50% miss under load).
 *
 * The panel now computes the fallback with the SAME deriveTitleFromMessages
 * over the SAME `updated` message array it persists, and ships the string on
 * the chat-start payload. When present we use it directly — no disk dependency,
 * no race. The `readDiskSentinel` fallback is only invoked when the payload
 * value is missing/empty (older panel builds), preserving backward compat.
 *
 * @param payloadFallback   - Fallback title carried on the chat-start message.
 * @param readDiskSentinel  - Lazy disk read; only called when payload is empty.
 * @returns The sentinel string, or undefined when neither source has one.
 */
export async function resolveTitleSentinel(
  payloadFallback: string | undefined,
  readDiskSentinel: () => Promise<string | undefined>,
): Promise<string | undefined> {
  if (payloadFallback !== undefined && payloadFallback !== "") {
    return payloadFallback;
  }
  return readDiskSentinel();
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
