# 长思考截断导致 loop 中断 — 实施 plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** reasoning 模型长思考不再因 `max_tokens=4096` 硬上限在思考中途被截断；万一仍截断，loop 不再静默当成"任务完成"，而是明确报错。

**Architecture:** 两条独立改动。(1) 给每个 anthropic-wire 模型从官方文档取真实"最大输出 token"，存进 `ModelMeta.maxOutputTokens`，在 `resolveModelConfig` 时塞进 `ModelConfig.maxOutputTokens`，由 `anthropic-sdk-core` 用它替换写死的 4096 默认（OpenAI-compat 路径完全不动，它本就"不填则用 provider 默认"）。(2) loop 把 `done` 事件里已有的 `stopReason` 接进来，用纯函数 `classifyStreamCompletion` 判定截断，无产出截断时走与现有 stream-error 一致的失败路径而非静默 chat-done。

**Tech Stack:** TypeScript 6 · 官方 `@anthropic-ai/sdk`（anthropic-wire 后端）· vitest。

**对应 spec：** `docs/specs/2026-06-08-thinking-truncation-maxtokens.md`

---

## 背景不变量（实施者必读）

- **anthropic-wire 家族 = 5 个 provider**：`anthropic` / `deepseek` / `minimax` / `mimo` / `stepfun`，全部走 `src/lib/model-router/providers/_shared/anthropic-sdk-core.ts`（官方 SDK，`max_tokens` 必填）。
- **OpenAI-compat 家族**（`openai`/`openrouter`/`zhipu`/`bailian`/`moonshot`/`moonshot-cn` + 所有 `custom:*`）走 `openai-compat-core.ts`，`max_tokens` 仅在 `config.maxTokens != null` 时发送——**本 plan 一行都不改这条路径**。`gemini` 走 native 模块，同样仅在 `config.maxTokens != null` 时发——也不改。
- **红线**：anthropic-wire 送出的 `max_tokens` 不能超过模型真实输出上限，否则 400。故 `maxOutputTokens` 必须是各 provider 官方文档查证的真实值，**严禁臆造**。查不到的标 TODO、留空，退回通用兜底常量。
- `max_tokens` 只是"绝对上限，模型可提前停"（SDK 文档原话）——把默认设成模型满额上限是零成本的，模型自然 `end_turn` 时就停。

---

## File Structure

| 文件 | 职责 | 改动 |
|---|---|---|
| `src/lib/model-router/providers/registry.ts` | provider/model 元数据 | `ModelMeta` 加 `maxOutputTokens?`；anthropic-wire 各模型填值 |
| `src/lib/model-router/index.ts` | `ModelConfig` 定义 | 加 `maxOutputTokens?` 字段 |
| `src/lib/provider-custom-model-meta.ts` | builtin 自定义模型 sidecar | `StoredCustomModelMeta` 加 `maxOutputTokens?` |
| `src/lib/instances.ts` | `resolveModelConfig` 组装 ModelConfig | 解析并填 `ModelConfig.maxOutputTokens` |
| `src/lib/model-router/providers/_shared/anthropic-sdk-core.ts` | anthropic-wire 后端 | 用 `maxOutputTokens` + 新兜底常量替换 `?? 4096` |
| `src/lib/agent/stream-completion.ts`（新建） | 纯函数：截断判定 | 新文件 + 单测 |
| `src/lib/agent/loop.ts` | ReAct loop | 捕获 `stopReason` + 接 `classifyStreamCompletion` 分支 |

---

## Task 1: 给 `ModelMeta` 与 `ModelConfig` 加 `maxOutputTokens` 字段

**Files:**
- Modify: `src/lib/model-router/providers/registry.ts:5-16`（`ModelMeta` interface）
- Modify: `src/lib/model-router/index.ts:32-49`（`ModelConfig` interface）

纯类型字段，无独立测试（后续 Task 的测试覆盖其使用）。

- [ ] **Step 1: 给 `ModelMeta` 加字段**

在 `registry.ts` 的 `ModelMeta` interface 末尾（`maxContextTokens` 之后）加：

```ts
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
  /**
   * 模型真实「最大输出 token」上限（≠ maxContextTokens 输入窗口）。
   * 仅 anthropic-wire 家族（anthropic/deepseek/minimax/mimo/stepfun，走官方 SDK，
   * max_tokens 必填）需要它——见 anthropic-sdk-core。OpenAI-compat / gemini 不填则用
   * provider 默认，无需此值。必须来自 provider 官方文档，查不到则留空（退回兜底常量）。
   */
  maxOutputTokens?: number;
}
```

