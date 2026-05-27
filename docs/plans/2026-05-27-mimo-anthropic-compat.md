# MiMo provider via Anthropic-compat shared core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Xiaomi MiMo as a builtin provider via its Anthropic API–compatible endpoint, after extracting `anthropic.ts` core into a reusable `anthropic-compat-core` shared module.

**Architecture:** Mirror the existing `_shared/openai-compat-core.ts` pattern. The extracted `_shared/anthropic-compat-core.ts` exposes hooks (`endpointPath`, `authHeaders`, `customHeaders`, `promptCache`); `anthropic.ts` becomes a thin wrapper passing `{ promptCache: true }`, and the new `mimo.ts` wrapper overrides endpoint to `/anthropic/v1/messages` and auth to Bearer.

**Tech Stack:** TypeScript, vitest, happy-dom, Chrome Extension MV3, pnpm.

**Spec:** `docs/specs/2026-05-27-mimo-anthropic-compat-design.md`

---

## File Structure

**New files:**
- `src/lib/model-router/providers/_shared/anthropic-compat-core.ts` — extracted streaming + wire-format logic with hook interface
- `src/lib/model-router/providers/_shared/anthropic-compat-core.test.ts` — hook-injection unit tests
- `src/lib/model-router/providers/mimo.ts` — thin wrapper that calls shared core with MiMo-specific hooks
- `src/lib/model-router/providers/mimo.test.ts` — wrapper-level assertions (URL / headers / no cache_control)

**Modified files:**
- `src/lib/model-router/providers/anthropic.ts` — rewritten as thin wrapper passing `{ promptCache: true }`, re-exports test helpers
- `src/lib/model-router/index.ts` — extend `BuiltinProvider` union with `"mimo"`
- `src/lib/model-router/providers/index.ts` — import `mimoChat` and add to `streamChatByProvider`
- `src/lib/model-router/providers/registry.ts` — add MiMo `ProviderMeta` entry with 5 chat models
- `src/lib/model-router/providers/registry.test.ts` — add MiMo registration + model coverage tests
- `src/lib/model-router/dispatch.test.ts` — add `"mimo"` to the expected provider list
- `manifest.json` — append `"https://api.xiaomimimo.com/*"` to `host_permissions`

**Unchanged but referenced:**
- `src/lib/model-router/providers/_shared/openai-compat-core.ts` — `displayProviderName` is imported by the new anthropic-compat-core
- `src/lib/model-router/sse.ts` — `readSSELines` used by the new core (same as today)
- `src/lib/model-router/types.ts` — `AgentMessage`, `ToolDefinition`, `StreamEvent` unchanged

---

## Task 1: Extract `_shared/anthropic-compat-core.ts` (pure refactor, no behavior change)

**Goal:** Move the current `anthropic.ts` implementation verbatim into a shared module, with `anthropic.ts` becoming a thin delegate. No hook surface yet — that comes in Task 2. The existing `anthropic.test.ts` is the regression net: it must keep passing without modification.

**Files:**
- Create: `src/lib/model-router/providers/_shared/anthropic-compat-core.ts`
- Modify: `src/lib/model-router/providers/anthropic.ts` (rewrite)
- Reference (must keep passing): `src/lib/model-router/providers/anthropic.test.ts`

### Steps

- [ ] **Step 1.1: Create the shared core file**

Create `src/lib/model-router/providers/_shared/anthropic-compat-core.ts` with the full contents below. This is a verbatim move of `anthropic.ts` logic, renaming `streamChat` to `streamChatAnthropicCompat`. The hook param exists but is unused for now (filled in by Task 2/3).

```ts
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
): Record<string, unknown> {
  const { system, messages: wireMessages } = toWireMessages(messages);

  const body: Record<string, unknown> = {
    model: config.model,
    messages: wireMessages,
    stream: true,
    max_tokens: config.maxTokens ?? 4096,
  };

  if (system) {
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
    (wireTools[wireTools.length - 1] as Record<string, unknown>).cache_control =
      CACHE_CONTROL_EPHEMERAL;
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
  const body = buildRequestBody(config, messages, tools);
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
export const _buildRequestBodyForTest = buildRequestBody;
```

- [ ] **Step 1.2: Rewrite `anthropic.ts` as thin wrapper**

Overwrite `src/lib/model-router/providers/anthropic.ts` with:

