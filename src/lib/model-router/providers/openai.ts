import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { streamChatOpenAICompat, type OpenAICompatHooks } from "./_shared/openai-compat-core";

const hooks: OpenAICompatHooks = {
  transformRequestBody: (body) => {
    // gpt-5.x reasoning 系在 /v1/chat/completions 拒收 max_tokens，只认
    // max_completion_tokens；gpt-4o 老系两个都认，故一律用新字段。
    if (body.max_tokens != null) {
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
    }
    // gpt-5.6 起 chat/completions 上 function tools 与 reasoning_effort≠none
    // 互斥（默认 medium 即 400）；带 reasoning 跑 tools 需迁 /v1/responses。
    if (body.tools && typeof body.model === "string" && body.model.startsWith("gpt-5.6")) {
      body.reasoning_effort = "none";
    }
  },
};

export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  yield* streamChatOpenAICompat(config, messages, signal, tools, hooks);
}

// Test-only re-export for back-compat with existing openai.test.ts
export { _toWireMessagesForTest } from "./_shared/openai-compat-core";