- [ ] **Step 2: 给 `ModelConfig` 加字段**

在 `index.ts` 的 `ModelConfig` interface 里 `maxTokens?: number;`（第 39 行）之后加：

```ts
  maxTokens?: number;
  /**
   * 模型 meta 的最大输出上限，task-start 时由 `resolveModelConfig` 从
   * `resolveModelMeta(...).maxOutputTokens` 解析填入。anthropic-sdk-core 用它作为
   * 「用户没手填 maxTokens 时」的默认（max_tokens 在该 wire 是必填字段）。
   * OpenAI-compat / gemini 不读此字段（它们不填则省略 max_tokens）。
   */
  maxOutputTokens?: number;
```

- [ ] **Step 3: typecheck 通过**

Run: `pnpm typecheck`
Expected: 0 错（新增可选字段，不破坏现有代码）。

- [ ] **Step 4: Commit**

```bash
git add src/lib/model-router/providers/registry.ts src/lib/model-router/index.ts
git commit -m "feat(model-router): add optional maxOutputTokens to ModelMeta/ModelConfig"
```

---

## Task 2: 给 anthropic-wire 各模型填官方查证的 `maxOutputTokens`

**Files:**
- Modify: `src/lib/model-router/providers/registry.ts`（anthropic / minimax / deepseek / mimo / stepfun 的 `models[]`）
- Test: `src/lib/model-router/providers/registry.test.ts`

**取值来源（均来自各 provider 官方文档，已查证）：**

| provider | model | maxOutputTokens | 出处 |
|---|---|---|---|
| anthropic | claude-opus-4-7 | 128_000 | platform.claude.com models（Opus 4.7 max output 128K） |
| anthropic | claude-sonnet-4-6 | 64_000 | 同上（Sonnet 4.6 max output 64K） |
| anthropic | claude-haiku-4-5-20251001 | 64_000 | 同上（Haiku 4.5 max output 64K） |
| deepseek | deepseek-v4-flash | 384_000 | api-docs.deepseek.com/quick_start/pricing（Max Output "384K"） |
| deepseek | deepseek-v4-pro | 384_000 | 同上 |
| minimax | MiniMax-M3 | 524_288 | platform.minimaxi.com api-reference（M3 上限 524288） |
| minimax | MiniMax-M2.7 | 204_800 | 同上（"其他模型"上限 204800） |
| minimax | MiniMax-M2.7-highspeed | 204_800 | 同上 |
| minimax | MiniMax-M2.5 | 204_800 | 同上 |
| minimax | MiniMax-M2.5-highspeed | 204_800 | 同上 |
| minimax | MiniMax-M2.1 | 204_800 | 同上 |
| minimax | MiniMax-M2.1-highspeed | 204_800 | 同上 |
| minimax | MiniMax-M2 | 204_800 | 同上 |
| mimo | mimo-v2.5-pro | 131_072 | platform.xiaomimimo.com/docs（Maximum Output 128K） |
| mimo | mimo-v2.5 | 131_072 | 同上 |
| mimo | mimo-v2-pro | 131_072 | 同上 |
| mimo | mimo-v2-omni | 131_072 | 同上 |
| mimo | mimo-v2-flash | 65_536 | 同上（Maximum Output 64K） |
| stepfun | step-3.7-flash | **留空（TODO）** | 官方仅给 context 256K，max_tokens 文档为 INF/不限，无单独输出上限 |
| stepfun | step-3.5-flash | **留空（TODO）** | 同上 |

> DeepSeek 官方写 "384K" 未给精确整数，取保守的 `384_000`（不取非官方的 393216），避免越界 400。

- [ ] **Step 1: 写 failing test**

在 `registry.test.ts` 末尾加（导入按文件现有风格）：

