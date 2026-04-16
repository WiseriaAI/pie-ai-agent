// Model Router — unified LLM interface abstraction

import { streamChat as anthropicStreamChat } from "./providers/anthropic";
import { streamChat as openaiStreamChat } from "./providers/openai";
import { getProviderMeta } from "./providers/registry";

export type { StreamEvent, AgentMessage, ContentBlock, TextBlock, ToolUseBlock, ToolResultBlock, ToolDefinition } from "./types";
export { PROVIDER_REGISTRY, getProviderMeta } from "./providers/registry";
export type { ProviderMeta } from "./providers/registry";

export type Provider =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "minimax"
  | "zhipu"
  | "bailian"
  | "google"
  | "ollama";

export interface ModelConfig {
  provider: Provider;
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxTokens?: number;
}

// Panel↔SW wire protocol message — content stays string only, never modified
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatResponse {
  content: string;
  usage?: { inputTokens: number; outputTokens: number };
}

// Adapter: convert ChatMessage[] (Panel wire) to AgentMessage[] (model-router IR).
// String content passes through unchanged. Structural compat is preserved because
// ChatMessage is a subtype of AgentMessage (string content satisfies string | ContentBlock[]).
export function chatMessagesToAgent(
  messages: ChatMessage[],
): import("./types").AgentMessage[] {
  return messages as import("./types").AgentMessage[];
}

export async function* streamChat(
  config: ModelConfig,
  messages: import("./types").AgentMessage[],
  signal?: AbortSignal,
  tools?: import("./types").ToolDefinition[],
): AsyncGenerator<import("./types").StreamEvent> {
  const meta = getProviderMeta(config.provider);
  if (!meta) {
    yield {
      type: "error",
      error: `Unknown provider: ${config.provider}`,
    };
    return;
  }

  // Inject default base URL if not overridden
  const resolvedConfig = {
    ...config,
    baseUrl: config.baseUrl || meta.defaultBaseUrl,
  };

  switch (meta.type) {
    case "anthropic":
      yield* anthropicStreamChat(resolvedConfig, messages, signal, tools);
      break;
    case "openai-compatible":
      yield* openaiStreamChat(resolvedConfig, messages, signal, tools);
      break;
  }
}

export async function chat(
  config: ModelConfig,
  messages: ChatMessage[],
): Promise<ChatResponse> {
  let content = "";
  let usage: ChatResponse["usage"];

  for await (const event of streamChat(config, chatMessagesToAgent(messages))) {
    if (event.type === "text-delta") {
      content += event.text;
    } else if (event.type === "done") {
      usage = event.usage;
    } else if (event.type === "error") {
      throw new Error(event.error);
    }
  }

  return { content, usage };
}
