# Moonshot (Kimi) Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Moonshot AI (Kimi) as a builtin BYOK provider, exposed as **two** selectable registry entries — international (`api.moonshot.ai`) and China (`api.moonshot.cn`) — that share one streaming module and one model list.

**Architecture:** Moonshot speaks the **OpenAI Chat Completions wire** (`Authorization: Bearer <key>`, `POST /v1/chat/completions`, SSE streaming). So the provider module is a zero-hook thin wrapper around the existing `_shared/openai-compat-core.ts`, exactly like `openai.ts`/`zhipu.ts`. The two-region requirement is satisfied **without** breaking the "builtin baseUrl is hardcoded, UI never edits it" invariant: we register two `ProviderMeta` entries (`moonshot` + `moonshot-cn`) with different `defaultBaseUrl`/`name`, both dispatching to the same `moonshot.ts` and both referencing one shared `MOONSHOT_MODELS` array. The user picks the region by picking the entry in the New-Config wizard (which auto-renders from `PROVIDER_REGISTRY`).

**Tech Stack:** TypeScript 6, `_shared/openai-compat-core.ts`, vitest (happy-dom), Chrome MV3 manifest, pnpm.

---

## Why this shape (decisions already made)

- **Wire format = OpenAI-compatible.** Kimi docs: *"compatible with OpenAI Chat Completions API"*, `Authorization: Bearer $MOONSHOT_API_KEY`, base `https://api.moonshot.ai/v1`. → Use `streamChatOpenAICompat` with **no hooks** (default Bearer auth already matches).
- **Two registry entries, not an in-form region dropdown.** Builtin `defaultBaseUrl` is the single source of truth and the UI never edits it (`src/lib/model-router/providers/registry.ts:20`, CLAUDE.md "BaseURL 封装"). A per-instance region override would break that invariant and ripple into `InstanceForm`, instance storage, `resolveInstanceToModelConfig`, and checkpoint snapshots. Two entries achieve the same UX with zero new machinery. **User confirmed this approach.**
- **Endpoint derivation is automatic.** `openai-compat-core.ts:125` appends `/v1/chat/completions` when `baseUrl` does **not** end in `/vN`. With base `https://api.moonshot.ai` → `https://api.moonshot.ai/v1/chat/completions`. Correct for both regions. (We deliberately store the bare host, matching `openai`/`anthropic`/`deepseek` style — not the `/v1` suffix.)
- **Provider id `moonshot-cn` (hyphen) is safe.** Dispatch only special-cases the `custom:` prefix (`providers/index.ts:41`); registry lookup is `===`; instance storage is keyed by uuid, not provider id. The per-provider sticky model pool key `pcm_${provider}` becomes `pcm_moonshot-cn` (a valid storage key).
- **Curated model list** (4 models, shared by both regions):

  | model id | vision | tools | maxContextTokens | note |
  |---|---|---|---|---|
  | `kimi-k2.6` | ✅ | ✅ | 256_000 | flagship, multimodal |
  | `kimi-k2.5` | ✅ | ✅ | 256_000 | multimodal |
  | `moonshot-v1-128k` | ❌ | ✅ | 128_000 | text fallback |
  | `moonshot-v1-32k` | ❌ | ✅ | 32_000 | cheaper text fallback |

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/lib/model-router/index.ts` | Modify (`:13-22`) | Add `"moonshot"` + `"moonshot-cn"` to the `BuiltinProvider` union (the compile-time exhaustiveness anchor). |
| `src/lib/model-router/providers/moonshot.ts` | **Create** | Thin OpenAI-compat streaming wrapper shared by both regions. |
| `src/lib/model-router/providers/moonshot.test.ts` | **Create** | Verifies both regions POST to the right endpoint with Bearer auth and no custom headers. |
| `src/lib/model-router/providers/index.ts` | Modify (`:13`, `:23-33`) | Import `moonshotChat`; add `moonshot` + `"moonshot-cn"` keys to `streamChatByProvider`. |
| `src/lib/model-router/dispatch.test.ts` | Modify (`:6`) | Extend the exhaustiveness `expected` list with the two new ids. |
| `src/lib/model-router/providers/registry.ts` | Modify (add `MOONSHOT_MODELS` const + 2 entries before `:140`) | The two `ProviderMeta` entries + shared model list. |
| `src/lib/model-router/providers/registry.test.ts` | Modify (`:30` + new `describe`) | Lock in dual-region registration + capability flags. |
| `manifest.json` | Modify (`:8-20`) | Add `https://api.moonshot.ai/*` + `https://api.moonshot.cn/*` host permissions. |
| `README.md` | Modify (`:142`) | Add Moonshot row to the supported-providers table. |
| `CLAUDE.md` | Modify (`:74`) | Add `moonshot` to the documented OpenAI-compat family list (doc hygiene). |