```ts
import { describe, it, expect } from "vitest";
import { PROVIDER_REGISTRY, getModelMeta } from "./registry";

describe("maxOutputTokens (anthropic-wire, sourced from provider docs)", () => {
  const cases: Array<[string, string, number]> = [
    ["anthropic", "claude-opus-4-7", 128_000],
    ["anthropic", "claude-sonnet-4-6", 64_000],
    ["anthropic", "claude-haiku-4-5-20251001", 64_000],
    ["deepseek", "deepseek-v4-flash", 384_000],
    ["deepseek", "deepseek-v4-pro", 384_000],
    ["minimax", "MiniMax-M3", 524_288],
    ["minimax", "MiniMax-M2.7", 204_800],
    ["minimax", "MiniMax-M2", 204_800],
    ["mimo", "mimo-v2.5-pro", 131_072],
    ["mimo", "mimo-v2-flash", 65_536],
  ];
  it.each(cases)("%s/%s → %d", (provider, model, expected) => {
    expect(getModelMeta(provider as never, model)?.maxOutputTokens).toBe(expected);
  });

  it("stepfun flash models intentionally have no maxOutputTokens (官方未披露)", () => {
    expect(getModelMeta("stepfun" as never, "step-3.7-flash")?.maxOutputTokens).toBeUndefined();
    expect(getModelMeta("stepfun" as never, "step-3.5-flash")?.maxOutputTokens).toBeUndefined();
  });

  it("每个 minimax/mimo 模型都填了 maxOutputTokens（stepfun 除外）", () => {
    for (const p of PROVIDER_REGISTRY) {
      if (p.id === "minimax" || p.id === "mimo" || p.id === "deepseek") {
        for (const m of p.models) {
          expect(m.maxOutputTokens, `${p.id}/${m.id}`).toBeTypeOf("number");
        }
      }
    }
  });
});
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `pnpm test src/lib/model-router/providers/registry.test.ts`
Expected: FAIL（maxOutputTokens 全是 undefined）。

- [ ] **Step 3: 填值**

按上表给 `registry.ts` 各 anthropic-wire 模型加 `maxOutputTokens`。示例（anthropic 块）：

```ts
    models: [
      { id: "claude-opus-4-7", vision: true, tools: true, maxContextTokens: 200_000, maxOutputTokens: 128_000 },
      { id: "claude-sonnet-4-6", vision: true, tools: true, maxContextTokens: 200_000, maxOutputTokens: 64_000 },
      { id: "claude-haiku-4-5-20251001", displayName: "claude-haiku-4-5", vision: true, tools: true, maxContextTokens: 200_000, maxOutputTokens: 64_000 },
    ],
```

deepseek 块：

```ts
    models: [
      { id: "deepseek-v4-flash", vision: false, tools: true, maxContextTokens: 1_000_000, maxOutputTokens: 384_000 },
      { id: "deepseek-v4-pro", vision: false, tools: true, maxContextTokens: 1_000_000, maxOutputTokens: 384_000 },
    ],
```

minimax 块（M3=524_288，其余 7 个=204_800）：

```ts
    models: [
      { id: "MiniMax-M3", vision: true, tools: true, maxContextTokens: 1_000_000, maxOutputTokens: 524_288 },
      { id: "MiniMax-M2.7", vision: false, tools: true, maxContextTokens: 204_800, maxOutputTokens: 204_800 },
      { id: "MiniMax-M2.7-highspeed", vision: false, tools: true, maxContextTokens: 204_800, maxOutputTokens: 204_800 },
      { id: "MiniMax-M2.5", vision: false, tools: true, maxContextTokens: 204_800, maxOutputTokens: 204_800 },
      { id: "MiniMax-M2.5-highspeed", vision: false, tools: true, maxContextTokens: 204_800, maxOutputTokens: 204_800 },
      { id: "MiniMax-M2.1", vision: false, tools: true, maxContextTokens: 204_800, maxOutputTokens: 204_800 },
      { id: "MiniMax-M2.1-highspeed", vision: false, tools: true, maxContextTokens: 204_800, maxOutputTokens: 204_800 },
      { id: "MiniMax-M2", vision: false, tools: true, maxContextTokens: 204_800, maxOutputTokens: 204_800 },
    ],
```

mimo 块（pro/v2.5/omni=131_072，flash=65_536）：

```ts
    models: [
      { id: "mimo-v2.5-pro", vision: false, tools: true, maxContextTokens: 1_000_000, maxOutputTokens: 131_072 },
      { id: "mimo-v2.5",     vision: true,  tools: true, maxContextTokens: 1_000_000, maxOutputTokens: 131_072 },
      { id: "mimo-v2-pro",   vision: false, tools: true, maxContextTokens: 1_000_000, maxOutputTokens: 131_072 },
      { id: "mimo-v2-omni",  vision: true,  tools: true, maxContextTokens: 256_000,   maxOutputTokens: 131_072 },
      { id: "mimo-v2-flash", vision: false, tools: true, maxContextTokens: 256_000,   maxOutputTokens: 65_536 },
    ],
