---
date: 2026-05-06
topic: provider-config-center
status: brainstormed
related:
  - docs/ROADMAP.md  # §7 Provider + Model 能力中心化管理（已被本 spec 吸收）
  - docs/ROADMAP.md  # §1 Gemini provider（被本 spec 吸收，作为首个 native module）
  - docs/ROADMAP.md  # §8 Phase 5 v1.1 — MiniMax / 智谱 / 百炼 vision（per-model schema 上线后才能展开）
  - src/lib/model-router/providers/registry.ts  # 当前 ProviderMeta schema
  - src/lib/storage.ts  # 当前 provider_${provider} 存储 schema
  - src/sidepanel/components/Settings.tsx  # 当前 list-based UI
---

# Provider + Model 配置中心规整化（B+ scope）

## Problem Frame

当前模型配置层有三个累积痛点：

1. **Provider list-based UI**：Settings 里 6 家 provider 静态摊开，每家一行 `[apiKey + model + baseUrl]` form。用户想"第二把 OpenAI key（work + personal）"做不到，只能复用唯一一行覆盖。
2. **BaseURL 用户手填**：`defaultBaseUrl` 字段虽有，但 Settings UI 把它暴露给用户编辑——大部分用户根本不知道该填什么、会填错；少数自部署用户的需求把 UI 拉宽，给所有用户增加心智成本。
3. **Provider 协议接入扁平化**：5 家 OpenAI-compat 共享一份 `openai.ts` shaper（含散布的 ZhiPu/Bailian `[DONE] flush` quirk + MiniMax/OpenRouter tool_call 单 chunk quirk），新加 provider 必须改这个共享文件；Anthropic native 已独立但 Gemini / 未来 native provider 的入口形态没建立。

ROADMAP §7 是相邻 backlog（per-model capability flag + 删手填 BaseURL + dropdown），但只覆盖了痛点 #2 + #3 的一半。本 spec 把 §7 + 用户 2026-05-06 brainstorm 提的两条新轴（**多实例配置中心** + **每家 provider 独立 module**）合并成一次 ship。

**关键 reframe（brainstorm 期间）**：

- "原生 API 接入" 的真实诉求**不是替换 wire format**（OpenRouter 本身就是 OpenAI-compat，没有可替换协议），而是 **module 边界**——每家独立文件，便于挂 per-provider 专属字段 + 已积累 quirk 显式归位。
- "现有 5 家 OpenAI-compat 不主动拆 module" 被用户最终推翻：抽 `_shared/openai-compat-core.ts` 是为后续扩展更多中国 provider（DeepSeek / Doubao / Moonshot / Stepfun / Hunyuan）打地基，从"读懂全 shaper 改局部" 降到"50 行 wrapper + registry entry"。

## v1 Scope（B+）

**做**：

- 配置中心（multi-instance）：同 provider 允许 N 把 key，每个 instance 独立 nickname / model / 默认 maxTokens；storage `instance_${uuid}` + `instances_index` + `active_instance_id`
- BaseURL 完全封装：从 UI 删除手填，registry `defaultBaseUrl` 唯一权威
- Per-model capability schema：`ProviderMeta.models: ModelMeta[]`（每条带 `vision` / `tools` / `maxContextTokens` flag），降粒度
- Hardcoded model list 随发版同步官方 doc（5/6 家 + Gemini）+ OpenRouter lazy `/v1/models` + ↻ refresh + per-instance custom models 兜底
- Settings UI 重写：list "我的 instance" + "+ 新建配置" wizard（选 provider → 填 key + 选 model）+ 行展开 form
- Per-session instance override：Chat composer action 行加 InstanceSelector chip + 上开 dropdown + ⌘, 跳 Settings；新 chat 默认读全局 active；首条消息前可改；task start snapshot 锁 ModelConfig
- Provider 模块拆分：`_shared/openai-compat-core.ts` 抽出 + 5 家 OpenAI-compat 各成 wrapper（hooks 注入 customHeaders / authHeader）
- Gemini 作为首个新 native module：`generativelanguage.googleapis.com` host_permission + `inline_data` wire format + 自家 stream 解析（用 `?alt=sse` 复用 `_shared/sse.ts`）
- Migration：silent，第一次升级启动把老 `provider_*` 转成 instance；老 baseUrl 静默丢弃；session backfill lazy（用户打开 pre-migration session 时再写）

