// Shared transport for every Anthropic-wire provider (anthropic / deepseek /
// minimax / mimo), backed by the official @anthropic-ai/sdk. Replaced the
// hand-rolled SSE core in #91 after MiMo validated the SDK path against real traffic.
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
import { parseTextToolInvocations } from "@/lib/agent/text-tool-invocation";

export interface AnthropicSdkHooks {
  /** Appended to config.baseUrl before the SDK's own `/v1/messages` suffix.
   *  e.g. MiMo's endpoint is `/anthropic/v1/messages` → suffix `/anthropic`. */
  baseUrlSuffix?: string;
  /** `apiKey` → x-api-key header (real Anthropic); `bearer` → Authorization: Bearer. */
  auth?: "apiKey" | "bearer";
  /** Remove the SDK's default `anthropic-version` header (parity with providers
   *  whose anthropic-compatible endpoint doesn't expect it). */
  stripAnthropicVersion?: boolean;
  /** Mark system + last tool + a rolling point in messages with cache_control. */
  promptCache?: boolean;
}

const CACHE_CONTROL_EPHEMERAL = { type: "ephemeral" } as const;

/**
 * 历史上的滚动 cache breakpoint 位置(返回 -1 表示不打)。
 *
 * 为什么必须打:Anthropic 只缓存**显式声明了 breakpoint 的前缀**。此前只打了
 * system 与 tools 最后一项,于是 cache_read 恒等于「system+tools」那点量,而
 * 真正的大头 —— 长任务里 70%+ 的历史 —— 每轮全价 prefill。实测某轮
 * prompt 102244 中 hist 75953,而 cached 恒为 18048、命中率 15-18%。
 *
 * 为什么打在「倒数第二个 user turn 的前一条」:
 * 历史本身是 append-only 的,但 elideStaleObservations 每轮会把**上一轮**那条
 * 完整快照翻成 marker(它只保最新一条完整)。也就是说每轮有且仅有一个旧位置的
 * 字节会变,就是倒数第二个 user turn。断点必须落在它**之前**,否则每轮都命中
 * 不了、还要按 1.25x 重写整段 —— 比不缓存更贵。
 *
 * 落后一轮不浪费:这一轮被排除的那条,下一轮就已经是稳定 marker,自然被纳入。
 *
 * 少于 3 个 user turn 时不打:Anthropic 有最小可缓存长度(1024 tokens 起),
 * 短历史打了也不会生效,徒增一个 breakpoint 配额。
 */
function messageCacheBreakpointIndex(messages: Anthropic.MessageParam[]): number {
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") userIndices.push(i);
  }
  if (userIndices.length < 3) return -1;
  return userIndices[userIndices.length - 2] - 1;
}

/** 在指定 message 的最后一个可承载块上挂 cache_control(thinking 块不能挂)。 */
function withMessageCacheBreakpoint(
  messages: Anthropic.MessageParam[],
  index: number,
): Anthropic.MessageParam[] {
  if (index < 0 || index >= messages.length) return messages;
  const target = messages[index];
  const blocks: Anthropic.ContentBlockParam[] =
    typeof target.content === "string"
      ? [{ type: "text", text: target.content }]
      : [...target.content];

  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    // thinking / redacted_thinking 不接受 cache_control(SDK 类型与 API 都拒绝)。
    if (block.type === "thinking" || block.type === "redacted_thinking") continue;
    blocks[i] = { ...block, cache_control: CACHE_CONTROL_EPHEMERAL };
    const out = [...messages];
    out[index] = { ...target, content: blocks };
    return out;
  }
  return messages;
}

/**
 * anthropic-wire 的 max_tokens 是必填字段（官方 SDK 类型 + API 强制）。当模型
 * 既没有用户手填 maxTokens、registry 也没填 maxOutputTokens 时（当前仅 stepfun）
 * 用此兜底。取值远大于历史的 4096（避免长思考被截断），又远小于已知 anthropic-wire
 * 模型的最小真实输出上限 64K（不会越界 400）。模型一旦有官方真实值就走 maxOutputTokens。
 */
