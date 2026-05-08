---
date: 2026-05-07
topic: custom-providers
status: brainstormed
related:
  - docs/specs/2026-05-06-provider-config-center-design.md  # 前置 spec：multi-instance + per-model capability + provider 模块拆分（已落地，本 spec 在其之上扩展）
  - src/lib/model-router/providers/registry.ts  # 当前 PROVIDER_REGISTRY hardcoded 8 家
  - src/lib/model-router/providers/_shared/openai-compat-core.ts  # 5 家 OpenAI-compat 共享 core，custom provider 复用
  - src/lib/instances.ts  # 多实例 schema（StoredInstance.provider 字段类型扩展）
  - src/lib/migration-v2.ts  # V1→V2 迁移（本次零迁移，不动该文件）
---

# 自定义 Provider 配置（Custom OpenAI-compat Providers）

## Problem Frame

Pie 当前 8 家 builtin provider 写死在 `src/lib/model-router/providers/registry.ts`，`Provider` 是 8 个字符串字面量的 union，dispatch 是 `Record<Provider, fn>` 静态查表。用户无法接入：

- **本地推理**：Ollama、LM Studio、vLLM
- **自托管 / 公司内网网关**：Azure OpenAI deployment、内部 OpenAI-compat proxy
- **新出的第三方 OpenAI-compat 服务**：SiliconFlow、Groq、Together、火山方舟、Moonshot、Stepfun 等（每加一家就要发版改 registry + manifest）

此 spec 在 `2026-05-06-provider-config-center-design.md` 落地（multi-instance + per-model capability + `_shared/openai-compat-core.ts` 抽出 + BaseURL 封装）的基础上，新增 **用户自定义 OpenAI-compat provider** 能力，让用户在 UI 内完成 name / baseUrl / 模型清单 / capability flags 的配置，无需开发者介入。

## Decisions Locked During Brainstorm

| Q | Decision | Rationale |
|---|---|---|
| **范围** (A) | builtin 8 家不动，新增 custom OpenAI-compat 入口 | 风险最小，老用户零迁移；OpenAI-compat 覆盖 99% 第三方 |
| **数据模型** (B1) | Provider Template 解耦于 instance | 对齐已有"provider × N instance"心智；同 endpoint 多 key 复用 |
| **Capability flags UX** (C2) | 智能默认 + 折叠高级选项 | 80% 用户一键加 model；5% 高级用户能调 |
| **Preset** (D1) | 空白表单，无 starter preset | 先打基础，preset 后续易加 |

**不做**（明确 punt）：

- Builtin provider 可编辑 baseUrl / model 列表 — 维持 `defaultBaseUrl` 唯一权威 invariant
- Custom provider 走 native protocol（Anthropic / Gemini wire format）— 仅 OpenAI-compat
- Custom headers UI（HTTP-Referer / X-Title 等） — YAGNI，后续按需加
- 远程 preset 库（GitHub raw / CDN 拉模板） — 引入网络 + CSP + versioning 复杂度
- URL allow/deny list — BYOK 信任由用户负责
- https-only 强制 — localhost http 必须支持（Ollama / LM Studio 默认 http）
- Per-instance baseUrl override — provider 层面 baseUrl 是单一权威
- OpenRouter 之外的 builtin lazy `/v1/models` — 维持现状

## Section 1 — 数据模型 + 类型系统

### 1.1 新增 storage 实体 `StoredCustomProvider`

```ts
// src/lib/custom-providers.ts （新文件）
export interface StoredCustomProvider {
  id: string;                    // uuid，instance 通过 `custom:${id}` 引用
  name: string;                  // 用户自定义显示名
  baseUrl: string;               // OpenAI-compat endpoint root
  models: CustomModelMeta[];     // 用户维护的模型清单
  createdAt: number;
  updatedAt: number;
}

export interface CustomModelMeta {
  id: string;                    // 发给 API 的 model id
  displayName?: string;          // 下拉显示名（缺省用 id）
  vision: boolean;               // 默认 false
  tools: boolean;                // 默认 true
  maxContextTokens: number;      // 默认 128000
}
```

