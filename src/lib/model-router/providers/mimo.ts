import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { streamChatAnthropicSdk } from "./_shared/anthropic-sdk-core";

// MiMo (小米) speaks the Anthropic wire at `/anthropic/v1/messages` with Bearer
// auth. It rides the official-SDK transport (#91 canary). Wire stays byte-identical
// to the previous hand-rolled path: Bearer auth, no anthropic-version, no prompt cache.
export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  yield* streamChatAnthropicSdk(config, messages, signal, tools, {
    baseUrlSuffix: "/anthropic",
    auth: "bearer",
    stripAnthropicVersion: true,
  });
}