**不做**（明确 punt）：

- OpenRouter `provider` 路由 / `models` fallback / `transforms` 字段暴露 — 用户 Q1 主动降级
- 官方 SDK 接入（`@openrouter/sdk` 等） — MV3 SW + bundle 体积 + CSP 风险未评估
- Anthropic `cache_control: ephemeral` — Phase 5 v1.1 §8 backlog
- OpenAI `response_format: json_schema` / `reasoning_effort` — 与本期 UX/storage 解耦
- Per-instance maxTokens override UI 字段 — schema 字段保留但 UI 不暴露
- 手填 BaseURL advanced override — Q1 非妥协项明确删
- Active instance fallback chain（多 key 限流降级） — YAGNI
- OpenRouter 之外的 provider lazy `/v1/models` — 硬编码 + 发版同步够用

## Decisions Recap

| Q | Decision | Rationale |
|---|---|---|
| Q1 | Provider 模块拆分采用 (b)：每家独立 module + 抽 `_shared/openai-compat-core.ts` | 一次落地为后续扩展更多中国 provider（DeepSeek / Doubao / Moonshot / Stepfun / Hunyuan）打地基 |
| Q1.1 | BaseURL 完全封装，UI 删 input | 用户 non-negotiable |
| Q2 | 多实例语义 = (ii) 1 provider × N instances | "work + personal key" 真实需求 |
| Q3 | Model dropdown：有 `/v1/models` 拉、无则空 | 后续被 Q4 升级 |
| Q4 | 实际策略：5/6 家 + Gemini 走 hardcoded registry list（随发版同步）；OpenRouter 因 200+ model 仍 lazy fetch；所有 provider 保留 per-instance customModels 兜底 | 维护成本 vs 冷启 UX 的最佳平衡 |
| Q5 | Migration UX = (i) silent，无 toast / banner | 实际无人改过手填 baseUrl，风险被高估 |
| Q6 | Active instance = (Y) Global default + per-session override | "一步到位"，session schema 加 `instanceId` 字段 |

## Data Model

### Registry schema 升级

```ts
// src/lib/model-router/providers/registry.ts
export interface ModelMeta {
  id: string;                    // 例 "claude-opus-4-7" / "glm-4v-plus"
  displayName?: string;          // 友好名字, 不填则 = id
  vision: boolean;               // per-model
  tools: boolean;                // per-model
  maxContextTokens: number;      // per-model
}

export interface ProviderMeta {
  id: Provider;
  name: string;
  defaultBaseUrl: string;        // 唯一 source of truth, 不再有 user override
  placeholder: string;
  /** 硬编码 model list（随发版同步官方 doc）；空数组 = 仅 lazy fetch */
  models: ModelMeta[];
  /** lazy 拉 /v1/models 的 endpoint（相对 defaultBaseUrl）；不填则不支持 */
  modelsEndpoint?: string;
}
```

**删除字段**：`defaultModel`（冷启可能空，没默认） / `supportsTools` / `supportsVision` / `maxContextTokens` / `type`（dispatch 用 provider id 直接查表，不需要 type 分类）。

### Storage schema

```ts
interface StoredInstance {
  id: string;                    // uuid
  provider: Provider;
  nickname: string;              // 用户可改, 默认 = provider name 或 + 序号
  encryptedKey: string;          // AES-GCM 加密
  model: string;                 // 选定 model id
  customModels?: string[];       // 该 instance 用户手填过的 model ids
  fetchedModels?: ModelMeta[];   // OpenRouter lazy fetch 缓存
  fetchedAt?: number;            // ms timestamp; ↻ refresh 时清掉
  maxTokens?: number;            // schema 保留, UI 不暴露
  createdAt: number;
}

// chrome.storage.local keys:
// instance_${uuid}        → StoredInstance
// instances_index         → string[]   (uuid 顺序决定 UI 展示顺序)
// active_instance_id      → string | null
// schema_version          → 2          (sentinel for one-shot migration)
// migration_v2_mapping    → Record<old_provider_id, new_instance_uuid>
// session_${id}_meta      → 增加 instanceId: string 字段
```