storage key:
- `custom_provider_${uuid}` — 单 entity
- `custom_providers_index: string[]` — id 列表

### 1.2 `Provider` → `ProviderRef`（discriminated）

```ts
// src/lib/model-router/index.ts
export type BuiltinProvider =
  | "anthropic" | "openai" | "openrouter" | "minimax"
  | "zhipu" | "bailian" | "gemini" | "deepseek";

export type ProviderRef = BuiltinProvider | `custom:${string}`;
```

- 所有现有 `Provider` 引用点改成 `ProviderRef`，TS 编译器兜底找漏改
- `StoredInstance.provider: ProviderRef` — 老数据零迁移（`"openai"` 等仍合法）
- 新建 custom instance 存 `provider: "custom:<uuid>"`
- 保留 `BuiltinProvider` 别名给只接受 builtin 的 helper 用

### 1.3 `ModelConfig` 扩展

```ts
export interface ModelConfig {
  provider: ProviderRef;
  providerName?: string;   // 新增：显示名（错误信息用），由 resolveInstanceToModelConfig 填
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxTokens?: number;
}
```

### 1.4 Provider meta 解析统一入口

```ts
// 同步版仅认 builtin（保留给少数同步调用点）
export function getBuiltinProviderMeta(id: BuiltinProvider): ProviderMeta | null;

// 异步统一版（builtin + custom）
export async function resolveProviderMeta(ref: ProviderRef): Promise<ProviderMeta | null>;

// agent loop / risk classifier / sliding window 用
export async function resolveModelMeta(ref: ProviderRef, modelId: string): Promise<ModelMeta | null>;
```

### 1.5 不动的部分（明确）

- `chatMessagesToAgent` / `streamChat` 入口签名 / wire format / `_shared/openai-compat-core.ts` 内核
- `defaultBaseUrl` invariant 对 builtin 仍然成立
- Custom provider 的 `baseUrl` 在 provider 层定义，**instance 不能 override**
- 加密：API key 仍走 AES-GCM 存 `instance_${id}`；custom provider 自身（name/baseUrl/models）**不加密**（非敏感）

## Section 2 — Dispatch 改造

### 2.1 `streamChatByProvider` 从 record 变 function

```ts
// src/lib/model-router/providers/index.ts
const BUILTIN_DISPATCH: Record<BuiltinProvider, StreamChatFn> = {
  anthropic: anthropicChat, openai: openaiChat, /* ... */
};

export function dispatchStreamChat(config: ModelConfig): StreamChatFn {
  if (config.provider in BUILTIN_DISPATCH) {
    return BUILTIN_DISPATCH[config.provider as BuiltinProvider];
  }
  if (config.provider.startsWith("custom:")) {
    return streamChatOpenAICompat;  // 直接复用 shared core，不带 hooks
  }
  throw new Error(`Unknown provider: ${config.provider}`);
}
```

### 2.2 `streamChat` 入口适配

```ts
// src/lib/model-router/index.ts
export async function* streamChat(config, messages, signal?, tools?) {
  const meta = await resolveProviderMeta(config.provider);
  if (!meta) { yield { type: "error", error: `Unknown provider: ${config.provider}` }; return; }
  const resolvedConfig = { ...config, baseUrl: config.baseUrl || meta.defaultBaseUrl };
  yield* dispatchStreamChat(config)(resolvedConfig, messages, signal, tools);
}
```

### 2.3 baseUrl 来源

- builtin → `meta.defaultBaseUrl`（不变）
- custom → `customProvider.baseUrl`（在 `resolveInstanceToModelConfig` 内填到 `ModelConfig.baseUrl`）
- ModelConfig 仍然只携带最终 `baseUrl`，dispatch 层无需关心 builtin/custom 区别

### 2.4 Custom provider 不传 hooks

仅标准 `Authorization: Bearer ${apiKey}` + `content-type: application/json`，覆盖 99% OpenAI-compat。需要 custom header 的服务后续再加（YAGNI）。

### 2.5 错误前缀显示名 — sync helper