```ts
import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { streamChatAnthropicCompat } from "./_shared/anthropic-compat-core";

export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  yield* streamChatAnthropicCompat(config, messages, signal, tools);
}

// Preserve test-only re-exports for anthropic.test.ts (imports via ./anthropic)
export { _toWireMessagesForTest, _buildRequestBodyForTest } from "./_shared/anthropic-compat-core";
```

- [ ] **Step 1.3: Run the existing anthropic test suite to verify no regression**

Run: `pnpm test -- src/lib/model-router/providers/anthropic.test.ts`

Expected: all 6 tests pass (image wire-shape + 5 prompt-caching tests).

- [ ] **Step 1.4: Run the full test suite**

Run: `pnpm test`

Expected: all tests pass. If anything outside the anthropic provider fails, stop and debug — the refactor should be behavior-preserving.

- [ ] **Step 1.5: Commit**

```bash
git add src/lib/model-router/providers/_shared/anthropic-compat-core.ts \
        src/lib/model-router/providers/anthropic.ts
git commit -m "refactor(model-router): extract anthropic-compat-core shared module

No behavior change. anthropic.ts is now a thin delegate to the new
shared core. Hook interface (endpointPath, authHeaders, customHeaders,
promptCache) is declared but unused — wired up in follow-up commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add `promptCache` hook (TDD)

**Goal:** Make prompt-cache breakpoints opt-in via `hooks.promptCache`. Default `false`. Anthropic native passes `true`; MiMo (and future Anthropic-compat providers) get `false` for free.

**Files:**
- Create: `src/lib/model-router/providers/_shared/anthropic-compat-core.test.ts`
- Modify: `src/lib/model-router/providers/_shared/anthropic-compat-core.ts`
- Modify: `src/lib/model-router/providers/anthropic.ts`

### Steps

- [ ] **Step 2.1: Write the failing tests for `promptCache: false`**

Create `src/lib/model-router/providers/_shared/anthropic-compat-core.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { _buildRequestBodyForTest } from "./anthropic-compat-core";
import type { AgentMessage, ToolDefinition } from "@/lib/model-router/types";
import type { ModelConfig } from "@/lib/model-router";

const config: ModelConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  apiKey: "sk-test",
  baseUrl: "https://api.anthropic.com",
};
const systemMsg: AgentMessage = { role: "system", content: "You are an agent." };
const userMsg: AgentMessage = { role: "user", content: "do the thing" };
const tools: ToolDefinition[] = [
  { name: "click", description: "click", parameters: { type: "object" } },
  { name: "type", description: "type", parameters: { type: "object" } },
];

describe("anthropic-compat-core: promptCache hook", () => {
  it("promptCache=false produces a plain string system field (no block array, no cache_control)", () => {
    const body = _buildRequestBodyForTest(config, [systemMsg, userMsg], tools, false);
    expect(body.system).toBe("You are an agent.");
  });

  it("promptCache=false leaves tools without cache_control", () => {
    const body = _buildRequestBodyForTest(config, [systemMsg, userMsg], tools, false);
    const wireTools = body.tools as Array<Record<string, unknown>>;
    expect(wireTools).toHaveLength(2);
    expect(wireTools[0].cache_control).toBeUndefined();
    expect(wireTools[1].cache_control).toBeUndefined();
  });

  it("promptCache=true still produces the cached-breakpoint shape (default for anthropic native)", () => {
    const body = _buildRequestBodyForTest(config, [systemMsg, userMsg], tools, true);
    expect(body.system).toEqual([
      { type: "text", text: "You are an agent.", cache_control: { type: "ephemeral" } },
    ]);
    const wireTools = body.tools as Array<Record<string, unknown>>;
    expect(wireTools[1].cache_control).toEqual({ type: "ephemeral" });
  });
});
```

- [ ] **Step 2.2: Run the new test file to confirm it fails**

Run: `pnpm test -- src/lib/model-router/providers/_shared/anthropic-compat-core.test.ts`

Expected: 2 failures — `promptCache=false` cases fail because `_buildRequestBodyForTest` doesn't yet accept the 4th `promptCache` arg and currently always emits `cache_control`. The `promptCache=true` test passes (matches current behavior).

- [ ] **Step 2.3: Thread `promptCache` through `buildRequestBody` and the test helper**

In `src/lib/model-router/providers/_shared/anthropic-compat-core.ts`:

Replace the existing `buildRequestBody` function with:

```ts
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
```

Update the `streamChatAnthropicCompat` body builder call to pass the flag:

Replace `const body = buildRequestBody(config, messages, tools);` with:

```ts
  const body = buildRequestBody(config, messages, tools, _hooks?.promptCache ?? false);