```

stepfun 块——**不填 maxOutputTokens**，加 TODO 注释：

```ts
    // TODO(maxOutputTokens): StepFun 官方文档仅披露 context window 256K，未给
    // 单独的最大输出上限（max_tokens 文档为 INF/不限）。查到官方值前留空，
    // 退回 anthropic-sdk-core 的 ANTHROPIC_WIRE_FALLBACK_MAX_TOKENS。
    models: [
      { id: "step-3.7-flash", vision: true, tools: true, maxContextTokens: 256_000 },
      { id: "step-3.5-flash", vision: false, tools: true, maxContextTokens: 256_000 },
    ],
```

- [ ] **Step 4: 跑测试确认 pass**

Run: `pnpm test src/lib/model-router/providers/registry.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-router/providers/registry.ts src/lib/model-router/providers/registry.test.ts
git commit -m "feat(model-router): fill anthropic-wire maxOutputTokens from provider docs"
```

---

## Task 3: pcmm sidecar 支持 `maxOutputTokens`

让 builtin provider 的「自定义模型」（用户在 anthropic-wire provider 下手添加的 model id）也能挂输出上限。

**Files:**
- Modify: `src/lib/provider-custom-model-meta.ts:12-16`（`StoredCustomModelMeta`）
- Modify: `src/lib/model-router/providers/registry.ts:279-288`（`resolveModelMeta` 的 pcmm 分支）
- Test: `src/lib/provider-custom-model-meta.test.ts`（若不存在则新建）

- [ ] **Step 1: 写 failing test**

在 `provider-custom-model-meta.test.ts` 加（happy-dom + fake idb 环境按现有测试风格；若该文件不存在，参考 `instances.test.ts` 的 IDB mock 起一个新文件）：

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { setProviderCustomModelMeta, getProviderCustomModelMeta } from "./provider-custom-model-meta";

describe("pcmm maxOutputTokens 透传", () => {
  it("存取 maxOutputTokens 字段", async () => {
    await setProviderCustomModelMeta("deepseek", "my-custom-r1", {
      vision: false,
      maxContextTokens: 128_000,
      maxOutputTokens: 32_000,
    });
    const got = await getProviderCustomModelMeta("deepseek", "my-custom-r1");
    expect(got?.maxOutputTokens).toBe(32_000);
  });
});
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `pnpm test src/lib/provider-custom-model-meta.test.ts`
Expected: FAIL（类型上 `maxOutputTokens` 不存在 / 值丢失）。

- [ ] **Step 3: 加字段 + 透传**

`provider-custom-model-meta.ts` 的 `StoredCustomModelMeta`：

```ts
export interface StoredCustomModelMeta {
  displayName?: string;
  vision: boolean;
  maxContextTokens: number;
  /** anthropic-wire builtin 自定义模型的最大输出上限。见 ModelMeta.maxOutputTokens。 */
  maxOutputTokens?: number;
}
```

`registry.ts` 的 `resolveModelMeta` pcmm 分支（第 280-288 行那段构造对象），把 `maxOutputTokens` 带上：

```ts
    if (stored) {
      return {
        id: modelId,
        ...(stored.displayName ? { displayName: stored.displayName } : {}),
        vision: stored.vision,
        tools: true,
        maxContextTokens: stored.maxContextTokens,
        ...(stored.maxOutputTokens != null && { maxOutputTokens: stored.maxOutputTokens }),
      };
    }
```

- [ ] **Step 4: 跑测试确认 pass**

Run: `pnpm test src/lib/provider-custom-model-meta.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/provider-custom-model-meta.ts src/lib/model-router/providers/registry.ts src/lib/provider-custom-model-meta.test.ts
git commit -m "feat(model-router): plumb maxOutputTokens through pcmm sidecar"
```

---

## Task 4: `resolveModelConfig` 填充 `ModelConfig.maxOutputTokens`

**Files:**
- Modify: `src/lib/instances.ts:136-164`（`resolveModelConfig`）
- Test: `src/lib/instances.test.ts`

- [ ] **Step 1: 写 failing test**

在 `instances.test.ts` 加（沿用该文件已有的 instance/IDB 搭建 helper；下面假设已有 `seedInstance`-类 helper，按文件实际命名调整）：

```ts
import { describe, it, expect } from "vitest";
import { resolveModelConfig } from "./instances";
// ...（沿用文件顶部既有的 IDB / instance 种子工具）

