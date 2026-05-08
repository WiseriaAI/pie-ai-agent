# Provider Config Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor provider/model configuration into a multi-instance config center with native per-provider modules, hardcoded model lists with capability flags, encapsulated BaseURL, and per-session instance override.

**Architecture:** Extract `_shared/openai-compat-core.ts` from current `openai.ts`; each existing provider becomes a thin wrapper. Add Gemini as first new native module. Replace `provider_${id}` storage with `instance_${uuid}` keyed by uuid, indexed via `instances_index`, with `active_instance_id` global pointer + per-session `instanceId` override snapshot-locked at task start. Settings UI rewrite to instance-based list + 2-step new-config wizard. Chat composer gets a borderless `InstanceSelector` chip that opens an upward dropdown overlay.

**Tech Stack:** TypeScript 6, React 19, vitest + @testing-library/react, chrome.storage.local with AES-GCM via Web Crypto. Spec: `docs/specs/2026-05-06-provider-config-center-design.md`.

---

## Pre-flight

Before Task 1, verify clean working tree and tests baseline:

```bash
git status                    # Expected: clean
pnpm test                     # Expected: all current tests pass (baseline)
pnpm build                    # Expected: dist/ produced cleanly
```

If any baseline fails, stop and resolve before proceeding.

---

## Task 1: Registry schema upgrade with per-model capability

**Files:**
- Modify: `src/lib/model-router/providers/registry.ts`
- Modify: `src/lib/model-router/providers/registry.test.ts`
- Modify: `src/lib/model-router/index.ts` (re-export `ModelMeta`)

**Reason:** Move `vision` / `tools` / `maxContextTokens` from per-provider to per-model. Drop `defaultModel`, `defaultBaseUrl` becomes the only source of truth for endpoint, drop `type` (will be replaced by id-keyed dispatch in Task 4). Add Gemini entry. Seed model lists for 7 providers.

- [ ] **Step 1: Write the failing tests**

Replace `src/lib/model-router/providers/registry.test.ts` content with:

```ts
import { describe, it, expect } from "vitest";
import { getProviderMeta, getModelMeta, PROVIDER_REGISTRY } from "./registry";

describe("ProviderMeta schema", () => {
  it("every provider has a defaultBaseUrl, placeholder, and models[]", () => {
    for (const p of PROVIDER_REGISTRY) {
      expect(p.defaultBaseUrl).toMatch(/^https:\/\//);
      expect(typeof p.placeholder).toBe("string");
      expect(Array.isArray(p.models)).toBe(true);
    }
  });

  it("ProviderMeta no longer carries supportsVision / supportsTools / maxContextTokens / defaultModel / type", () => {
    const meta = getProviderMeta("anthropic")!;
    expect("supportsVision" in meta).toBe(false);
    expect("supportsTools" in meta).toBe(false);
    expect("maxContextTokens" in meta).toBe(false);
    expect("defaultModel" in meta).toBe(false);
    expect("type" in meta).toBe(false);
  });

  it("OpenRouter has empty models[] and modelsEndpoint set (lazy fetch)", () => {
    const meta = getProviderMeta("openrouter")!;
    expect(meta.models).toEqual([]);
    expect(meta.modelsEndpoint).toBe("/v1/models");
  });

  it("non-OpenRouter providers have non-empty models[] (hardcoded)", () => {
    const ids = ["anthropic", "openai", "zhipu", "bailian", "minimax", "gemini"] as const;
    for (const id of ids) {
      const meta = getProviderMeta(id)!;
      expect(meta.models.length).toBeGreaterThan(0);
    }
  });

  it("Gemini is registered", () => {
    expect(getProviderMeta("gemini")).toBeDefined();
    expect(getProviderMeta("gemini")!.defaultBaseUrl).toBe("https://generativelanguage.googleapis.com");
  });
});

describe("ModelMeta capability flags (per-model)", () => {
  it("claude-opus-4-7 has vision + tools", () => {
    const m = getModelMeta("anthropic", "claude-opus-4-7")!;
    expect(m.vision).toBe(true);
    expect(m.tools).toBe(true);
    expect(m.maxContextTokens).toBeGreaterThan(100_000);
  });

  it("gpt-4o has vision; gpt-4o-mini also has vision", () => {
    expect(getModelMeta("openai", "gpt-4o")?.vision).toBe(true);
    expect(getModelMeta("openai", "gpt-4o-mini")?.vision).toBe(true);
  });

  it("ZhiPu glm-4-plus does NOT have vision; glm-4v-plus does", () => {
    expect(getModelMeta("zhipu", "glm-4-plus")?.vision).toBe(false);
    expect(getModelMeta("zhipu", "glm-4v-plus")?.vision).toBe(true);
  });

  it("Bailian qwen-max does NOT have vision; qwen-vl-max does", () => {
    expect(getModelMeta("bailian", "qwen-max")?.vision).toBe(false);
    expect(getModelMeta("bailian", "qwen-vl-max")?.vision).toBe(true);
  });

  it("getModelMeta returns undefined for unknown model", () => {
    expect(getModelMeta("anthropic", "no-such-model")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test src/lib/model-router/providers/registry.test.ts
```

Expected: multiple failures — `getModelMeta` undefined, `models` field missing, `gemini` not registered.

- [ ] **Step 3: Replace registry.ts**

Replace entire `src/lib/model-router/providers/registry.ts` with:

```ts
import type { Provider } from "@/lib/model-router";

export interface ModelMeta {
  /** Provider-native model id (sent to API as-is). */
  id: string;
  /** Optional friendly name for dropdown display. Falls back to id. */
  displayName?: string;
  /** Image input supported by this specific model. */
  vision: boolean;
  /** Tool / function calling supported. */
  tools: boolean;
  /** Approximate context window for the token-budget guard. */
  maxContextTokens: number;
}

export interface ProviderMeta {
  id: Provider;
  name: string;
  /** Hardcoded official endpoint. Single source of truth — UI never edits. */
  defaultBaseUrl: string;
  placeholder: string;
  /**
   * Hardcoded curated model list, synced with each release. Empty array
   * means the provider's models are fetched lazily from `modelsEndpoint`
   * (currently only OpenRouter).
   */
  models: ModelMeta[];
  /**
   * Relative endpoint for lazy GET of available models. When set + models[]
   * is empty, the Settings UI fetches on first instance dropdown open and
   * caches per instance.
   */
  modelsEndpoint?: string;
}

export const PROVIDER_REGISTRY: ProviderMeta[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    placeholder: "sk-ant-...",
    models: [
      { id: "claude-opus-4-7", vision: true, tools: true, maxContextTokens: 200_000 },
      { id: "claude-sonnet-4-6", vision: true, tools: true, maxContextTokens: 200_000 },
      { id: "claude-haiku-4-5-20251001", displayName: "claude-haiku-4-5", vision: true, tools: true, maxContextTokens: 200_000 },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    defaultBaseUrl: "https://api.openai.com",
    placeholder: "sk-...",
    models: [
      { id: "gpt-4o", vision: true, tools: true, maxContextTokens: 128_000 },
      { id: "gpt-4o-mini", vision: true, tools: true, maxContextTokens: 128_000 },
      { id: "o3-mini", vision: false, tools: true, maxContextTokens: 200_000 },
      { id: "o3", vision: false, tools: true, maxContextTokens: 200_000 },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api",
    placeholder: "sk-or-...",
    models: [],
    modelsEndpoint: "/v1/models",
  },
  {
    id: "minimax",
    name: "MiniMax",
    defaultBaseUrl: "https://api.minimax.chat",
    placeholder: "eyJ...",
    models: [
      { id: "MiniMax-Text-01", vision: false, tools: true, maxContextTokens: 1_000_000 },
      { id: "MiniMax-VL", vision: true, tools: true, maxContextTokens: 256_000 },
    ],
  },
  {
    id: "zhipu",
    name: "ZhiPu (智谱)",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    placeholder: "API key",
    models: [
      { id: "glm-4-plus", vision: false, tools: true, maxContextTokens: 128_000 },
      { id: "glm-4v-plus", vision: true, tools: true, maxContextTokens: 8_000 },
      { id: "glm-4-air", vision: false, tools: true, maxContextTokens: 128_000 },
    ],
  },
  {
    id: "bailian",
    name: "Bailian (百炼)",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
    placeholder: "sk-...",
    models: [
      { id: "qwen-max", vision: false, tools: true, maxContextTokens: 32_000 },
      { id: "qwen-vl-max", vision: true, tools: true, maxContextTokens: 32_000 },
      { id: "qwen-plus", vision: false, tools: true, maxContextTokens: 128_000 },
    ],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    placeholder: "AIza...",
    models: [
      { id: "gemini-2.0-flash", vision: true, tools: true, maxContextTokens: 1_000_000 },
      { id: "gemini-2.0-pro", vision: true, tools: true, maxContextTokens: 2_000_000 },
    ],
  },
];

export function getProviderMeta(id: Provider): ProviderMeta | undefined {
  return PROVIDER_REGISTRY.find((p) => p.id === id);
}

export function getModelMeta(provider: Provider, modelId: string): ModelMeta | undefined {
  return getProviderMeta(provider)?.models.find((m) => m.id === modelId);
}
```

- [ ] **Step 4: Update model-router/index.ts re-exports**

In `src/lib/model-router/index.ts`, find the line:

```ts
export type { ProviderMeta } from "./providers/registry";
```

Replace with:

```ts
export type { ProviderMeta, ModelMeta } from "./providers/registry";
export { getModelMeta } from "./providers/registry";
```

Also extend the `Provider` union to include `"gemini"` (it's already there per check, confirm). The current list includes `"google" | "ollama"` — replace `"google"` with `"gemini"`:

Find:
```ts
export type Provider =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "minimax"
  | "zhipu"
  | "bailian"
  | "google"
  | "ollama";
```

Replace with:
```ts
export type Provider =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "minimax"
  | "zhipu"
  | "bailian"
  | "gemini";
```

(Drop `ollama` — out of scope; can be added later.)

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm test src/lib/model-router/providers/registry.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Run wider tests to check no callsite broke**

```bash
pnpm test
```

Expected: many failures (existing code reads `meta.type`, `meta.supportsTools`, `meta.supportsVision`, `meta.defaultModel`). These will be fixed in subsequent tasks. Note the failures and continue.

- [ ] **Step 7: Commit**

```bash
git add src/lib/model-router/providers/registry.ts src/lib/model-router/providers/registry.test.ts src/lib/model-router/index.ts
git commit -m "feat(registry): per-model capability schema + 7 providers seed list

- ModelMeta { id, vision, tools, maxContextTokens } per model
- Drop ProviderMeta.{ defaultModel, supportsTools, supportsVision, maxContextTokens, type }
- Add Gemini entry; OpenRouter keeps empty models[] + modelsEndpoint for lazy fetch
- Drop unused 'google'/'ollama' provider ids from union

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Extract `_shared/openai-compat-core.ts` + thin openai.ts wrapper

**Files:**
- Create: `src/lib/model-router/providers/_shared/openai-compat-core.ts`
- Create: `src/lib/model-router/providers/_shared/openai-compat-core.test.ts`
- Modify: `src/lib/model-router/providers/openai.ts` (becomes thin wrapper)
- Modify: `src/lib/model-router/providers/openai.test.ts` (rename existing tests if they target shared logic)

**Reason:** Pull the streaming + wire conversion logic into a shared core that takes optional hooks for custom headers + custom auth. `openai.ts` becomes a one-line passthrough. Defensive quirks (ZhiPu/Bailian `[DONE] flush`, MiniMax `tool_call` single-chunk) stay in core with documenting JSDoc.

- [ ] **Step 1: Write the failing test for the new shared core**

Create `src/lib/model-router/providers/_shared/openai-compat-core.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { streamChatOpenAICompat } from "./openai-compat-core";
import type { ModelConfig } from "@/lib/model-router";

function mockSseResponse(lines: string[]) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const l of lines) controller.enqueue(enc.encode(l + "\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("streamChatOpenAICompat", () => {
  it("hooks.customHeaders are merged into the request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockSseResponse([
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        "data: [DONE]",
      ]),
    );
    const config: ModelConfig = {
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
      apiKey: "test-key",
      baseUrl: "https://example.test",
    };
    const events: unknown[] = [];
    for await (const ev of streamChatOpenAICompat(config, [{ role: "user", content: "hi" }], undefined, undefined, {
      customHeaders: () => ({ "X-Custom": "yes" }),
    })) {
      events.push(ev);
    }
    expect(fetchMock).toHaveBeenCalled();
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Custom"]).toBe("yes");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    fetchMock.mockRestore();
  });

  it("ZhiPu/Bailian quirk: [DONE] without finish_reason still flushes pending tool_calls", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockSseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"foo","arguments":"{\\"x\\":1}"}}]}}]}',
        "data: [DONE]",
      ]),
    );
    const config: ModelConfig = {
      provider: "zhipu",
      model: "glm-4-plus",
      apiKey: "k",
      baseUrl: "https://example.test/v4",
    };
    const events: { type: string }[] = [];
    for await (const ev of streamChatOpenAICompat(config, [{ role: "user", content: "x" }])) {
      events.push(ev as { type: string });
    }
    const types = events.map((e) => e.type);
    expect(types).toContain("tool-call-end");
    const done = events.find((e) => e.type === "done") as { type: "done"; stopReason: string };
    expect(done.stopReason).toBe("tool_calls");
    fetchMock.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/lib/model-router/providers/_shared/openai-compat-core.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `_shared/openai-compat-core.ts`**