No UI files change — `NewConfigWizard` and `InstanceForm` render from `PROVIDER_REGISTRY`, so both entries appear automatically. No `_locales` change — `name`/`placeholder` are plain strings in the registry (consistent with `ZhiPu (智谱)` etc.).

---

## Task 1: Provider module, type union, and dispatch wiring

This is the foundational vertical slice. It keeps `tsc` green at commit time: `streamChatByProvider` is typed `Record<BuiltinProvider, StreamChatFn>`, so adding the union members **forces** the dispatch keys to exist (compile-time guard), and the module they reference must exist.

**Files:**
- Modify: `src/lib/model-router/index.ts:13-22`
- Create: `src/lib/model-router/providers/moonshot.ts`
- Create: `src/lib/model-router/providers/moonshot.test.ts`
- Modify: `src/lib/model-router/providers/index.ts:13` and `:23-33`
- Modify: `src/lib/model-router/dispatch.test.ts:6`

- [ ] **Step 1: Add the two ids to the `BuiltinProvider` union**

In `src/lib/model-router/index.ts`, change the union (currently lines 13-22) to:

```typescript
export type BuiltinProvider =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "minimax"
  | "zhipu"
  | "bailian"
  | "gemini"
  | "deepseek"
  | "mimo"
  | "moonshot"
  | "moonshot-cn";
```

- [ ] **Step 2: Write the failing wrapper test**

Create `src/lib/model-router/providers/moonshot.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { streamChat } from "./moonshot";
import type { ModelConfig } from "@/lib/model-router";

function done(): Response {
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

afterEach(() => vi.restoreAllMocks());

describe("moonshot wrapper (OpenAI-compat, dual-region)", () => {
  it("international entry posts to api.moonshot.ai/v1/chat/completions with Bearer auth", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(done());
    const config: ModelConfig = {
      provider: "moonshot",
      model: "kimi-k2.6",
      apiKey: "sk-test",
      baseUrl: "https://api.moonshot.ai",
    };
    for await (const _ of streamChat(config, [{ role: "user", content: "hi" }])) {
      /* drain */
    }
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.moonshot.ai/v1/chat/completions");
    const h = new Headers((init as RequestInit).headers as HeadersInit);
    expect(h.get("authorization")).toBe("Bearer sk-test");
    // zero-hook wrapper → no provider-specific custom headers (unlike OpenRouter)
    expect(h.get("HTTP-Referer")).toBeNull();
  });

  it("China entry posts to api.moonshot.cn/v1/chat/completions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(done());
    const config: ModelConfig = {
      provider: "moonshot-cn",
      model: "kimi-k2.6",
      apiKey: "sk-test",
      baseUrl: "https://api.moonshot.cn",
    };
    for await (const _ of streamChat(config, [{ role: "user", content: "hi" }])) {
      /* drain */
    }
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.moonshot.cn/v1/chat/completions");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test moonshot`
Expected: FAIL — vitest cannot resolve the import, e.g. `Failed to resolve import "./moonshot"` / `Cannot find module './moonshot'`.

- [ ] **Step 4: Create the provider module**

Create `src/lib/model-router/providers/moonshot.ts`:

```typescript
import type { ModelConfig } from "@/lib/model-router";
import type { AgentMessage, ToolDefinition, StreamEvent } from "@/lib/model-router/types";
import { streamChatOpenAICompat } from "./_shared/openai-compat-core";

// Moonshot AI (Kimi) speaks the OpenAI Chat Completions wire: Bearer auth,
// POST /v1/chat/completions, SSE streaming. No hooks needed — the core's
// default `Authorization: Bearer ${apiKey}` already matches Moonshot.
//
// Both the international (api.moonshot.ai) and China (api.moonshot.cn) endpoints
// share this module; the region is selected by which registry entry
// (moonshot / moonshot-cn) the instance was created under, which sets
// config.baseUrl before this runs.
export async function* streamChat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
): AsyncGenerator<StreamEvent> {
  yield* streamChatOpenAICompat(config, messages, signal, tools);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test moonshot`
