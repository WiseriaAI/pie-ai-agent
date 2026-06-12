import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { streamChatOpenAICompat } from "./_shared/openai-compat-core";

// 官方托管网关是标准 OpenAI 兼容端点（LiteLLM）。virtual key 走默认
// `Authorization: Bearer`，model 字段送 tier 别名 "default"，无需任何 hook。
export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  yield* streamChatOpenAICompat(config, messages, signal, tools);
}