`openai-compat-core.ts` 是 streaming generator，错误路径是 sync —— **不能 await async meta resolve**。所以 helper 必须 sync：

```ts
export function displayProviderName(config: ModelConfig): string {
  return config.providerName ?? config.provider;
}
```

**`providerName` 字段在 `resolveInstanceToModelConfig` 时一次性填好**（builtin → `meta.name`；custom → `customProvider.name`）。这样 SSE 错误路径只读 `config.providerName`，不再查 storage。

### 2.6 `fetchedModels` 字段对 custom 不写

`StoredInstance.fetchedModels` 是 OpenRouter 专用 lazy-fetch cache。Custom instance 的 model 来源是 provider 级 `customProvider.models`，**不写 `fetchedModels`**。后续如有需要可扩展，但当前 v1 范围内：custom instance 创建/编辑流程不触碰该字段。

## Section 3 — Settings UI + fetch /v1/models

### 3.1 `Settings.tsx` 加 "Custom Providers" section

与 INSTANCES 平级，列出所有 custom providers + 各自的 instance 计数 + "+ New custom provider" 按钮。

### 3.2 `NewConfigWizard.tsx` 第一步扩展

- 现有 8 个 builtin 卡片之后，列出 custom providers（可直接选）
- 末尾 "+ 创建新的 custom provider" → 切到 CustomProviderForm，存好后自动回流到 wizard 选中它

### 3.3 新组件 `CustomProviderForm.tsx`

字段：
- NAME（必填，≤ 40 字）
- BASE URL（必填，`http://` 或 `https://` 开头，trim + 去末尾 `/`）
- MODELS（list；每项可 edit/delete；"+ add model"）
- 操作：[Test connection] / [Save] / [Forget]（edit 模式）

每个 model 的 add/edit modal：
- MODEL ID（必填）
- DISPLAY（可选）
- ▸ Advanced（默认折叠）：Tools (toggle, default ✓) / Vision (toggle, default ✗) / Max context tokens (number, default 128000)

**Test connection**：
- 调归一化后的 `/v1/models` URL（详见 3.7）
- 200 → "✓ 连接成功，发现 N 个 models"，列出可勾选导入到清单
- 非 200 → 显示错误前缀 + 状态码 + body 摘要

### 3.4 baseUrl 软警告

输入框下方提示：
- 任意 baseUrl: `ⓘ 该 URL 会被发送 API key，请确认你信任此服务`
- 若 `http://` 且非 localhost / 127.0.0.1 / 10./172./192. 内网: `⚠ 非加密连接，API key 会明文传输`

### 3.5 `InstanceForm.tsx` 适配 custom provider

- 接受 `provider: ProviderRef`
- 用 `useProviderMeta(ref)` hook 异步加载 meta（builtin/custom 统一接口），加载中 skeleton
- "PROVIDER" 行 hint：builtin 显 `defaultBaseUrl`；custom 显 `customProvider.baseUrl` 且 LOCKED
- "MODEL" 来源：custom 走 `customProvider.models`，**custom instance 不再支持 instance 级 customModels[]**（避免与 provider 级清单冗余）

### 3.6 `ModelDropdown.tsx` 调整

- custom 场景：传 `customModels=[]`、`fetchedModels=customProvider.models`，复用渲染
- "+ 添加自定义 model" 按钮在 custom instance 模式下隐藏

### 3.7 fetch helper 通用化

```ts
// src/lib/openai-compat-models-fetch.ts
// 把现有 src/lib/openrouter-models-fetch.ts 升级为通用版
export async function fetchOpenAICompatModels(
  baseUrl: string,
  apiKey?: string,
): Promise<CustomModelMeta[]>;
```

**URL 归一化规则（与 `_shared/openai-compat-core.ts:112` 同正则，避免 `/v1/v1/models` 类 404）**：
```ts
const trimmed = baseUrl.replace(/\/$/, "");
const url = trimmed.match(/\/v\d+$/)
  ? `${trimmed}/models`           // baseUrl 已带 /v1 或 /v2 等
  : `${trimmed}/v1/models`;       // 默认追加 /v1
```
（典型受影响场景：用户填 `https://dashscope.aliyuncs.com/compatible-mode/v1`，若盲追 `/v1/models` → 404）

