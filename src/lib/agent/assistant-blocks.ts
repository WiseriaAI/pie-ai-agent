import type { ContentBlock } from "@/lib/model-router/types";

export type ThinkingContentBlock = Extract<ContentBlock, { type: "thinking" }>;
export interface CompletedToolCall { id: string; name: string; args: unknown; }

/** assistant 轮次内容块组装：thinking（前插，Anthropic 要求） → text → tool_use。 */
export function assembleAssistantBlocks(
  thinkingBlocks: ThinkingContentBlock[],
  text: string,
  toolCalls: CompletedToolCall[],
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const tb of thinkingBlocks) blocks.push(tb);
  if (text) blocks.push({ type: "text", text });
  for (const tc of toolCalls) {
    blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
  }
  return blocks;
}
