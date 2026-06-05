# Provider / Model 解耦 — Composer 二级模型选择器 + 设置页纯 Provider 配置

> Design spec · 2026-06-05 · status: draft（待 review）
> Paper 原型：文件「Pie Frontend」→ 画板「NEW — Composer Model Picker · 2 Directions」与「NEW — Settings · Providers (no model, no active)」

## 1. 概述

把「模型选择」从设置页/instance 配置中解耦出来，移到 Composer。改动后：

- **设置页**只配置 Provider（Provider + API Key + 昵称 + 模型列表管理），不再选择「生效模型」、不再有「启用/Activate」。
- **Composer** 新增二级模型选择器：一级 = Provider，二级 = 该 Provider 支持的模型，支持搜索。
- **生效模型**不再有「默认」概念，改为**继承上次选择的 (provider, model)**。
- **内置 Provider 加图标**：先建图标接入机制 + monogram 占位，真实图标资源后续统一提供。

## 2. 现状与问题

当前 `instance` 是一个四元组紧耦合：`(provider, model, apiKey, nickname)`。

- 用户在设置页创建/编辑 instance 时必须同时选定一个 model。
- Composer 的 `InstanceSelector` 切换的是 instance（= 间接切 model），无法独立选 model。
- 全局 `active_instance_id` 决定默认 instance；per-session `instanceId` 可覆盖，task start 时 snapshot 进 checkpoint。
- 同一 provider 可建多个 instance（不同 key/昵称/model）。

痛点：选模型和配 key 强绑定，换模型要去设置页改 instance 或新建 instance；模型不是「会话级随手可换」的东西。

## 3. 目标与非目标

**目标**
- instance 退化为 `(provider, apiKey, nickname)`，不再持有 model。
- 一个 Provider 一份 key（一 instance）。
- Composer 二级模型选择器（手风琴），Provider 内搜索。
- 设置页 Provider 编辑卡内含「模型列表」区（内置只读 + 自定义增删改）。
- 内置 Provider 图标接入机制 + 占位。

**非目标（YAGNI）**
- 同 Provider 多 key 的并存（本次明确砍掉，未来需要再说）。
- 模型的语义搜索 / 跨 Provider 全局搜索（搜索仅限当前展开 Provider）。
- 真实图标资源（本次只占位，资源后续提供）。

## 4. 关键设计决策（已与用户确认）

| # | 决策 | 选择 |
|---|---|---|
| D1 | 同 Provider 多 key 的展示 | **一 Provider 一 key**，彻底简化；一级列表 = Provider |
| D2 | 生效模型作用域 / 「默认」语义 | **取消「默认/Activate」**，新会话**继承全局上次选择的 (provider, model)**；per-session 记住各自选择 |
| D3 | 「上次选择」为空时的 fallback | **第一个可用 Provider 的第一个 registry model**；零配置时 Composer 提示去设置页加 Provider |
| D4 | Composer 二级列表搜索范围 | **仅当前展开的 Provider 内** |
| D5 | 「添加/管理自定义模型」入口 | **设置页** Provider 编辑卡内的「模型列表」区；Composer 只负责选、不增删 |
| D6 | Composer 二级列表交互形态 | **方向 A 手风琴**：就地展开 model 子列表，子列表 `max-height` + 内部滚动控高 |
| D7 | 迁移：同 Provider 多 instance | **保留 active/最近的那个**（其 key+昵称），其余同 Provider 的 instance 静默丢弃 |

## 5. 数据模型变更

### 5.1 `StoredInstance`（`src/lib/instances.ts`）

```diff
 export interface StoredInstance {
   id: string;
   provider: ProviderRef;
   nickname: string;
   encryptedKey: string;
-  model: string;                 // 移除：instance 不再持有 model
   customModels?: string[];       // 保留：自定义模型 id（builtin 走 PCM/PCMM）
   fetchedModels?: {...}[];        // 保留：OpenRouter 动态模型
   fetchedAt?: number;
   maxTokens?: number;
   createdAt: number;
 }
```

> `model` 字段移除后，`DecryptedInstance`、`createInstance`、`updateInstance`、`InstanceForm` 表单等同步去除 model 相关入参。

### 5.2 「上次选择」与 per-session 选择

新增全局「上次使用的模型选择」存储（`chrome.storage.local`）：

```ts
// key: "last_model_selection"
interface LastModelSelection {
  instanceId: string;   // 一 provider 一 key，instanceId ↔ provider 一一对应
  model: string;        // provider-native model id
}
```

`SessionMeta` 的 per-session override 从「只存 instanceId」扩展为存 instance + model：

```diff
 export interface SessionMeta {
   ...
-  instanceId?: string;
+  instanceId?: string;   // 沿用：选中的 provider 配置
+  model?: string;        // 新增：本会话选中的 model
 }
```

> 兼容：仅有 instanceId、无 model 的老 session，model 走 fallback（D3）。

