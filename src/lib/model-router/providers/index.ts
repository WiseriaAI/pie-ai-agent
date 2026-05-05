import type { Provider } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import type { ModelConfig } from "@/lib/model-router";

import { streamChat as anthropicChat } from "./anthropic";
import { streamChat as openaiChat } from "./openai";
import { streamChat as openrouterChat } from "./openrouter";
import { streamChat as zhipuChat } from "./zhipu";
import { streamChat as bailianChat } from "./bailian";
import { streamChat as minimaxChat } from "./minimax";
import { streamChat as geminiChat } from "./gemini";

export type StreamChatFn = (
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
) => AsyncGenerator<StreamEvent>;

export const streamChatByProvider: Record<Provider, StreamChatFn> = {
  anthropic: anthropicChat,
  openai: openaiChat,
  openrouter: openrouterChat,
  zhipu: zhipuChat,
  bailian: bailianChat,
  minimax: minimaxChat,
  gemini: geminiChat,
};