```

Update the test export to default `true` (so legacy `anthropic.test.ts` calls — which omit the 4th arg — keep getting the cached shape):

Replace `export const _buildRequestBodyForTest = buildRequestBody;` with:

```ts
export const _buildRequestBodyForTest = (
  config: ModelConfig,
  messages: AgentMessage[],
  tools?: ToolDefinition[],
  promptCache: boolean = true,
) => buildRequestBody(config, messages, tools, promptCache);
```

- [ ] **Step 2.4: Pass `promptCache: true` from the Anthropic native wrapper**

In `src/lib/model-router/providers/anthropic.ts`, replace the body of `streamChat`:

```ts
  yield* streamChatAnthropicCompat(config, messages, signal, tools, { promptCache: true });
```

- [ ] **Step 2.5: Run both test files**

Run: `pnpm test -- src/lib/model-router/providers/_shared/anthropic-compat-core.test.ts src/lib/model-router/providers/anthropic.test.ts`

Expected: all tests pass. The new core tests verify both `promptCache` modes; `anthropic.test.ts` still passes because its calls hit the test helper's `true` default.

- [ ] **Step 2.6: Run the full test suite**

Run: `pnpm test`

Expected: all tests pass.

- [ ] **Step 2.7: Commit**

```bash
git add src/lib/model-router/providers/_shared/anthropic-compat-core.ts \
        src/lib/model-router/providers/_shared/anthropic-compat-core.test.ts \
        src/lib/model-router/providers/anthropic.ts
git commit -m "feat(model-router): add promptCache hook to anthropic-compat-core

Anthropic native passes promptCache=true to preserve cache_control
breakpoints; future compat providers (MiMo) leave it false. The
_buildRequestBodyForTest test helper defaults to true so the existing
anthropic.test.ts continues to pass unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add `endpointPath`, `authHeaders`, `customHeaders` hooks (TDD)

**Goal:** Make endpoint path and auth headers customizable so MiMo can target `/anthropic/v1/messages` with `Authorization: Bearer ...` instead of the Anthropic-native `/v1/messages` with `x-api-key` + `anthropic-version`.

**Files:**
- Modify: `src/lib/model-router/providers/_shared/anthropic-compat-core.test.ts`
- Modify: `src/lib/model-router/providers/_shared/anthropic-compat-core.ts`

### Steps

- [ ] **Step 3.1: Append failing tests for hook injection**

Append to `src/lib/model-router/providers/_shared/anthropic-compat-core.test.ts`:

```ts
import { vi } from "vitest";
import { streamChatAnthropicCompat } from "./anthropic-compat-core";

function mockEmptyStream() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("event: message_stop\ndata: {}\n\n"));
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  );
}

describe("anthropic-compat-core: endpoint and header hooks", () => {
  it("default endpointPath is /v1/messages", async () => {
    const fetchMock = mockEmptyStream();
    for await (const _ of streamChatAnthropicCompat(config, [userMsg])) { /* drain */ }
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.anthropic.com/v1/messages");
    fetchMock.mockRestore();
  });

  it("hooks.endpointPath overrides the request URL suffix", async () => {
    const fetchMock = mockEmptyStream();
    for await (const _ of streamChatAnthropicCompat(config, [userMsg], undefined, undefined, {
      endpointPath: "/anthropic/v1/messages",
    })) { /* drain */ }
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.anthropic.com/anthropic/v1/messages");
    fetchMock.mockRestore();
  });

  it("default auth headers are x-api-key + anthropic-version", async () => {
    const fetchMock = mockEmptyStream();
    for await (const _ of streamChatAnthropicCompat(config, [userMsg])) { /* drain */ }
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers.authorization).toBeUndefined();
    fetchMock.mockRestore();
  });

  it("hooks.authHeaders fully replaces the default auth set", async () => {
    const fetchMock = mockEmptyStream();
    for await (const _ of streamChatAnthropicCompat(config, [userMsg], undefined, undefined, {
      authHeaders: (c) => ({ authorization: `Bearer ${c.apiKey}` }),
    })) { /* drain */ }
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBeUndefined();
    fetchMock.mockRestore();
  });

  it("hooks.customHeaders are merged on top of auth", async () => {
    const fetchMock = mockEmptyStream();
    for await (const _ of streamChatAnthropicCompat(config, [userMsg], undefined, undefined, {
      customHeaders: () => ({ "x-trace-id": "abc" }),
    })) { /* drain */ }
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-trace-id"]).toBe("abc");
    expect(headers["x-api-key"]).toBe("sk-test");
    fetchMock.mockRestore();
  });
});
```