OpenRouter 的扩展字段（context_length / pricing）在 OpenRouter wrapper 里特殊处理。

### 3.8 Test connection 的 apiKey 来源

CustomProviderForm 自身**不存储** apiKey（apiKey 仍属 instance），但加一个**临时字段**「Test API Key (optional)」，仅用于点 Test 时拼到 fetch 请求：
- 不持久化，关掉 form 即丢
- 留空：发不带 Authorization 的请求（Ollama / LM Studio 等无鉴权 endpoint 可用）
- 填值：带 `Authorization: Bearer ${transientKey}`（SiliconFlow / Groq / Together / Azure 等需要 key 才能列 models）
- 这是 form 上独立 field，与 instance.apiKey 完全无关；UI 上的 hint：「仅本次测试使用，不会保存」

### 3.9 空 models 的 custom provider

允许保存「models 为空」的 custom provider（intermediate state；用户可能先建 provider 再慢慢补 model）。但创建该 provider 下的 instance 时，InstanceForm 的现有 guard 会要求 `model.trim().length > 0`，所以空 models 的 provider **能存在但不能用**——这与现有行为一致。Custom Providers section 的列表上若 `models.length === 0` 显示 `(no models — add some to use)` 提示。

## Section 4 — Cascade、Lifecycle、权限边界

### 4.1 删除 custom provider — block + 引导

若有 instance 引用 → 删除按钮 disabled，hint：「该 provider 被 N 个 instance 使用」+ 列出依赖 instance（带跳转），用户先清空再删。
**理由**：cascade-delete 风险大；soft-delete 增加 state 复杂度无收益。

### 4.2 编辑 model 清单 — 删 model 时

- 检查所有 instance 是否有 `instance.model === 删掉的 modelId`
- 有 → confirm modal：「N 个 instance 选中此 model，删后变 invalid，需重新选择」
- 不强制清理，instance 在编辑时显示 `⚠ model 已不在 provider 清单中` 并阻止启动 task（与现有 builtin 处理风格一致）

### 4.3 编辑 baseUrl

- 给 hint：「修改 baseUrl 会影响下属 N 个 instance，可能需要更新 API key」
- 不阻止保存，不 invalidate apiKey
- 已 in-flight 的 task 用 SW snapshot 跑完（`agent_checkpoint_${taskId}` C1 invariant 自然适用）

### 4.4 active instance 与 cascade

- active instance 属于某 custom provider 时，删 provider 被 4.1 拦截
- 删 active instance 走 `deleteInstance` 现有流程（自动切下一个）

### 4.5 权限/安全边界

- `<all_urls>` 已覆盖 manifest `host_permissions`，custom baseUrl 任意填可 fetch
- 不做 URL allow/deny list（BYOK 信任由用户负责）
- 不强制 https-only（localhost 必须支持 http）
- 4.4 节的软警告生效

### 4.6 storage 隔离

- `StoredCustomProvider` 不存敏感数据
- API key 仍走 `StoredInstance.encryptedKey`，加密策略不变
- session 持久化（R10 invariant）不受影响

## Section 5 — Migration、Invariant、向后兼容

### 5.1 零迁移

老 `instance_${id}.provider: "openai"` 等字符串完全包含在新 `ProviderRef` 类型内，**不需要 migration 脚本**。`migration-v2.ts` 不动。

### 5.2 不 bump schema

`custom_providers_index` / `custom_provider_${uuid}` 是 additive storage key。旧版本读到忽略；新版本读不到当空数组。`schema_version` 保持 2。

### 5.3 builtin invariant 一字不改

| Invariant | 状态 |
|-----------|------|
| `defaultBaseUrl` 唯一权威，UI 不暴露 | builtin 不变 |
| Provider registry pattern | builtin 不变 |
| V1→V2 migration 静默丢弃用户手填 baseUrl | 不变 |

