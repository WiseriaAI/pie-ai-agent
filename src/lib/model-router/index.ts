// Model Router — unified LLM interface abstraction

import { dispatchStreamChat } from "./providers";
import { resolveProviderMeta } from "./providers/registry";
import type { Attachment } from "@/lib/images";

export type { StreamEvent, AgentMessage, ContentBlock, TextBlock, ToolUseBlock, ToolResultBlock, ImageBlock, ToolDefinition } from "./types";
export { PROVIDER_REGISTRY, getProviderMeta, resolveProviderMeta, resolveModelMeta, resolveEndpointVariant } from "./providers/registry";
export type { ProviderMeta, ModelMeta, EndpointVariant } from "./providers/registry";
export { getModelMeta } from "./providers/registry";
export { dispatchStreamChat } from "./providers";

export type BuiltinProvider =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "minimax"
  | "zhipu"
  | "bailian"
  | "gemini"
  | "deepseek"
  | "mimo"
  | "moonshot"
  | "moonshot-cn"
  | "stepfun"
  | "managed";

export type ProviderRef = BuiltinProvider | `custom:${string}`;

/** @deprecated Use `BuiltinProvider` instead. Kept for backward compat. */
export type Provider = BuiltinProvider;

export interface ModelConfig {
  provider: ProviderRef;
  model: string;
  apiKey: string;
  baseUrl?: string;
  /** Display name for error messages — resolved at instance load time. */
  providerName?: string;
  maxTokens?: number;
  /**
   * 模型 meta 的最大输出上限，task-start 时由 `resolveModelConfig` 从
   * `resolveModelMeta(...).maxOutputTokens` 解析填入。anthropic-sdk-core 用它作为
   * 「用户没手填 maxTokens 时」的默认（max_tokens 在该 wire 是必填字段）。
   * OpenAI-compat / gemini 不读此字段（它们不填则省略 max_tokens）。
   */
  maxOutputTokens?: number;
  /**
   * Whether the resolved model accepts image input. Resolved at task-start
   * time by `resolveInstanceToModelConfig` via `resolveModelVision`, which
   * consults the hardcoded registry first and falls back to the instance's
   * `fetchedModels` (OpenRouter lazy catalog). `undefined` means "unknown" —
   * the screenshot vision guard treats unknown as fail-open so user-typed
   * custom OpenRouter ids aren't silently locked out.
   */
  vision?: boolean;
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
  const meta = await resolveProviderMeta(config.provider);
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

  yield* dispatchStreamChat(config)(resolvedConfig, messages, signal, tools);
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
