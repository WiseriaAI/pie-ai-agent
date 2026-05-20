import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ContentBlock, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { readSSELines } from "@/lib/model-router/sse";

// Serialize AgentMessage[] to Anthropic wire format.
// - system role messages (string content) are hoisted to the top-level `system` field.
// - user/assistant messages pass content blocks through directly (Anthropic native format).
// - Multiple system messages are joined with "\n\n" (preserves Phase 1 behavior).
// - ImageBlock: camelCase mediaType → snake_case media_type for Anthropic wire.
function toWireMessages(messages: AgentMessage[]): {
  system: string | undefined;
  messages: { role: string; content: string | unknown[] }[];
} {
  const systemParts: string[] = [];
  const wireMessages: { role: string; content: string | unknown[] }[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      // system content is always string (enforced at type level)
      systemParts.push(msg.content);
      continue;
    }
    if (typeof msg.content === "string") {
      wireMessages.push({ role: msg.role, content: msg.content });
      continue;
    }
    // ContentBlock[] — map each block to Anthropic wire shape.
    // Most blocks pass through verbatim (text, tool_use, tool_result use
    // Anthropic-native field names already). ImageBlock needs camelCase →
    // snake_case translation on mediaType → media_type for the Anthropic wire.
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

// Test-only export — Phase 5 wire shape validation
export const _toWireMessagesForTest = toWireMessages;

// Build the Anthropic /v1/messages request body, including prompt-caching
// breakpoints (#57). Within a single ReAct task the system prompt and the tool
// definitions are constant across all (up to 30) steps, so a `cache_control:
// ephemeral` breakpoint at the end of each lets Anthropic serve them from cache
// instead of re-billing them every step. Caching is prefix-cumulative (tools
// precede system precede messages), so the breakpoints sit on the *last* tool
// and on the system block. Anthropic ignores breakpoints below the minimum
// cacheable length, so this is always safe to set.
//
// The volatile per-step observation lives in the trailing user message and is
// intentionally left uncached — that is the suffix in the "stable prefix +
// volatile suffix" structure described in the issue.
const CACHE_CONTROL_EPHEMERAL = { type: "ephemeral" } as const;

function buildRequestBody(
  config: ModelConfig,
  messages: AgentMessage[],
  tools?: ToolDefinition[],
): Record<string, unknown> {
  const { system, messages: wireMessages } = toWireMessages(messages);

  const body: Record<string, unknown> = {
    model: config.model,
    messages: wireMessages,
    stream: true,
    max_tokens: config.maxTokens ?? 4096,
  };

  if (system) {
    // Hoist the string into a single text block carrying the cache breakpoint.
    body.system = [
      { type: "text", text: system, cache_control: CACHE_CONTROL_EPHEMERAL },
    ];
  }

  if (tools && tools.length > 0) {
    const wireTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
    // Breakpoint on the last tool caches the entire tools prefix.
    (wireTools[wireTools.length - 1] as Record<string, unknown>).cache_control =
      CACHE_CONTROL_EPHEMERAL;
    body.tools = wireTools;
    body.tool_choice = { type: "auto" };
  }

  return body;
}

// Test-only export — #57 prompt-caching wire shape validation
export const _buildRequestBodyForTest = buildRequestBody;

// Map Anthropic stop_reason to our normalized stopReason
function mapStopReason(
  reason: string | null | undefined,
): "end" | "tool_calls" | "length" | undefined {
  if (reason === "end_turn") return "end";
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  return undefined;
}

export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  const baseUrl = config.baseUrl!.replace(/\/$/, "");

  const body = buildRequestBody(config, messages, tools);

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
      error: `Network error: ${e instanceof Error ? e.message : "Failed to connect to Anthropic API"}`,
    };
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 401) {
      yield { type: "error", error: "Invalid Anthropic API key" };
    } else if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      yield {
        type: "error",
        error: `Anthropic rate limit exceeded${retryAfter ? `. Retry after ${retryAfter}s` : ""}`,
      };
    } else {
      yield {
        type: "error",
        error: `Anthropic API error (${response.status}): ${text}`,
      };
    }
    return;
  }

  let usage: { inputTokens: number; outputTokens: number } | undefined;
  let stopReason: "end" | "tool_calls" | "length" | undefined;

  // Track open content blocks by index: "text" | "tool_use"
  const openBlocks = new Map<number, { type: "text" | "tool_use"; id?: string; name?: string; argsAccum: string }>();

  try {
    for await (const sse of readSSELines(response, signal)) {
      if (signal?.aborted) return;

      if (sse.event === "content_block_start") {
        const data = JSON.parse(sse.data);
        const index: number = data.index;
        const block = data.content_block;
        if (block?.type === "tool_use") {
          openBlocks.set(index, {
            type: "tool_use",
            id: block.id,
            name: block.name,
            argsAccum: "",
          });
          yield {
            type: "tool-call-start",
            id: block.id,
            index,
            name: block.name,
          };
        } else {
          // text or other block types — track as "text" so we can ignore on stop
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
            yield {
              type: "tool-call-delta",
              index,
              argsDelta: data.delta.partial_json ?? "",
            };
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
          usage = {
            inputTokens: data.message.usage.input_tokens ?? 0,
            outputTokens: 0,
          };
        }
      } else if (sse.event === "message_stop") {
        yield { type: "done", stopReason, usage };
        return;
      } else if (sse.event === "error") {
        const data = JSON.parse(sse.data);
        yield {
          type: "error",
          error: `Anthropic stream error: ${data.error?.message ?? sse.data}`,
        };
        return;
      }
    }

    // Stream ended without message_stop
    yield { type: "done", stopReason, usage };
  } catch (e) {
    if (signal?.aborted) return;
    yield {
      type: "error",
      error: `Stream interrupted: ${e instanceof Error ? e.message : "Unknown error"}`,
    };
  }
}
