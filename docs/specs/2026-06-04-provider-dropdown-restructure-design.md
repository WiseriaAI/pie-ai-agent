# Provider 配置 UI 重构：从「provider 长列表」到「dropdown 选择」

**日期**：2026-06-04
**状态**：设计已确认，待实施
**分支**：`worktree-feat+provider-dropdown-restructure`

## 背景与动机

设置页「新建配置」当前是两步向导：

1. **Step 1**（`NewConfigWizard.tsx:110-165`）：把全部 builtin provider（现已 12 家）+ 已存 custom provider 平铺成按钮长列表，再加一个「新建自定义 Provider」按钮。
2. **Step 2**（`NewConfigWizard.tsx:181-293`）：选中 provider 后进入 `InstanceForm`，填 API Key、选 Model。

随着 provider 增多，Step 1 的列表越来越长，纵向占满窄侧栏，体验变差。本次重构把「选 provider」折叠成一个 **dropdown**，并与「填 API Key + 选 Model」**合并到同一页**，同时把 custom provider 的新建/编辑/删除入口也收进这个 dropdown。

## 现状梳理（实施前必须理解）

### 组件与数据流

- **`NewConfigWizard`**（`src/sidepanel/components/NewConfigWizard.tsx`）
  - 持有全部 wizard 态：`step`、`provider`、`customProviders`、`pool`（provider 级 custom model 池）、`metas`（pcmm）、`fetchedModels`/`fetchedAt`/`isFetching`（OpenRouter lazy fetch）。
  - provider 选中时（`:57-84`）：拉 custom model 池、pcmm metas；若是 OpenRouter 立即 pre-fetch `/v1/models`。
  - `showCustomForm` 为真时整屏切到 `CustomProviderForm`（`:95-108`），保存后回到 Step 2 并选中新 provider。
- **`InstanceForm`**（`src/sidepanel/components/InstanceForm.tsx`）
  - 已是统一表单。provider 字段当前**只读**（`:118-127`，显示名称 + baseUrl + 🔒）。
  - 能按 `ProviderRef` 自动解析 builtin/custom meta（`useProviderMeta` + 同步 `getProviderMeta`）。custom provider 的 model 来自 `meta.models`（`:64-67`）。
  - model 增删通过 `ModelDropdown` 的 `onAddCustom`/`onUpdateCustomMeta`/`onRemoveCustom` 回调上抛，由父组件（`NewConfigWizard`）按 builtin/custom 分流持久化（`:198-240`）。
  - 暴露 `renderActions` render-prop，让父组件自定义操作行。
- **`ModelDropdown`**（`src/sidepanel/components/ModelDropdown.tsx`）
  - 已支持 inline 添加/编辑/删除 custom model（含 `vision`/`tools`/`maxContextTokens` meta，经 `ModelMetaEditor`）。合并 registry models + `fetchedModels` + `customModels` 去重展示。
- **`CustomProviderForm`**（`src/sidepanel/components/CustomProviderForm.tsx`）
  - 整屏表单。字段：name、baseUrl、**测试连接**（`fetchOpenAICompatModels` → 勾选批量导入）、逐个 model 增删编辑（`ModelMetaEditor`）。
  - 新建：`saveCustomProvider`；编辑：`updateCustomProvider`；删除：`deleteCustomProvider`，删前用 `getInstancesUsingCustomProvider` 做依赖检查（有 instance 在用则禁删）。
- **`Settings.tsx`**
  - `:319-333`：挂载 `NewConfigWizard` / 「新建配置」按钮。
  - `:335-379`：**独立的 custom provider 管理区**——列出已存 custom provider，每项「编辑」（→ `CustomProviderForm`）/「删除」（`deleteCustomProvider`）。
  - `handleCreate`（`:91-95`）：`createInstance({ provider, ...payload })`。

### 关键数据语义（重构必须保持）

- **custom provider 是共享实体**。多个 instance 可引用同一个 `custom:<id>`；改它的 `baseUrl` 影响所有引用者；删除时若有 instance 在用，必须被 block。
- builtin 的 `model` 字段、custom model 池（`pcm_*`）、pcmm sidecar（`pcmm_*`）的持久化路径不变。
- instance 持久化结构与 `instances.ts` CRUD 签名不变。

