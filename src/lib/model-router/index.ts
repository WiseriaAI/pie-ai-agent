// Model Router — unified LLM interface abstraction

import { streamChat as anthropicStreamChat } from "./providers/anthropic";
import { streamChat as openaiStreamChat } from "./providers/openai";
import { getProviderMeta } from "./providers/registry";
import type { Attachment } from "@/lib/images";

export type { StreamEvent, AgentMessage, ContentBlock, TextBlock, ToolUseBlock, ToolResultBlock, ImageBlock, ToolDefinition } from "./types";
export { PROVIDER_REGISTRY, getProviderMeta } from "./providers/registry";
export type { ProviderMeta, ModelMeta } from "./providers/registry";
export { getModelMeta } from "./providers/registry";

export type Provider =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "minimax"
  | "zhipu"
  | "bailian"
  | "gemini";

export interface ModelConfig {
  provider: Provider;
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxTokens?: number;
}

// Panel↔SW wire protocol message — content stays string (Phase 1 wire invariant);
// `attachments` is the Phase 5 additive field for image input.
//
// R10 storage policy (will be enforced in Task 12, NOT today): chrome.storage
// MUST never carry attachment.data bytes — setSessionMeta will replace any
// `kind: "image"` with `kind: "image_placeholder"` before write. Task 1 only
// adds the optional field to the type; until Task 12 wires the scrubber,
// callers should not write image attachments to storage.
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  attachments?: Attachment[];
}

export interface ChatResponse {
  content: string;
  usage?: { inputTokens: number; outputTokens: number };
}

// Adapter: convert ChatMessage[] (Panel wire) to AgentMessage[] (model-router IR).
// String content passes through unchanged when no attachments are present.
// When attachments are present, expands into ContentBlock[] with image/placeholder blocks.
export function chatMessagesToAgent(
  messages: ChatMessage[],
): import("./types").AgentMessage[] {
  return messages.map((m): import("./types").AgentMessage => {
    if (m.role === "system") return { role: "system", content: m.content };
    if (!m.attachments?.length) return { role: m.role, content: m.content };

    const blocks: import("./types").ContentBlock[] = [];
    for (const a of m.attachments) {
      if (a.kind === "image") {
        blocks.push({
          type: "image",
          source: { type: "base64", mediaType: a.mediaType, data: a.data },
        });
      } else {
        blocks.push({ type: "text", text: "[image released — no longer available]" });
      }
    }
    if (m.content.length > 0) blocks.push({ type: "text", text: m.content });
    return { role: m.role, content: blocks };
  });
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
