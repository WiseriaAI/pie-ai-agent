// Shared transport for Anthropic-wire providers, backed by the official
// @anthropic-ai/sdk (parallel to ./anthropic-compat-core.ts, which is hand-rolled
// SSE). Introduced for #91: MiMo adopts this first as a canary; other Anthropic-wire
// providers can follow once it's proven against real traffic.
//
// Why the SDK is safe in the MV3 service worker (verified): it ships no eval /
// new Function (CSP-safe), uses fetch / ReadableStream / TextDecoder, and its
// process.* / Buffer references are all guarded behind runtime detection or
// duck-typing — none execute when those globals are absent.
import Anthropic from "@anthropic-ai/sdk";
import type { ModelConfig } from "@/lib/model-router";
import type {
  AgentMessage,
  ContentBlock,
  ToolDefinition,
  StreamEvent,
} from "@/lib/model-router/types";

export interface AnthropicSdkHooks {
  /** Appended to config.baseUrl before the SDK's own `/v1/messages` suffix.
   *  e.g. MiMo's endpoint is `/anthropic/v1/messages` → suffix `/anthropic`. */
  baseUrlSuffix?: string;
  /** `apiKey` → x-api-key header (real Anthropic); `bearer` → Authorization: Bearer. */
  auth?: "apiKey" | "bearer";
  /** Remove the SDK's default `anthropic-version` header (parity with providers
   *  whose anthropic-compatible endpoint doesn't expect it). */
  stripAnthropicVersion?: boolean;
  /** Mark system + last tool with cache_control: ephemeral. */
  promptCache?: boolean;
}

const CACHE_CONTROL_EPHEMERAL = { type: "ephemeral" } as const;

function toSdkParams(messages: AgentMessage[]): {
  system: string | undefined;
  messages: Anthropic.MessageParam[];
} {
  const systemParts: string[] = [];
  const out: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
      continue;
    }
    if (typeof msg.content === "string") {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    const blocks = msg.content.map((block: ContentBlock) => {
      if (block.type === "image") {
        return {
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: block.source.mediaType,
            data: block.source.data,
          },
        };
      }
      if (block.type === "tool_result") {
        return {
          type: "tool_result" as const,
          tool_use_id: block.toolUseId,
          content: block.content,
          ...(block.isError !== undefined ? { is_error: block.isError } : {}),
        };
      }
      if (block.type === "tool_use") {
        return { type: "tool_use" as const, id: block.id, name: block.name, input: block.input };
      }
      return { type: "text" as const, text: block.text };
    });
    out.push({ role: msg.role, content: blocks as Anthropic.ContentBlockParam[] });
  }

  return { system: systemParts.length ? systemParts.join("\n\n") : undefined, messages: out };
}

function mapStopReason(
  reason: string | null | undefined,
): "end" | "tool_calls" | "length" | undefined {
  if (reason === "end_turn") return "end";
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  return undefined;
}

export async function* streamChatAnthropicSdk(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
  hooks?: AnthropicSdkHooks,
): AsyncGenerator<StreamEvent> {
  const auth = hooks?.auth ?? "apiKey";
  const baseURL = config.baseUrl
    ? config.baseUrl.replace(/\/$/, "") + (hooks?.baseUrlSuffix ?? "")
    : undefined;

  const client = new Anthropic({
    baseURL,
    // BYOK: the key is the user's own, stored locally; this flag's whole point
    // is "I accept the key lives client-side" — already true for this extension.
    dangerouslyAllowBrowser: true,
    ...(auth === "bearer" ? { authToken: config.apiKey } : { apiKey: config.apiKey }),
    ...(hooks?.stripAnthropicVersion
      ? { defaultHeaders: { "anthropic-version": null } }
      : {}),
  });

  const promptCache = hooks?.promptCache ?? false;

  const { system: systemText, messages: sdkMessages } = toSdkParams(messages);
  const system = !systemText
    ? undefined
    : promptCache
      ? [{ type: "text" as const, text: systemText, cache_control: CACHE_CONTROL_EPHEMERAL }]
      : systemText;

  const wireTools = tools?.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
    ...(promptCache && i === tools.length - 1
      ? { cache_control: CACHE_CONTROL_EPHEMERAL }
      : {}),
  }));

  let usage: { inputTokens: number; outputTokens: number } | undefined;
  let stopReason: "end" | "tool_calls" | "length" | undefined;
  const toolBlocks = new Set<number>();

  try {
    const stream = await client.messages.create(
      {
        model: config.model,
        max_tokens: config.maxTokens ?? 4096,
        stream: true,
        ...(system ? { system } : {}),
        messages: sdkMessages,
        ...(wireTools?.length ? { tools: wireTools, tool_choice: { type: "auto" } } : {}),
      },
      { signal },
    );

    for await (const event of stream) {
      if (signal?.aborted) return;
      if (event.type === "message_start") {
        usage = { inputTokens: event.message.usage.input_tokens ?? 0, outputTokens: 0 };
      } else if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") {
          toolBlocks.add(event.index);
          yield {
            type: "tool-call-start",
            id: event.content_block.id,
            index: event.index,
            name: event.content_block.name,
          };
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          yield { type: "text-delta", text: event.delta.text };
        } else if (event.delta.type === "input_json_delta") {
          yield { type: "tool-call-delta", index: event.index, argsDelta: event.delta.partial_json };
        }
      } else if (event.type === "content_block_stop") {
        if (toolBlocks.has(event.index)) {
          yield { type: "tool-call-end", index: event.index };
          toolBlocks.delete(event.index);
        }
      } else if (event.type === "message_delta") {
        stopReason = mapStopReason(event.delta.stop_reason);
        usage = {
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: event.usage.output_tokens ?? 0,
        };
      }
    }

    yield { type: "done", stopReason, usage };
  } catch (e) {
    if (signal?.aborted || e instanceof Anthropic.APIUserAbortError) return;
    const name = config.provider;
    if (e instanceof Anthropic.APIError) {
      if (e.status === 401) {
        yield { type: "error", error: `Invalid ${name} API key` };
      } else if (e.status === 429) {
        yield { type: "error", error: `${name} rate limit exceeded` };
      } else {
        yield { type: "error", error: `${name} API error (${e.status}): ${e.message}` };
      }
      return;
    }
    yield {
      type: "error",
      error: `Stream interrupted: ${e instanceof Error ? e.message : "Unknown error"}`,
    };
  }
}