describe("resolveModelConfig.maxOutputTokens", () => {
  it("从 registry 解析 anthropic-wire 模型的 maxOutputTokens", async () => {
    const id = await /* 创建一个 deepseek instance 的既有 helper */ createTestInstance({ provider: "deepseek" });
    const cfg = await resolveModelConfig(id, "deepseek-v4-flash");
    expect(cfg?.maxOutputTokens).toBe(384_000);
  });

  it("stepfun（registry 未填）→ maxOutputTokens 为 undefined", async () => {
    const id = await createTestInstance({ provider: "stepfun" });
    const cfg = await resolveModelConfig(id, "step-3.7-flash");
    expect(cfg?.maxOutputTokens).toBeUndefined();
  });

  it("用户手填 maxTokens 时两个字段并存（maxTokens 不被覆盖）", async () => {
    const id = await createTestInstance({ provider: "deepseek", maxTokens: 8000 });
    const cfg = await resolveModelConfig(id, "deepseek-v4-flash");
    expect(cfg?.maxTokens).toBe(8000);
    expect(cfg?.maxOutputTokens).toBe(384_000);
  });
});
```

> 若 `instances.test.ts` 没有现成的 instance 种子 helper，先读该文件顶部，复用其 IDB 搭建方式建一个最小 deepseek/stepfun instance；不要新造一套 mock。

- [ ] **Step 2: 跑测试确认 fail**

Run: `pnpm test src/lib/instances.test.ts`
Expected: FAIL（`maxOutputTokens` 始终 undefined）。

- [ ] **Step 3: 实现**

`instances.ts` 的 `resolveModelConfig`：在 `vision` 解析之后、`return` 之前，解析 `maxOutputTokens`，并加进返回对象。

```ts
  // maxOutputTokens：anthropic-wire 后端用它当 max_tokens 必填默认。registry/
  // 自定义 provider 经 resolveModelMeta 统一解析；OpenRouter(fetched) 命中不到则
  // 留 undefined（OpenAI-compat 不读此字段，无影响）。
  const maxOutputTokens = (await resolveModelMeta(inst.provider, model))?.maxOutputTokens;

  return {
    provider: inst.provider,
    providerName: meta.name,
    model,
    apiKey: inst.apiKey,
    baseUrl: meta.defaultBaseUrl,
    ...(inst.maxTokens != null && { maxTokens: inst.maxTokens }),
    ...(maxOutputTokens != null && { maxOutputTokens }),
    ...(vision !== undefined && { vision }),
  };
```

确认 `resolveModelMeta` 已在 `instances.ts` 顶部 import（文件已用 `resolveModelVision` 等，从 `@/lib/model-router/providers/registry` 补 import `resolveModelMeta`，若尚未导入）。

- [ ] **Step 4: 跑测试确认 pass**

Run: `pnpm test src/lib/instances.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/instances.ts src/lib/instances.test.ts
git commit -m "feat(model-router): resolve maxOutputTokens into ModelConfig at task start"
```

---

## Task 5: anthropic-sdk-core 用 `maxOutputTokens` 替换写死的 4096

**Files:**
- Modify: `src/lib/model-router/providers/_shared/anthropic-sdk-core.ts:145`（+ 顶部加常量）
- Test: `src/lib/model-router/providers/_shared/anthropic-sdk-core.test.ts`

解析优先级：`config.maxTokens`（用户手填）→ `config.maxOutputTokens`（模型 meta）→ `ANTHROPIC_WIRE_FALLBACK_MAX_TOKENS`（兜底）。

兜底常量取 `32_768`：远大于旧的 4096（避免长思考截断），又远小于已知 anthropic-wire 模型的真实上限（最小 64K）→ 不会越界 400。它只在「模型 meta 未填」时生效（当前仅 stepfun：context 256K、官方 max_tokens 不限，32768 安全）。

- [ ] **Step 1: 写 failing test**

在 `anthropic-sdk-core.test.ts` 加一个能捕获请求体的 helper 与 3 个用例（沿用文件已有的 `sse` / `config` / `collect`）：

```ts
// 捕获 client.messages.create 实际发出的请求体（SDK 底层走 fetch）
function captureBody(): { body: () => any } {
  let captured: any = null;
  vi.spyOn(globalThis, "fetch").mockImplementation((_url: any, init: any) => {
    captured = init?.body ? JSON.parse(init.body as string) : null;
    return Promise.resolve(sse(TEXT_THEN_TOOL));
  });
  return { body: () => captured };
}