新增 invariant（实现完成时写进 `CLAUDE.md` 和 `docs/solutions/`）：
- Custom provider `baseUrl` 在 provider 层定义，instance 不能 override
- Custom provider 一律走 `_shared/openai-compat-core.ts`
- `<all_urls>` host_permission 是 custom provider fetch 的前提

### 5.4 与现有 invariant 的交互（已逐条核对，全部 ✅ 无影响）

Streaming / SSE parser / Multi-instance config / Injected functions / Risk classifier / Per-session sandbox / Session 持久化 raw agentMessages — 均不受影响。

### 5.5 backwards-incompat 检查

- ❌ 不删任何 builtin
- ❌ 不改 `Provider` 字面量值
- ❌ 不动 `StoredInstance` 已有字段
- ❌ 不改 wire format / SSE / port 协议
- ❌ 不动 manifest 已有 host_permissions

## Section 6 — 测试 + Verification

### 6.1 单元测试（vitest）

新增：
- `custom-providers.test.ts` — CRUD + index 一致性 + cascade-block guard
- `model-router/providers/registry.test.ts` 扩展 — `resolveProviderMeta` builtin / custom / 不存在
- `instances.test.ts` 扩展 — `resolveInstanceToModelConfig` custom 解析正确（baseUrl / model / providerName）
- `model-router/dispatch.test.ts` 扩展 — `dispatchStreamChat({ provider: "custom:..." })` 返回 OpenAI-compat fn
- `openai-compat-models-fetch.test.ts` — normalize OpenAI / OpenRouter 响应；缺字段填 C2 默认；URL 归一化（带 `/v1` 不重复追加）
- `migration-v2.test.ts` — V1→V2 老数据不被本次改动污染

UI 测试：
- `CustomProviderForm.test.tsx` — name/baseUrl 校验、add/remove model、advanced 折叠、Test 调 fetch、transient apiKey 不持久化
- `Settings.test.tsx` 扩展 — Custom Providers section 渲染、cascade-block 提示
- `NewConfigWizard.test.tsx` 扩展 — custom provider 出现在第一步 + 新建后回流

### 6.2 Cross-layer integration test（CLAUDE.md memory 要求）

新加 1 个 SW-level test：mock storage，构造 custom provider + custom instance，调 `resolveInstanceToModelConfig`，断言返回 `ModelConfig.baseUrl === customProvider.baseUrl` 且 `providerName === customProvider.name`。

### 6.3 手工 verification（实现完成时跑一遍）

1. `pnpm test` 全绿
2. `pnpm build` 成功（build-time invariants 通过）
3. `pnpm dev` + load unpacked
4. 端到端：
   - 创建 custom provider "My Test" + baseUrl `https://api.openai.com` + model `gpt-4o-mini` → Test → Save
   - 创建 custom instance（绑定上面的 provider + apiKey）
   - 切到该 instance → Chat 发消息 → 看到流式回复
   - 跑一个 agent 工具调用任务（验 capability flags 路径）
   - 删测试：先尝试删 provider 应 block；先删 instance 再删 provider 应通
   - 切回 builtin instance 应正常
5. 重启浏览器 → custom provider + instance 仍存在
6. 跨 session：builtin / custom 各开一个，互不影响

### 6.4 不写的测试（YAGNI）

- baseUrl https vs http 的网络行为差异（fetch 自身保证）
- OpenAI-compat 第三方服务兼容性矩阵
- stress / load test

## Pre-existing Bug — 单独修

调用点 enumeration 期间发现 `src/lib/agent/loop.ts:1784-1786` 用 `providerMeta?.supportsVision`，但该字段自 2026-05-06 重构后已下放 `ModelMeta` per-model 维度，导致 screenshot tools 永远被拦截。

