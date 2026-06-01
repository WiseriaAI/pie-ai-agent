import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { streamChatAnthropicSdk } from "./_shared/anthropic-sdk-core";

// Native Anthropic on the official @anthropic-ai/sdk: x-api-key auth, standard
// `/v1/messages`, prompt caching on.
export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  yield* streamChatAnthropicSdk(config, messages, signal, tools, {
    auth: "apiKey",
    promptCache: true,
  });
}
