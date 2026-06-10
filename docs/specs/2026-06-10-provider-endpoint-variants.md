# Provider Endpoint Variants — 按量计费 API / Plan API 切换

**日期**: 2026-06-10
**状态**: Design approved（方案 A），待实施 plan

## 背景与目标

部分 builtin provider 同一家提供两种计费形态的 API：按量计费（pay-as-you-go）和订阅套餐（Coding Plan / Token Plan），两者 base URL 不同，有的还限定模型清单。现状 `defaultBaseUrl` 是单值权威、UI 不暴露，用户持 Plan key 无法使用订阅端点。

目标：registry 声明式地给 provider 挂多个端点变体（variant），用户在 Settings 配置 instance 时通过 segmented 切换选择端点；没声明 variants 的 provider 一切不变。

**不破坏既有不变量**：baseUrl 仍然封装——用户只能在 registry 白名单端点间选，不能自由填 URL。

## 非目标

- Custom provider 不支持 variants（其 baseUrl 本来就用户自填）。
- 不做跨协议 variant（首批五家调研确认 Plan 端点与按量端点 wire 协议一致，OpenAI-compat 家族仍 OpenAI-compat、Anthropic-wire 家族仍 Anthropic-wire；variant 只换 baseUrl，不换 dispatch 路径）。
- 不做 per-variant API key 格式校验（mimo `tp-` vs `sk-` 等只靠 placeholder 提示）。
- MiniMax 不涉及（官方确认 Plan 与按量同 URL，靠 key 区分计费，零改动）。
- DeepSeek 官方无 Plan，不涉及。

## 数据模型

### Registry（`src/lib/model-router/providers/registry.ts`）

```ts
export interface EndpointVariant {
  /** 稳定 id，持久化进 StoredInstance.endpointVariant。 */
  id: string;
  /** 面向用户的切换选项文案（与 provider name 同样不做 i18n，直接显示）。 */
  label: string;
  /** 该变体的 base URL，替换 defaultBaseUrl 进入 ModelConfig.baseUrl。
   *  Anthropic-wire 家族的 baseUrlSuffix hook 照常在 core 层拼接。 */
  baseUrl: string;
  /** 可选：整体替换该变体下的模型清单（如 Kimi Code 只认 kimi-for-coding）。
   *  缺省沿用 ProviderMeta.models。 */
  models?: ModelMeta[];
  /** 可选：替换 API key 输入框 placeholder（如 Plan key 前缀不同）。 */
  placeholder?: string;
}

export interface ProviderMeta {
  // ...现有字段不变
  /** 额外端点变体。缺省 = 该 provider 无变体，UI 不渲染切换。 */
  endpointVariants?: EndpointVariant[];
  /** 有 endpointVariants 时，默认端点在切换控件里的文案。 */
  defaultEndpointLabel?: string;
}
```

`defaultBaseUrl` 语义不变：默认端点（variant 未选 / 选了未知 id 时的 fallback）。

### Instance（`src/lib/instances.ts`）

```ts
interface StoredInstance {
  // ...现有字段不变
  /** EndpointVariant.id。缺省 = 默认端点。 */
  endpointVariant?: string;
}
```

- `createInstance` input / `updateInstance` patch 各加一个可选 `endpointVariant` 透传。
- **零 migration**：旧记录无此字段 → 落到 defaultBaseUrl，行为与今天完全一致。registry 删掉某 variant 后，存量 instance 的悬空 id 同样 fallback 到默认端点（不报错）。

## 解析逻辑

### baseUrl 注入（唯一覆盖点）

`resolveModelConfig()`（`instances.ts:136`）：

```ts
const variant = inst.endpointVariant
  ? meta.endpointVariants?.find((v) => v.id === inst.endpointVariant)
  : undefined;
// ...
baseUrl: variant?.baseUrl ?? meta.defaultBaseUrl,
```

下游（`openai-compat-core` 的 `/v1` 探测拼接、`anthropic-sdk-core` 的 `baseUrlSuffix` 拼接）零改动。checkpoint 不存 ModelConfig、resume 重新 resolve，session 持久化零改动。

### 模型元数据查找：union lookup

`getModelMeta(provider, modelId)` 改为先查 `meta.models`，未命中再查各 `endpointVariants[].models`（union）。variant 模型 id 与默认清单不冲突（如 `kimi-for-coding`），union 无歧义。

这样 `resolveModelMeta` / `resolveModelVision` / `resolveModelConfig` 的 vision、maxOutputTokens 解析链路**签名零改动**全部自动覆盖——variant 维度只在两处生效：baseUrl 注入（上节）与展示清单过滤（下节）。

### 展示清单过滤（variant-aware 的两处）