### Migration（silent，on first launch）

伪代码：

```ts
async function migrateV1toV2() {
  if ((await chrome.storage.local.get("schema_version")).schema_version === 2) return;

  const key = await getOrCreateEncryptionKey();   // 复用现有 lib/crypto.ts
  const oldActive = await getOldActiveProvider();
  const mapping: Record<string, string> = {};
  const instancesIndex: string[] = [];

  for (const p of PROVIDER_REGISTRY) {
    const oldStored = await chrome.storage.local.get(`provider_${p.id}`);
    if (!oldStored) continue;

    const apiKey = await decrypt(oldStored.encryptedKey, key);
    const newId = uuid();
    const inst: StoredInstance = {
      id: newId,
      provider: p.id,
      nickname: p.name,
      encryptedKey: await encrypt(apiKey, key),
      model: oldStored.model,
      customModels: p.models.find(m => m.id === oldStored.model)
        ? undefined
        : [oldStored.model],          // 不在 registry 的入 customModels
      createdAt: Date.now(),
      // 老的 baseUrl 字段静默丢弃 (Q5 接受)
    };
    await chrome.storage.local.set({ [`instance_${newId}`]: inst });
    instancesIndex.push(newId);
    mapping[p.id] = newId;
  }

  await chrome.storage.local.set({
    instances_index: instancesIndex,
    active_instance_id: oldActive ? mapping[oldActive] : null,
    schema_version: 2,
    migration_v2_mapping: mapping,
  });

  // 删老 keys
  for (const p of PROVIDER_REGISTRY) {
    await chrome.storage.local.remove(`provider_${p.id}`);
  }
  await chrome.storage.local.remove("active_provider");
}
```

**幂等性**：`schema_version: 2` 写入后第二次启动 early return。

**Session backfill（lazy）**：用户打开 pre-migration session → SW `loadSessionMeta(id)` 检测 `meta.instanceId == undefined && meta.provider != undefined` → 查 `migration_v2_mapping[meta.provider]` → 写入 `meta.instanceId` 并清掉旧 `meta.provider`。`migration_v2_mapping` 永久保留（< 1 KB），不 GC。

## Provider 模块架构

### 目标布局

```
src/lib/model-router/providers/
├── _shared/
│   ├── sse.ts                       # 已存在
│   └── openai-compat-core.ts        # NEW: 抽出当前 openai.ts streaming + wire 主体
├── anthropic.ts                     # 不动结构（已 native）
├── openai.ts                        # → thin wrapper, 调 _shared core
├── openrouter.ts                    # NEW wrapper: + OR 专属 headers
├── zhipu.ts                         # NEW wrapper
├── bailian.ts                       # NEW wrapper
├── minimax.ts                       # NEW wrapper
├── gemini.ts                        # NEW: native（inline_data wire format）
├── index.ts                         # NEW: streamChatByProvider 分发表
└── registry.ts                      # 升级 schema（如上）
```

### `_shared/openai-compat-core.ts` 接口

```ts
export interface OpenAICompatHooks {
  customHeaders?: (config: ModelConfig) => Record<string, string>;
  authHeader?: (config: ModelConfig) => Record<string, string>;
}

export async function* streamChatOpenAICompat(
  config: ModelConfig,
  messages: AgentMessage[],
  signal?: AbortSignal,
  tools?: ToolDefinition[],
  hooks?: OpenAICompatHooks,
): AsyncGenerator<StreamEvent> {
  // 当前 openai.ts L138–319 全部搬过来, 加上 hooks 注入点
  // ZhiPu/Bailian [DONE] flush quirk + MiniMax/OpenRouter tool_call 单 chunk
  // quirk 留在 core 内 defensive 处理（liberal in what you accept）
  // JSDoc 顶部说明每条 quirk 来自哪家 / 为什么留在 core
}
```