- [ ] **Step 3.2: Run the test file to confirm 4 of 5 new tests fail**

Run: `pnpm test -- src/lib/model-router/providers/_shared/anthropic-compat-core.test.ts`

Expected: the "default endpointPath" and "default auth headers" tests pass (current behavior already matches). The `endpointPath`, `authHeaders`, and `customHeaders` override tests fail because the hooks are ignored.

- [ ] **Step 3.3: Wire hooks into the fetch call**

In `src/lib/model-router/providers/_shared/anthropic-compat-core.ts`, locate the `streamChatAnthropicCompat` function body. Replace the existing fetch block:

Find:
```ts
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
```

Replace with:
```ts
  const baseUrl = config.baseUrl!.replace(/\/$/, "");
  const endpointPath = _hooks?.endpointPath ?? "/v1/messages";
  const body = buildRequestBody(config, messages, tools, _hooks?.promptCache ?? false);
  const name = displayProviderName(config);

  const auth = _hooks?.authHeaders?.(config) ?? {
    "x-api-key": config.apiKey,
    "anthropic-version": "2023-06-01",
  };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...auth,
    ...(_hooks?.customHeaders?.(config) ?? {}),
  };

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${endpointPath}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
```

Rename `_hooks` → `hooks` in the function signature now that it's used (cosmetic — but keep it consistent):

Find:
```ts
  _hooks?: AnthropicCompatHooks,
```

Replace with:
```ts
  hooks?: AnthropicCompatHooks,
```

And update all three `_hooks?.` references in the function body to `hooks?.`.

- [ ] **Step 3.4: Run the test file**

Run: `pnpm test -- src/lib/model-router/providers/_shared/anthropic-compat-core.test.ts`

Expected: all 8 tests in this file pass.

- [ ] **Step 3.5: Run the full test suite**

Run: `pnpm test`

Expected: all tests pass. `anthropic.test.ts` is unaffected because the Anthropic native wrapper passes no overrides — defaults apply.

- [ ] **Step 3.6: Commit**

```bash
git add src/lib/model-router/providers/_shared/anthropic-compat-core.ts \
        src/lib/model-router/providers/_shared/anthropic-compat-core.test.ts
git commit -m "feat(model-router): wire endpointPath/authHeaders/customHeaders hooks

Mirrors the OpenAI-compat hook surface. Defaults preserve Anthropic
native behavior (/v1/messages + x-api-key + anthropic-version). MiMo
will override endpoint and auth in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Add MiMo wrapper + wrapper-level test (TDD)

**Goal:** Wire MiMo's request shape (Bearer auth, `/anthropic/v1/messages`, no cache_control) through the new hooks.

**Files:**
- Create: `src/lib/model-router/providers/mimo.test.ts`
- Create: `src/lib/model-router/providers/mimo.ts`

### Steps

- [ ] **Step 4.1: Write the failing wrapper test**

Create `src/lib/model-router/providers/mimo.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { streamChat } from "./mimo";
import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition } from "../types";

