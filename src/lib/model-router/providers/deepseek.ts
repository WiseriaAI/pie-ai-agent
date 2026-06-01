import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { streamChatAnthropicSdk } from "./_shared/anthropic-sdk-core";

// DeepSeek's Anthropic-compatible API: base `https://api.deepseek.com/anthropic`,
// x-api-key auth, anthropic-version ignored, cache_control ignored (#91).
export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  yield* streamChatAnthropicSdk(config, messages, signal, tools, {
    baseUrlSuffix: "/anthropic",
    auth: "apiKey",
  });
}