describe("anthropic-sdk-core max_tokens 解析", () => {
  it("用户手填 maxTokens 优先", async () => {
    const cap = captureBody();
    await collect(streamChatAnthropicSdk(config({ maxTokens: 8000, maxOutputTokens: 384_000 }), [{ role: "user", content: "hi" }]));
    expect(cap.body().max_tokens).toBe(8000);
  });

  it("无 maxTokens 时用模型 maxOutputTokens", async () => {
    const cap = captureBody();
    await collect(streamChatAnthropicSdk(config({ maxOutputTokens: 384_000 }), [{ role: "user", content: "hi" }]));
    expect(cap.body().max_tokens).toBe(384_000);
  });

  it("两者都没有时退回兜底常量（不再是 4096）", async () => {
    const cap = captureBody();
    await collect(streamChatAnthropicSdk(config(), [{ role: "user", content: "hi" }]));
    expect(cap.body().max_tokens).toBe(32_768);
  });
});
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `pnpm test src/lib/model-router/providers/_shared/anthropic-sdk-core.test.ts`
Expected: FAIL（第 2 个得到 4096、第 3 个得到 4096）。

- [ ] **Step 3: 实现**

在 `anthropic-sdk-core.ts` 顶部（import 之后）加常量：

```ts
/**
 * anthropic-wire 的 max_tokens 是必填字段（官方 SDK 类型 + API 强制）。当模型
 * 既没有用户手填 maxTokens、registry 也没填 maxOutputTokens 时（当前仅 stepfun）
 * 用此兜底。取值远大于历史的 4096（避免长思考被截断），又远小于已知 anthropic-wire
 * 模型的最小真实输出上限 64K（不会越界 400）。模型一旦有官方真实值就走 maxOutputTokens。
 */
const ANTHROPIC_WIRE_FALLBACK_MAX_TOKENS = 32_768;
```

把第 145 行改为：

```ts
        max_tokens: config.maxTokens ?? config.maxOutputTokens ?? ANTHROPIC_WIRE_FALLBACK_MAX_TOKENS,
```

- [ ] **Step 4: 跑测试确认 pass**

Run: `pnpm test src/lib/model-router/providers/_shared/anthropic-sdk-core.test.ts`
Expected: PASS（含原有 3 个用例不回归）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/model-router/providers/_shared/anthropic-sdk-core.ts src/lib/model-router/providers/_shared/anthropic-sdk-core.test.ts
git commit -m "fix(anthropic-sdk-core): use per-model maxOutputTokens instead of hardcoded 4096"
```

---

## Task 6: 新建纯函数 `classifyStreamCompletion`（截断判定）

把 factor 2 的判定逻辑抽成无副作用纯函数，便于单测；Task 7 再接进 loop。

**Files:**
- Create: `src/lib/agent/stream-completion.ts`
- Test: `src/lib/agent/stream-completion.test.ts`

判定语义：
- `ok` — 正常完成（非 length 截断，或有 tool call / 有文本）。走原有流程。
- `truncated-empty` — `stopReason==="length"` 且**既无 tool call 又无文本**（即上报的 bug：思考中途被砍、什么都没产出）。→ Task 7 走失败终止。
- `truncated-partial` — `stopReason==="length"` 且**无 tool call 但有部分文本**（部分答案已流式给用户，但不完整）。→ Task 7 追加截断提示后按纯文本收尾。

注：有 tool call 时即使 length 也算 `ok`（tool 结果会进下一轮，loop 自然继续）。

- [ ] **Step 1: 写 failing test**

Create `src/lib/agent/stream-completion.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyStreamCompletion } from "./stream-completion";

