import type { ModelConfig, ChatMessage } from "@/lib/model-router";
import type { StreamEvent } from "@/lib/model-router/types";
import { readSSELines } from "@/lib/model-router/sse";

export async function* streamChat(
  config: ModelConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const baseUrl = config.baseUrl?.replace(/\/$/, "") || "https://api.anthropic.com";

  // Anthropic requires system as a top-level field, not in messages array
  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");
  const systemText = systemMessages.map((m) => m.content).join("\n\n");

  const body: Record<string, unknown> = {
    model: config.model,
    messages: nonSystemMessages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    stream: true,
    max_tokens: config.maxTokens ?? 4096,
  };
  if (systemText) {
    body.system = systemText;
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

  try {
    for await (const sse of readSSELines(response, signal)) {
      if (signal?.aborted) return;

      if (sse.event === "content_block_delta") {
        const data = JSON.parse(sse.data);
        if (data.delta?.type === "text_delta" && data.delta.text) {
          yield { type: "text-delta", text: data.delta.text };
        }
      } else if (sse.event === "message_delta") {
        const data = JSON.parse(sse.data);
        if (data.usage) {
          usage = {
            inputTokens: usage?.inputTokens ?? 0,
            outputTokens: data.usage.output_tokens ?? 0,
          };
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
        yield { type: "done", usage };
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
    yield { type: "done", usage };
  } catch (e) {
    if (signal?.aborted) return;
    yield {
      type: "error",
      error: `Stream interrupted: ${e instanceof Error ? e.message : "Unknown error"}`,
    };
  }
}