describe("mimo wrapper", () => {
  it("posts to /anthropic/v1/messages with Bearer auth and no anthropic-version / cache_control", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("event: message_stop\ndata: {}\n\n"));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const config: ModelConfig = {
      provider: "mimo",
      model: "mimo-v2.5-pro",
      apiKey: "mk-test",
      baseUrl: "https://api.xiaomimimo.com",
    };
    const messages: AgentMessage[] = [
      { role: "system", content: "you are an agent" },
      { role: "user", content: "hi" },
    ];
    const tools: ToolDefinition[] = [
      { name: "click", description: "click", parameters: { type: "object" } },
    ];

    for await (const _ of streamChat(config, messages, undefined, tools)) { /* drain */ }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.xiaomimimo.com/anthropic/v1/messages");

    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer mk-test");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBeUndefined();

    const body = JSON.parse((init as RequestInit).body as string);
    expect(typeof body.system).toBe("string");
    expect(body.system).toBe("you are an agent");
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].cache_control).toBeUndefined();

    fetchMock.mockRestore();
  });
});
```

- [ ] **Step 4.2: Run the test to confirm it fails**

Run: `pnpm test -- src/lib/model-router/providers/mimo.test.ts`

Expected: fail with "Cannot find module './mimo'".

- [ ] **Step 4.3: Create the MiMo wrapper**

Create `src/lib/model-router/providers/mimo.ts`:

```ts
import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { streamChatAnthropicCompat } from "./_shared/anthropic-compat-core";

export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  yield* streamChatAnthropicCompat(config, messages, signal, tools, {
    endpointPath: "/anthropic/v1/messages",
    authHeaders: (c) => ({ authorization: `Bearer ${c.apiKey}` }),
  });
}
```

- [ ] **Step 4.4: Run the test to verify it passes**

Run: `pnpm test -- src/lib/model-router/providers/mimo.test.ts`

Expected: pass.

- [ ] **Step 4.5: Commit**

```bash
git add src/lib/model-router/providers/mimo.ts \
        src/lib/model-router/providers/mimo.test.ts
git commit -m "feat(model-router): add MiMo provider via anthropic-compat-core

MiMo (小米) exposes an Anthropic-compatible endpoint at
/anthropic/v1/messages with Bearer auth. Wrapper just supplies hooks;
all wire-format logic is in the shared core.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire MiMo into the type system, dispatch table, and registry

**Goal:** Make `"mimo"` a first-class `BuiltinProvider`. After this task, an instance configured for MiMo will route end-to-end.

**Files:**
- Modify: `src/lib/model-router/index.ts`
- Modify: `src/lib/model-router/providers/index.ts`
- Modify: `src/lib/model-router/providers/registry.ts`
- Modify: `src/lib/model-router/providers/registry.test.ts`
- Modify: `src/lib/model-router/dispatch.test.ts`

### Steps

- [ ] **Step 5.1: Extend `BuiltinProvider` union**

In `src/lib/model-router/index.ts`, find the type definition:

```ts
export type BuiltinProvider =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "minimax"
  | "zhipu"
  | "bailian"
  | "gemini"
  | "deepseek";
```

Replace with:

```ts
export type BuiltinProvider =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "minimax"
  | "zhipu"
  | "bailian"
  | "gemini"
  | "deepseek"
  | "mimo";
```

- [ ] **Step 5.2: Add MiMo dispatch entry**

In `src/lib/model-router/providers/index.ts`:

Find:
```ts
import { streamChat as deepseekChat } from "./deepseek";
```

Add directly below:
```ts
import { streamChat as mimoChat } from "./mimo";
```

Find:
```ts
export const streamChatByProvider: Record<BuiltinProvider, StreamChatFn> = {
  anthropic: anthropicChat,
  openai: openaiChat,
  openrouter: openrouterChat,
  zhipu: zhipuChat,
  bailian: bailianChat,
  minimax: minimaxChat,
  gemini: geminiChat,
  deepseek: deepseekChat,
};
```

Replace with:
```ts
export const streamChatByProvider: Record<BuiltinProvider, StreamChatFn> = {
  anthropic: anthropicChat,
  openai: openaiChat,
  openrouter: openrouterChat,
  zhipu: zhipuChat,
  bailian: bailianChat,
  minimax: minimaxChat,
  gemini: geminiChat,
  deepseek: deepseekChat,
  mimo: mimoChat,
};
```

- [ ] **Step 5.3: Add MiMo registry entry**

In `src/lib/model-router/providers/registry.ts`, append the new entry to the end of `PROVIDER_REGISTRY` (after the DeepSeek block, before the closing `];`):