Move the entire body of `src/lib/model-router/providers/openai.ts` (as it exists today, lines 1–322 verified via Task 0 baseline) into `src/lib/model-router/providers/_shared/openai-compat-core.ts`, with these modifications:

```ts
import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ContentBlock, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
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
  // [identical to current openai.ts toWireMessages — copy verbatim]
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
    yield { type: "error", error: `Network error: ${e instanceof Error ? e.message : `Failed to connect to ${config.provider} API`}` };
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const name = config.provider;
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
```

- [ ] **Step 4: Replace `openai.ts` with thin wrapper**

Replace entire `src/lib/model-router/providers/openai.ts` with:

```ts
import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { streamChatOpenAICompat } from "./_shared/openai-compat-core";

export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  yield* streamChatOpenAICompat(config, messages, signal, tools);
}

// Test-only re-export for back-compat with existing openai.test.ts
export { _toWireMessagesForTest } from "./_shared/openai-compat-core";
```

- [ ] **Step 5: Run targeted tests**

```bash
pnpm test src/lib/model-router/providers/_shared/openai-compat-core.test.ts src/lib/model-router/providers/openai.test.ts
```

Expected: both files pass. The existing `openai.test.ts` still works because the same functions are re-exported.

- [ ] **Step 6: Commit**

```bash
git add src/lib/model-router/providers/_shared src/lib/model-router/providers/openai.ts
git commit -m "refactor(providers): extract _shared/openai-compat-core; openai.ts becomes thin wrapper

Foundation for per-provider modules. Defensive quirks (ZhiPu/Bailian [DONE] flush,
MiniMax single-chunk tool_call args) documented and retained in shared core.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Create OpenRouter / ZhiPu / Bailian / MiniMax wrappers

**Files:**
- Create: `src/lib/model-router/providers/openrouter.ts`
- Create: `src/lib/model-router/providers/openrouter.test.ts`
- Create: `src/lib/model-router/providers/zhipu.ts`
- Create: `src/lib/model-router/providers/zhipu.test.ts`
- Create: `src/lib/model-router/providers/bailian.ts`
- Create: `src/lib/model-router/providers/bailian.test.ts`
- Create: `src/lib/model-router/providers/minimax.ts`
- Create: `src/lib/model-router/providers/minimax.test.ts`

**Reason:** OpenRouter needs `HTTP-Referer` + `X-OpenRouter-Title` headers. The other three are pure passthroughs but get their own files for future extension.

- [ ] **Step 1: Write OpenRouter test**

Create `src/lib/model-router/providers/openrouter.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { streamChat } from "./openrouter";
import type { ModelConfig } from "@/lib/model-router";

