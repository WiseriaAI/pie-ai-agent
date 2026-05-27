import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { streamChatAnthropicCompat } from "./_shared/anthropic-compat-core";

export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  yield* streamChatAnthropicCompat(config, messages, signal, tools, { promptCache: true });
}

// Preserve test-only re-exports for anthropic.test.ts (imports via ./anthropic)
export { _toWireMessagesForTest, _buildRequestBodyForTest } from "./_shared/anthropic-compat-core";