### Wrapper 极薄

```ts
// providers/openai.ts
export const streamChat = (config, messages, signal, tools) =>
  streamChatOpenAICompat(config, messages, signal, tools);

// providers/openrouter.ts
export async function* streamChat(config, messages, signal, tools) {
  yield* streamChatOpenAICompat(config, messages, signal, tools, {
    customHeaders: () => ({
      "HTTP-Referer": "https://github.com/WiseriaAI/chrome-ai-agent",
      "X-OpenRouter-Title": "Pie",
    }),
  });
}

// providers/zhipu.ts / bailian.ts / minimax.ts: 一行 yield* 透传
```

### Dispatch 表

```ts
// providers/index.ts (NEW)
import { streamChat as anthropicChat } from "./anthropic";
import { streamChat as openaiChat } from "./openai";
import { streamChat as openrouterChat } from "./openrouter";
import { streamChat as zhipuChat } from "./zhipu";
import { streamChat as bailianChat } from "./bailian";
import { streamChat as minimaxChat } from "./minimax";
import { streamChat as geminiChat } from "./gemini";

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

`model-router/index.ts` 的 switch 改成查表 `streamChatByProvider[meta.id](resolvedConfig, ...)`。

加新 provider = 加 module + 加 registry entry + 加 manifest host_permission，不改路由代码。

### Quirk 归属

ZhiPu/Bailian `[DONE] flush` + MiniMax/OpenRouter `tool_call` 单 chunk 留在 `_shared/openai-compat-core.ts` 内 defensive。core 文件顶部 JSDoc 注明：

```ts
/**
 * Defensive quirk handling (do not remove without verification):
 *
 * 1. [DONE] without preceding finish_reason="tool_calls"
 *    Triggered by: ZhiPu (open.bigmodel.cn), Bailian (dashscope.aliyuncs.com)
 *    Fix: flush pending tool calls + emit done with stopReason="tool_calls" if pending Map non-empty
 *
 * 2. tool_call function.arguments included in same first chunk as id+name
 *    Triggered by: MiniMax (api.minimax.chat), some OpenRouter routes, zero-arg tools
 *    Fix: read+accumulate initialArgs from first chunk, emit tool-call-delta if non-empty
 */
```

### Gemini native module 详解

- **Endpoint**：`https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse&key={apiKey}`
- **Auth**：API key 走 URL query，不是 header
- **Stream 协议**：用 `?alt=sse` query 把 chunked JSON array 转成 SSE 流，复用 `_shared/sse.ts`；event payload 是 Gemini 自家 shape，独立 wire converter
- **Wire format**：
  ```ts
  // ContentBlock[] → Gemini contents
  contents: [{
    role: "user",
    parts: [
      { text: "..." },
      { inline_data: { mime_type: "image/png", data: base64 } },
    ]
  }]
  ```
- **Tool calling**：`tools: [{ function_declarations: [...] }]`，shape 接近 OpenAI 但需要 wire converter（参数名不同：`name` / `description` / `parameters`）
- **Manifest**：`host_permissions` 加 `https://generativelanguage.googleapis.com/*`

### Anthropic touch

仅 registry 数据更新（`models: ModelMeta[]`），代码不动。`cache_control: ephemeral` 是 §8 v1.1 backlog，不在本 scope。

## Settings UI 配置中心

### 顶层结构（替换当前 ProvidersView）

```
┌─────────────────────────────────────────┐
│ Settings        [Configs] [Skills]      │  ← 标签从 "Providers" → "Configs"
├─────────────────────────────────────────┤
│ ACTIVE                                  │
│ ⏺ Anthropic · claude-opus-4-7  ↻       │  ← 当前 active instance 单独突出
├─────────────────────────────────────────┤
│ MY CONFIGS              5 of 8 provider │
│ ─────────────────────────────────────── │
│ ⚪ Anthropic · sonnet-4-6 · sk-..xy     │
│ ⚪ OpenAI · Work · gpt-4o · sk-..ab     │
│ ⚪ OpenAI · Personal · o3-mini · sk-..cd│
│ ⚪ OpenRouter · sonnet-4 · sk-or-..7H   │
│ ⚪ ZhiPu · glm-4-plus · ••..••          │
│ ─────────────────────────────────────── │
│ + 新建配置                              │
└─────────────────────────────────────────┘
```