Expected: PASS — 2 passed (api.moonshot.ai + api.moonshot.cn endpoints, Bearer auth).

- [ ] **Step 6: Wire the module into the dispatch table**

In `src/lib/model-router/providers/index.ts`, add the import after line 13 (`import { streamChat as mimoChat } from "./mimo";`):

```typescript
import { streamChat as moonshotChat } from "./moonshot";
```

Then add the two keys to `streamChatByProvider` (currently lines 23-33) so it reads:

```typescript
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
  moonshot: moonshotChat,
  "moonshot-cn": moonshotChat,
};
```

- [ ] **Step 7: Extend the dispatch exhaustiveness test**

In `src/lib/model-router/dispatch.test.ts`, change the `expected` array (line 6) to:

```typescript
    const expected = ["anthropic", "openai", "openrouter", "zhipu", "bailian", "minimax", "gemini", "deepseek", "mimo", "moonshot", "moonshot-cn"] as const;
```

- [ ] **Step 8: Run typecheck + dispatch test**

Run: `pnpm typecheck`
Expected: PASS — exit 0, no output. (Before Step 6 it would have failed with `Property 'moonshot' is missing in type ... Record<BuiltinProvider, StreamChatFn>` — that compile-time guard is now satisfied.)

Run: `pnpm test dispatch`
Expected: PASS — `has a streamChat function for every Provider in the union`.

- [ ] **Step 9: Commit**

```bash
git add src/lib/model-router/index.ts src/lib/model-router/providers/moonshot.ts src/lib/model-router/providers/moonshot.test.ts src/lib/model-router/providers/index.ts src/lib/model-router/dispatch.test.ts
git commit -m "feat(model-router): add Moonshot (Kimi) streaming module + dispatch (dual-region)"
```

---

## Task 2: Registry entries for both regions

Registers `moonshot` (international) and `moonshot-cn` (China) as `ProviderMeta`, sharing one `MOONSHOT_MODELS` list. This is what makes both regions appear in the New-Config wizard and resolves the per-region `defaultBaseUrl`.

**Files:**
- Modify: `src/lib/model-router/providers/registry.ts` (new const above `PROVIDER_REGISTRY`; two entries before the closing `]` at line 140)
- Modify: `src/lib/model-router/providers/registry.test.ts:30` + new `describe` block

- [ ] **Step 1: Write the failing registry tests**

In `src/lib/model-router/providers/registry.test.ts`, first extend the existing non-empty-models list (line 30) to include the new ids:

```typescript
    const ids = ["anthropic", "openai", "zhipu", "bailian", "minimax", "gemini", "deepseek", "mimo", "moonshot", "moonshot-cn"] as const;
```

Then append a new `describe` block at the end of the file (after the `Per-provider model id uniqueness` block, after line 171):

```typescript
describe("Moonshot (Kimi) — dual-region registration", () => {
  it("international entry registered with api.moonshot.ai", () => {
    const meta = getProviderMeta("moonshot")!;
    expect(meta).toBeDefined();
    expect(meta.defaultBaseUrl).toBe("https://api.moonshot.ai");
    expect(meta.name).toBe("Moonshot (Kimi)");
  });

  it("China entry registered with api.moonshot.cn", () => {
    const meta = getProviderMeta("moonshot-cn")!;
    expect(meta).toBeDefined();
    expect(meta.defaultBaseUrl).toBe("https://api.moonshot.cn");
    expect(meta.name).toBe("Moonshot (Kimi) 中国区");
  });

  it("both regions expose the same model list", () => {
    const intl = getProviderMeta("moonshot")!.models.map((m) => m.id);
    const cn = getProviderMeta("moonshot-cn")!.models.map((m) => m.id);
    expect(cn).toEqual(intl);
    expect(intl).toContain("kimi-k2.6");
  });

  it("kimi-k2.6 / kimi-k2.5 have vision + tools + 256K context", () => {
    for (const id of ["kimi-k2.6", "kimi-k2.5"]) {
      const m = getModelMeta("moonshot", id)!;
      expect(m.vision).toBe(true);
      expect(m.tools).toBe(true);
      expect(m.maxContextTokens).toBe(256_000);
    }
  });

  it("moonshot-v1-128k is text-only with tools (128K)", () => {
    const m = getModelMeta("moonshot", "moonshot-v1-128k")!;
    expect(m.vision).toBe(false);
    expect(m.tools).toBe(true);
    expect(m.maxContextTokens).toBe(128_000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test registry`
