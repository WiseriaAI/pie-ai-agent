# MiMo provider via Anthropic-compat shared core

**Date:** 2026-05-27
**Status:** Design approved, pending implementation plan
**Scope:** Add Xiaomi MiMo as a builtin provider, accessed through MiMo's Anthropic API–compatible endpoint. As a prerequisite, extract a reusable `anthropic-compat-core` shared module from the existing `anthropic.ts` provider — symmetric to the existing `openai-compat-core`.

## Motivation

MiMo (小米 MiMo, `platform.xiaomimimo.com`) exposes two interfaces:

1. OpenAI Chat Completions–compatible at `/v1/chat/completions`
2. Anthropic Messages–compatible at `/anthropic/v1/messages`

The user prefers the Anthropic-compat path. The codebase currently has shared infrastructure for OpenAI-compat (`_shared/openai-compat-core.ts`) consumed by 6 providers (openai, openrouter, zhipu, bailian, minimax, deepseek), but Anthropic is a native one-off. Adding a second Anthropic-compat provider (MiMo) is the right moment to lift the shared core, so future Anthropic-compat providers (Bedrock, Vertex, custom proxies) plug in with a thin wrapper instead of a fork.

## Non-goals

- Adding MiMo's OpenAI-compat path. The user explicitly chose Anthropic-compat first; a second path would multiply the surface area without a use case.
- Exposing MiMo's TTS / voice-clone / voice-design models (`mimo-v2.5-tts*`, `mimo-v2-tts`). They do not implement chat completions.
- Wiring MiMo's `thinking` field (Anthropic-incompatible extension for extended-thinking output). Out of scope; revisit when a user asks.
- Letting users edit `baseUrl` in the UI. Preserves the existing invariant that `defaultBaseUrl` is the single source of truth.
- Migration logic. New provider has no V1 storage to migrate from.

## Architecture

### Shared core extraction

Today:

```
providers/
├── anthropic.ts                       (~270 lines: wire + cache + SSE + errors)
└── _shared/openai-compat-core.ts      (consumed by openai, openrouter, zhipu,
                                         bailian, minimax, deepseek — 6 providers)
```

After:

```
providers/
├── anthropic.ts                       (thin wrapper, ~15 lines)
├── mimo.ts                            (thin wrapper, ~15 lines, NEW)
└── _shared/
    ├── openai-compat-core.ts          (unchanged)
    └── anthropic-compat-core.ts       (NEW: extracted from anthropic.ts)
```

### Shared-core hook surface

```ts
// _shared/anthropic-compat-core.ts
export interface AnthropicCompatHooks {
  /** Endpoint path appended to config.baseUrl. Default: "/v1/messages" */
  endpointPath?: string;

  /**
   * Auth headers. Default:
   *   { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
   * MiMo overrides to Bearer and omits anthropic-version.
   */
  authHeaders?: (config: ModelConfig) => Record<string, string>;

  /** Extra headers merged onto the base set. */
  customHeaders?: (config: ModelConfig) => Record<string, string>;

  /**
   * Enable Anthropic prompt-cache breakpoints (cache_control: ephemeral on
   * system block + last tool). Default: false. Anthropic native sets true;
   * MiMo leaves false (cache_control behavior not documented upstream).
   */
  promptCache?: boolean;
}

export async function* streamChatAnthropicCompat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
  hooks?: AnthropicCompatHooks,
): AsyncGenerator<StreamEvent>;
```

Error messages use `displayProviderName(config)` (the helper already exported by `openai-compat-core`), so MiMo errors say "MiMo (小米) API error" not "Anthropic API error". `displayProviderName` will be relocated to a shared utility or re-exported from `anthropic-compat-core` to avoid a cross-import cycle — exact placement is an implementation detail for the plan.

### Provider wrappers

**`anthropic.ts` (rewritten as thin wrapper):**

```ts
import { streamChatAnthropicCompat } from "./_shared/anthropic-compat-core";

export async function* streamChat(config, messages, signal, tools) {
  yield* streamChatAnthropicCompat(config, messages, signal, tools, {
    promptCache: true,
  });
}

// Test-only re-exports preserved for anthropic.test.ts
export { _toWireMessagesForTest, _buildRequestBodyForTest } from "./_shared/anthropic-compat-core";
```

**`mimo.ts` (new):**

```ts
import { streamChatAnthropicCompat } from "./_shared/anthropic-compat-core";

export async function* streamChat(config, messages, signal, tools) {
  yield* streamChatAnthropicCompat(config, messages, signal, tools, {
    endpointPath: "/anthropic/v1/messages",
    authHeaders: (c) => ({ authorization: `Bearer ${c.apiKey}` }),
  });
}
```

