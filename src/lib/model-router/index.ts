// Model Router — unified LLM interface abstraction

import { streamChat as anthropicStreamChat } from "./providers/anthropic";
import { streamChat as openaiStreamChat } from "./providers/openai";

export type { StreamEvent } from "./types";

export type Provider = "anthropic" | "openai" | "google" | "ollama";

export interface ModelConfig {
  provider: Provider;
  model: string;
  apiKey: string;
  baseUrl?: string; // for Ollama or custom endpoints
  maxTokens?: number; // override default max_tokens (e.g. 1 for connection test)
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatResponse {
  content: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export async function* streamChat(
  config: ModelConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<import("./types").StreamEvent> {
  switch (config.provider) {
    case "anthropic":
      yield* anthropicStreamChat(config, messages, signal);
      break;
    case "openai":
      yield* openaiStreamChat(config, messages, signal);
      break;
    case "google":
      yield {
        type: "error",
        error: "Gemini provider will be supported in Phase 3",
      };
      break;
    case "ollama":
      yield {
        type: "error",
        error: "Ollama provider will be supported in Phase 3",
      };
      break;
  }
}

export async function chat(
  config: ModelConfig,
  messages: ChatMessage[],
): Promise<ChatResponse> {
  let content = "";
  let usage: ChatResponse["usage"];

  for await (const event of streamChat(config, messages)) {
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