### Instance 行（collapsed）

`[active 圆点] [nickname · model · masked key] [Activate / 展开 ▾]`。同 provider 多 instance 用 `· nickname` 分隔（`OpenAI · Work` / `OpenAI · Personal`），nickname 字号比 provider 小一档。点击展开 inline form。

### Instance form（展开后）

字段：

1. **Nickname**（编辑，默认 `${ProviderName}` 或 + 序号；instance 唯一标识用 uuid，nickname 可改可重）
2. **Provider**（read-only，建好不可改 → 换 provider = 删了重建）
3. **API key**（password + show 切换；保存时 AES-GCM 加密）
4. **Model dropdown**（替代当前 text input；行为见下）
5. ~~Base URL~~（**删除**）
6. **测试连接 / 保存 / 删除** 按钮

展开行视觉：bullet 变 accent 色 + `▾` caret 替代 Activate 按钮，告知用户当前行已 expand。

### Model dropdown 行为

| Provider 类型 | dropdown 内容 | 操作 |
|---|---|---|
| **Registry-listed**（Anthropic / OpenAI / 智谱 / 百炼 / MiniMax / Gemini） | `provider.models[]` ∪ `instance.customModels[]` 去重 | 底部 "+ 添加自定义模型..." → 输入框 → push 进 `customModels[]` |
| **OpenRouter** | `instance.fetchedModels[]`（首次打开 dropdown 时 lazy 拉 `/v1/models`，spinner ~200ms）∪ `customModels[]` | dropdown 顶端 "↻ 刷新" 按钮，清 `fetchedAt` 重拉 |
| **任何 provider 历史填过 customModels** | 标 `[自定义]` 灰色 tag 区分 | 行尾 "×" 删除该自定义 model |

每条 model 右侧 capability tag（`vision` / `tools`），自定义 model 默认 `vision: false, tools: false, maxContextTokens: 32000`，instance form 里可以勾上。

### "+ 新建配置" wizard

inline 展开（不进 modal），二步：

```
Step 1 — 选 provider     Step 2 — 标准 instance form
⊙ Anthropic              (nickname 预填、apiKey 空、model dropdown 按 provider 类型)
⊙ OpenAI                 [继续 →]
⊙ OpenRouter             [取消]
⊙ Gemini
⊙ ZhiPu / Bailian / MiniMax
```

保存后 push `instances_index` → 若是首个 instance 自动 setActive → 卡片塌陷为 instance 行。

### Active 操作

- 行尾 "Activate" 按钮 → `setActive(instanceId)`
- 全局只能一个 active；切换 = 替换
- 删除当前 active 时：自动选 `instances_index[0]` 当 active；index 空 → null

### 删除流程

行展开 form 底部 "Forget config" 按钮（warning 红）。点击 → 二次确认 → 解密 key 销毁 + chrome.storage.local.remove(`instance_${id}`) + 从 `instances_index` 摘除。任何 session pin 该 instance 的：session_meta 留 stale `instanceId`，session 下次启动 chat 时 fail-soft → 提示 "原配置已删除，请重选" 不爆炸。

### Mockup 引用

Pie Frontend 画布两块：
- **04b — Settings · Configs · Collapsed · Dark**：主视图（multi-instance + 新建配置入口）
- **04c — Settings · Configs · Row Expanded · Dark**：行展开 form（无 BaseURL 字段，含 Model dropdown capability tag + 12 in registry hint）

## Chat 集成（per-session instance + InstanceSelector）

### 数据流