### 5.3 ModelConfig 解析

`resolveInstanceToModelConfig` 不能再从 instance 读 model，改为显式传入：

```diff
-export async function resolveInstanceToModelConfig(id: string): Promise<ModelConfig | null>
+export async function resolveModelConfig(instanceId: string, model: string): Promise<ModelConfig | null>
```

- 返回的 `ModelConfig = { provider, model, apiKey, ... }` 形状不变（agent loop / streamChat 无感）。
- vision / maxContext 能力决议仍走三层 fallback：registry → fetchedModels → PCMM，输入 `(provider, model)` 不变。

### 5.4 选择解析顺序（新会话拿 (instanceId, model)）

```
session.instanceId & session.model  （本会话已选）
  ↓ 无
last_model_selection                （全局上次选择）
  ↓ 无 / 引用的 instance 已删
第一个 instance（按 createdAt）的 provider 的第一个 registry model   （D3 fallback）
  ↓ 零 instance
Composer 显示「请到设置页添加 Provider」空态
```

task start 时把解析出的 `(instanceId, model)` 写回 session meta 并 snapshot 进 checkpoint（沿用 C1 不变量：in-flight loop 不受中途切换影响）。用户在 Composer 选定后，同时更新 `session.{instanceId,model}` 与全局 `last_model_selection`。

## 6. Composer 二级模型选择器（方向 A 手风琴）

替换现有 `InstanceSelector` + `ModelDropdown` 的职责。

**结构**
- 触发 chip（composer 底部）：`[icon] Provider · short(model) ▾`
- 展开弹层（向上弹，沿用现有 popover 阴影/圆角）：
  - header：`选择模型` + `N providers`
  - Provider 行（折叠态）：`[icon] ProviderName ……… last-model(弱色) ›`
    - 当前选中的 Provider，其 model 用 accent 色显示
    - 从未用过的 Provider 显示「未使用」
  - 展开态 Provider（背景高亮 `#1A1E25`）：
    - 头行 chevron 转向
    - 内嵌搜索框：`搜索 <Provider> 模型…`（仅过滤当前 Provider 的 model）
    - model 子列表（缩进对齐 Provider 名）：`model-id` + `vision`/`tools` 胶囊 + 选中 `✓`
    - **子列表 `max-height` + 内部 `overflow-y:auto`**（解决 OpenRouter 数百模型撑高弹层）
    - 同时只展开一个 Provider

**行为**
- 点 Provider 行 → 展开/收起其 model 子列表（手风琴）。
- 点 model → 选中，更新 `session.{instanceId,model}` + 全局 `last_model_selection`，关闭弹层。
- 搜索 query 仅作用于当前展开 Provider；收起或切 Provider 时重置 query。
- OpenRouter 等 lazy provider：首次展开触发 `/v1/models` fetch（沿用现有 fetchedModels 缓存逻辑）。
- task 进行中（locked）：chip 显示锁、不可展开（沿用现有 locked 态）。

## 7. 设置页改造

`Settings` / `InstancesList` / `InstanceForm` 改造。

**列表（折叠态）**
- 标题：`我的 Provider · N`
- 移除顶部 ACTIVE 大卡、移除每行 `Activate` 按钮、移除 model 显示。
- Provider 行：`[icon] ProviderName / key 缩写 / 展开 chevron`
- 底部：`+ 新建 Provider`（带可选 provider 计数）

**编辑卡（展开态）**
- 头行：`[icon] ProviderName ▴`
- 字段：`昵称（可选）` / `Provider`（locked，显示 defaultBaseUrl）/ `API Key`（含 Show）
- **「模型列表」区**（核心新增）：
  - 标签：`模型列表` + 右侧 `N 内置 · M 自定义`（lazy provider 额外有「刷新」）
  - 一个滚动盒（`max-height` + 内部滚动）：
    - 内置模型：灰色只读，带 `vision`/`tools` 胶囊，**无操作按钮**
    - `自定义` 分组分隔
    - 自定义模型：`model-id` + 胶囊 + `✎ 编辑` + `× 删除`
    - 底部：`+ 添加自定义模型`（accent，弹 `ModelMetaEditor`）
- 底部操作：`测试连接` / `保存` / `删除`

> 自定义模型读写沿用现有双层架构：builtin → `addProviderCustomModel`(PCM) + `setProviderCustomModelMeta`(PCMM)；custom provider → provider 实体 `models[]`。`ModelDropdown` 组件被设置页的「模型列表」区取代/重构，其 add/edit/remove 逻辑迁移过来。

## 8. 图标接入

- `ProviderMeta` 新增可选字段：`iconAsset?: string`（指向 `public/provider-icons/<id>.svg`，@crxjs/vite build 期 `public/` 原样拷到 `dist/`）。
- 新增 `<ProviderIcon provider size>` 组件：
  - 有 `iconAsset` → 渲染图标，外层套圆角方块容器（`#1A1E25` 底 + `#2A3039` 边）。
  - 否则 → **monogram 占位**：同款方块 + 首字 / 缩写（Inter 700）。
  - custom provider 一律 monogram。
