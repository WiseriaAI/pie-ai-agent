import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { streamChatOpenAICompat } from "./_shared/openai-compat-core";

// Moonshot AI (Kimi) speaks the OpenAI Chat Completions wire: Bearer auth,
// POST /v1/chat/completions, SSE streaming. No hooks needed — the core's
// default `Authorization: Bearer ${apiKey}` already matches Moonshot.
//
// Both the international (api.moonshot.ai) and China (api.moonshot.cn) endpoints
// share this module; the region is selected by which registry entry
// (moonshot / moonshot-cn) the instance was created under, which sets
// config.baseUrl before this runs.
export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  yield* streamChatOpenAICompat(config, messages, signal, tools);
}
