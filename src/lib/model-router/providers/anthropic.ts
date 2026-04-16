import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ContentBlock, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { readSSELines } from "@/lib/model-router/sse";

// Serialize AgentMessage[] to Anthropic wire format.
// - system role messages (string content) are hoisted to the top-level `system` field.
// - user/assistant messages pass content blocks through directly (Anthropic native format).
// - Multiple system messages are joined with "\n\n" (preserves Phase 1 behavior).
function toWireMessages(messages: AgentMessage[]): {
  system: string | undefined;
  messages: { role: string; content: string | ContentBlock[] }[];
} {
  const systemParts: string[] = [];
  const wireMessages: { role: string; content: string | ContentBlock[] }[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      // system content is always string (enforced at type level)
      systemParts.push(msg.content);
    } else {
      wireMessages.push({ role: msg.role, content: msg.content });
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: wireMessages,
  };
}

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

  const { system, messages: wireMessages } = toWireMessages(messages);

  const body: Record<string, unknown> = {
    model: config.model,
    messages: wireMessages,
    stream: true,
    max_tokens: config.maxTokens ?? 4096,
  };

  if (system) {
    body.system = system;
  }

  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
    body.tool_choice = { type: "auto" };
  }

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