### Registry entry

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
}
```

TTS models (`mimo-v2.5-tts`, `mimo-v2.5-tts-voiceclone`, `mimo-v2.5-tts-voicedesign`, `mimo-v2-tts`) are excluded — they do not serve `/v1/messages`.

### Type / dispatch wiring

- `src/lib/model-router/index.ts`: extend `BuiltinProvider` with `"mimo"`.
- `src/lib/model-router/providers/index.ts`: import `streamChat as mimoChat` and add to `streamChatByProvider`.
- `manifest.json`: append `"https://api.xiaomimimo.com/*"` to `host_permissions`.

## Data flow

Identical to the existing Anthropic path:

1. `ModelConfig { provider: "mimo", model, apiKey, baseUrl: "https://api.xiaomimimo.com" }` resolves at task start (`resolveInstanceToModelConfig`).
2. `dispatchStreamChat` routes to `mimoChat` via `BUILTIN_DISPATCH`.
3. `mimoChat` calls `streamChatAnthropicCompat` with MiMo's hook overrides.
4. Shared core serializes `AgentMessage[]` to Anthropic wire format, POSTs to `https://api.xiaomimimo.com/anthropic/v1/messages`, parses SSE, yields normalized `StreamEvent` records to the agent loop.

No changes to ReAct loop, untrusted wrappers, session state, or sliding-window logic — the change is contained inside the provider layer.

## Testing strategy

Three layers of test:

1. **`_shared/anthropic-compat-core.test.ts` (new)** — pure core: wire-shape (system hoist, image mediaType snake_case, tool_use serialization), SSE state machine (open/close blocks, tool_use accumulation, stop_reason mapping), hook injection (endpointPath / authHeaders / customHeaders / promptCache toggle).
2. **`anthropic.test.ts` (preserved, possibly minor import tweak)** — verifies wrapper still emits Anthropic-native shape: `/v1/messages` URL, `x-api-key` + `anthropic-version: 2023-06-01`, `cache_control: ephemeral` on system + last tool. This is the regression net for the extraction.
3. **`mimo.test.ts` (new)** — verifies wrapper diverges where it should: URL ends with `/anthropic/v1/messages`, `authorization: Bearer ...` header present, `x-api-key` and `anthropic-version` absent, no `cache_control` field anywhere in the request body.

Run `pnpm test` and `pnpm build` before commit (per CLAUDE.md).

## Risks and mitigations

**R1 — MiMo SSE event names undocumented.** Official docs show only non-streaming response shape; streaming event names (`message_start`, `content_block_delta`, etc.) and payload field names are not explicitly listed. Assumption: MiMo's "Anthropic-compatible" label means the SSE protocol is byte-for-byte identical.

*Mitigation:* Ship as designed. If real-world traffic reveals divergence, add an `eventNameMap` or `parseSSE` hook in a follow-up; do not pre-build it.

**R2 — `thinking` field may emit non-Anthropic SSE events.** MiMo's `thinking` extension is for extended-thinking output; if the server ever streams `thinking_delta` or similar events with no client opt-in, the SSE loop will silently ignore them (no event handler matches → fall through). Risk is benign: the assistant still gets the final text output.

*Mitigation:* No code change. Document the behavior; if users want extended-thinking output surfaced, address it in a follow-up.

**R3 — `displayProviderName` extraction cycle.** It currently lives in `openai-compat-core.ts`. The Anthropic-compat core needs it too, but importing across `_shared/` siblings is fine. Picking the exact home (move to a new `_shared/util.ts`, or re-export) is plan-level detail.

**R4 — Existing `anthropic.test.ts` import drift.** The test currently imports `_toWireMessagesForTest` / `_buildRequestBodyForTest` from `./anthropic`. The wrapper preserves these re-exports, so the test path is unchanged.

## Implementation order (preview for writing-plans)

1. Extract `_shared/anthropic-compat-core.ts` from `anthropic.ts`; gate prompt-cache + headers behind `AnthropicCompatHooks`; preserve `_toWireMessagesForTest` / `_buildRequestBodyForTest` exports.
2. Rewrite `anthropic.ts` as thin wrapper passing `{ promptCache: true }`; verify existing tests pass.
3. Add `_shared/anthropic-compat-core.test.ts` for hook injection coverage.
4. Add `mimo.ts` wrapper and `mimo.test.ts`.
5. Extend `BuiltinProvider` type, registry entry, dispatch map.
6. Add `https://api.xiaomimimo.com/*` to manifest `host_permissions`.
7. Run `pnpm test` + `pnpm build`; fix any invariant fallout.

## Files touched (summary)

| File | Change |
|---|---|
| `src/lib/model-router/providers/_shared/anthropic-compat-core.ts` | NEW |
| `src/lib/model-router/providers/_shared/anthropic-compat-core.test.ts` | NEW |
| `src/lib/model-router/providers/anthropic.ts` | rewrite as thin wrapper |
| `src/lib/model-router/providers/anthropic.test.ts` | preserved; import path may need touch |
| `src/lib/model-router/providers/mimo.ts` | NEW |
| `src/lib/model-router/providers/mimo.test.ts` | NEW |
| `src/lib/model-router/providers/registry.ts` | add MiMo entry |
| `src/lib/model-router/providers/registry.test.ts` | update provider-count assertion if any |
| `src/lib/model-router/providers/index.ts` | import + dispatch |
| `src/lib/model-router/index.ts` | extend `BuiltinProvider` |
| `manifest.json` | add MiMo host_permission |