const ANTHROPIC_WIRE_FALLBACK_MAX_TOKENS = 32_768;

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
      if (block.type === "thinking") {
        return {
          type: "thinking" as const,
          thinking: block.thinking,
          ...(block.signature ? { signature: block.signature } : {}),
        };
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

  const { system: systemText, messages: rawSdkMessages } = toSdkParams(messages);
  const sdkMessages = promptCache
    ? withMessageCacheBreakpoint(rawSdkMessages, messageCacheBreakpointIndex(rawSdkMessages))
    : rawSdkMessages;
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
  // Prompt-cache counters (cache_read_input_tokens / cache_creation_input_tokens).
  // Anthropic-official reports them in message_start; keep the latest seen so a
  // late message_delta can override (parity with the input_tokens quirk below).
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let stopReason: "end" | "tool_calls" | "length" | undefined;
  const toolBlocks = new Set<number>();
  const thinkingSignatures = new Map<number, string>();
  const pendingTextBlocks = new Map<number, string>();
  let convertedTextToolInvocation = false;

  try {
    const stream = await client.messages.create(
      {
        model: config.model,
        max_tokens: config.maxTokens ?? config.maxOutputTokens ?? ANTHROPIC_WIRE_FALLBACK_MAX_TOKENS,
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
        const startUsage = event.message.usage;
        usage = { inputTokens: startUsage.input_tokens ?? 0, outputTokens: 0 };
        cacheReadTokens = startUsage.cache_read_input_tokens ?? 0;
        cacheCreationTokens = startUsage.cache_creation_input_tokens ?? 0;
      } else if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") {
          toolBlocks.add(event.index);
          yield {
            type: "tool-call-start",
            id: event.content_block.id,
            index: event.index,
            name: event.content_block.name,
          };
        } else if (event.content_block.type === "thinking") {
          thinkingSignatures.set(event.index, "");
          yield { type: "thinking-start", replay: true };
        } else if (event.content_block.type === "text") {
          pendingTextBlocks.set(event.index, event.content_block.text ?? "");
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          const pending = pendingTextBlocks.get(event.index);
          if (pending !== undefined) {
            const next = pending + event.delta.text;
            const probe = next.trimStart();
            if (
              probe.length === 0 ||
              "<tool_invocation".startsWith(probe) ||
              probe.startsWith("<tool_invocation")
            ) {
              pendingTextBlocks.set(event.index, next);
            } else {
              pendingTextBlocks.delete(event.index);
              yield { type: "text-delta", text: next };
            }
          } else {
            yield { type: "text-delta", text: event.delta.text };
          }
        } else if (event.delta.type === "input_json_delta") {
          yield { type: "tool-call-delta", index: event.index, argsDelta: event.delta.partial_json };
        } else if (event.delta.type === "thinking_delta") {
          yield { type: "thinking-delta", text: event.delta.thinking };
        } else if (event.delta.type === "signature_delta") {
          const prev = thinkingSignatures.get(event.index) ?? "";
          thinkingSignatures.set(event.index, prev + event.delta.signature);
        }
      } else if (event.type === "content_block_stop") {
        if (pendingTextBlocks.has(event.index)) {
          const text = pendingTextBlocks.get(event.index)!;
          pendingTextBlocks.delete(event.index);
          const invocations = parseTextToolInvocations(text);
          if (invocations.length > 0) {
            convertedTextToolInvocation = true;
            for (const invocation of invocations) {
              yield {
                type: "tool-call-start",
                id: invocation.id,
                index: event.index,
                name: invocation.name,
              };
              const argsJson = JSON.stringify(invocation.args ?? {});
              if (argsJson !== "{}") {
                yield { type: "tool-call-delta", index: event.index, argsDelta: argsJson };
              }
              yield { type: "tool-call-end", index: event.index };
            }
          } else if (text) {
            yield { type: "text-delta", text };
          }
        } else if (toolBlocks.has(event.index)) {
          yield { type: "tool-call-end", index: event.index };
          toolBlocks.delete(event.index);
        } else if (thinkingSignatures.has(event.index)) {
          const sig = thinkingSignatures.get(event.index)!;
          yield { type: "thinking-end", ...(sig ? { signature: sig } : {}) };
          thinkingSignatures.delete(event.index);
        }
      } else if (event.type === "message_delta") {
        stopReason = mapStopReason(event.delta.stop_reason);
        if (convertedTextToolInvocation && stopReason !== "length") {
          stopReason = "tool_calls";
        }
        // MiMo / MiniMax report the real prompt size only in this terminal
        // delta (message_start carried 0); Anthropic-official sends it up front
        // and leaves this null. Prefer a positive late value, else keep what
        // message_start already gave us. (#59)
        const deltaInput = event.usage.input_tokens;
        if (event.usage.cache_read_input_tokens != null) {
          cacheReadTokens = event.usage.cache_read_input_tokens;
        }
        if (event.usage.cache_creation_input_tokens != null) {
          cacheCreationTokens = event.usage.cache_creation_input_tokens;
        }
        usage = {
          inputTokens: deltaInput != null && deltaInput > 0 ? deltaInput : usage?.inputTokens ?? 0,
          outputTokens: event.usage.output_tokens ?? 0,
        };
      }
    }

    if (convertedTextToolInvocation && stopReason !== "length") {
      stopReason = "tool_calls";
    }
    // Attach cache counters only when the provider actually reported cache
    // activity (read or write) — absent otherwise so the UI can distinguish
    // "no cache info" from a legitimate 0% hit. Anthropic's input_tokens
    // excludes cached portions, so the ratio denominator is the full sum.
    const finalUsage = usage
      ? cacheReadTokens > 0 || cacheCreationTokens > 0
        ? {
            ...usage,
            cachedTokens: cacheReadTokens,
            promptTotalTokens: usage.inputTokens + cacheReadTokens + cacheCreationTokens,
          }
        : usage
      : undefined;
    yield { type: "done", stopReason, usage: finalUsage };
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