```ts
  {
    id: "mimo",
    name: "MiMo (小米)",
    defaultBaseUrl: "https://api.xiaomimimo.com",
    placeholder: "API key",
    models: [
      { id: "mimo-v2.5-pro", vision: false, tools: true, maxContextTokens: 1_000_000 },
      { id: "mimo-v2.5",     vision: true,  tools: true, maxContextTokens: 1_000_000 },
      { id: "mimo-v2-pro",   vision: false, tools: true, maxContextTokens: 1_000_000 },
      { id: "mimo-v2-omni",  vision: true,  tools: true, maxContextTokens: 256_000   },
      { id: "mimo-v2-flash", vision: false, tools: true, maxContextTokens: 256_000   },
    ],
  },
```

- [ ] **Step 5.4: Update `dispatch.test.ts` provider enumeration**

In `src/lib/model-router/dispatch.test.ts`, find:

```ts
    const expected = ["anthropic", "openai", "openrouter", "zhipu", "bailian", "minimax", "gemini", "deepseek"] as const;
```

Replace with:

```ts
    const expected = ["anthropic", "openai", "openrouter", "zhipu", "bailian", "minimax", "gemini", "deepseek", "mimo"] as const;
```

- [ ] **Step 5.5: Update `registry.test.ts` non-empty-models enumeration**

In `src/lib/model-router/providers/registry.test.ts`, find:

```ts
    const ids = ["anthropic", "openai", "zhipu", "bailian", "minimax", "gemini", "deepseek"] as const;
```

Replace with:

```ts
    const ids = ["anthropic", "openai", "zhipu", "bailian", "minimax", "gemini", "deepseek", "mimo"] as const;
```

- [ ] **Step 5.6: Add MiMo-specific registry tests**

In `src/lib/model-router/providers/registry.test.ts`, find the DeepSeek registration block:

```ts
  it("DeepSeek is registered", () => {
    expect(getProviderMeta("deepseek")).toBeDefined();
    expect(getProviderMeta("deepseek")!.defaultBaseUrl).toBe("https://api.deepseek.com");
  });
```

Add directly below it:

```ts
  it("MiMo is registered", () => {
    expect(getProviderMeta("mimo")).toBeDefined();
    expect(getProviderMeta("mimo")!.defaultBaseUrl).toBe("https://api.xiaomimimo.com");
    expect(getProviderMeta("mimo")!.name).toBe("MiMo (小米)");
  });
```

Then find the DeepSeek capability block:

```ts
  it("DeepSeek model capability flags", () => {
    expect(getModelMeta("deepseek", "deepseek-v4-flash")?.tools).toBe(true);
    expect(getModelMeta("deepseek", "deepseek-v4-flash")?.vision).toBe(false);
    expect(getModelMeta("deepseek", "deepseek-v4-flash")?.maxContextTokens).toBe(1_000_000);
  });
```

Add directly below it:

```ts
  it("MiMo model capability flags — pro is text-only, v2.5 has vision, omni has vision", () => {
    expect(getModelMeta("mimo", "mimo-v2.5-pro")?.tools).toBe(true);
    expect(getModelMeta("mimo", "mimo-v2.5-pro")?.vision).toBe(false);
    expect(getModelMeta("mimo", "mimo-v2.5-pro")?.maxContextTokens).toBe(1_000_000);

    expect(getModelMeta("mimo", "mimo-v2.5")?.vision).toBe(true);
    expect(getModelMeta("mimo", "mimo-v2.5")?.maxContextTokens).toBe(1_000_000);

    expect(getModelMeta("mimo", "mimo-v2-omni")?.vision).toBe(true);
    expect(getModelMeta("mimo", "mimo-v2-omni")?.maxContextTokens).toBe(256_000);
  });

  it("MiMo does NOT expose TTS models (mimo-v2.5-tts, etc.)", () => {
    expect(getModelMeta("mimo", "mimo-v2.5-tts")).toBeUndefined();
    expect(getModelMeta("mimo", "mimo-v2-tts")).toBeUndefined();
    expect(getModelMeta("mimo", "mimo-v2.5-tts-voiceclone")).toBeUndefined();
    expect(getModelMeta("mimo", "mimo-v2.5-tts-voicedesign")).toBeUndefined();
  });
```

- [ ] **Step 5.7: Run the full test suite**

Run: `pnpm test`

Expected: all tests pass, including the new MiMo coverage and the updated provider enumerations.

- [ ] **Step 5.8: Commit**