**已开 issue 单独修**：[#39](https://github.com/WiseriaAI/pie-ai-agent/issues/39)。

本 spec 实现时**仅做 async 化**（`getProviderMeta` → `resolveProviderMeta`），不动 vision 判断逻辑。Issue #39 修完后，未来 cleanup 可再把 vision 判断改成 model-level（`resolveModelMeta(...).vision`）；如果 #39 先合本 spec 再合，spec 实现要 rebase 一下避免 conflict。

## Critical Files to Modify

| 文件 | 改动 |
|------|------|
| `src/lib/model-router/index.ts` | `Provider` → `BuiltinProvider` + `ProviderRef`；`streamChat` 入口改 async meta resolve；`ModelConfig` 加 `providerName?` |
| `src/lib/model-router/providers/registry.ts` | 加 `resolveProviderMeta` async；保留 `getBuiltinProviderMeta`；加 `resolveModelMeta` |
| `src/lib/model-router/providers/index.ts` | `streamChatByProvider` record → `dispatchStreamChat(config)` function |
| `src/lib/model-router/providers/_shared/openai-compat-core.ts` | 错误前缀改用 `displayProviderName(config)` sync helper |
| `src/lib/instances.ts` | `StoredInstance.provider: ProviderRef`；`resolveInstanceToModelConfig` 异步解析 custom baseUrl + 填 `providerName` |
| `src/lib/custom-providers.ts` | **新增**：CRUD + cascade-block guard |
| `src/lib/openai-compat-models-fetch.ts` | **新增**：从 `openrouter-models-fetch.ts` 升级为通用 helper（含 URL 归一化） |
| `src/lib/openrouter-models-fetch.ts` | 重构为薄壳 → 调通用 helper + OpenRouter 扩展字段 |
| `src/sidepanel/components/Settings.tsx` | 加 Custom Providers section；同步用法 → `useProviderMeta` |
| `src/sidepanel/components/CustomProviderForm.tsx` | **新增** |
| `src/sidepanel/components/InstanceForm.tsx` | 接 `ProviderRef`；用 `useProviderMeta` hook；custom 隐藏 customModels[] 入口 |
| `src/sidepanel/components/NewConfigWizard.tsx` | 第一步加 custom 列表 + "+ New custom provider" |
| `src/sidepanel/components/ModelDropdown.tsx` | custom 场景隐藏 "+ 添加自定义 model" |
| `src/sidepanel/components/Chat.tsx` | `getModelMeta` → `resolveModelMeta` async（useEffect 内 await） |
| `src/sidepanel/hooks/useProviderMeta.ts` | **新增** hook |
| `src/lib/agent/window-token-budget.ts:127-133` | `applyTokenBudget(provider)` 改 async；`getProviderMeta` → `resolveProviderMeta` |
| `src/lib/agent/loop.ts:1784-1786` | `getProviderMeta` → `resolveProviderMeta` async（vision 判断逻辑暂不动，由 [#39](https://github.com/WiseriaAI/pie-ai-agent/issues/39) 单独修） |

**已 grep 过的全部调用点**（`getProviderMeta` / `getModelMeta` / `streamChatByProvider` / `PROVIDER_REGISTRY`）— 上表已穷举。

**已确认安全**（grep 不在 provider 关联代码里）：
- `src/lib/agent/risk.ts` — 仅一处 "BYOK provider" 字符串作 hint 文案，无 enumeration → ✅
- `src/lib/agent/tool-names.ts` — 不触碰 provider → ✅
- `src/lib/migration-v2.ts:22` — V1→V2 仅 iter builtin REGISTRY，**保持不动** → ✅

实现完成时还要更新：`CLAUDE.md`（新 invariant）、`docs/ROADMAP.md`（已交付）、`docs/solutions/`（trace doc）。

## References

- 前置 spec：`docs/specs/2026-05-06-provider-config-center-design.md`（已落地，本 spec 在其之上扩展）
- Brainstorm（本 spec 来源）：本对话 2026-05-07，4 轮 Q&A + 6 段 section review + advisor 6 条反馈 merge
- 当前 registry：`src/lib/model-router/providers/registry.ts`
- 当前 instances：`src/lib/instances.ts`
- 当前 dispatch：`src/lib/model-router/providers/index.ts`
- 当前 OpenAI-compat core：`src/lib/model-router/providers/_shared/openai-compat-core.ts`