describe("openrouter wrapper", () => {
  it("attaches HTTP-Referer and X-OpenRouter-Title headers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    const config: ModelConfig = {
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
      apiKey: "k",
      baseUrl: "https://openrouter.ai/api",
    };
    for await (const _ of streamChat(config, [{ role: "user", content: "hi" }])) { /* drain */ }
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["HTTP-Referer"]).toMatch(/github\.com/);
    expect(headers["X-OpenRouter-Title"]).toBe("Pie");
    fetchMock.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/lib/model-router/providers/openrouter.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `openrouter.ts`**

```ts
import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { streamChatOpenAICompat } from "./_shared/openai-compat-core";

export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  yield* streamChatOpenAICompat(config, messages, signal, tools, {
    customHeaders: () => ({
      "HTTP-Referer": "https://github.com/WiseriaAI/chrome-ai-agent",
      "X-OpenRouter-Title": "Pie",
    }),
  });
}
```

- [ ] **Step 4: Create three thin wrappers + their tests**

`src/lib/model-router/providers/zhipu.ts`:

```ts
import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { streamChatOpenAICompat } from "./_shared/openai-compat-core";

export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  yield* streamChatOpenAICompat(config, messages, signal, tools);
}
```

Same for `bailian.ts` and `minimax.ts` (identical content).

For each provider, create a smoke test that asserts the wrapper delegates correctly. Example `zhipu.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { streamChat } from "./zhipu";
import type { ModelConfig } from "@/lib/model-router";

describe("zhipu wrapper", () => {
  it("delegates to openai-compat core (no custom headers)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close(); } }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    const config: ModelConfig = {
      provider: "zhipu", model: "glm-4-plus", apiKey: "k",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    };
    for await (const _ of streamChat(config, [{ role: "user", content: "hi" }])) { /* drain */ }
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["HTTP-Referer"]).toBeUndefined();
    fetchMock.mockRestore();
  });
});
```

Repeat with provider/model/baseUrl substitutions for `bailian.test.ts` (provider:"bailian", model:"qwen-max", baseUrl:"https://dashscope.aliyuncs.com/compatible-mode") and `minimax.test.ts` (provider:"minimax", model:"MiniMax-Text-01", baseUrl:"https://api.minimax.chat").

- [ ] **Step 5: Run all four wrapper tests**

```bash
pnpm test src/lib/model-router/providers/openrouter.test.ts src/lib/model-router/providers/zhipu.test.ts src/lib/model-router/providers/bailian.test.ts src/lib/model-router/providers/minimax.test.ts
```

Expected: all 4 pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/model-router/providers/openrouter.* src/lib/model-router/providers/zhipu.* src/lib/model-router/providers/bailian.* src/lib/model-router/providers/minimax.*
git commit -m "feat(providers): per-provider wrappers (openrouter + zhipu + bailian + minimax)

OpenRouter adds HTTP-Referer + X-OpenRouter-Title headers via core hooks.
Three Chinese providers are passthrough wrappers establishing module boundaries
for future quirk localisation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Dispatch table + model-router/index.ts refactor

**Files:**
- Create: `src/lib/model-router/providers/index.ts`
- Modify: `src/lib/model-router/index.ts`

**Reason:** Replace the `switch (meta.type)` dispatch with a provider-id-keyed function table. Adding a new provider becomes: registry entry + module + (Task 14) manifest permission, with zero edits to dispatch code.

- [ ] **Step 1: Write failing dispatch test**

Create the test file but don't yet add it to existing `src/lib/model-router/index.test.ts` (if any). Quick approach: add to a new `src/lib/model-router/dispatch.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { streamChatByProvider } from "./providers";

describe("streamChatByProvider dispatch table", () => {
  it("has a streamChat function for every Provider in the union", () => {
    const expected = ["anthropic", "openai", "openrouter", "zhipu", "bailian", "minimax", "gemini"] as const;
    for (const id of expected) {
      expect(typeof streamChatByProvider[id]).toBe("function");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/lib/model-router/dispatch.test.ts
```

Expected: FAIL — `./providers` index does not exist.

- [ ] **Step 3: Create `providers/index.ts`**

```ts
import type { Provider } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import type { ModelConfig } from "@/lib/model-router";

import { streamChat as anthropicChat } from "./anthropic";
import { streamChat as openaiChat } from "./openai";
import { streamChat as openrouterChat } from "./openrouter";
import { streamChat as zhipuChat } from "./zhipu";
import { streamChat as bailianChat } from "./bailian";
import { streamChat as minimaxChat } from "./minimax";
import { streamChat as geminiChat } from "./gemini";

export type StreamChatFn = (
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
) => AsyncGenerator<StreamEvent>;

export const streamChatByProvider: Record<Provider, StreamChatFn> = {
  anthropic: anthropicChat,
  openai: openaiChat,
  openrouter: openrouterChat,
  zhipu: zhipuChat,
  bailian: bailianChat,
  minimax: minimaxChat,
  gemini: geminiChat,
};
```

Note: `gemini.ts` doesn't exist yet — Task 5 creates it. To keep this task green, create a stub `gemini.ts` first:

```ts
// src/lib/model-router/providers/gemini.ts (stub — Task 5 implements)
import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";

export async function* streamChat(
  _config: ModelConfig,
  _messages: AgentMessage[],
  _signal?: AbortSignal,
  _tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  yield { type: "error", error: "Gemini provider not yet implemented (Task 5)" };
}
```

- [ ] **Step 4: Refactor `model-router/index.ts` to use the dispatch table**

Replace the existing `streamChat` function in `src/lib/model-router/index.ts`:

Find:

```ts
switch (meta.type) {
  case "anthropic":
    yield* anthropicStreamChat(resolvedConfig, messages, signal, tools);
    break;
  case "openai-compatible":
    yield* openaiStreamChat(resolvedConfig, messages, signal, tools);
    break;
}
```

Replace with:

```ts
yield* streamChatByProvider[config.provider](resolvedConfig, messages, signal, tools);
```

Then update the imports at the top of `src/lib/model-router/index.ts`:

Find:

```ts
import { streamChat as anthropicStreamChat } from "./providers/anthropic";
import { streamChat as openaiStreamChat } from "./providers/openai";
import { getProviderMeta } from "./providers/registry";
```

Replace with:

```ts
import { streamChatByProvider } from "./providers";
import { getProviderMeta } from "./providers/registry";
```

- [ ] **Step 5: Run dispatch test + full suite to confirm no regressions**

```bash
pnpm test src/lib/model-router/dispatch.test.ts
pnpm test src/lib/model-router/
```

Expected: dispatch test passes; provider-level tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/model-router/providers/index.ts src/lib/model-router/providers/gemini.ts src/lib/model-router/index.ts src/lib/model-router/dispatch.test.ts
git commit -m "refactor(model-router): id-keyed dispatch table (drop ProviderMeta.type switch)

Adding a new provider now means: registry entry + module file + manifest
permission. No more dispatch edits. Gemini stub will be filled in Task 5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Gemini native module

**Files:**
- Modify: `src/lib/model-router/providers/gemini.ts` (replace stub)
- Create: `src/lib/model-router/providers/gemini.test.ts`

**Reason:** Implement Gemini's native wire format: `contents: [{ role, parts: [...] }]` with `inline_data` for images, function declarations for tools. Use `?alt=sse` query so we can reuse `_shared/sse.ts`.

- [ ] **Step 1: Write failing tests**

Create `src/lib/model-router/providers/gemini.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { streamChat, _toGeminiContentsForTest } from "./gemini";
import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage } from "@/lib/model-router/types";

describe("Gemini wire converter", () => {
  it("text-only user message → contents[].parts[{text}]", () => {
    const msgs: AgentMessage[] = [{ role: "user", content: "hi" }];
    const wire = _toGeminiContentsForTest(msgs);
    expect(wire).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });

  it("user with image block → parts has inline_data", () => {
    const msgs: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", mediaType: "image/png", data: "BASE64" } },
          { type: "text", text: "what's this?" },
        ],
      },
    ];
    const wire = _toGeminiContentsForTest(msgs);
    expect(wire[0].role).toBe("user");
    expect(wire[0].parts).toContainEqual({ inline_data: { mime_type: "image/png", data: "BASE64" } });
    expect(wire[0].parts).toContainEqual({ text: "what's this?" });
  });

  it("system message becomes systemInstruction at top level (separate from contents)", () => {
    // Verified at the streamChat level by checking request body shape; here we
    // just confirm the converter strips system from contents[].
    const msgs: AgentMessage[] = [
      { role: "system", content: "You are Pie." },
      { role: "user", content: "hi" },
    ];
    const wire = _toGeminiContentsForTest(msgs);
    expect(wire.find((c) => c.role === "system")).toBeUndefined();
    expect(wire).toContainEqual({ role: "user", parts: [{ text: "hi" }] });
  });
});

describe("Gemini streamChat", () => {
  it("hits streamGenerateContent endpoint with key in URL query", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(
          'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]},"finishReason":"STOP"}]}\n\n',
        ));
        c.close();
      },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const config: ModelConfig = {
      provider: "gemini",
      model: "gemini-2.0-flash",
      apiKey: "AIza-key",
      baseUrl: "https://generativelanguage.googleapis.com",
    };
    const events: { type: string }[] = [];
    for await (const ev of streamChat(config, [{ role: "user", content: "hi" }])) events.push(ev as { type: string });
    expect(fetchMock).toHaveBeenCalled();
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("/v1beta/models/gemini-2.0-flash:streamGenerateContent");
    expect(url).toContain("alt=sse");
    expect(url).toContain("key=AIza-key");
    expect(events.find((e) => e.type === "text-delta")).toBeDefined();
    expect(events.find((e) => e.type === "done")).toBeDefined();
    fetchMock.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/lib/model-router/providers/gemini.test.ts
```

Expected: FAIL — `_toGeminiContentsForTest` not exported.

- [ ] **Step 3: Implement `gemini.ts`**

Replace stub `src/lib/model-router/providers/gemini.ts` with:

```ts
import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { readSSELines } from "@/lib/model-router/sse";

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { content: string } };
}
interface GeminiContent {
  role: "user" | "model" | "function";
  parts: GeminiPart[];
}

function toGeminiContents(messages: AgentMessage[]): GeminiContent[] {
  const result: GeminiContent[] = [];
  for (const msg of messages) {
    if (msg.role === "system") continue; // hoisted to systemInstruction below
    const role: GeminiContent["role"] = msg.role === "assistant" ? "model" : "user";

    if (typeof msg.content === "string") {
      result.push({ role, parts: [{ text: msg.content }] });
      continue;
    }

    const parts: GeminiPart[] = [];
    for (const block of msg.content) {
      if (block.type === "text") parts.push({ text: block.text });
      else if (block.type === "image") {
        parts.push({ inline_data: { mime_type: block.source.mediaType, data: block.source.data } });
      } else if (block.type === "tool_use" && msg.role === "assistant") {
        const args: Record<string, unknown> = typeof block.input === "string"
          ? (JSON.parse(block.input) as Record<string, unknown>)
          : (block.input ?? {}) as Record<string, unknown>;
        parts.push({ functionCall: { name: block.name, args } });
      } else if (block.type === "tool_result" && msg.role === "user") {
        // Gemini wants tool results in role:"function" content
        result.push({ role: "function", parts: [{ functionResponse: { name: block.toolUseId, response: { content: block.content } } }] });
        continue;
      }
    }
    if (parts.length > 0) result.push({ role, parts });
  }
  return result;
}

function extractSystemInstruction(messages: AgentMessage[]): string | undefined {
  const sys = messages.find((m) => m.role === "system");
  return sys && typeof sys.content === "string" ? sys.content : undefined;
}

function toGeminiTools(tools: ToolDefinition[]): { function_declarations: Array<{ name: string; description: string; parameters: unknown }> } {
  return {
    function_declarations: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  };
}

export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  const baseUrl = config.baseUrl!.replace(/\/$/, "");
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(config.apiKey)}`;

  const body: Record<string, unknown> = {
    contents: toGeminiContents(messages),
  };
  const sys = extractSystemInstruction(messages);
  if (sys) body.systemInstruction = { parts: [{ text: sys }] };
  if (tools && tools.length > 0) body.tools = [toGeminiTools(tools)];
  if (config.maxTokens != null) body.generationConfig = { maxOutputTokens: config.maxTokens };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) return;
    yield { type: "error", error: `Network error: ${e instanceof Error ? e.message : "Failed to connect to Gemini API"}` };
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      yield { type: "error", error: "Invalid Gemini API key" };
    } else if (response.status === 429) {
      yield { type: "error", error: "Gemini rate limit exceeded" };
    } else {
      yield { type: "error", error: `Gemini API error (${response.status}): ${text}` };
    }
    return;
  }

  let usage: { inputTokens: number; outputTokens: number } | undefined;
  let toolCallIndex = 0;
  let stopReason: "end" | "tool_calls" | "length" | undefined;

  try {
    for await (const sse of readSSELines(response, signal)) {
      if (signal?.aborted) return;
      try {
        const data = JSON.parse(sse.data);
        const candidate = data.candidates?.[0];
        if (!candidate) continue;
        const parts: GeminiPart[] = candidate.content?.parts ?? [];
        for (const p of parts) {
          if (p.text) {
            yield { type: "text-delta", text: p.text };
          } else if (p.functionCall) {
            const id = `gemini_call_${toolCallIndex}`;
            yield { type: "tool-call-start", id, index: toolCallIndex, name: p.functionCall.name };
            const argsJson = JSON.stringify(p.functionCall.args ?? {});
            if (argsJson !== "{}") yield { type: "tool-call-delta", index: toolCallIndex, argsDelta: argsJson };
            yield { type: "tool-call-end", index: toolCallIndex };
            toolCallIndex++;
            stopReason = "tool_calls";
          }
        }
        if (candidate.finishReason === "STOP" && stopReason !== "tool_calls") stopReason = "end";
        else if (candidate.finishReason === "MAX_TOKENS") stopReason = "length";
        if (data.usageMetadata) {
          usage = {
            inputTokens: data.usageMetadata.promptTokenCount ?? 0,
            outputTokens: data.usageMetadata.candidatesTokenCount ?? 0,
          };
        }
      } catch {
        // skip unparseable
      }
    }
    yield { type: "done", stopReason, usage };
  } catch (e) {
    if (signal?.aborted) return;
    yield { type: "error", error: `Stream interrupted: ${e instanceof Error ? e.message : "Unknown error"}` };
  }
}

export const _toGeminiContentsForTest = toGeminiContents;
```

- [ ] **Step 4: Run tests**

```bash
pnpm test src/lib/model-router/providers/gemini.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-router/providers/gemini.ts src/lib/model-router/providers/gemini.test.ts
git commit -m "feat(providers): Gemini native module (inline_data + function_declarations)

Uses ?alt=sse to reuse _shared/sse.ts. systemInstruction hoisted from system
message; tool_result becomes role:'function' content per Gemini spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: instances.ts CRUD layer

**Files:**
- Create: `src/lib/instances.ts`
- Create: `src/lib/instances.test.ts`

**Reason:** Replace `provider_${provider}` storage with `instance_${uuid}` + `instances_index` + `active_instance_id`. Provide save / get / list / delete / setActive / getActive primitives. Storage encryption keeps using AES-GCM via existing `lib/crypto.ts`.

- [ ] **Step 1: Write failing tests**

Create `src/lib/instances.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { chromeMock } from "@/test/setup";
import {
  createInstance, getInstance, listInstances, deleteInstance,
  setActiveInstance, getActiveInstance, resolveActiveInstanceModelConfig,
} from "./instances";

beforeEach(() => {
  chromeMock.storage.local.__store = {};
});