```bash
git add src/lib/model-router/index.ts \
        src/lib/model-router/providers/index.ts \
        src/lib/model-router/providers/registry.ts \
        src/lib/model-router/providers/registry.test.ts \
        src/lib/model-router/dispatch.test.ts
git commit -m "feat(model-router): register MiMo (小米) as builtin provider

Adds 'mimo' to the BuiltinProvider union, dispatch table, and registry
with 5 chat models (mimo-v2.5-pro/v2.5/v2-pro/v2-omni/v2-flash). TTS
variants are excluded since they do not implement /v1/messages.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Manifest host permission + final verification

**Goal:** Allow the extension to reach `api.xiaomimimo.com`, then run the full test + build pipeline (the build is the place where the manifest invariants and `tool-names.ts` / `tools.ts` checks run).

**Files:**
- Modify: `manifest.json`

### Steps

- [ ] **Step 6.1: Add MiMo host_permission**

In `manifest.json`, find the `host_permissions` array:

```json
  "host_permissions": [
    "<all_urls>",
    "https://api.anthropic.com/*",
    "https://api.openai.com/*",
    "https://openrouter.ai/*",
    "https://api.minimax.chat/*",
    "https://open.bigmodel.cn/*",
    "https://dashscope.aliyuncs.com/*",
    "https://generativelanguage.googleapis.com/*",
    "https://api.deepseek.com/*",
    "https://api.tavily.com/*"
  ],
```

Add `"https://api.xiaomimimo.com/*"` after the DeepSeek entry:

```json
  "host_permissions": [
    "<all_urls>",
    "https://api.anthropic.com/*",
    "https://api.openai.com/*",
    "https://openrouter.ai/*",
    "https://api.minimax.chat/*",
    "https://open.bigmodel.cn/*",
    "https://dashscope.aliyuncs.com/*",
    "https://generativelanguage.googleapis.com/*",
    "https://api.deepseek.com/*",
    "https://api.xiaomimimo.com/*",
    "https://api.tavily.com/*"
  ],
```

- [ ] **Step 6.2: Run the full test suite once more**

Run: `pnpm test`

Expected: all tests pass.

- [ ] **Step 6.3: Run the production build**

Run: `pnpm build`

Expected: build completes without errors. Per CLAUDE.md, build-time invariants in `tool-names.ts` and `tools.ts` will throw if anything is out of place — none of our changes touch tools, so these should stay green. `dist/manifest.json` should now contain the MiMo host permission.

- [ ] **Step 6.4: Commit**

```bash
git add manifest.json
git commit -m "chore(manifest): add MiMo host_permission for /anthropic/v1/messages

Required for the MiMo provider to fetch the streaming endpoint from
the side panel.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Checklist (executed before commit chain)

- **Spec coverage:** Tasks 1–3 cover the shared-core extraction + hook surface; Task 4 covers `mimo.ts` + `mimo.test.ts`; Task 5 covers BuiltinProvider type, registry entry, dispatch, registry/dispatch test updates; Task 6 covers manifest. All spec sections trace to a task.
- **Placeholder scan:** No TBD / TODO / "add appropriate error handling" / "similar to Task N" — every code block is complete and self-contained.
- **Type consistency:** `streamChatAnthropicCompat` signature is identical across Tasks 1–3 (config, messages, signal?, tools?, hooks?). `AnthropicCompatHooks` field names (`endpointPath`, `authHeaders`, `customHeaders`, `promptCache`) match between definition (Task 1) and consumption (Tasks 2–4). `_buildRequestBodyForTest` signature is consistent across declaration (Task 2, with `promptCache: true` default) and the existing `anthropic.test.ts` callers (omit 4th arg, get default true).
- **Test isolation:** `mimo.test.ts` mocks `globalThis.fetch` and restores in a `finally`-equivalent (mockRestore at end of `it`). Shared-core tests do the same. No cross-test state.

---

## Notes for the executor

- Run `pnpm test` and `pnpm build` after each task — not only at the end. The build is the place where MV3 manifest invariants surface; tests are the place where capability-flag and dispatch invariants surface.
- If `pnpm test` fails in a non-MiMo provider after Task 1, **stop**. The extraction should be behavior-preserving; a regression there indicates the move dropped something. Compare Task 1's shared-core file character-by-character against the pre-extraction `anthropic.ts`.
- Do not push to remote during execution unless explicitly asked.
- Do not bump version / release. That is a separate workflow (see CLAUDE.md "Release").
