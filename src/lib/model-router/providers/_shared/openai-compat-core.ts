import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { readSSELines } from "@/lib/model-router/sse";

/**
 * Shared OpenAI-compatible Chat Completions streaming core.
 *
 * Used by: openai, openrouter, zhipu, bailian, minimax wrappers.
 *
 * Defensive quirk handling (do not remove without verifying the upstream
 * provider has fixed the wire issue):
 *
 * 1. [DONE] without preceding finish_reason="tool_calls" — Triggered by
 *    ZhiPu (open.bigmodel.cn) and Bailian (dashscope.aliyuncs.com). When
 *    [DONE] arrives with non-empty pendingToolCalls, we flush tool-call-end
 *    events and emit done with stopReason="tool_calls".
 *
 * 2. tool_call function.arguments included in same first chunk as id+name —
 *    Triggered by MiniMax (api.minimax.chat), some OpenRouter routes, and
 *    zero-arg tools. We accumulate `initialArgs` from the first chunk and
 *    emit a tool-call-delta if non-empty.
 */

/**
 * Sync helper for error display — returns the friendly provider name if
 * available, falling back to the raw provider ref.
 *
 * `providerName` is resolved once at instance-load time by
 * `resolveInstanceToModelConfig`, so no async storage call is needed
 * in the streaming error path.
 */
export function displayProviderName(config: ModelConfig): string {
  return config.providerName ?? config.provider;
}

export interface OpenAICompatHooks {
  /** Headers merged on top of standard `Authorization` + `content-type`. */
  customHeaders?: (config: ModelConfig) => Record<string, string>;
  /** Replaces the default `Authorization: Bearer ${apiKey}`. */
  authHeader?: (config: ModelConfig) => Record<string, string>;
}

interface OpenAIWireMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

function toWireMessages(messages: AgentMessage[]): OpenAIWireMessage[] {
  const result: OpenAIWireMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      result.push({ role: "system", content: msg.content });
      continue;
    }
    const content = msg.content;
    if (typeof content === "string") {
      result.push({ role: msg.role, content });
      continue;
    }
    if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: OpenAIWireMessage["tool_calls"] = [];
      for (const block of content) {
        if (block.type === "text") textParts.push(block.text);
        else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
            },
          });
        }
      }
      const assistantContent = textParts.length > 0 ? textParts.join("") : null;
      const wireMsg: OpenAIWireMessage = { role: "assistant", content: assistantContent };
      if (toolCalls.length > 0) wireMsg.tool_calls = toolCalls;
      result.push(wireMsg);
    } else if (msg.role === "user") {
      const textParts: string[] = [];
      const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
      for (const block of content) {
        if (block.type === "text") textParts.push(block.text);
        else if (block.type === "tool_result") {
          result.push({ role: "tool", content: block.content, tool_call_id: block.toolUseId });
        } else if (block.type === "image") {
          imageBlocks.push({
            type: "image_url",
            image_url: { url: `data:${block.source.mediaType};base64,${block.source.data}` },
          });
        }
      }
      if (imageBlocks.length > 0) {
        const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [...imageBlocks];
        if (textParts.length > 0) parts.push({ type: "text", text: textParts.join("") });
        result.push({ role: "user", content: parts });
      } else if (textParts.length > 0) {
        result.push({ role: "user", content: textParts.join("") });
      }
    }
  }
  return result;
}

function mapStopReason(reason: string | null | undefined): "end" | "tool_calls" | "length" | undefined {
  if (reason === "stop") return "end";
  if (reason === "tool_calls") return "tool_calls";
  if (reason === "length") return "length";
  return undefined;
}

interface PendingToolCall { id: string; name: string; argsAccum: string; }

export async function* streamChatOpenAICompat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
  hooks?: OpenAICompatHooks,
): AsyncGenerator<StreamEvent> {
  const baseUrl = config.baseUrl!.replace(/\/$/, "");
  const endpoint = baseUrl.match(/\/v\d+$/) ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
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
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    requestBody.tool_choice = "auto";
  }

  const auth = hooks?.authHeader?.(config) ?? { authorization: `Bearer ${config.apiKey}` };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...auth,
    ...(hooks?.customHeaders?.(config) ?? {}),
  };

  let response: Response;
  try {
    response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(requestBody), signal });
  } catch (e) {
    if (signal?.aborted) return;
    yield { type: "error", error: `Network error: ${e instanceof Error ? e.message : `Failed to connect to ${displayProviderName(config)} API`}` };
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const name = displayProviderName(config);
    if (response.status === 401) yield { type: "error", error: `Invalid ${name} API key` };
    else if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      yield { type: "error", error: `${name} rate limit exceeded${retryAfter ? `. Retry after ${retryAfter}s` : ""}` };
    } else {
      yield { type: "error", error: `${name} API error (${response.status}): ${text}` };
    }
    return;
  }

  let usage: { inputTokens: number; outputTokens: number } | undefined;
  const pendingToolCalls = new Map<number, PendingToolCall>();

  try {
    for await (const sse of readSSELines(response, signal)) {
      if (signal?.aborted) return;
      if (sse.data === "[DONE]") {
        if (pendingToolCalls.size > 0) {
          for (const [index] of pendingToolCalls) yield { type: "tool-call-end", index };
          pendingToolCalls.clear();
          yield { type: "done", stopReason: "tool_calls", usage };
          return;
        }
        yield { type: "done", stopReason: "end", usage };
        return;
      }
      try {
        const data = JSON.parse(sse.data);
        if (data.usage) usage = { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 };
        const choice = data.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        const finishReason: string | null = choice.finish_reason;
        if (delta?.content) yield { type: "text-delta", text: delta.content };
        if (delta?.tool_calls) {
          for (const tcd of delta.tool_calls) {
            const index: number = tcd.index;
            const existing = pendingToolCalls.get(index);
            if (!existing) {
              const id: string = tcd.id ?? "";
              const name: string = tcd.function?.name ?? "";
              const initialArgs: string = tcd.function?.arguments ?? "";
              pendingToolCalls.set(index, { id, name, argsAccum: initialArgs });
              yield { type: "tool-call-start", id, index, name };
              if (initialArgs) yield { type: "tool-call-delta", index, argsDelta: initialArgs };
            } else {
              const argFragment: string = tcd.function?.arguments ?? "";
              if (argFragment) {
                existing.argsAccum += argFragment;
                yield { type: "tool-call-delta", index, argsDelta: argFragment };
              }
            }
          }
        }
        if (finishReason != null) {
          if (finishReason === "tool_calls") {
            for (const [index] of pendingToolCalls) yield { type: "tool-call-end", index };
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
    yield { type: "done", usage };
  } catch (e) {
    if (signal?.aborted) return;
    yield { type: "error", error: `Stream interrupted: ${e instanceof Error ? e.message : "Unknown error"}` };
  }
}

export const _toWireMessagesForTest = toWireMessages;
