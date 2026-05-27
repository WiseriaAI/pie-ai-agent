import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { readSSELines } from "@/lib/model-router/sse";
import { displayProviderName } from "./openai-compat-core";

// Hook interface — filled out in subsequent tasks. For now the core ignores it
// and behaves exactly like the pre-extraction Anthropic native provider.
export interface AnthropicCompatHooks {
  endpointPath?: string;
  authHeaders?: (config: ModelConfig) => Record<string, string>;
  customHeaders?: (config: ModelConfig) => Record<string, string>;
  promptCache?: boolean;
}

const CACHE_CONTROL_EPHEMERAL = { type: "ephemeral" } as const;

function toWireMessages(messages: AgentMessage[]): {
  system: string | undefined;
  messages: { role: string; content: string | unknown[] }[];
} {
  const systemParts: string[] = [];
  const wireMessages: { role: string; content: string | unknown[] }[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
      continue;
    }
    if (typeof msg.content === "string") {
      wireMessages.push({ role: msg.role, content: msg.content });
      continue;
    }
    const wireBlocks = msg.content.map((block) => {
      if (block.type === "image") {
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: block.source.mediaType,
            data: block.source.data,
          },
        };
      }
      return block;
    });
    wireMessages.push({ role: msg.role, content: wireBlocks });
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: wireMessages,
  };
}

function buildRequestBody(
  config: ModelConfig,
  messages: AgentMessage[],
  tools?: ToolDefinition[],
  promptCache: boolean = false,
): Record<string, unknown> {
  const { system, messages: wireMessages } = toWireMessages(messages);

  const body: Record<string, unknown> = {
    model: config.model,
    messages: wireMessages,
    stream: true,
    max_tokens: config.maxTokens ?? 4096,
  };

  if (system) {
    body.system = promptCache
      ? [{ type: "text", text: system, cache_control: CACHE_CONTROL_EPHEMERAL }]
      : system;
  }

  if (tools && tools.length > 0) {
    const wireTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
    if (promptCache) {
      (wireTools[wireTools.length - 1] as Record<string, unknown>).cache_control =
        CACHE_CONTROL_EPHEMERAL;
    }
    body.tools = wireTools;
    body.tool_choice = { type: "auto" };
  }

  return body;
}

function mapStopReason(
  reason: string | null | undefined,
): "end" | "tool_calls" | "length" | undefined {
  if (reason === "end_turn") return "end";
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  return undefined;
}

export async function* streamChatAnthropicCompat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
  _hooks?: AnthropicCompatHooks,
): AsyncGenerator<StreamEvent> {
  const baseUrl = config.baseUrl!.replace(/\/$/, "");
  const body = buildRequestBody(config, messages, tools, _hooks?.promptCache ?? false);
  const name = displayProviderName(config);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) return;
    yield {
      type: "error",
      error: `Network error: ${e instanceof Error ? e.message : `Failed to connect to ${name} API`}`,
    };
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 401) {
      yield { type: "error", error: `Invalid ${name} API key` };
    } else if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      yield {
        type: "error",
        error: `${name} rate limit exceeded${retryAfter ? `. Retry after ${retryAfter}s` : ""}`,
      };
    } else {
      yield {
        type: "error",
        error: `${name} API error (${response.status}): ${text}`,
      };
    }
    return;
  }

  let usage: { inputTokens: number; outputTokens: number } | undefined;
  let stopReason: "end" | "tool_calls" | "length" | undefined;

  const openBlocks = new Map<number, { type: "text" | "tool_use"; id?: string; name?: string; argsAccum: string }>();

  try {
    for await (const sse of readSSELines(response, signal)) {
      if (signal?.aborted) return;

      if (sse.event === "content_block_start") {
        const data = JSON.parse(sse.data);
        const index: number = data.index;
        const block = data.content_block;
        if (block?.type === "tool_use") {
          openBlocks.set(index, { type: "tool_use", id: block.id, name: block.name, argsAccum: "" });
          yield { type: "tool-call-start", id: block.id, index, name: block.name };
        } else {
          openBlocks.set(index, { type: "text", argsAccum: "" });
        }
      } else if (sse.event === "content_block_delta") {
        const data = JSON.parse(sse.data);
        const index: number = data.index;
        if (data.delta?.type === "text_delta" && data.delta.text) {
          yield { type: "text-delta", text: data.delta.text };
        } else if (data.delta?.type === "input_json_delta") {
          const block = openBlocks.get(index);
          if (block && block.type === "tool_use") {
            block.argsAccum += data.delta.partial_json ?? "";
            yield { type: "tool-call-delta", index, argsDelta: data.delta.partial_json ?? "" };
          }
        }
      } else if (sse.event === "content_block_stop") {
        const data = JSON.parse(sse.data);
        const index: number = data.index;
        const block = openBlocks.get(index);
        if (block && block.type === "tool_use") {
          yield { type: "tool-call-end", index };
          openBlocks.delete(index);
        } else if (block) {
          openBlocks.delete(index);
        }
      } else if (sse.event === "message_delta") {
        const data = JSON.parse(sse.data);
        if (data.usage) {
          usage = {
            inputTokens: usage?.inputTokens ?? 0,
            outputTokens: data.usage.output_tokens ?? 0,
          };
        }
        if (data.delta?.stop_reason != null) {
          stopReason = mapStopReason(data.delta.stop_reason);
        }
      } else if (sse.event === "message_start") {
        const data = JSON.parse(sse.data);
        if (data.message?.usage) {
          usage = { inputTokens: data.message.usage.input_tokens ?? 0, outputTokens: 0 };
        }
      } else if (sse.event === "message_stop") {
        yield { type: "done", stopReason, usage };
        return;
      } else if (sse.event === "error") {
        const data = JSON.parse(sse.data);
        yield {
          type: "error",
          error: `${name} stream error: ${data.error?.message ?? sse.data}`,
        };
        return;
      }
    }

    yield { type: "done", stopReason, usage };
  } catch (e) {
    if (signal?.aborted) return;
    yield {
      type: "error",
      error: `Stream interrupted: ${e instanceof Error ? e.message : "Unknown error"}`,
    };
  }
}

// Test-only exports — preserve names used by anthropic.test.ts
export const _toWireMessagesForTest = toWireMessages;
export const _buildRequestBodyForTest = (
  config: ModelConfig,
  messages: AgentMessage[],
  tools?: ToolDefinition[],
  promptCache: boolean = true,
) => buildRequestBody(config, messages, tools, promptCache);