```
[Settings 操作]
  ↓
chrome.storage.local: instance_${uuid} / instances_index / active_instance_id

[新建 chat]
  ↓
SessionDrawer "+ new" → SW handleNewSession
  ↓
读 active_instance_id → 预填 session_${id}_meta.instanceId

[Chat 渲染]
  ↓
Composer action 行 InstanceChip 显示 `${nickname} · ${shortModel}`
  ↓
首条 user message 发送之前可点开下拉换 instance（写回 meta.instanceId）

[Task start]
  ↓
读 session_meta.instanceId → loadInstance(uuid) → 解出 ModelConfig
  ↓
snapshot 进 agent_checkpoint_${taskId} (C1 invariant 已有)
  ↓
LLM call 用 snapshot config; 中途用户改 active_instance_id 或删 instance
不影响 in-flight task
```

### Composer 结构（取代当前 textarea+Send 单行）

```
┌ ComposerBox (rounded #1A1E25 / border #22272F) ──────┐
│ [textarea 全宽]                                       │
│                                                      │
│ [● Anthropic · opus-4-7 ▴]    [📎] [● REC] [Send ↵] │
└──────────────────────────────────────────────────────┘
  / skills    SHIFT ↵ NEWLINE                ← box 外 hint
```

action 行单行：
- **左**：InstanceSelector chip（无 frame：`background: transparent`、`border: none`，靠 accent dot + `▴` caret 暗示可点击）
- **flex spacer**
- **右**：`[📎 Attach][● REC][Send ↵]` 三按钮组（保留现有 bordered 形态）

chip 文字格式 `${nickname} · ${shortModel}`，short model 去掉常见 vendor 前缀（例：`claude-opus-4-7` → `opus-4-7`，`anthropic/claude-sonnet-4` → `sonnet-4`），让 chip 在 4 控件挤一行时不溢出。具体 shortening 算法（drop 哪些前缀、是否 fallback 到完整 id）属实现细节，落地时 per-provider 可调，dropdown 展开仍显示完整 model id 以避免歧义。

### Dropdown 浮在 composer 上层

实现：
- `position: absolute`（实际代码层面，非 mockup 限制）
- 锚 composer 内 chip，朝上 expand
- z-index 高于 chat content
- backdrop scrim `position: fixed inset:0 background:rgba(0,0,0,0.4)` 点击外部关闭
- `box-shadow: 0 16px 40px rgba(0,0,0,0.7), 0 4px 12px rgba(0,0,0,0.5), 0 0 0 1px rgba(184,200,214,0.12)` 三层阴影立体感

dropdown 内容：

```
┌────────────────────────────────────┐
│ SWITCH CONFIG          5 configs   │
├────────────────────────────────────┤
│ ⏺ Anthropic                ACTIVE │
│   claude-opus-4-7                  │
│ ⚪ OpenAI · Work                   │
│   gpt-4o                           │
│ ⚪ OpenAI · Personal               │
│   o3-mini                          │
│ ⚪ OpenRouter                      │
│   claude-sonnet-4                  │
│ ⚪ ZhiPu                           │
│   glm-4-plus                       │
├────────────────────────────────────┤
│ + 新建配置 / Manage configs   ⌘,  │
└────────────────────────────────────┘
```

footer ⌘, shortcut 跳 Settings。

### Locked 态（task 进行中）

chip 进 read-only：

- bg / border 退到 `#22272F` 中性
- bullet 退到 `#525965` muted
- caret 替换为 12×12 锁 icon
- `cursor: not-allowed`
- tooltip "task 进行中无法切换"

### Snapshot lock（C1 invariant 复用）

`agent_checkpoint_${taskId}` schema 已有 `modelConfig` 字段，逻辑不变：

- Task start 时把当时的 `instanceId → ModelConfig` 解析结果 snapshot
- Loop 每 step 读 checkpoint 的 modelConfig，**不重新解析 instanceId**
- C1 现有的 resume 路径 100% 复用，不改

### Stale instance fail-soft

3 个场景：

1. **Session 创建后、首条消息前 instance 被删除**：`loadInstance(meta.instanceId)` 返回 null → SW emit `error` event：`{type:"error", error:"该 session 绑定的配置已删除，请重新选择"}` → panel 标红 InstanceChip + 阻止发送
2. **In-flight task 中 instance 被删**：snapshot 已锁，task 跑完不受影响；下一条消息再触发 case 1
3. **历史 archived session 的 instance 被删**：UI 不让用户重启该 session 的 chat（Resume 按钮禁用 + 提示）；只读浏览历史不受影响