Expected: FAIL — `getProviderMeta("moonshot")` returns `undefined` at runtime, so `meta.defaultBaseUrl` throws `TypeError: Cannot read properties of undefined (reading 'defaultBaseUrl')` (and the line-30 loop throws on `.models.length`).

- [ ] **Step 3: Add the shared model list + two registry entries**

In `src/lib/model-router/providers/registry.ts`, add the shared model const immediately **above** `export const PROVIDER_REGISTRY` (i.e. before line 37):

```typescript
// Kimi (Moonshot) curated models — shared by both the international
// (api.moonshot.ai) and China (api.moonshot.cn) registry entries so the two
// stay in lockstep. kimi-k2.x are multimodal; moonshot-v1-* are text fallbacks.
const MOONSHOT_MODELS: ModelMeta[] = [
  { id: "kimi-k2.6", vision: true, tools: true, maxContextTokens: 256_000 },
  { id: "kimi-k2.5", vision: true, tools: true, maxContextTokens: 256_000 },
  { id: "moonshot-v1-128k", vision: false, tools: true, maxContextTokens: 128_000 },
  { id: "moonshot-v1-32k", vision: false, tools: true, maxContextTokens: 32_000 },
];
```

Then insert the two entries inside `PROVIDER_REGISTRY`, immediately after the `mimo` entry's closing `},` (line 139) and before the array's closing `];` (line 140):