describe("classifyStreamCompletion", () => {
  it("正常结束 → ok", () => {
    expect(classifyStreamCompletion({ stopReason: "end", hasToolCalls: false, hasText: true })).toBe("ok");
  });
  it("有 tool call（即使 length）→ ok", () => {
    expect(classifyStreamCompletion({ stopReason: "length", hasToolCalls: true, hasText: false })).toBe("ok");
  });
  it("length 截断 + 无 tool + 无文本 → truncated-empty", () => {
    expect(classifyStreamCompletion({ stopReason: "length", hasToolCalls: false, hasText: false })).toBe("truncated-empty");
  });
  it("length 截断 + 无 tool + 有部分文本 → truncated-partial", () => {
    expect(classifyStreamCompletion({ stopReason: "length", hasToolCalls: false, hasText: true })).toBe("truncated-partial");
  });
  it("stopReason undefined（provider 没报）→ ok（不误判）", () => {
    expect(classifyStreamCompletion({ stopReason: undefined, hasToolCalls: false, hasText: false })).toBe("ok");
  });
});
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `pnpm test src/lib/agent/stream-completion.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

Create `src/lib/agent/stream-completion.ts`:

```ts
import type { StreamEvent } from "@/lib/model-router/types";

type StopReason = Extract<StreamEvent, { type: "done" }>["stopReason"];

export type StreamCompletionKind = "ok" | "truncated-empty" | "truncated-partial";

/**
 * 判定一次 LLM 流式输出的收尾性质，专门识别「被 max_tokens 上限截断」的两种坏情况。
 * 纯函数，无副作用。`stopReason === "length"` 即 provider 报告输出触顶（anthropic-wire
 * 的 max_tokens / openai-compat 的 finish_reason="length" 都映射成它）。
 */
export function classifyStreamCompletion(input: {
  stopReason: StopReason;
  hasToolCalls: boolean;
  hasText: boolean;
}): StreamCompletionKind {
  if (input.stopReason !== "length") return "ok";
  if (input.hasToolCalls) return "ok"; // tool 结果进下一轮，loop 自然继续
  return input.hasText ? "truncated-partial" : "truncated-empty";
}
```

- [ ] **Step 4: 跑测试确认 pass**

Run: `pnpm test src/lib/agent/stream-completion.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/stream-completion.ts src/lib/agent/stream-completion.test.ts
git commit -m "feat(agent): add classifyStreamCompletion truncation classifier"
```

---

## Task 7: loop 捕获 `stopReason` 并接入截断处理

**Files:**
- Modify: `src/lib/agent/loop.ts`（done 处理 ~1552；pure-text 分支前 ~1648）

行为：
- `truncated-empty`：走与现有 LLM-stream-error 一致的失败终止（不再静默 chat-done）。这正是上报的 bug 场景。
- `truncated-partial`：部分文本已流式发出，追加一条可见截断提示 chunk，再按原 pure-text 路径收尾。
- `ok`：完全不变。

> 不做自动翻倍重试（YAGNI）：factor 1 已把 anthropic-wire 默认抬到模型满额上限，截断只剩「用户手动把 maxTokens 设很低」或「stepfun 退兜底」两种边角；对这些给出明确「调高最大输出」的失败信息已足够。自动 escalation 列为后续可选增强。

- [ ] **Step 1: import 纯函数**

在 `loop.ts` 顶部 import 区加：

```ts
import { classifyStreamCompletion } from "./stream-completion";
```

- [ ] **Step 2: 在流循环外声明 stopReason 局部，done 里捕获**

在 `let lastStepUsage ...`（~1498）旁边加：

```ts
      let lastStopReason: Extract<StreamEvent, { type: "done" }>["stopReason"];
