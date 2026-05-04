// src/lib/agent/image-hydration.ts
import { addImage, getImageById } from "@/background/image-cache";
import type { ChatMessage } from "@/lib/model-router";
import type { ImageRef } from "@/lib/images";

/**
 * Walks user messages, writes ImageAttachment bytes into the per-session
 * cache, and re-inflates ImagePlaceholder entries when the cache still has
 * the corresponding bytes (R11 cross-turn persistence + R12 cache-miss
 * placeholder fallthrough).
 *
 * Returns:
 *   - `messages` (new array; modified messages are shallow-cloned) where placeholders that hit the cache are
 *     promoted back to ImageAttachment with bytes
 *   - `hasImageContent` true if at least one image (cached or fresh) is
 *     present after hydration — drives R14 fail-on-image precondition.
 *
 * Pure helper: `addImage` / `getImageById` are the cache module's I/O;
 * tests stub them via `vi.mock("@/background/image-cache")`.
 */
export function hydrateAttachments(
  sessionId: string,
  messages: ChatMessage[],
): { messages: ChatMessage[]; hasImageContent: boolean } {
  let hasImageContent = false;
  const out = messages.map((m, idx): ChatMessage => {
    if (m.role !== "user" || !m.attachments?.length) return m;
    const userTurnId = `turn_${idx}`;
    const attachments = m.attachments.map((a) => {
      if (a.kind === "image") {
        const ref: ImageRef = {
          id: a.id,
          userTurnId,
          mediaType: a.mediaType,
          data: a.data,
          width: a.width,
          height: a.height,
          byteLength: a.byteLength,
          addedAt: Date.now(),
        };
        addImage(sessionId, ref);
        hasImageContent = true;
        return a;
      }
      // image_placeholder — try cache hydration
      const cached = getImageById(sessionId, a.id);
      if (cached) {
        hasImageContent = true;
        return {
          kind: "image" as const,
          id: a.id,
          mediaType: cached.mediaType,
          data: cached.data,
          width: cached.width,
          height: cached.height,
          byteLength: cached.byteLength,
        };
      }
      return a;
    });
    return { ...m, attachments };
  });
  return { messages: out, hasImageContent };
}
