import type { AgentMessage, ContentBlock } from "../model-router/types";

/**
 * Issue #61(c) — stale-snapshot elision. The agent always acts on the
 * CURRENT page; historical DOM snapshots are dead weight in context. This
 * pure, deterministic transform runs in the wire-time pipeline (on the
 * windowed COPY only — at-rest agentMessages stay RAW per R28 v2) and
 * replaces the bulky interactive-element list of every observation EXCEPT
 * the most recent with a short marker, keeping the cheap semantic header
 * (url / title / headings / alerts / status).
 *
 * tool_result blocks are preserved untouched (they must stay paired with
 * their tool_use ids — Anthropic requirement).
 */

/** Marker that replaces an elided observation's frame/element blocks. */
export const STALE_OBSERVATION_MARKER =
  "[Interactive elements from this earlier page snapshot were omitted to save context. " +
  "Only the most recent snapshot is shown in full. If you still need details from this " +
  "page, re-read it (e.g. get_tab_content) or rely on notes you kept in your reasoning.]";

/**
 * Literal that begins every per-frame block emitted by `renderFrameBlock`
 * in prompt.ts. Splitting an observation's text at the FIRST occurrence
 * separates the cheap semantic header from the bulky element listing (and
 * any trailing <reflections> tail (added by #61(b)), which is re-appended
 * fresh to the newest observation each round anyway).
 */
const FRAME_BLOCK_MARKER = "<untrusted_page_content";

function elideText(text: string): string | null {
  const frameStart = text.indexOf(FRAME_BLOCK_MARKER);
  if (frameStart === -1) return null; // not an observation-with-frames; leave as-is
  const header = text.slice(0, frameStart).trimEnd();
  return `${header}\n\n${STALE_OBSERVATION_MARKER}`;
}

export function elideStaleObservations(messages: AgentMessage[]): AgentMessage[] {
  // The most-recent user turn carries the current observation — never elide it.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  return messages.map((msg, idx) => {
    if (idx === lastUserIdx) return msg;
    if (msg.role !== "user") return msg;
    if (typeof msg.content === "string") return msg;
    const blocks = msg.content as ContentBlock[];

    // The observation is the LAST text block in the user turn.
    let lastTextIdx = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].type === "text") {
        lastTextIdx = i;
        break;
      }
    }
    if (lastTextIdx === -1) return msg;

    const textBlock = blocks[lastTextIdx] as Extract<ContentBlock, { type: "text" }>;
    const elided = elideText(textBlock.text);
    if (elided === null) return msg;

    const newBlocks = blocks.slice();
    newBlocks[lastTextIdx] = { type: "text", text: elided };
    return { ...msg, content: newBlocks };
  });
}
