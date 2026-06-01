import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { streamChatAnthropicSdk } from "./_shared/anthropic-sdk-core";

// MiniMax's Anthropic-compatible API: base `https://api.minimaxi.com/anthropic`,
// x-api-key auth. M3 supports image input; M2.x is text-only (#91 / #92).
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
