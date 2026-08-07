import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { streamChatOpenAICompat } from "./_shared/openai-compat-core";

export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  yield* streamChatOpenAICompat(config, messages, signal, tools, {
    customHeaders: () => ({
      "HTTP-Referer": "https://github.com/WiseriaAI/pie-ai-agent",
      "X-OpenRouter-Title": "Pie",
    }),
    // OpenRouter 的 Usage Accounting 是 opt-in:不带这个字段时它只回
    // prompt_tokens / completion_tokens / total_tokens,**没有**
    // prompt_tokens_details,于是缓存命中数无从得知(上下文环与 [ctx] 的 hit
    // 都只能显示 n/a)。带上之后 usage 里会多出 prompt_tokens_details.cached_tokens
    // 与 cost —— 前者正是 openai-compat-core 已经在读的第一顺位字段。
    extraBody: () => ({ usage: { include: true } }),
  });
}
