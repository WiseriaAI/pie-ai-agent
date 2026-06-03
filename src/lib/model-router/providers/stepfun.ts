import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { streamChatAnthropicSdk } from "./_shared/anthropic-sdk-core";

// StepFun (阶跃星辰) speaks the Anthropic wire at `https://api.stepfun.com/v1/messages`
// with Bearer auth (`Authorization: Bearer <key>`). Unlike MiMo / MiniMax / DeepSeek
// the endpoint sits directly under `/v1/messages`, so there is no baseUrlSuffix.
// The docs list only confirmed fields and never mention `anthropic-version`, so we
// strip the SDK's default version header (same minimal-surface stance as MiMo).
export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  yield* streamChatAnthropicSdk(config, messages, signal, tools, {
    auth: "bearer",
    stripAnthropicVersion: true,
  });
}