```

把 done 分支（~1552-1558）改为同时记录 stopReason：

```ts
        } else if (event.type === "done") {
          lastStopReason = event.stopReason;
          // Issue #59 — capture real provider-reported usage for the ring.
          if (event.usage && event.usage.inputTokens > 0) {
            lastStepUsage = event.usage;
          }
```

> 确认 `StreamEvent` 已在 loop.ts import（文件已用 streamChat/StreamEvent 相关类型；若未直接 import 类型，从 `@/lib/model-router/types` 补 `import type { StreamEvent }`）。

- [ ] **Step 3: 在 pure-text 分支之前插入截断处理**

在 `if (signal.aborted) return;`（~1630）之后、`if (completedToolCalls.length === 0) {`（~1648）之前插入：

```ts
      // 截断兜底（factor 2）：max_tokens 触顶时不静默当作"任务完成"。
      const completion = classifyStreamCompletion({
        stopReason: lastStopReason,
        hasToolCalls: completedToolCalls.length > 0,
        hasText: accumulatedText.trim().length > 0,
      });
      if (completion === "truncated-empty") {
        // 思考/输出在产出任何可用内容前就触顶——与 LLM-stream-error 同路失败，
        // 不走 chat-done（否则 loop 会假装任务完成）。
        const msg =
          "模型在产出任何回复前就触达输出 token 上限（stop_reason=length），" +
          "通常是长推理吃光了输出预算。请在该 instance 调高最大输出（maxTokens），" +
          "或简化任务后重试。";
        port.postMessage(withSession({ type: "chat-error", error: msg }, sessionId));
        await emitDone({
          type: "agent-done-task",
          success: false,
          summary: msg,
          stepCount: stepIndex,
        }, "fail");
        return;
      }
      if (completion === "truncated-partial") {
        // 部分答案已流式发出但不完整——追加可见提示，再走正常 pure-text 收尾。
        port.postMessage(
          withSession(
            { type: "chat-chunk", text: "\n\n⚠️ [回复被输出 token 上限截断，未必完整。可在该 instance 调高最大输出后重试。]" },
            sessionId,
          ),
        );
        // 落到下面的 pure-text 分支（completedToolCalls.length === 0）正常收尾。
      }
```

> `emitDone({... success:false}, "fail")` 与既有 LLM-stream-error 路径（~1560-1567）完全同形，复用其清理语义（pin 释放等由 emitDone 的 "fail" 路径处理）。`truncated-partial` 不 return，自然落入紧接其后的 `completedToolCalls.length === 0` pure-text 分支收尾。

- [ ] **Step 4: 跑相关测试 + 全量回归**

Run: `pnpm test src/lib/agent/`
Expected: PASS（loop 既有测试不回归；若 loop.test.ts 有"纯文本正常收尾"用例，确认其 stopReason 非 "length"，不受影响）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/loop.ts
git commit -m "fix(agent): surface max_tokens truncation instead of silent task-done"
```

---

## 收尾：全量校验

- [ ] **Step 1: typecheck**

Run: `pnpm typecheck`
Expected: 0 错。

- [ ] **Step 2: 全量测试**

Run: `pnpm test`
Expected: 全绿（基线 ~1800+ 测试 + 本次新增）。

- [ ] **Step 3: build（含 tool-names/tools 构建期不变量）**

Run: `pnpm build`
Expected: 成功。

- [ ] **Step 4: 提交 spec + plan 文档（若尚未提交）**

```bash
git add docs/specs/2026-06-08-thinking-truncation-maxtokens.md docs/plans/2026-06-08-thinking-truncation-maxtokens.md
git commit -m "docs: spec + plan for thinking-truncation maxTokens fix"
```

---

## 真机回归（实施后人工）

自动化测试覆盖不到真实 provider 行为，需人工验证：
- 用一个会长思考的 reasoning 模型（deepseek-v4 / minimax M3 / mimo-v2.5）跑一个需要长链推理的任务，确认不再在思考中途中断、loop 正常继续到完成。
- 临时把某 instance 的 maxTokens 手动设成很小（如 256）跑任务，确认出现明确的"触达输出上限"失败信息，而非静默"完成"。
- 确认 OpenAI-compat provider（如 openai/zhipu）行为无变化。

---

## Self-Review

- **Spec 覆盖**：因素 1 → Task 1-5；因素 2 → Task 6-7；"不准猜、查官方文档" → Task 2 的查证表 + stepfun 留空 TODO；"OpenAI-compat 不动" → 背景不变量 + 各 Task 明确不触碰。全覆盖。
- **占位符**：无 TBD/TODO 式占位（stepfun 的 TODO 是有意的代码注释，非 plan 缺口）。每个代码步骤含完整代码。
- **类型一致**：`maxOutputTokens` 在 ModelMeta/ModelConfig/StoredCustomModelMeta 三处命名一致；`classifyStreamCompletion` 入参/返回与 Task 6 定义、Task 7 调用一致；`StreamCompletionKind` 三值（ok/truncated-empty/truncated-partial）贯穿。
- **已知前提**：Task 4 假设 `instances.test.ts` 有 instance 种子 helper，已注明"无则复用文件顶部 IDB 搭建、勿新造 mock"。