## 目标设计

### 1. `NewConfigWizard` 单页化

删除 `step` state。表单从上到下一屏到底：

```
┌─ 新建配置 ──────────────────────────┐
│ Provider:  [ Anthropic        ▾ ]  │  ← ProviderDropdown（新组件）
│ 昵称:      [ Anthropic         ]   │
│ API Key:   [ sk-••••••_______ ]   │
│ Model:     [ claude-...      ▾ ]   │
│            [取消] [测试] [创建]     │
└────────────────────────────────────┘
```

- `provider === null` 时只亮 dropdown（其余字段隐藏或禁用占位），选中后填充其余字段并把昵称种子设为 provider 显示名（沿用现有 `metaName` 逻辑）。
- 移除 Step 2 的「← 更改 Provider」按钮——换 provider 直接用 dropdown 重选。
- 保留现有 OpenRouter 选中即 pre-fetch、`onRefreshModels`、custom model 回调分流等逻辑，只是不再绑定 `step`。

### 2. 新增 `ProviderDropdown` 组件

复用 `ModelDropdown` 的视觉/交互语言（popover + 搜索 + 分组 + inline 项内按钮）。

- **Trigger**：显示当前选中 provider 名称（未选时显示 placeholder）。
- **Popover** 自上而下：
  - 搜索框（按显示名/baseUrl 过滤）
  - `── 内置 ──` 分组：`PROVIDER_REGISTRY` 按本地化显示名排序（沿用 `sortedProviders`）。
  - `── 自定义 ──` 分组：已存 custom provider，**每项右侧带 `✎` 编辑 / `🗑` 删除小按钮**。
  - 底部固定项：`+ 新建自定义 Provider`。
- Props（建议）：
  ```ts
  interface ProviderDropdownProps {
    value: ProviderRef | null;
    builtinProviders: ProviderMeta[];   // 已排序
    customProviders: StoredCustomProvider[];
    onSelect: (ref: ProviderRef) => void;
    onCreateCustom: () => void;          // → 进入「新建 custom」内联态
    onEditCustom: (cp: StoredCustomProvider) => void;  // → 进入「编辑 custom」内联态
    onDeleteCustom: (cp: StoredCustomProvider) => void; // 依赖检查后删
  }
  ```

### 3. Provider 区三态（统一新建与编辑 custom）

表单的 provider 区默认**只读展示**，但对 custom 可切到**内联可编辑**。新建与编辑 custom 复用**同一套内联字段**，区别只在入口与保存语义：

| 触发入口 | provider 区状态 | 保存语义 |
|---|---|---|
| dropdown 选 builtin | 只读（名称 + baseUrl + 🔒），保持现状 | — |
| dropdown `+ 新建自定义 Provider` | 内联展开 name / baseUrl / 测试连接（**空白**） | 「创建」时**原子** `saveCustomProvider` → `createInstance` |
| dropdown 项内 `✎` | 内联展开 name / baseUrl / 测试连接（**预填现值**），带「此 Provider 被 N 个配置共用」提示 | `updateCustomProvider`（共享实体，立即生效） |
| dropdown 项内 `🗑` | —（不进表单） | `getInstancesUsingCustomProvider` 依赖检查；无依赖则 `deleteCustomProvider`，有依赖则禁删并提示 |

内联可编辑区即 `CustomProviderForm` 的核心字段（name / baseUrl / 测试连接）下沉版；不再是整屏组件。

### 4. Model 来源统一成一条流

custom provider 的「测试连接」复用 `fetchOpenAICompatModels(baseUrl)`，结果**喂给 `fetchedModels`**——与 OpenRouter 的 `/v1/models` fetch 走**同一条路**，直接进 `ModelDropdown` 供选择。

- 取代 `CustomProviderForm` 原有的「勾选批量导入」UI。
- `ModelDropdown` 既有的 inline add / edit（`ModelMetaEditor`，含 vision/tools/maxContext）/ remove 取代原「逐个 model 列表管理」。
- 新建 custom（provider 尚未持久化）时，model 暂存在 form 本地 `customModels` 态，随「创建」一起落盘到 `saveCustomProvider({ ..., models })`。
- 编辑已存 custom 时，model 增删沿用现有回调（`addCustomProviderModel` / `updateCustomProviderModel` / `removeCustomProviderModel`，经 `providerRefToId`）。

