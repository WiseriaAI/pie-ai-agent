import type { BuiltinProvider } from "@/lib/model-router";
import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";

import { streamChat as anthropicChat } from "./anthropic";
import { streamChat as openaiChat } from "./openai";
import { streamChat as openrouterChat } from "./openrouter";
import { streamChat as zhipuChat } from "./zhipu";
import { streamChat as bailianChat } from "./bailian";
import { streamChat as minimaxChat } from "./minimax";
import { streamChat as geminiChat } from "./gemini";
import { streamChat as deepseekChat } from "./deepseek";
import { streamChatOpenAICompat } from "./_shared/openai-compat-core";

export type StreamChatFn = (
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
) => AsyncGenerator<StreamEvent>;

export const streamChatByProvider: Record<BuiltinProvider, StreamChatFn> = {
  anthropic: anthropicChat,
  openai: openaiChat,
  openrouter: openrouterChat,
  zhipu: zhipuChat,
  bailian: bailianChat,
  minimax: minimaxChat,
  gemini: geminiChat,
  deepseek: deepseekChat,
};

const BUILTIN_DISPATCH: Record<BuiltinProvider, StreamChatFn> = streamChatByProvider;

export function dispatchStreamChat(config: ModelConfig): StreamChatFn {
  if (config.provider in BUILTIN_DISPATCH) {
    return BUILTIN_DISPATCH[config.provider as BuiltinProvider];
  }
  if (typeof config.provider === "string" && config.provider.startsWith("custom:")) {
    return streamChatOpenAICompat;
  }
  throw new Error(`Unknown provider: ${config.provider}`);
}