### Mockup 引用

Pie Frontend 画布：
- **02e — Agent · Instance Selector in Composer · Open · Dark**：dropdown 开态（chip 在 composer action 行左侧 + dropdown 朝上展开 + 层次感由阴影 + chat 内容 0.3 opacity 体现 — Paper 渲染 `position:absolute` 有 quirk，mockup 用语义等效呈现，实现层走真正的 z-overlay）

## Test Strategy

### Unit / Pure logic

1. `loadInstance(uuid) → ModelConfig` 正常 + null 返回
2. Migration handler：`provider_*` → `instance_${uuid}`，baseUrl 字段被 drop，model 不在 registry 时自动入 customModels
3. Migration sentinel：`schema_version: 2` 写入后第二次启动 early return
4. Per-model capability lookup：`getModelMeta(provider, modelId).vision` 含 customModels 兜底（默认 false）
5. `_shared/openai-compat-core.ts` quirk regression：ZhiPu/Bailian `[DONE] flush` + MiniMax tool_call 单 chunk
6. Gemini wire converter：text+image → `parts: [{text}, {inline_data}]`；function_calling shape

### Integration / Wire

7. 新建 instance → push `instances_index` → 若首个自动 setActive → ModelConfig 解析正确
8. Lazy `/v1/models` (OpenRouter)：fetch + cache 进 `instance.fetchedModels` + ↻ refresh 清 cache
9. Snapshot lock：Task start snapshot ModelConfig；snapshot 后改 active_instance / 删 instance 不影响 in-flight loop
10. Lazy session backfill：打开 pre-migration session → `meta.instanceId` 缺失 → 查 `migration_v2_mapping` → 写入 meta

### Cross-layer / E2E

11. 删除 active instance：自动选 `instances_index[0]` 当 active；index 空 → null；in-flight task 跑完不爆炸；下一次 send 触发 stale instance fail-soft

## Rollout & Risk

- **No flag**：本期是 storage migration + UI 重写，没有 ramp 概念。一次 cut → 全量
- **回滚口子**：保留 `migration_v2_mapping`，回滚 = 删 `instance_*` 键 + 用 mapping 反推恢复 `provider_*`（原始 baseUrl 已丢，只能恢复到 registry 默认）；用户改过 baseUrl 的真实回滚不可能 — Q5 已接受
- **Beta 通道**：BYOK 用户基数小 + dogfood 主力 = 自己，无 alpha 池，merge → ship 一步
- **风险高峰**：迁移 handler 错误丢失 key — 多写一层 unit test 覆盖各种残破 storage state（部分 provider 配过 / 加密 key 解不开 / model 字段空）

## Invariant Compatibility（无 break）

| Invariant | 是否改 |
|---|---|
| C1 任务级 checkpoint snapshot | 不改，复用 |
| Per-session port + ownerToken | 不改 |
| R7 跨 session lock | 不改 |
| Session at-rest 持 raw agentMessages | 不改 |
| ChatMessage 始终 string-only wire | 不改（Gemini wire 转换在 SW 内部） |
| Risk classifier | 不改 |
| Untrusted wrappers | 不改 |
| Pinned tab / multi-pin | 不改 |
| Phase 5 multimodal image input wire | 不改（Gemini `inline_data` 在 provider 模块内部，对 SW 上层透明） |

## References

- 当前 registry：`src/lib/model-router/providers/registry.ts`
- 当前 storage：`src/lib/storage.ts`
- 当前 Settings：`src/sidepanel/components/Settings.tsx`
- ROADMAP §7：被本 spec 吸收
- ROADMAP §1（Gemini provider）：被本 spec 吸收
- ROADMAP §8（v1.1 多模态 backlog）：等本 spec 上线 per-model schema 后才能展开"中国 provider vision"路径
- Brainstorm（本 spec 来源）：本对话 2026-05-06，6 轮 Q&A + Paper 三块 mockup
- Paper mockups：`Pie Frontend` 文件，artboards `04b` / `04c` / `02e`