- **单色 logo 用 `currentColor`**：落盘的 svg 已把所有 `fill` 改为 `currentColor`，组件用 `color` 控制（深色主题→浅色 logo，浅色主题→深色 logo），无需为主题准备两套资源。当前选中态可用 accent 色 `#B8C8D6`。
- 同一 `<ProviderIcon>` 在 Composer chip / Composer 二级列表 / 设置页列表 / 设置页编辑卡头复用。

### 8.1 已落盘图标（`public/provider-icons/`，2026-06-05）

`anthropic` · `openai` · `openrouter` · `minimax` · `zhipu`(GLM) · `gemini` · `deepseek` · `mimo` · `moonshot` · `stepfun` —— 共 10 个，均已清理为 `viewBox` + `fill="currentColor"` 的干净 svg。

- `moonshot-cn` 复用 `moonshot.svg`（registry 的 `moonshot-cn` 条目 `iconAsset` 指向 `moonshot.svg`）。
- **`bailian`（阿里百炼）图标缺失** —— 用户暂未提供，registry 不填 `iconAsset`，UI 走 monogram fallback；待补。

## 9. 迁移（V2 内小迁移，silent）

触发点：读取 instances 时检测 schema。

1. **同 Provider 多 instance 合并**（D7）：按 provider 分组，每组保留 `active_instance_id` 指向的那个；若该组无 active，保留 `createdAt` 最新的。其余同 provider instance 删除（key 一并丢弃）。
2. **剥离 model 字段**：被保留 instance 的 `model` 值用于初始化全局 `last_model_selection = { instanceId, model }`（保证迁移后首个会话仍用老模型，体验连续）。随后从 instance 删除 `model`。
3. **清理 `active_instance_id`**：保留该 key 仅作为「迁移期选 last_model_selection 的依据」，迁移完成后不再用于「默认」语义（可保留为「上次选择的 instance」别名，或废弃——实现时二选一并在代码注释说明）。

> 迁移不可逆、会丢弃多余 key。个人 BYOK 场景可接受；丢弃的 provider 用户重新填 key 即可。

## 10. 受影响文件

| 文件 | 改动 |
|---|---|
| `src/lib/instances.ts` | 去 `model` 字段；`resolveInstanceToModelConfig`→`resolveModelConfig(instanceId, model)`；迁移逻辑 |
| `src/lib/model-router/providers/registry.ts` | `ProviderMeta` 加 `iconAsset?` |
| `src/lib/sessions/types.ts` | `SessionMeta` 加 `model?` |
| `src/lib/sessions/storage.ts` | 读写 session.model |
| 新增 `src/lib/last-model-selection.ts` | 全局 `last_model_selection` 读写 |
| 新增 `src/sidepanel/components/ProviderIcon.tsx` | 图标 / monogram 占位 |
| 新增 `src/sidepanel/components/ModelPicker.tsx` | Composer 二级手风琴选择器（取代 InstanceSelector+ModelDropdown 在 composer 的角色）|
| `src/sidepanel/components/InstanceSelector.tsx` | 移除或并入 ModelPicker |
| `src/sidepanel/components/ModelDropdown.tsx` | 重构为设置页「模型列表」区（或新建 `ProviderModelList.tsx` 承接，删除旧 dropdown）|
| `src/sidepanel/components/Settings.tsx` / `InstancesList.tsx` / `InstanceForm.tsx` | 去 model/Activate/ACTIVE；编辑卡加模型列表区 |
| `src/sidepanel/components/Chat.tsx` | instanceId+model 解析与持久化 |
| `src/background/index.ts` | 用 `resolveModelConfig(instanceId, model)`；snapshot (instanceId, model) |
| `src/lib/i18n`（中英） | 新增/调整文案（双语同步）|

## 11. 测试要点

- 解析顺序（§5.4）：session 已选 / 全局上次 / fallback / 零配置 四条路径各一例。
- 迁移：同 provider 2 instance（含/不含 active）→ 合并结果正确；model 正确写入 last_model_selection；幂等（再跑不二次删）。
- Composer：手风琴同时只展开一个；搜索仅过滤当前 Provider；选 model 写回 session + 全局；lazy provider 首展开 fetch。
- 设置页：内置模型只读不可删；自定义模型增删改走 PCM/PCMM；custom provider 走 provider.models。
- task start snapshot：中途切换 model 不影响 in-flight loop（C1 不变量）。
- `pnpm test` / `pnpm typecheck` / `pnpm build`（build-time invariants）。

## 12. 开放问题

无（关键决策 D1–D7 已确认）。实现时需定的小细节：`active_instance_id` 迁移后是废弃还是改语义（§9.3），在代码注释中明确即可。