1. **Composer ModelPicker**：instance 的 variant 声明了 `models` → 该 instance 的可选列表 = `variant.models` + 该 provider 的 pcm 自定义模型池；未声明 → 现状不变（`meta.models` + pcm + fetchedModels）。
2. **`firstModelForProvider()`**（D3 兜底 / eval）：已持有 instance，优先级改为 `inst.customModels[0]` → variant.models[0]（若该 instance 选了带 models 的 variant）→ `registry[0]` → `fetched[0]`。

**接受的边界行为**：用户切换 variant 后，原选中模型可能不在新清单（last_model_selection 失效）——不做主动校验，运行期 provider 报错 + 用户在 picker 重选即可（picker 列表已是新清单）。

## Settings UI

- **`InstanceForm.tsx`**：当 `meta.endpointVariants` 非空时，在 provider 行下方渲染 segmented 切换，选项 = `[defaultEndpointLabel, ...variants.map(v => v.label)]`；create 与 edit 模式都可改。选中带 `placeholder` 的 variant 时 API key 输入框 placeholder 跟随。
- **`Settings.tsx`**：`handleCreate` / `handleSaveEdit` 把 `endpointVariant`（默认端点 = 不写字段 / `undefined`）透传给 `createInstance` / `updateInstance`。
- `InstanceFormPayload` 加 `endpointVariant?: string`。
- **InstancesList** 在 instance 行的 provider 名旁追加 variant label 小标签（让用户一眼区分同 provider 的按量/Plan 两个 instance），无 variant 不显示。

## 首批 registry 数据

| Provider | 默认端点（defaultEndpointLabel） | Variant | Variant baseUrl | models override |
|---|---|---|---|---|
| zhipu | 按量 `…/api/paas/v4`（"Pay-as-you-go"） | `coding-plan` "Coding Plan" | `https://open.bigmodel.cn/api/coding/paas/v4` | 无（Plan 限 4 模型但是按量子集，选错自纠，免维护两份清单） |
| moonshot / moonshot-cn | 按量（"Pay-as-you-go"） | `kimi-code` "Kimi Code Plan" | `https://api.kimi.com/coding`（core 自动拼 `/v1/chat/completions`） | `[{ id: "kimi-for-coding", vision: false, tools: true, maxContextTokens: 256_000 }]`；placeholder `sk-kimi-...` |
| mimo | **Token Plan**（"Token Plan"，现 defaultBaseUrl `token-plan-cn` 本就是订阅端点，保持不动零破坏存量） | `payg` "Pay-as-you-go" | `https://api.xiaomimimo.com`（baseUrlSuffix `/anthropic` 照常拼接） | 无（两侧目录大体重合）；variant placeholder `sk-...`；同时把 mimo 的 `ProviderMeta.placeholder` 从 "API key" 改为 `tp-...`（默认侧即 Token Plan） |
| stepfun | 按量（"Pay-as-you-go"） | `step-plan` "Step Plan" | `https://api.stepfun.com/step_plan`（Anthropic SDK 自动拼 `/v1/messages`，**不带 `/v1`**） | `step-3.7-flash`(vision)、`step-3.5-flash-2603`、`step-3.5-flash`、`step-router-v1`（均 tools:true、256K、maxOutputTokens 留空走兜底） |

两个 moonshot 条目共享同一个 variant 对象（与 `MOONSHOT_MODELS` 同样的 const 共享模式）。

**待实施期核实**（标 TODO 进 registry 注释）：`kimi-for-coding` 是否支持图片输入（暂 fail-closed `vision:false`）；StepFun plan 模型的 maxOutputTokens 官方值。

### Manifest

`host_permissions` 新增两条（zhipu / stepfun 的 Plan 端点同域已覆盖）：

- `https://api.kimi.com/*`
- `https://api.xiaomimimo.com/*`

`<all_urls>` 本就兜底，新增是延续「builtin 域名显式列出」的既有约定。

## 测试

- `instances.test`：endpointVariant 持久化 round-trip；resolveModelConfig 三态（无 variant / 合法 variant / 悬空 id fallback）。
- `registry.test`：union lookup 命中 variant 模型；`getModelMeta` 默认清单优先。
- `firstModelForProvider`：带 models 的 variant 下取 variant 首模型。
- InstanceForm 组件测试：有/无 variants 的渲染分支、payload 透传、placeholder 跟随。
- 真机回归清单（合并前）：zhipu Coding Plan key + glm-4.7 跑任务；Kimi Code key + `kimi-for-coding`；StepFun Step Plan key；mimo 切按量端点（持 sk- key 时）；存量 instance 升级后行为不变。

## 风险

- Plan 端点的模型清单随官方调整漂移——与现有 curated models 同一维护模式（随 release 同步），无新机制。
- variant 是 registry 数据驱动：后续给其他 provider 加 Plan（如 StepFun 之外的新家）只是加一条数据 + 可能的 manifest 域名，不动机制代码。