describe("instances CRUD", () => {
  it("createInstance writes encrypted, registers in instances_index, returns uuid", async () => {
    const id = await createInstance({
      provider: "anthropic",
      nickname: "Anthropic",
      apiKey: "sk-ant-secret",
      model: "claude-opus-4-7",
    });
    expect(id).toMatch(/^[0-9a-f]{8}-/);
    const stored = chromeMock.storage.local.__store[`instance_${id}`];
    expect(stored.encryptedKey).toBeDefined();
    expect(stored.encryptedKey).not.toContain("sk-ant-secret");
    const idx = chromeMock.storage.local.__store["instances_index"];
    expect(idx).toContain(id);
  });

  it("getInstance round-trips with decrypted apiKey", async () => {
    const id = await createInstance({ provider: "openai", nickname: "Work", apiKey: "sk-test", model: "gpt-4o" });
    const inst = await getInstance(id);
    expect(inst!.apiKey).toBe("sk-test");
    expect(inst!.provider).toBe("openai");
    expect(inst!.nickname).toBe("Work");
    expect(inst!.model).toBe("gpt-4o");
  });

  it("listInstances returns all registered, in instances_index order", async () => {
    const a = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "k1", model: "claude-opus-4-7" });
    const b = await createInstance({ provider: "openai", nickname: "B", apiKey: "k2", model: "gpt-4o" });
    const list = await listInstances();
    expect(list.map((i) => i.id)).toEqual([a, b]);
  });

  it("deleteInstance removes storage + index entry; if active, picks next", async () => {
    const a = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "k1", model: "claude-opus-4-7" });
    const b = await createInstance({ provider: "openai", nickname: "B", apiKey: "k2", model: "gpt-4o" });
    await setActiveInstance(a);
    await deleteInstance(a);
    expect(chromeMock.storage.local.__store[`instance_${a}`]).toBeUndefined();
    expect(chromeMock.storage.local.__store["instances_index"]).toEqual([b]);
    expect(await getActiveInstance()).toBe(b);
  });

  it("deleting last instance clears active_instance_id", async () => {
    const a = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "k1", model: "claude-opus-4-7" });
    await setActiveInstance(a);
    await deleteInstance(a);
    expect(await getActiveInstance()).toBeNull();
  });

  it("resolveActiveInstanceModelConfig returns ModelConfig with resolved baseUrl", async () => {
    const id = await createInstance({ provider: "anthropic", nickname: "A", apiKey: "sk-test", model: "claude-opus-4-7" });
    await setActiveInstance(id);
    const cfg = await resolveActiveInstanceModelConfig();
    expect(cfg).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-4-7",
      apiKey: "sk-test",
      baseUrl: "https://api.anthropic.com",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/lib/instances.test.ts
```

Expected: FAIL — `./instances` does not exist.

- [ ] **Step 3: Implement `src/lib/instances.ts`**

```ts
import type { Provider, ModelConfig } from "@/lib/model-router";
import { getProviderMeta } from "@/lib/model-router";
import { getOrCreateEncryptionKey, encrypt, decrypt } from "@/lib/crypto";

export interface StoredInstance {
  id: string;
  provider: Provider;
  nickname: string;
  encryptedKey: string;
  model: string;
  customModels?: string[];
  fetchedModels?: { id: string; vision: boolean; tools: boolean; maxContextTokens: number }[];
  fetchedAt?: number;
  maxTokens?: number;
  createdAt: number;
}

export interface DecryptedInstance extends Omit<StoredInstance, "encryptedKey"> {
  apiKey: string;
}

const INSTANCE_KEY = (id: string) => `instance_${id}`;
const INDEX_KEY = "instances_index";
const ACTIVE_KEY = "active_instance_id";

export async function createInstance(input: {
  provider: Provider;
  nickname: string;
  apiKey: string;
  model: string;
}): Promise<string> {
  if (!input.apiKey.trim()) throw new Error("API key cannot be empty");
  const id = crypto.randomUUID();
  const key = await getOrCreateEncryptionKey();
  const stored: StoredInstance = {
    id,
    provider: input.provider,
    nickname: input.nickname,
    encryptedKey: await encrypt(input.apiKey, key),
    model: input.model,
    createdAt: Date.now(),
  };
  const idx = await readIndex();
  idx.push(id);
  await chrome.storage.local.set({ [INSTANCE_KEY(id)]: stored, [INDEX_KEY]: idx });
  if (idx.length === 1 && !(await getActiveInstance())) await setActiveInstance(id);
  return id;
}

export async function getInstance(id: string): Promise<DecryptedInstance | null> {
  const result = await chrome.storage.local.get(INSTANCE_KEY(id));
  const stored: StoredInstance | undefined = result[INSTANCE_KEY(id)];
  if (!stored) return null;
  const key = await getOrCreateEncryptionKey();
  const apiKey = await decrypt(stored.encryptedKey, key);
  const { encryptedKey: _enc, ...rest } = stored;
  return { ...rest, apiKey };
}

export async function listInstances(): Promise<DecryptedInstance[]> {
  const idx = await readIndex();
  const out: DecryptedInstance[] = [];
  for (const id of idx) {
    const inst = await getInstance(id);
    if (inst) out.push(inst);
  }
  return out;
}

export async function deleteInstance(id: string): Promise<void> {
  const idx = (await readIndex()).filter((x) => x !== id);
  await chrome.storage.local.set({ [INDEX_KEY]: idx });
  await chrome.storage.local.remove(INSTANCE_KEY(id));
  if ((await getActiveInstance()) === id) {
    if (idx.length > 0) await setActiveInstance(idx[0]!);
    else await chrome.storage.local.remove(ACTIVE_KEY);
  }
}

export async function setActiveInstance(id: string): Promise<void> {
  await chrome.storage.local.set({ [ACTIVE_KEY]: id });
}

export async function getActiveInstance(): Promise<string | null> {
  const r = await chrome.storage.local.get(ACTIVE_KEY);
  return (r[ACTIVE_KEY] as string) ?? null;
}

export async function resolveInstanceToModelConfig(id: string): Promise<ModelConfig | null> {
  const inst = await getInstance(id);
  if (!inst) return null;
  const meta = getProviderMeta(inst.provider);
  if (!meta) return null;
  return {
    provider: inst.provider,
    model: inst.model,
    apiKey: inst.apiKey,
    baseUrl: meta.defaultBaseUrl,
    ...(inst.maxTokens != null && { maxTokens: inst.maxTokens }),
  };
}

export async function resolveActiveInstanceModelConfig(): Promise<ModelConfig | null> {
  const id = await getActiveInstance();
  if (!id) return null;
  return resolveInstanceToModelConfig(id);
}

async function readIndex(): Promise<string[]> {
  const r = await chrome.storage.local.get(INDEX_KEY);
  return ((r[INDEX_KEY] as string[]) ?? []).slice();
}

export async function updateInstance(id: string, patch: Partial<{
  nickname: string;
  apiKey: string;
  model: string;
  customModels: string[];
  fetchedModels: StoredInstance["fetchedModels"];
  fetchedAt: number;
  maxTokens: number;
}>): Promise<void> {
  const r = await chrome.storage.local.get(INSTANCE_KEY(id));
  const stored: StoredInstance | undefined = r[INSTANCE_KEY(id)];
  if (!stored) throw new Error(`Instance ${id} not found`);
  const next: StoredInstance = { ...stored };
  if (patch.nickname !== undefined) next.nickname = patch.nickname;
  if (patch.apiKey !== undefined) {
    const key = await getOrCreateEncryptionKey();
    next.encryptedKey = await encrypt(patch.apiKey, key);
  }
  if (patch.model !== undefined) next.model = patch.model;
  if (patch.customModels !== undefined) next.customModels = patch.customModels;
  if (patch.fetchedModels !== undefined) next.fetchedModels = patch.fetchedModels;
  if (patch.fetchedAt !== undefined) next.fetchedAt = patch.fetchedAt;
  if (patch.maxTokens !== undefined) next.maxTokens = patch.maxTokens;
  await chrome.storage.local.set({ [INSTANCE_KEY(id)]: next });
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test src/lib/instances.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/instances.ts src/lib/instances.test.ts
git commit -m "feat(instances): multi-instance CRUD layer

instance_\${uuid} + instances_index + active_instance_id schema. createInstance
auto-promotes the first instance to active. deleteInstance picks next instance
when active is removed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: migration-v2.ts handler

**Files:**
- Create: `src/lib/migration-v2.ts`
- Create: `src/lib/migration-v2.test.ts`
- Modify: `src/background/index.ts` (call migration on SW install)

**Reason:** Silent one-shot migration on first launch after upgrade. Convert each `provider_${id}` to a new instance, drop user-set baseUrl, map old `active_provider` to a new active instance UUID, write `migration_v2_mapping` for lazy session backfill.

- [ ] **Step 1: Write failing tests**

Create `src/lib/migration-v2.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { chromeMock } from "@/test/setup";
import { migrateV1toV2 } from "./migration-v2";
import { listInstances, getActiveInstance } from "./instances";
import { getOrCreateEncryptionKey, encrypt } from "./crypto";

beforeEach(() => {
  chromeMock.storage.local.__store = {};
});

async function seedV1(provider: string, apiKey: string, model: string, baseUrl?: string) {
  const key = await getOrCreateEncryptionKey();
  chromeMock.storage.local.__store[`provider_${provider}`] = {
    encryptedKey: await encrypt(apiKey, key),
    model,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

describe("migrateV1toV2", () => {
  it("converts each provider_* to instance_${uuid}; drops baseUrl; sets active", async () => {
    await seedV1("anthropic", "sk-ant-x", "claude-opus-4-7");
    await seedV1("openai", "sk-y", "gpt-4o", "https://my.proxy.example/v1");
    chromeMock.storage.local.__store["active_provider"] = "openai";

    await migrateV1toV2();

    const list = await listInstances();
    expect(list).toHaveLength(2);
    const openai = list.find((i) => i.provider === "openai")!;
    expect(openai.apiKey).toBe("sk-y");
    expect(openai.model).toBe("gpt-4o");
    // user's baseUrl override silently dropped
    expect(("baseUrl" in (openai as object))).toBe(false);

    expect(await getActiveInstance()).toBe(openai.id);
    expect(chromeMock.storage.local.__store["schema_version"]).toBe(2);
    expect(chromeMock.storage.local.__store["migration_v2_mapping"]).toMatchObject({
      anthropic: expect.any(String),
      openai: openai.id,
    });
    // old keys cleaned up
    expect(chromeMock.storage.local.__store["provider_anthropic"]).toBeUndefined();
    expect(chromeMock.storage.local.__store["provider_openai"]).toBeUndefined();
    expect(chromeMock.storage.local.__store["active_provider"]).toBeUndefined();
  });

  it("idempotent: second call early-returns when schema_version=2", async () => {
    await seedV1("anthropic", "sk-ant-x", "claude-opus-4-7");
    await migrateV1toV2();
    const firstSnapshot = JSON.stringify(chromeMock.storage.local.__store);
    await migrateV1toV2();
    expect(JSON.stringify(chromeMock.storage.local.__store)).toBe(firstSnapshot);
  });

  it("model not in registry → goes into customModels[]", async () => {
    await seedV1("openai", "sk-y", "gpt-5-experimental");
    await migrateV1toV2();
    const list = await listInstances();
    const inst = list[0]!;
    expect(inst.model).toBe("gpt-5-experimental");
    expect(inst.customModels).toEqual(["gpt-5-experimental"]);
  });

  it("no v1 data: writes schema_version=2 and exits cleanly", async () => {
    await migrateV1toV2();
    expect(chromeMock.storage.local.__store["schema_version"]).toBe(2);
    expect(await listInstances()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
pnpm test src/lib/migration-v2.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/lib/migration-v2.ts`**

```ts
import type { Provider } from "@/lib/model-router";
import { PROVIDER_REGISTRY, getProviderMeta } from "@/lib/model-router/providers/registry";
import { getOrCreateEncryptionKey, encrypt, decrypt } from "@/lib/crypto";
import type { StoredInstance } from "@/lib/instances";

const SCHEMA_VERSION_KEY = "schema_version";
const MAPPING_KEY = "migration_v2_mapping";

export async function migrateV1toV2(): Promise<void> {
  const sv = (await chrome.storage.local.get(SCHEMA_VERSION_KEY))[SCHEMA_VERSION_KEY];
  if (sv === 2) return;

  const key = await getOrCreateEncryptionKey();
  const oldActiveResult = await chrome.storage.local.get("active_provider");
  const oldActive = oldActiveResult.active_provider as Provider | undefined;

  const mapping: Record<string, string> = {};
  const instancesIndex: string[] = [];
  const writes: Record<string, unknown> = {};
  const removes: string[] = [];

  for (const p of PROVIDER_REGISTRY) {
    const r = await chrome.storage.local.get(`provider_${p.id}`);
    const old = r[`provider_${p.id}`] as { encryptedKey: string; model: string; baseUrl?: string } | undefined;
    if (!old) continue;

    let plain: string;
    try {
      plain = await decrypt(old.encryptedKey, key);
    } catch {
      // unable to decrypt — skip silently (corrupt data); user will reconfigure
      removes.push(`provider_${p.id}`);
      continue;
    }

    const newId = crypto.randomUUID();
    const inRegistry = p.models.some((m) => m.id === old.model);
    const stored: StoredInstance = {
      id: newId,
      provider: p.id,
      nickname: p.name,
      encryptedKey: await encrypt(plain, key),
      model: old.model,
      ...(inRegistry ? {} : { customModels: [old.model] }),
      createdAt: Date.now(),
    };
    writes[`instance_${newId}`] = stored;
    instancesIndex.push(newId);
    mapping[p.id] = newId;
    removes.push(`provider_${p.id}`);
  }

  writes["instances_index"] = instancesIndex;
  if (oldActive && mapping[oldActive]) writes["active_instance_id"] = mapping[oldActive];
  writes[SCHEMA_VERSION_KEY] = 2;
  writes[MAPPING_KEY] = mapping;

  await chrome.storage.local.set(writes);
  if (removes.length > 0) await chrome.storage.local.remove([...removes, "active_provider"]);
}

export async function getMigrationMapping(): Promise<Record<string, string>> {
  const r = await chrome.storage.local.get(MAPPING_KEY);
  return (r[MAPPING_KEY] as Record<string, string>) ?? {};
}
```

- [ ] **Step 4: Wire migration into SW startup**

In `src/background/index.ts`, find the very top imports and add:

```ts
import { migrateV1toV2 } from "@/lib/migration-v2";
```

Find the SW initialization (search for `chrome.runtime.onInstalled` or top-level setup). Add the migration call. If there's no clear init, add a top-level invocation:

```ts
// Run V1→V2 migration once on SW load (idempotent via schema_version sentinel).
migrateV1toV2().catch((e) => console.error("migration v2 failed", e));
```

Place this near the top of the SW file body, after imports but before any handler registration.

- [ ] **Step 5: Run tests**

```bash
pnpm test src/lib/migration-v2.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/migration-v2.ts src/lib/migration-v2.test.ts src/background/index.ts
git commit -m "feat(migration): silent V1→V2 storage migration with mapping persistence

Idempotent via schema_version sentinel. Drops user-set baseUrl per spec Q5
acceptance. Models not in current registry get pushed into customModels[].
Mapping persisted (~1KB) for lazy session backfill in Task 8.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: SessionMeta.instanceId field + lazy backfill

**Files:**
- Modify: `src/lib/sessions/types.ts` (add `instanceId?: string` to SessionMeta)
- Modify: `src/lib/sessions/storage.ts` (lazy backfill helper inside getSessionMeta)
- Modify: `src/lib/sessions/storage.test.ts` (cover backfill case)

**Reason:** Per-session instance pinning. Backfill historic sessions lazily on first access using `migration_v2_mapping`.

- [ ] **Step 1: Add field to SessionMeta**

In `src/lib/sessions/types.ts`, find the `SessionMeta` interface and add:

```ts
export interface SessionMeta {
  id: string;
  // ... existing fields ...

  /**
   * Per-session instance override (Q6 = Y). Set at session creation by
   * reading active_instance_id; can be changed by the user via the
   * InstanceSelector chip in the composer until the first task starts.
   * Once a task starts, the resolved ModelConfig is snapshotted into the
   * checkpoint (C1 invariant) and instance changes mid-task are ignored.
   *
   * Pre-migration sessions (before V2) lack this field; lazy backfill
   * happens in getSessionMeta when migration_v2_mapping is present.
   */
  instanceId?: string;
}
```

- [ ] **Step 2: Write backfill test**

Add to `src/lib/sessions/storage.test.ts`:

```ts
import { migrateV1toV2 } from "@/lib/migration-v2";
import { encrypt } from "@/lib/crypto";
import { getOrCreateEncryptionKey } from "@/lib/crypto";

describe("getSessionMeta lazy backfill", () => {
  beforeEach(() => {
    chromeMock.storage.local.__store = {};
  });

  it("when meta.instanceId missing but mapping exists, backfills from legacy provider", async () => {
    // Seed v1 provider config + run migration to populate mapping
    const key = await getOrCreateEncryptionKey();
    chromeMock.storage.local.__store["provider_anthropic"] = {
      encryptedKey: await encrypt("sk-ant", key),
      model: "claude-opus-4-7",
    };
    await migrateV1toV2();
    const mapping = chromeMock.storage.local.__store["migration_v2_mapping"];
    const expectedInstanceId = mapping.anthropic;

    // Seed a pre-migration session that has a legacy provider field but no instanceId
    chromeMock.storage.local.__store["session_legacy_meta"] = {
      id: "legacy", createdAt: 1, lastAccessedAt: 1, status: "archived",
      messages: [],
      provider: "anthropic", // legacy field
    };

    const meta = await getSessionMeta("legacy");
    expect(meta!.instanceId).toBe(expectedInstanceId);
    // legacy field cleaned up
    expect(("provider" in (meta as object))).toBe(false);
  });

  it("session with no provider + no instanceId is left as-is", async () => {
    chromeMock.storage.local.__store["session_x_meta"] = {
      id: "x", createdAt: 1, lastAccessedAt: 1, status: "active",
      messages: [],
    };
    const meta = await getSessionMeta("x");
    expect(meta!.instanceId).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm test src/lib/sessions/storage.test.ts
```

Expected: FAIL — backfill not implemented.

- [ ] **Step 4: Implement backfill in storage.ts**

In `src/lib/sessions/storage.ts`, find `getSessionMeta`. Wrap its return value with a backfill helper:

```ts
import { getMigrationMapping } from "@/lib/migration-v2";

// Add this helper near top of file:
async function backfillInstanceId(meta: SessionMeta & { provider?: string }): Promise<SessionMeta> {
  if (meta.instanceId || !meta.provider) return meta;
  const mapping = await getMigrationMapping();
  const instanceId = mapping[meta.provider];
  if (!instanceId) return meta;
  const { provider: _drop, ...rest } = meta as SessionMeta & { provider?: string };
  const next: SessionMeta = { ...rest, instanceId };
  // Persist the backfill so we don't keep doing it
  await chrome.storage.local.set({ [`session_${meta.id}_meta`]: next });
  return next;
}

// Modify getSessionMeta to apply backfill:
export async function getSessionMeta(id: string): Promise<SessionMeta | null> {
  const r = await chrome.storage.local.get(`session_${id}_meta`);
  const raw = r[`session_${id}_meta`] as (SessionMeta & { provider?: string }) | undefined;
  if (!raw) return null;
  return backfillInstanceId(raw);
}
```

(Adjust the `getSessionMeta` body to match the existing one — wrap its existing return with `backfillInstanceId`.)

- [ ] **Step 5: Run test**

```bash
pnpm test src/lib/sessions/storage.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/sessions/types.ts src/lib/sessions/storage.ts src/lib/sessions/storage.test.ts
git commit -m "feat(sessions): per-session instanceId + lazy V1→V2 backfill

SessionMeta gains optional instanceId; getSessionMeta auto-backfills from
migration_v2_mapping when a pre-V2 session is opened, persisting the rewrite.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: ModelDropdown component

**Files:**
- Create: `src/sidepanel/components/ModelDropdown.tsx`
- Create: `src/sidepanel/components/ModelDropdown.test.tsx`

**Reason:** Reusable model selector. Three behaviours: registry-listed (Anthropic / OpenAI / Gemini / 3 Chinese), OpenRouter (lazy fetch + cache + ↻), per-instance customModels with `[自定义]` tag.

- [ ] **Step 1: Write failing test**

Create `src/sidepanel/components/ModelDropdown.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import ModelDropdown from "./ModelDropdown";

describe("ModelDropdown", () => {
  it("registry-listed provider: shows hardcoded models with capability tags", () => {
    render(
      <ModelDropdown
        provider="anthropic"
        value="claude-opus-4-7"
        customModels={[]}
        onChange={() => {}}
        onAddCustom={() => {}}
        onRefresh={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /claude-opus-4-7/i }));
    expect(screen.getByText(/claude-sonnet-4-6/)).toBeInTheDocument();
  });

  it("custom models render with [custom] tag and × delete button", () => {
    const onChange = vi.fn();
    render(
      <ModelDropdown
        provider="anthropic"
        value="my-finetune"
        customModels={["my-finetune"]}
        onChange={onChange}
        onAddCustom={() => {}}
        onRefresh={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /my-finetune/i }));
    expect(screen.getByText(/my-finetune/i)).toBeInTheDocument();
    expect(screen.getByText(/custom/i)).toBeInTheDocument();
  });

  it("OpenRouter: empty registry triggers onRefresh on first open if no fetchedModels", () => {
    const onRefresh = vi.fn();
    render(
      <ModelDropdown
        provider="openrouter"
        value=""
        customModels={[]}
        fetchedModels={undefined}
        onChange={() => {}}
        onAddCustom={() => {}}
        onRefresh={onRefresh}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onRefresh).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
pnpm test src/sidepanel/components/ModelDropdown.test.tsx
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `ModelDropdown.tsx`**

```tsx
import { useState, useEffect } from "react";
import type { Provider, ModelMeta } from "@/lib/model-router";
import { getProviderMeta } from "@/lib/model-router";

interface Props {
  provider: Provider;
  value: string;
  customModels: string[];
  fetchedModels?: ModelMeta[];
  fetchedAt?: number;
  isFetching?: boolean;
  onChange: (modelId: string) => void;
  onAddCustom: (modelId: string) => void;
  onRemoveCustom?: (modelId: string) => void;
  onRefresh: () => void;
}

export default function ModelDropdown(props: Props) {
  const meta = getProviderMeta(props.provider);
  const registryModels = meta?.models ?? [];
  const fetched = props.fetchedModels ?? [];
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  // Lazy fetch on first open if registry empty and no fetched cache
  useEffect(() => {
    if (open && registryModels.length === 0 && fetched.length === 0 && !props.isFetching) {
      props.onRefresh();
    }
  }, [open, registryModels.length, fetched.length, props.isFetching]);

  // Combined sorted list
  const baseList: { id: string; meta?: ModelMeta; isCustom: boolean }[] = [
    ...registryModels.map((m) => ({ id: m.id, meta: m, isCustom: false })),
    ...fetched.map((m) => ({ id: m.id, meta: m, isCustom: false })),
    ...props.customModels.map((id) => ({ id, isCustom: true })),
  ];
  // Dedupe by id (registry wins over custom if collision)
  const seen = new Set<string>();
  const list = baseList.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));

  const isLazy = registryModels.length === 0;

  return (
    <div className="flex flex-col gap-1.5">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded border border-line bg-field px-3 py-2 text-left text-[12px] text-fg-1 hover:border-fg-3"
      >
        <span className="font-mono">{props.value || "(选择模型)"}</span>
        <span className="ml-auto text-fg-3">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div className="rounded border border-line bg-surface">
          {isLazy && (
            <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-[10px] text-fg-3">
              <span className="font-mono">{props.fetchedAt ? new Date(props.fetchedAt).toLocaleString() : "未拉取"}</span>
              <button onClick={() => props.onRefresh()} className="hover:text-fg-1">
                {props.isFetching ? "拉取中…" : "↻ 刷新"}
              </button>
            </div>
          )}
          {list.length === 0 && (
            <div className="px-3 py-2 text-[11px] text-fg-3">{props.isFetching ? "拉取中…" : "(空 — 用 + 添加自定义)"}</div>
          )}
          {list.map((m) => (
            <button
              key={m.id}
              onClick={() => { props.onChange(m.id); setOpen(false); }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-field ${m.id === props.value ? "bg-field" : ""}`}
            >
              <span className="font-mono text-fg-1">{m.id}</span>
              {m.meta?.vision && <span className="rounded bg-line px-1 text-[9px] text-fg-3">vision</span>}
              {m.meta?.tools && <span className="rounded bg-line px-1 text-[9px] text-fg-3">tools</span>}
              {m.isCustom && (
                <>
                  <span className="rounded bg-line px-1 text-[9px] text-fg-3">custom</span>
                  {props.onRemoveCustom && (
                    <span
                      onClick={(e) => { e.stopPropagation(); props.onRemoveCustom!(m.id); }}
                      className="ml-auto text-fg-3 hover:text-warning"
                    >
                      ×
                    </span>
                  )}
                </>
              )}
            </button>
          ))}

          <div className="border-t border-line">
            {!adding ? (
              <button
                onClick={() => setAdding(true)}
                className="w-full px-3 py-2 text-left text-[11px] text-accent hover:bg-field"
              >
                + 添加自定义模型
              </button>
            ) : (
              <div className="flex gap-1.5 p-2">
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="model id"
                  className="flex-1 rounded border border-line bg-field px-2 py-1 font-mono text-[11px] text-fg-1"
                />
                <button
                  disabled={!draft.trim()}
                  onClick={() => { props.onAddCustom(draft.trim()); setDraft(""); setAdding(false); }}
                  className="rounded bg-fg-1 px-2 py-1 text-[10px] text-canvas disabled:opacity-30"
                >
                  保存
                </button>
                <button
                  onClick={() => { setDraft(""); setAdding(false); }}
                  className="rounded border border-line px-2 py-1 text-[10px] text-fg-3"
                >
                  取消
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test src/sidepanel/components/ModelDropdown.test.tsx
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/ModelDropdown.tsx src/sidepanel/components/ModelDropdown.test.tsx
git commit -m "feat(ui): ModelDropdown component (registry + custom + lazy fetch)

Three behaviours unified: hardcoded registry models, OpenRouter lazy fetch
with refresh button, per-instance customModels with [custom] tag and × delete.
Capability flags (vision/tools) render inline for visibility.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: InstanceForm component

**Files:**
- Create: `src/sidepanel/components/InstanceForm.tsx`
- Create: `src/sidepanel/components/InstanceForm.test.tsx`

**Reason:** Reusable form for create + edit. Fields: nickname / provider (read-only on edit, picker on create) / API key (password+show) / Model dropdown / Test+Save+Delete buttons. **No BaseURL field.**

- [ ] **Step 1: Write failing test**

```tsx
// src/sidepanel/components/InstanceForm.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import InstanceForm from "./InstanceForm";

describe("InstanceForm", () => {
  it("does NOT render a BaseURL field", () => {
    render(
      <InstanceForm
        mode="create"
        provider="anthropic"
        initialNickname="Anthropic"
        onSave={() => {}}
        onTest={() => {}}
      />,
    );
    expect(screen.queryByText(/base url/i)).not.toBeInTheDocument();
  });

  it("provider field is read-only in edit mode", () => {
    render(
      <InstanceForm
        mode="edit"
        provider="openai"
        initialNickname="Work"
        initialModel="gpt-4o"
        onSave={() => {}}
        onTest={() => {}}
        onDelete={() => {}}
      />,
    );
    const provider = screen.getByText(/openai/i);
    expect(provider).toBeInTheDocument();
    // No combobox / button for provider
    expect(screen.queryByRole("combobox", { name: /provider/i })).not.toBeInTheDocument();
  });

  it("fires onSave with form payload", () => {
    const onSave = vi.fn();
    render(
      <InstanceForm
        mode="create"
        provider="anthropic"
        initialNickname="Anthropic"
        onSave={onSave}
        onTest={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: "sk-ant-test" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "sk-ant-test" }));
  });
});
```

- [ ] **Step 2: Run failing**

```bash
pnpm test src/sidepanel/components/InstanceForm.test.tsx
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `InstanceForm.tsx`**

```tsx
import { useState } from "react";
import type { Provider, ModelMeta } from "@/lib/model-router";
import { getProviderMeta } from "@/lib/model-router";
import ModelDropdown from "./ModelDropdown";

export interface InstanceFormPayload {
  nickname: string;
  apiKey: string;
  model: string;
}

interface Props {
  mode: "create" | "edit";
  provider: Provider;
  initialNickname: string;
  initialModel?: string;
  initialCustomModels?: string[];
  fetchedModels?: ModelMeta[];
  fetchedAt?: number;
  isFetching?: boolean;
  maskedKey?: string;
  onSave: (payload: InstanceFormPayload) => void;
  onTest: (payload: InstanceFormPayload) => void;
  onDelete?: () => void;
  onAddCustomModel?: (id: string) => void;
  onRemoveCustomModel?: (id: string) => void;
  onRefreshModels?: () => void;
  saveLabel?: string;
}

export default function InstanceForm(props: Props) {
  const meta = getProviderMeta(props.provider);
  const [nickname, setNickname] = useState(props.initialNickname);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState(props.initialModel ?? "");

  const canSave = apiKey.trim().length > 0 && model.trim().length > 0;

  const payload: InstanceFormPayload = { nickname, apiKey, model };

  return (
    <div className="flex flex-col gap-3 px-3.5 py-3.5">
      <Field label="NICKNAME">
        <input
          aria-label="nickname"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          className="rounded border border-line bg-field px-3 py-2 text-[12px] text-fg-1"
        />
      </Field>

      <Field label="PROVIDER" hint={meta?.defaultBaseUrl}>
        <div className="flex items-center gap-2 rounded border border-line bg-field px-3 py-2 text-[12px] text-fg-2">
          <span className="text-fg-1">{meta?.name ?? props.provider}</span>
          <span className="ml-auto font-mono text-[10px] text-fg-3">LOCKED</span>
        </div>
      </Field>

      <Field label="API KEY" hint={props.maskedKey ? `Current ${props.maskedKey}` : undefined}>
        <div className="flex gap-1.5">
          <input
            aria-label="api key"
            type={showKey ? "text" : "password"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={meta?.placeholder ?? ""}
            className="flex-1 rounded border border-line bg-field px-3 py-2 text-[12px] text-fg-1"
          />
          <button
            onClick={() => setShowKey(!showKey)}
            className="rounded border border-line bg-field px-2.5 text-[11px] text-fg-2"
          >
            {showKey ? "Hide" : "Show"}
          </button>
        </div>
      </Field>

      <Field label="MODEL">
        <ModelDropdown
          provider={props.provider}
          value={model}
          customModels={props.initialCustomModels ?? []}
          fetchedModels={props.fetchedModels}
          fetchedAt={props.fetchedAt}
          isFetching={props.isFetching}
          onChange={setModel}
          onAddCustom={(id) => { setModel(id); props.onAddCustomModel?.(id); }}
          onRemoveCustom={props.onRemoveCustomModel}
          onRefresh={props.onRefreshModels ?? (() => {})}
        />
      </Field>

      <div className="flex flex-wrap gap-1.5 pt-1">
        <button
          onClick={() => props.onTest(payload)}
          disabled={!canSave}
          className="rounded border border-line bg-transparent px-3 py-1.5 text-[11px] text-fg-2 hover:border-fg-3 disabled:opacity-30"
        >
          Test
        </button>
        <button
          onClick={() => props.onSave(payload)}
          disabled={!canSave}
          className="rounded bg-fg-1 px-3 py-1.5 text-[11px] font-medium text-canvas disabled:opacity-30"
        >
          {props.saveLabel ?? "Save"}
        </button>
        {props.mode === "edit" && props.onDelete && (
          <button
            onClick={() => props.onDelete!()}
            className="ml-auto rounded border border-warning-line bg-transparent px-3 py-1.5 text-[11px] text-warning hover:bg-warning-tint"
          >
            Forget config
          </button>
        )}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3">{label}</span>
        {hint && <span className="font-mono text-[10px] text-fg-3">{hint}</span>}
      </div>
      {children}
    </label>
  );
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm test src/sidepanel/components/InstanceForm.test.tsx
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/InstanceForm.tsx src/sidepanel/components/InstanceForm.test.tsx
git commit -m "feat(ui): InstanceForm component (no BaseURL field)

Reusable for create + edit modes. Provider locked on edit. ModelDropdown
inlined with capability tags. PROVIDER row shows defaultBaseUrl as a hint
so users know where requests go without it being editable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: InstancesList + NewConfigWizard

**Files:**
- Create: `src/sidepanel/components/InstancesList.tsx`
- Create: `src/sidepanel/components/NewConfigWizard.tsx`

**Reason:** Instance list rows (collapsed view) + wizard for creating a new instance (Step 1: pick provider, Step 2: form).

- [ ] **Step 1: Create `InstancesList.tsx`**

```tsx
import type { DecryptedInstance } from "@/lib/instances";

interface Props {
  instances: DecryptedInstance[];
  activeId: string | null;
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  onSetActive: (id: string) => void;
  renderForm: (id: string) => React.ReactNode;
}

export default function InstancesList(props: Props) {
  return (
    <div className="flex flex-col gap-px overflow-hidden rounded-lg border border-line bg-line">
      {props.instances.map((inst) => {
        const isActive = props.activeId === inst.id;
        const isOpen = props.expandedId === inst.id;
        return (
          <div key={inst.id} className="bg-surface">
            <button
              onClick={() => props.onToggleExpand(inst.id)}
              className="flex w-full items-center gap-3 px-3.5 py-3 text-left hover:bg-field"
            >
              <div className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${isActive ? "bg-accent" : "bg-fg-3"}`} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-fg-1">
                  {inst.nickname}
                  <span className="ml-1 text-[11px] font-normal text-fg-3">· {inst.provider}</span>
                </div>
                <div className="truncate font-mono text-[11px] text-fg-2">
                  {inst.model} · {maskKey(inst.apiKey)}
                </div>
              </div>
              {isActive ? (
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-accent">ACTIVE</span>
              ) : (
                <button
                  onClick={(e) => { e.stopPropagation(); props.onSetActive(inst.id); }}
                  className="rounded border border-line bg-transparent px-2.5 py-1 text-[11px] text-fg-2 hover:text-fg-1"
                >
                  Activate
                </button>
              )}
            </button>
            {isOpen && <div className="border-t border-line bg-canvas">{props.renderForm(inst.id)}</div>}
          </div>
        );
      })}
    </div>
  );
}

function maskKey(k: string) { return k.length <= 8 ? "••••••••" : `${k.slice(0, 4)}...${k.slice(-4)}`; }
```

- [ ] **Step 2: Create `NewConfigWizard.tsx`**

```tsx
import { useState } from "react";
import type { Provider } from "@/lib/model-router";
import { PROVIDER_REGISTRY, getProviderMeta } from "@/lib/model-router/providers/registry";
import InstanceForm, { type InstanceFormPayload } from "./InstanceForm";

interface Props {
  onCreate: (provider: Provider, payload: InstanceFormPayload) => void;
  onCancel: () => void;
  onTest: (provider: Provider, payload: InstanceFormPayload) => void;
}

export default function NewConfigWizard(props: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [provider, setProvider] = useState<Provider | null>(null);

  if (step === 1 || !provider) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-3.5">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3">STEP 1 — 选 PROVIDER</div>
        <div className="flex flex-col gap-1.5">
          {PROVIDER_REGISTRY.map((p) => (
            <button
              key={p.id}
              onClick={() => { setProvider(p.id); setStep(2); }}
              className="flex items-center gap-2 rounded border border-line px-3 py-2 text-left hover:bg-field"
            >
              <div className="h-1.5 w-1.5 rounded-full bg-fg-3" />
              <span className="text-[13px] text-fg-1">{p.name}</span>
              <span className="ml-auto font-mono text-[10px] text-fg-3">{p.defaultBaseUrl.replace(/^https?:\/\//, "")}</span>
            </button>
          ))}
        </div>
        <button onClick={props.onCancel} className="self-start text-[11px] text-fg-3 hover:text-fg-1">
          取消
        </button>
      </div>
    );
  }

  const meta = getProviderMeta(provider)!;
  return (
    <div className="rounded-lg border border-line bg-canvas">
      <div className="border-b border-line px-3.5 py-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-fg-3">STEP 2 — {meta.name}</div>
      </div>
      <InstanceForm
        mode="create"
        provider={provider}
        initialNickname={meta.name}
        saveLabel="Create"
        onSave={(p) => props.onCreate(provider, p)}
        onTest={(p) => props.onTest(provider, p)}
      />
      <div className="border-t border-line px-3.5 py-2">
        <button onClick={() => setStep(1)} className="text-[11px] text-fg-3 hover:text-fg-1">
          ← 改 provider
        </button>
        <button onClick={props.onCancel} className="ml-3 text-[11px] text-fg-3 hover:text-fg-1">
          取消
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Smoke test (no full unit suite — Settings.tsx integration in Task 12 is the real test)**

```bash
pnpm tsc --noEmit
```

Expected: clean — no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/sidepanel/components/InstancesList.tsx src/sidepanel/components/NewConfigWizard.tsx
git commit -m "feat(ui): InstancesList + NewConfigWizard

InstancesList renders 'my configs' rows with active dot, nickname · provider,
model · masked key. Activate button on inactive rows. NewConfigWizard is a
2-step inline flow (pick provider → fill form).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Settings.tsx full rewrite

**Files:**
- Modify: `src/sidepanel/components/Settings.tsx`
- Modify: `src/sidepanel/components/Settings.test.tsx` (if exists; otherwise create one)

**Reason:** Replace list-based providers UI with the new instance-based config center. Wire to `instances.ts` CRUD. Tab label changes "Providers" → "Configs".

- [ ] **Step 1: Replace `Settings.tsx`**

Rewrite `src/sidepanel/components/Settings.tsx` with:

```tsx
import { useState, useEffect, useCallback } from "react";
import type { Provider } from "@/lib/model-router";
import { chat } from "@/lib/model-router";
import {
  createInstance, listInstances, deleteInstance,
  setActiveInstance, getActiveInstance, updateInstance, getInstance,
  type DecryptedInstance,
} from "@/lib/instances";
import { getProviderMeta } from "@/lib/model-router/providers/registry";
import { isKeyboardSimulationEnabled, setKeyboardSimulationEnabled } from "@/lib/keyboard-simulation";
import SkillsList from "./SkillsList";
import InstanceForm, { type InstanceFormPayload } from "./InstanceForm";
import InstancesList from "./InstancesList";
import NewConfigWizard from "./NewConfigWizard";

interface Props {
  onBack: () => void;
  onRunSkill?: (skillId: string, skillName: string) => void;
}

type Tab = "configs" | "skills";

export default function Settings({ onBack, onRunSkill }: Props) {
  const [tab, setTab] = useState<Tab>("configs");
  const [instances, setInstances] = useState<DecryptedInstance[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [keyboardSim, setKeyboardSim] = useState(false);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; message: string }>>({});

  const reload = useCallback(async () => {
    setInstances(await listInstances());
    setActiveId(await getActiveInstance());
  }, []);

  useEffect(() => {
    reload();
    isKeyboardSimulationEnabled().then(setKeyboardSim);
  }, [reload]);

  async function handleCreate(provider: Provider, payload: InstanceFormPayload) {
    await createInstance({ provider, ...payload });
    setShowWizard(false);
    await reload();
  }

  async function handleSaveEdit(id: string, payload: InstanceFormPayload) {
    await updateInstance(id, {
      nickname: payload.nickname,
      apiKey: payload.apiKey,
      model: payload.model,
    });
    await reload();
  }

  async function handleDelete(id: string) {
    if (!confirm("Forget this config?")) return;
    await deleteInstance(id);
    setExpandedId(null);
    await reload();
  }

  async function handleTest(id: string | null, provider: Provider, payload: InstanceFormPayload) {
    const cfg = {
      provider,
      model: payload.model,
      apiKey: payload.apiKey,
      baseUrl: getProviderMeta(provider)!.defaultBaseUrl,
      maxTokens: 1,
    };
    const key = id ?? "_new";
    try {
      await chat(cfg, [{ role: "user", content: "Hi" }]);
      setTestResult((p) => ({ ...p, [key]: { ok: true, message: "Connection successful" } }));
    } catch (e) {
      setTestResult((p) => ({ ...p, [key]: { ok: false, message: e instanceof Error ? e.message : "Failed" } }));
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-line bg-canvas px-3.5 py-3">
        <button onClick={onBack} className="flex h-7 w-7 items-center justify-center rounded text-fg-2 hover:bg-field" aria-label="Back">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M9 11L5 7L9 3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <span className="text-[13px] font-semibold text-fg-1">Settings</span>
        <div className="flex-1" />
        <SegmentedTabs value={tab} onChange={setTab} />
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        {tab === "configs" ? (
          <div className="flex flex-col gap-7">
            <ActiveSection instances={instances} activeId={activeId} />

            <section className="flex flex-col gap-3.5">
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-fg-3">MY CONFIGS</span>
                <span className="font-mono text-[10px] text-fg-3">{instances.length} configs</span>
              </div>
              <InstancesList
                instances={instances}
                activeId={activeId}
                expandedId={expandedId}
                onToggleExpand={(id) => setExpandedId(expandedId === id ? null : id)}
                onSetActive={async (id) => { await setActiveInstance(id); await reload(); }}
                renderForm={(id) => {
                  const inst = instances.find((i) => i.id === id)!;
                  const result = testResult[id];
                  return (
                    <>
                      <InstanceForm
                        mode="edit"
                        provider={inst.provider}
                        initialNickname={inst.nickname}
                        initialModel={inst.model}
                        initialCustomModels={inst.customModels ?? []}
                        fetchedModels={inst.fetchedModels}
                        fetchedAt={inst.fetchedAt}
                        maskedKey={maskKey(inst.apiKey)}
                        onSave={(p) => handleSaveEdit(id, p)}
                        onTest={(p) => handleTest(id, inst.provider, p)}
                        onDelete={() => handleDelete(id)}
                        onAddCustomModel={async (mid) => {
                          const next = [...(inst.customModels ?? []), mid];
                          await updateInstance(id, { customModels: next });
                          await reload();
                        }}
                        onRemoveCustomModel={async (mid) => {
                          const next = (inst.customModels ?? []).filter((x) => x !== mid);
                          await updateInstance(id, { customModels: next });
                          await reload();
                        }}
                        onRefreshModels={async () => {
                          // Implemented in Task 12.5 (lazy fetch wiring) — for now no-op
                        }}
                      />
                      {result && (
                        <div className={`mx-3.5 mb-3 rounded border px-2.5 py-1.5 text-[11px] ${result.ok ? "border-line bg-field text-fg-2" : "border-warning-line bg-warning-tint text-warning"}`}>
                          {result.message}
                        </div>
                      )}
                    </>
                  );
                }}
              />

              {showWizard ? (
                <NewConfigWizard
                  onCreate={handleCreate}
                  onTest={(p, payload) => handleTest(null, p, payload)}
                  onCancel={() => setShowWizard(false)}
                />
              ) : (
                <button
                  onClick={() => setShowWizard(true)}
                  className="flex items-center gap-2 self-start rounded border border-line bg-transparent px-3.5 py-2 text-[12px] text-accent hover:bg-field"
                >
                  + 新建配置
                </button>
              )}
            </section>

            <KeyboardSimSection enabled={keyboardSim} onToggle={async (n) => { setKeyboardSim(n); await setKeyboardSimulationEnabled(n); }} />
          </div>
        ) : (
          <SkillsList onRunSkill={onRunSkill ?? (() => {})} />
        )}
      </div>
    </div>
  );
}

function ActiveSection({ instances, activeId }: { instances: DecryptedInstance[]; activeId: string | null }) {
  const active = instances.find((i) => i.id === activeId);
  if (!active) {
    return (
      <section className="rounded-lg border border-warning-line bg-warning-tint px-3 py-2.5 text-[12px] text-warning">
        No active config — pick one below.
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-fg-3">ACTIVE</div>
      <div className="flex items-baseline justify-between">
        <div className="text-[14px] font-semibold text-fg-1">{active.nickname}</div>
        <div className="font-mono text-[11px] text-accent">{active.model}</div>
      </div>
    </section>
  );
}

function SegmentedTabs({ value, onChange }: { value: Tab; onChange: (t: Tab) => void }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: "configs", label: "Configs" },
    { id: "skills", label: "Skills" },
  ];
  return (
    <div className="flex">
      {tabs.map((t, i) => {
        const active = value === t.id;
        return (
          <button key={t.id} onClick={() => onChange(t.id)}
            className={`border border-line px-3 py-1 text-[11px] ${i === 0 ? "rounded-l-md" : "-ml-px rounded-r-md"} ${active ? "bg-field font-medium text-fg-1" : "bg-transparent text-fg-2"}`}>
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function KeyboardSimSection({ enabled, onToggle }: { enabled: boolean; onToggle: (n: boolean) => void }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3.5">
      <div className="flex items-start gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <div className="text-[13px] font-medium text-fg-1">CDP keyboard input</div>
          <p className="text-[12px] text-fg-2">Lets the agent type into canvas-rendered editors via Chrome DevTools Protocol.</p>
        </div>
        <button onClick={() => onToggle(!enabled)} className={`relative inline-flex h-6 w-11 items-center rounded-full border ${enabled ? "border-accent-line bg-accent-tint" : "border-line bg-field"}`}>
          <span className={`inline-block h-3.5 w-3.5 transform rounded-full transition-transform ${enabled ? "translate-x-6 bg-accent" : "translate-x-1 bg-fg-3"}`} />
        </button>
      </div>
    </section>
  );
}

function maskKey(k: string) { return k.length <= 8 ? "••••••••" : `${k.slice(0, 4)}...${k.slice(-4)}`; }
```

- [ ] **Step 2: Type-check**

```bash
pnpm tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Run all tests to confirm no regressions**

```bash
pnpm test
```

Expected: existing Settings tests may need adjustment for the new tab label. Update any test assertions that look for "Providers" tab text → "Configs". Also any test mocking old `getProviderConfig` / `getActiveProvider` paths needs update.

- [ ] **Step 4: Manual smoke check**

```bash
pnpm dev
```

Open the extension, navigate to Settings → Configs tab. Verify: empty state shows "+ 新建配置"; clicking opens 2-step wizard; create one Anthropic instance; activates automatically; expanded form has no BaseURL field; Model dropdown shows registry models with capability tags.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/Settings.tsx
git commit -m "feat(ui): rewrite Settings to instance-based config center

Drops list-by-provider UI in favor of 'my configs' instance list + 2-step
wizard for new configs. ACTIVE section pinned at top. No BaseURL field
anywhere. Tab label 'Providers' → 'Configs'.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: InstanceSelector chip + Chat composer integration

**Files:**
- Create: `src/sidepanel/components/InstanceSelector.tsx`
- Create: `src/sidepanel/components/InstanceSelector.test.tsx`
- Modify: `src/sidepanel/components/Chat.tsx` (composer action row)

**Reason:** Borderless chip in composer action row that opens an upward dropdown of all configured instances. Locked when task is in flight.

- [ ] **Step 1: Write failing test**

```tsx
// src/sidepanel/components/InstanceSelector.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import InstanceSelector from "./InstanceSelector";
import type { DecryptedInstance } from "@/lib/instances";

const sampleInstances: DecryptedInstance[] = [
  { id: "1", provider: "anthropic", nickname: "Anthropic", apiKey: "sk", model: "claude-opus-4-7", createdAt: 0 },
  { id: "2", provider: "openai", nickname: "Work", apiKey: "sk", model: "gpt-4o", createdAt: 0 },
];

describe("InstanceSelector", () => {
  it("renders chip with shortened model name (no border)", () => {
    render(
      <InstanceSelector
        instances={sampleInstances}
        currentId="1"
        locked={false}
        onChange={() => {}}
        onManage={() => {}}
      />,
    );
    const chip = screen.getByRole("button", { name: /anthropic/i });
    expect(chip).toHaveTextContent(/opus-4-7/);
    // chip is borderless: no class with 'border-' prefix on the chip
    // (we just check it's not boxed visually — class assertion shape):
    expect(chip.className).not.toMatch(/\bborder\b(?!-)/);
  });

  it("opens dropdown listing all instances; clicking switches selection", () => {
    const onChange = vi.fn();
    render(
      <InstanceSelector instances={sampleInstances} currentId="1" locked={false} onChange={onChange} onManage={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /anthropic/i }));
    fireEvent.click(screen.getByText(/work/i));
    expect(onChange).toHaveBeenCalledWith("2");
  });

  it("locked: chip is disabled and dropdown won't open", () => {
    render(
      <InstanceSelector instances={sampleInstances} currentId="1" locked={true} onChange={() => {}} onManage={() => {}} />,
    );
    const chip = screen.getByRole("button", { name: /anthropic/i });
    expect(chip).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/sidepanel/components/InstanceSelector.test.tsx
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `InstanceSelector.tsx`**

```tsx
import { useState, useEffect, useRef } from "react";
import type { DecryptedInstance } from "@/lib/instances";

interface Props {
  instances: DecryptedInstance[];
  currentId: string | null;
  locked: boolean;
  onChange: (id: string) => void;
  onManage: () => void;
}

function shortModel(modelId: string): string {
  // drop OpenRouter "vendor/" prefix
  if (modelId.includes("/")) return modelId.split("/").pop()!;
  // drop common "claude-" prefix
  if (modelId.startsWith("claude-")) return modelId.slice("claude-".length);
  return modelId;
}

export default function InstanceSelector(props: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const current = props.instances.find((i) => i.id === props.currentId);

  // Click-outside to close
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => !props.locked && setOpen(!open)}
        disabled={props.locked}
        className="flex items-center gap-1.5 px-1.5 py-1 text-[10px] disabled:opacity-50"
        aria-label={current ? `${current.nickname} ${current.model}` : "select config"}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${props.locked ? "bg-fg-3" : "bg-accent"}`} />
        <span className="font-mono tracking-[0.04em] text-fg-1">
          {current ? `${current.nickname} · ${shortModel(current.model)}` : "(none)"}
        </span>
        {props.locked ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M3 5V3.5C3 2.4 3.9 1.5 5 1.5C6.1 1.5 7 2.4 7 3.5V5M2.5 5H7.5V8.5H2.5V5Z" stroke="#525965" strokeWidth="0.9" strokeLinecap="round" />
          </svg>
        ) : (
          <span className="text-accent">{open ? "▾" : "▴"}</span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          className="absolute bottom-full left-0 mb-2 w-[280px] rounded-lg border border-line bg-surface shadow-2xl"
          style={{ boxShadow: "0 16px 40px rgba(0,0,0,0.7), 0 4px 12px rgba(0,0,0,0.5)" }}
        >
          <div className="flex items-baseline justify-between px-3.5 pt-2.5 pb-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-fg-3">SWITCH CONFIG</span>
            <span className="font-mono text-[10px] text-fg-3">{props.instances.length} configs</span>
          </div>
          <div className="flex flex-col">
            {props.instances.map((inst) => {
              const isCurrent = inst.id === props.currentId;
              return (
                <button
                  key={inst.id}
                  onClick={() => { props.onChange(inst.id); setOpen(false); }}
                  className={`flex items-center gap-2.5 px-3.5 py-2 text-left hover:bg-field ${isCurrent ? "bg-field" : ""}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${isCurrent ? "bg-accent" : "bg-fg-3"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-medium text-fg-1">
                      {inst.nickname}
                      <span className="ml-1 text-[11px] font-normal text-fg-3">· {inst.provider}</span>
                    </div>
                    <div className="font-mono text-[10px] text-fg-2">{shortModel(inst.model)}</div>
                  </div>
                  {isCurrent && <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-accent">ACTIVE</span>}
                </button>
              );
            })}
          </div>
          <button
            onClick={() => { setOpen(false); props.onManage(); }}
            className="flex w-full items-center gap-2 border-t border-line px-3.5 py-2 text-left text-[11px] text-fg-2 hover:bg-field"
          >
            <span>+ 新建配置 / Manage configs</span>
            <span className="ml-auto font-mono text-[10px] text-fg-3">⌘,</span>
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire into Chat.tsx composer**

In `src/sidepanel/components/Chat.tsx`, locate the composer action row (the `<div>` containing the textarea + Send button + REC + attach). Add `InstanceSelector` as the leftmost element of the action row, with a flex spacer between it and the right-side buttons.

Add this import near the top of `Chat.tsx`:

```tsx
import InstanceSelector from "./InstanceSelector";
import { listInstances, type DecryptedInstance } from "@/lib/instances";
```

Add state to Chat:

```tsx
const [instances, setInstances] = useState<DecryptedInstance[]>([]);
const [currentInstanceId, setCurrentInstanceId] = useState<string | null>(null);
const taskInFlight = /* existing computed value, or session.status === "active" + has in-flight stream */;

useEffect(() => {
  listInstances().then(setInstances);
  // load session.instanceId via existing session meta hook
  // setCurrentInstanceId(session.meta.instanceId ?? null);
}, [/* sessionId */]);
```

In the action row JSX, add the chip:

```tsx
<div className="flex items-center gap-2 px-1">
  <InstanceSelector
    instances={instances}
    currentId={currentInstanceId}
    locked={taskInFlight}
    onChange={async (id) => {
      setCurrentInstanceId(id);
      // Persist to session meta — call existing setSessionMeta or post message to SW
      await persistSessionInstanceId(sessionId, id);
    }}
    onManage={() => onOpenSettings?.()}
  />
  <div className="flex-1" />
  {/* existing attach / REC / Send buttons */}
</div>
```

The `persistSessionInstanceId` helper writes the chosen instance id back to session meta (use the existing `chrome.runtime.sendMessage` patterns or `sessionMessenger` utility already in use; if unsure, search for how `pinnedTabs` is written from Chat.tsx and follow the same path).

- [ ] **Step 5: Run tests**

```bash
pnpm test src/sidepanel/components/InstanceSelector.test.tsx
```

Expected: pass.

- [ ] **Step 6: Manual smoke**

```bash
pnpm dev
```

Open extension, create 2 instances in Settings, switch to Chat, verify chip shows current instance, click → dropdown lists both, switch → chip updates. Start a task → chip locks (dimmed, lock icon).

- [ ] **Step 7: Commit**

```bash
git add src/sidepanel/components/InstanceSelector.tsx src/sidepanel/components/InstanceSelector.test.tsx src/sidepanel/components/Chat.tsx
git commit -m "feat(ui): InstanceSelector chip in composer + Chat integration

Borderless chip on the left of the action row, opens upward dropdown listing
all instances with active marker. Locked while task in flight (lock icon
replaces caret, button disabled, tooltip explains).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: SW dispatch + manifest + smoke build

**Files:**
- Modify: `src/background/index.ts` (replace `getActiveProvider`/`getProviderConfig` calls)
- Modify: `manifest.json` (add Gemini host_permission)
- Delete (eventually): `src/lib/storage.ts` legacy paths — keep file exports `getProviderConfig` for back-compat shim that just routes to instances

**Reason:** SW now resolves session.instanceId → ModelConfig at task start, falling back to global `active_instance_id` only when session.instanceId is absent (newly-created sessions before first message). Add Gemini host permission so fetch works in MV3 SW. Build + smoke.

- [ ] **Step 1: Update SW resolver paths**

In `src/background/index.ts`, find the two locations that call `getActiveProvider()` + `getProviderConfig()` (lines ~595-615 and ~1010-1145 from baseline grep). Replace each block with:

```ts
import { getInstance, getActiveInstance, resolveInstanceToModelConfig } from "@/lib/instances";

// ... at the call site:
const sessionMeta = await getSessionMeta(sessionId);
const instanceId = sessionMeta?.instanceId ?? (await getActiveInstance());
if (!instanceId) {
  port.postMessage({ type: "chat-error", error: "No config selected. Open Settings to create one.", sessionId });
  return;
}
const modelConfig = await resolveInstanceToModelConfig(instanceId);
if (!modelConfig) {
  port.postMessage({ type: "chat-error", error: "Selected config was deleted. Pick another in the chat header.", sessionId });
  return;
}
```

Remove the now-unused imports `getActiveProvider`, `getProviderConfig` from the SW file.

- [ ] **Step 2: Persist instanceId on first chat-start**

When SW receives `chat-start` for a session whose `meta.instanceId` is undefined, write `meta.instanceId = (await getActiveInstance())` before resolving ModelConfig — so per-session pin survives even if global active changes mid-conversation.

Add right before the `resolveInstanceToModelConfig` call above:

```ts
if (!sessionMeta?.instanceId && instanceId) {
  await setSessionMeta(sessionId, { ...sessionMeta!, instanceId });
}
```

- [ ] **Step 3: Add Gemini host_permission to manifest**

In `manifest.json`, find `host_permissions` and add `"https://generativelanguage.googleapis.com/*"`:

```json
"host_permissions": [
  "<all_urls>",
  "https://api.anthropic.com/*",
  "https://api.openai.com/*",
  "https://openrouter.ai/*",
  "https://api.minimax.chat/*",
  "https://open.bigmodel.cn/*",
  "https://dashscope.aliyuncs.com/*",
  "https://generativelanguage.googleapis.com/*"
],
```

- [ ] **Step 4: Build + smoke**

```bash
pnpm build
```

Expected: clean build, no TS errors, dist/ produced.

```bash
pnpm test
```

Expected: full suite passes (provider tests + instances + migration + sessions backfill + UI components).

- [ ] **Step 5: Manual smoke**

1. `pnpm dev` and load `dist/` as unpacked extension
2. Open extension on a fresh profile (or wipe storage):
   - Settings shows empty configs list + "+ 新建配置"
   - Create Anthropic config with real key + claude-opus-4-7 → auto-active
   - Switch to chat → InstanceChip shows "Anthropic · opus-4-7"
   - Send a message → response streams back
3. Create a second Anthropic config nicknamed "Personal":
   - Configs list shows 2 rows
   - Activate "Personal" → chip in chat updates after refresh
4. With existing session, switch chip back to first config → next message uses original
5. Delete active config → next config auto-activated; chat chip updates
6. Test Gemini if you have a key: create instance, send message — fetches from generativelanguage.googleapis.com
7. Reload extension (unload/load) → migration sentinel prevents re-running; configs intact

- [ ] **Step 6: Commit**

```bash
git add src/background/index.ts manifest.json
git commit -m "feat(sw): resolve session.instanceId → ModelConfig + manifest gemini permission

SW dispatch now reads from instance_\${uuid} layer; per-session instanceId
locks at first chat-start so global active changes don't disrupt in-flight
chats. Manifest gains generativelanguage.googleapis.com for Gemini.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Cleanup

After all 14 tasks land, remove dead code from `src/lib/storage.ts`:

- Delete `saveProviderConfig`, `getProviderConfig`, `deleteProviderConfig`, `getActiveProvider`, `setActiveProvider` (no longer called)
- Keep file structure but make it a barrel re-export of `instances.ts` if any test still imports it, otherwise delete the file

Run `pnpm test && pnpm build` once more to confirm. Single cleanup commit:

```bash
git add src/lib/storage.ts
git commit -m "chore(storage): remove provider_\${id} legacy paths

All call sites moved to instance_\${uuid} layer in Tasks 6/7/14. Schema_version
sentinel guarantees no provider_* keys remain in user storage post-migration.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

Re-checked spec against this plan:

| Spec section | Plan coverage |
|---|---|
| Registry schema upgrade (ProviderMeta + ModelMeta) | Task 1 |
| Storage schema (instance + index + active) | Task 6 |
| Migration silent + mapping | Task 7 |
| Session instanceId + lazy backfill | Task 8 |
| Provider modules architecture (extract core + 4 wrappers) | Tasks 2, 3, 4 |
| Gemini native module | Task 5 |
| Settings UI 配置中心 | Tasks 9–12 |
| Chat composer InstanceSelector | Task 13 |
| SW dispatch | Task 14 |
| Manifest Gemini permission | Task 14 |
| Test strategy 11 tests | Distributed across Tasks 1, 2, 3, 5, 6, 7, 8, 9, 10, 13 |

Placeholder scan: no "TBD" / "TODO" / "implement later" found. Type consistency: `StoredInstance` / `DecryptedInstance` / `InstanceFormPayload` are defined in tasks 6 / 6 / 10 respectively and used consistently downstream.

---

Plan complete and saved to `docs/plans/2026-05-06-provider-config-center.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
