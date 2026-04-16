import type { ModelConfig, ChatMessage } from "@/lib/model-router";
import type { StreamEvent } from "@/lib/model-router/types";
import { readSSELines } from "@/lib/model-router/sse";

export async function* streamChat(
  config: ModelConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const baseUrl = config.baseUrl!.replace(/\/$/, "");

  // For providers whose baseUrl already includes a version path (e.g. /v4),
  // append /chat/completions. For standard OpenAI-style, append /v1/chat/completions.
  const endpoint = baseUrl.match(/\/v\d+$/)
    ? `${baseUrl}/chat/completions`
    : `${baseUrl}/v1/chat/completions`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
        stream_options: { include_usage: true },
        ...(config.maxTokens != null && { max_tokens: config.maxTokens }),
      }),
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

  try {
    for await (const sse of readSSELines(response, signal)) {
      if (signal?.aborted) return;

      if (sse.data === "[DONE]") {
        yield { type: "done", usage };
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

        const content = data.choices?.[0]?.delta?.content;
        if (content) {
          yield { type: "text-delta", text: content };
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
