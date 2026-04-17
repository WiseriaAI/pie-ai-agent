import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ContentBlock, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { readSSELines } from "@/lib/model-router/sse";

// OpenAI wire message type
interface OpenAIWireMessage {
  role: string;
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

// Fan-out AgentMessage[] to OpenAI wire format.
// - system/user with string content → straight through
// - user with ContentBlock[] → fan out tool_result blocks as role:"tool" messages,
//   text blocks concatenated into content string
// - assistant with string content → straight through
// - assistant with ContentBlock[] containing tool_use → one assistant message with
//   tool_calls array (text blocks become content string, or null if none), followed
//   by role:"tool" messages for any tool_result blocks (shouldn't appear on assistant,
//   but guard anyway)
function toWireMessages(messages: AgentMessage[]): OpenAIWireMessage[] {
  const result: OpenAIWireMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      // system content is always string
      result.push({ role: "system", content: msg.content });
      continue;
    }

    const content = msg.content;

    if (typeof content === "string") {
      result.push({ role: msg.role, content });
      continue;
    }

    // content is ContentBlock[]
    if (msg.role === "assistant") {
      // Collect text parts and tool_use parts
      const textParts: string[] = [];
      const toolCalls: OpenAIWireMessage["tool_calls"] = [];

      for (const block of content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: typeof block.input === "string"
                ? block.input
                : JSON.stringify(block.input ?? {}),
            },
          });
        }
        // tool_result in assistant position is unusual — skip
      }

      const assistantContent = textParts.length > 0 ? textParts.join("") : null;
      const wireMsg: OpenAIWireMessage = { role: "assistant", content: assistantContent };
      if (toolCalls.length > 0) {
        wireMsg.tool_calls = toolCalls;
      }
      result.push(wireMsg);
    } else if (msg.role === "user") {
      // Collect text and tool_result blocks separately
      const textParts: string[] = [];

      for (const block of content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_result") {
          // Each tool_result becomes a separate role:"tool" message
          result.push({
            role: "tool",
            content: block.content,
            tool_call_id: block.toolUseId,
          });
        }
        // tool_use in user position is unusual — skip
      }

      // If there were text parts, emit a user message
      if (textParts.length > 0) {
        result.push({ role: "user", content: textParts.join("") });
      }
    }
  }

  return result;
}

// Map OpenAI finish_reason to our normalized stopReason
function mapStopReason(
  reason: string | null | undefined,
): "end" | "tool_calls" | "length" | undefined {
  if (reason === "stop") return "end";
  if (reason === "tool_calls") return "tool_calls";
  if (reason === "length") return "length";
  return undefined;
}

interface PendingToolCall {
  id: string;
  name: string;
  argsAccum: string;
}

export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  const baseUrl = config.baseUrl!.replace(/\/$/, "");

  // For providers whose baseUrl already includes a version path (e.g. /v4),
  // append /chat/completions. For standard OpenAI-style, append /v1/chat/completions.
  const endpoint = baseUrl.match(/\/v\d+$/)
    ? `${baseUrl}/chat/completions`
    : `${baseUrl}/v1/chat/completions`;

  const wireMessages = toWireMessages(messages);

  const requestBody: Record<string, unknown> = {
    model: config.model,
    messages: wireMessages,
    stream: true,
    stream_options: { include_usage: true },
    ...(config.maxTokens != null && { max_tokens: config.maxTokens }),
  };

  if (tools && tools.length > 0) {
    requestBody.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    requestBody.tool_choice = "auto";
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) return;
    yield {
      type: "error",
      error: `Network error: ${e instanceof Error ? e.message : `Failed to connect to ${config.provider} API`}`,
    };
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const name = config.provider;
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

  // Map from tool_calls index to pending call state
  const pendingToolCalls = new Map<number, PendingToolCall>();

  try {
    for await (const sse of readSSELines(response, signal)) {
      if (signal?.aborted) return;

      if (sse.data === "[DONE]") {
        // Some providers (e.g. ZhiPu, Bailian) send [DONE] without a preceding
        // finish_reason: "tool_calls" chunk. Flush any pending tool calls so
        // the consumer sees tool-call-end events and the correct stopReason.
        if (pendingToolCalls.size > 0) {
          for (const [index] of pendingToolCalls) {
            yield { type: "tool-call-end", index };
          }
          pendingToolCalls.clear();
          yield { type: "done", stopReason: "tool_calls", usage };
          return;
        }
        yield { type: "done", stopReason: "end", usage };
        return;
      }

      try {
        const data = JSON.parse(sse.data);

        if (data.usage) {
          usage = {
            inputTokens: data.usage.prompt_tokens ?? 0,
            outputTokens: data.usage.completion_tokens ?? 0,
          };
        }

        const choice = data.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        const finishReason: string | null = choice.finish_reason;

        // Handle text content delta
        if (delta?.content) {
          yield { type: "text-delta", text: delta.content };
        }

        // Handle tool_calls deltas
        if (delta?.tool_calls) {
          for (const toolCallDelta of delta.tool_calls) {
            const index: number = toolCallDelta.index;
            const existing = pendingToolCalls.get(index);

            if (!existing) {
              // First chunk for this index — has id + function.name.
              // Some providers (MiniMax, certain OpenRouter routes, zero-arg tools)
              // also include function.arguments in the same first chunk. Read and
              // accumulate it here so single-chunk tool calls don't lose their args.
              const id: string = toolCallDelta.id ?? "";
              const name: string = toolCallDelta.function?.name ?? "";
              const initialArgs: string = toolCallDelta.function?.arguments ?? "";
              pendingToolCalls.set(index, { id, name, argsAccum: initialArgs });
              yield { type: "tool-call-start", id, index, name };
              if (initialArgs) {
                yield { type: "tool-call-delta", index, argsDelta: initialArgs };
              }
            } else {
              // Subsequent chunks — accumulate function.arguments
              const argFragment: string = toolCallDelta.function?.arguments ?? "";
              if (argFragment) {
                existing.argsAccum += argFragment;
                yield { type: "tool-call-delta", index, argsDelta: argFragment };
              }
            }
          }
        }

        // Handle finish
        if (finishReason != null) {
          if (finishReason === "tool_calls") {
            // Emit tool-call-end for all pending tool calls
            for (const [index] of pendingToolCalls) {
              yield { type: "tool-call-end", index };
            }
            pendingToolCalls.clear();
            yield { type: "done", stopReason: "tool_calls", usage };
            return;
          } else if (finishReason === "stop" || finishReason === "length") {
            yield { type: "done", stopReason: mapStopReason(finishReason), usage };
            return;
          }
        }
      } catch {
        // skip unparseable lines
      }
    }

    // Stream ended without [DONE]
    yield { type: "done", usage };
  } catch (e) {
    if (signal?.aborted) return;
    yield {
      type: "error",
      error: `Stream interrupted: ${e instanceof Error ? e.message : "Unknown error"}`,
    };
  }
}