### 5. 删除 / 重构清单

- **删除** `Settings.tsx:335-379` 整块独立 custom provider 管理区，及其相关 state（`showCustomProviderForm`、`editingCustomProvider`）与 `CustomProviderForm` 整屏挂载。
- **重构** `CustomProviderForm`：核心字段下沉为主表单内联 provider 编辑区；整屏组件移除（或保留为薄内联子组件，名字可改）。`ModelMetaEditor` 仍被 `ModelDropdown` 复用。
- **不动** 编辑现有 instance 流程（`InstancesList` 展开 → `InstanceForm` mode="edit"）：provider 仍只读，不能换 provider，不在此处编辑 custom provider 实体。

## 创建 / 编辑 / 删除 的完整数据流

```
新建 builtin 配置：
  dropdown 选 builtin → 填 key/model → 创建
  → createInstance({ provider, nickname, apiKey, model, customModels })

新建 custom 配置：
  dropdown「+ 新建自定义」→ 内联填 name/baseUrl → [测试连接→fetchedModels]
  → ModelDropdown 选/加 model → 填 key → 创建
  → 原子：saveCustomProvider({ name, baseUrl, models }) 得 newId
        → createInstance({ provider: `custom:${newId}`, ... })

编辑已存 custom provider：
  dropdown 项 ✎ → 内联预填 name/baseUrl/models → 改 → 保存
  → updateCustomProvider(id, { name, baseUrl, models })
  （影响所有引用者；UI 提示「被 N 个配置共用」）

删除已存 custom provider：
  dropdown 项 🗑 → getInstancesUsingCustomProvider(id)
  → 有依赖：禁删 + 提示「被 N 个配置使用，请先删除这些配置」
  → 无依赖：deleteCustomProvider(id)
```

**原子性说明**：新建 custom 配置时，`saveCustomProvider` 与 `createInstance` 两步顺序执行。若 `createInstance` 失败而 provider 已落盘，会留下一个无 instance 引用的孤儿 provider——它会照常出现在 dropdown 的「自定义」分组，用户可手动 🗑 删除（无依赖），不构成数据损坏。无需引入事务。

## 范围边界（YAGNI）

**改动**：`NewConfigWizard`、`Settings.tsx`（删管理区）、新增 `ProviderDropdown`、`CustomProviderForm` 下沉重构、`InstanceForm` provider 区三态、对应 i18n key、对应测试。

**不碰**：
- builtin provider 的 registry / dispatch / 模块文件
- instance 持久化结构与 `instances.ts` CRUD 签名
- `pcm_*` / `pcmm_*` / custom-providers 存储层 API（仅复用，不改签名）
- edit-instance 流程的 provider 只读约束
- `ModelDropdown` 既有 custom model 管理能力（复用，不改）

## 测试策略

- 现有 `NewConfigWizard` / `InstanceForm` / `CustomProviderForm` 相关测试需随结构调整更新。
- 新增 `ProviderDropdown` 单测：搜索过滤、分组渲染、项内 ✎/🗑 触发、`+ 新建` 触发。
- 新建 custom 配置的原子流程测试：`saveCustomProvider` + `createInstance` 顺序与 `custom:<id>` ref 正确。
- 删除 custom provider 的依赖检查测试：有/无 instance 引用两种路径。
- 编辑 custom provider 的 `updateCustomProvider` 调用与「共用提示」渲染。
- 回归：builtin 新建（含 OpenRouter pre-fetch）、edit-instance provider 只读不变。
- 提交前跑 `pnpm test`、`pnpm typecheck`、`pnpm build`（build-time invariants）。

## i18n

新增/调整的文案 key 须**中英双份同步**（`README` 与 i18n 资源均遵循双语约定）。涉及：dropdown 搜索 placeholder、分组标题、「新建自定义 Provider」、项内编辑/删除 aria-label、「被 N 个配置共用」提示、删除依赖禁用提示。复用现有 `customProvider.*` / `newConfigWizard.*` key，删除随管理区一并废弃的 key。