```typescript
  {
    id: "moonshot",
    name: "Moonshot (Kimi)",
    defaultBaseUrl: "https://api.moonshot.ai",
    placeholder: "sk-...",
    models: MOONSHOT_MODELS,
  },
  {
    id: "moonshot-cn",
    name: "Moonshot (Kimi) 中国区",
    defaultBaseUrl: "https://api.moonshot.cn",
    placeholder: "sk-...",
    models: MOONSHOT_MODELS,
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test registry`
Expected: PASS — including the new `Moonshot (Kimi) — dual-region registration` block and the existing `non-OpenRouter providers have non-empty models[]` / `no provider has duplicate model ids` checks (both new entries have 4 unique model ids).

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS — exit 0. (`id: "moonshot"` / `"moonshot-cn"` are valid `ProviderRef` because Task 1 added them to `BuiltinProvider`.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/model-router/providers/registry.ts src/lib/model-router/providers/registry.test.ts
git commit -m "feat(model-router): register Moonshot (Kimi) intl + China registry entries"
```

---

## Task 3: Manifest host permissions

Without the host permission, the MV3 service worker's `fetch` to the Moonshot host is blocked even though the registry/dispatch are correct.

**Files:**
- Modify: `manifest.json:8-20`

- [ ] **Step 1: Add both hosts to `host_permissions`**

In `manifest.json`, inside the `host_permissions` array, add two lines immediately after `"https://api.xiaomimimo.com/*",` (line 18):

```json
    "https://api.moonshot.ai/*",
    "https://api.moonshot.cn/*",
```

The resulting array (lines 8-22) is:

```json
  "host_permissions": [
    "<all_urls>",
    "https://api.anthropic.com/*",
    "https://api.openai.com/*",
    "https://openrouter.ai/*",
    "https://api.minimaxi.com/*",
    "https://open.bigmodel.cn/*",
    "https://dashscope.aliyuncs.com/*",
    "https://generativelanguage.googleapis.com/*",
    "https://api.deepseek.com/*",
    "https://api.xiaomimimo.com/*",
    "https://api.moonshot.ai/*",
    "https://api.moonshot.cn/*",
    "https://api.tavily.com/*"
  ],
```

- [ ] **Step 2: Verify the manifest is valid JSON and the build packs it**

Run: `pnpm build`
Expected: PASS — Vite build completes, `dist/manifest.json` written. (The release-time invariants — `.js` service-worker suffix and version match — are unaffected by host permissions.)

Optionally confirm the new hosts landed:

Run: `node -e "console.log(require('./dist/manifest.json').host_permissions.filter(h => h.includes('moonshot')))"`
Expected: `[ 'https://api.moonshot.ai/*', 'https://api.moonshot.cn/*' ]`

- [ ] **Step 3: Commit**

```bash
git add manifest.json
git commit -m "feat(manifest): grant Moonshot (Kimi) host permissions (.ai + .cn)"
```

---

## Task 4: Documentation

Keep the user-facing provider list (README) and the project guide (CLAUDE.md) accurate. CLAUDE.md explicitly says the provider roster lives in README and that the OpenAI-compat family is enumerated in CLAUDE.md.

**Files:**
- Modify: `README.md:142`
- Modify: `CLAUDE.md:74`

- [ ] **Step 1: Add the README provider row**

In `README.md`, add a row to the supported-providers table immediately after the MiMo row (line 142):

```markdown
| Moonshot (Kimi) | OpenAI-compatible · 国际区 `api.moonshot.ai` / 中国区 `api.moonshot.cn`（新建实例时选对应条目即选区） |
```

- [ ] **Step 2: Update the CLAUDE.md OpenAI-compat family list**

In `CLAUDE.md` (the `pie-ai-agent` one), line 74 currently reads:

```
OpenAI-compat 家族（openai/openrouter/zhipu/bailian）走 `_shared/openai-compat-core.ts`（OpenRouter 用 customHeaders hook）
```

Change the family enumeration to include `moonshot`:

```
OpenAI-compat 家族（openai/openrouter/zhipu/bailian/moonshot）走 `_shared/openai-compat-core.ts`（OpenRouter 用 customHeaders hook；moonshot 双区 = moonshot/moonshot-cn 两条 registry 条目共用同一薄 wrapper）
```

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: list Moonshot (Kimi) provider (dual-region, OpenAI-compatible)"
```

---

## Task 5: Full verification + manual smoke test

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: PASS — all suites green, including `moonshot.test.ts`, `registry.test.ts`, `dispatch.test.ts`. No other suite should regress (no test enumerates provider counts or snapshots the provider list — `Chat.test.tsx` only seeds specific providers).

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS — exit 0 (repo-wide stays at 0 errors per CLAUDE.md invariant).

- [ ] **Step 3: Run the production build**

Run: `pnpm build`
Expected: PASS — `dist/` written, manifest invariants hold.

- [ ] **Step 4: Manual smoke test in Chrome**

1. `pnpm dev` (or load the `dist/` from Step 3 via `chrome://extensions` → Load unpacked).
2. Open the side panel → New instance → confirm **both** `Moonshot (Kimi)` (showing `api.moonshot.ai`) and `Moonshot (Kimi) 中国区` (showing `api.moonshot.cn`) appear in the provider list.
3. Pick `Moonshot (Kimi)`, choose `kimi-k2.6`, paste a real key from <https://platform.kimi.com> (or <https://platform.moonshot.ai>), save.
4. Run a simple agent task (e.g. "what's on this page?") and confirm: streaming text renders, a tool call executes, and the task completes without a network/permission error.
5. (If you have a China-region key) Repeat with `Moonshot (Kimi) 中国区` against a `platform.moonshot.cn` key to confirm `.cn` routing.

- [ ] **Step 5: (Optional) verify on a vision task**

With `kimi-k2.6` selected, run a task that triggers a screenshot tool and confirm the model accepts the image (vision flag is `true`, so the screenshot vision guard allows it).

---

## Self-review checklist (done while writing)

- **Spec coverage:** OpenAI-compat module ✅ (Task 1), dual-region selection ✅ (Task 2, two entries), type-union/dispatch exhaustiveness ✅ (Task 1, tsc-enforced), host permissions ✅ (Task 3), docs ✅ (Task 4), verification ✅ (Task 5).
- **No placeholders:** every code/edit step shows complete content; every run step states an expected result.
- **Type/name consistency:** `streamChat` export name matches the `import { streamChat as moonshotChat }`; the dispatch key `"moonshot-cn"` (quoted, hyphen) matches the union member, the registry `id`, and the test ids; `MOONSHOT_MODELS` is declared before use; model ids/flags in the registry match the registry-test assertions (`kimi-k2.6`/`kimi-k2.5` vision+256K, `moonshot-v1-128k` text+128K).
- **Invariant respected:** no per-instance baseUrl override added; builtin `defaultBaseUrl` stays the single source of truth.

## References (for the implementing engineer)

- Kimi API overview (OpenAI-compatible, Bearer auth, base `https://api.moonshot.ai/v1`): <https://platform.kimi.com/docs/api/overview> · <https://platform.moonshot.ai/docs/guide/migrating-from-openai-to-kimi>
- Kimi models (kimi-k2.6 / k2.5 256K multimodal; moonshot-v1-* series): <https://platform.kimi.com/docs/models>
- China-region platform (for `.cn` keys): <https://platform.moonshot.cn>
