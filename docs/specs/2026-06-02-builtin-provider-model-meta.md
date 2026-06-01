# Builtin Provider 自定义模型属性编辑

> 状态：设计已定，待写实施 plan
> 关联：#59（context ring）、#98（minimax/mimo 圆环 input_tokens 修复）
> 让 builtin provider 新增的自定义模型也能配 `vision` / `tools` / `maxContextTokens`，对齐 custom provider 的能力。

## 问题

Builtin provider（anthropic / minimax / mimo / openai 等）在 dropdown 里"新增模型"时，模型只以一个**裸 id**存在：

- `pcm_${provider}`（`provider-custom-models.ts`）—— per-provider sticky 池，`string[]`
- `instance.customModels` —— per-instance，`string[]`

两处都只有 id，没有任何 `ModelMeta`。后果：

| 缺失字段 | 用户可见症状 |
|---|---|
| `maxContextTokens` | context 圆环不显示（`resolveModelMeta` 返回 null，分母缺失）；滑动窗口预算 / compaction 阈值回退到 fallback |
| `vision` | 图片上传按钮锁死（`resolveModelVision` 对未知 id 返回 undefined → `?? false`） |
| `tools` | dropdown 不显示 `tools` badge（纯展示，无功能影响） |

Custom provider 则在模型编辑弹窗（`CustomProviderForm` 的 Advanced 折叠区）能逐个配这三属性，存为完整 `ModelMeta`。本 feature 把这个能力带给 builtin provider 的自定义模型。

## 范围

- **只覆盖用户新增的非 registry 模型**。registry 预置模型的属性**不可改**（预置永远优先于自定义 meta）。
- 可配 `vision` + `maxContextTokens`（两个真生效的属性），交互与默认值对齐 custom provider。
- **`tools` 不可配**：loop 对所有 provider 无条件发 tools，从不读 `ModelMeta.tools`（该 flag 全局只是 dropdown 展示 badge）。且这是浏览器 agent——能用来跑任务的模型必然支持工具调用，`tools=false` 没有真实使用场景，给它一个可配开关 = 配了不生效的误导。故 builtin 自定义模型**不暴露 tools 配置**，构造 `ModelMeta` 时 `tools` 恒为 `true`（语义真实）。

非目标（YAGNI）：

- 不允许覆盖 registry 预置模型属性。
- 不引入 token 估算；`maxContextTokens` 未配时圆环沿用 #59 的"不渲染"路径。

## 设计

### 1. 数据结构 & 存储

新模块 `src/lib/provider-custom-model-meta.ts`，与现有 `provider-custom-models.ts` 对称。

- 存储 key：`pcmm_${provider}`（provider-custom-model-**m**eta）
- 值类型：`Record<modelId, StoredCustomModelMeta>`，其中
  ```ts
  interface StoredCustomModelMeta {
    displayName?: string;
    vision: boolean;
    maxContextTokens: number;
    // 不存 tools —— builtin 自定义模型不可配 tools，见「范围」
  }
  ```
- **现有 `pcm_${provider}` 和 `instance.customModels`（`string[]` id 池）完全不动** —— id 仍是"模型是否存在"的唯一真相源，`pcmm` 只是旁挂的属性层。

API（全 async，读写 `chrome.storage.local`）：

```ts
getProviderCustomModelMetas(provider): Promise<Record<string, StoredCustomModelMeta>>
getProviderCustomModelMeta(provider, modelId): Promise<StoredCustomModelMeta | undefined>
setProviderCustomModelMeta(provider, modelId, meta): Promise<void>
removeProviderCustomModelMeta(provider, modelId): Promise<void>
```

**删除模型时连带清理**：`removeProviderCustomModel` 的所有调用点（`Settings.tsx` 的 `onRemoveCustomModel`、dropdown 的 ×）额外调 `removeProviderCustomModelMeta`，防止 `pcmm` 留下悬挂条目。

### 2. `resolveModelMeta` 查找顺序（`registry.ts`）

`resolveModelMeta(ref, modelId)` 已是 async（它 await `getCustomProvider`），加一层 builtin 自定义 meta 查询：

1. **builtin：registry 预置**（`getModelMeta`）命中 → 返回。**预置优先，不可被 `pcmm` 覆盖**（符合范围）。
2. **builtin：`pcmm_${provider}[modelId]`** 命中 → 构造 `ModelMeta`（`{ id: modelId, ...stored, tools: true }`，`tools` 恒 true）返回。
3. custom provider：`cp.models`（现状不变）。
4. 都没有 → `null`。回退默认：圆环不显示、vision 未知 —— **与今天行为一致，零回归**。

### 3. `vision` 生效路径

配了 `vision: true` 的 builtin 自定义模型，attach 按钮须解锁。当前 `Chat.tsx:544` 用**同步**的 `resolveModelVision`（只查 registry + fetchedModels，对自定义 id 返回 undefined）。

实现选项（plan 阶段定，二选一）：

- **(a)** `resolveModelVision` 增加 `pcmm` 查询 → 变 async；`Chat.tsx:544` 改 `await`（该函数已是 async，line 545 已 await `resolveModelMeta`）。
- **(b)** `Chat.tsx` 复用 line 545 已拿到的 `resolveModelMeta` 结果取 `meta.vision`，仅在 registry/fetched 都 miss 时回退。注意 `resolveModelVision` 还有 OpenRouter `fetchedModels` 的 fallback，不能简单整体替换。

倾向 (a)：保持 `resolveModelVision` 作为唯一 vision 真相源，fallback 链补一段 `pcmm`。

### 4. UI：抽出共用编辑弹窗

把 `CustomProviderForm` 的模型编辑 modal（`editingModel` 那段，`CustomProviderForm.tsx:431-546`）抽成独立组件 `src/sidepanel/components/ModelMetaEditor.tsx`：

- 字段：`modelId`（可配"只读"）+ `displayName` + Advanced 折叠（`vision` / `maxContextTokens`，以及受 `showTools` 控制的 `tools`）
- `showTools` prop：custom provider 传 `true`（保留 tools 字段，行为不变）；builtin 传 `false`（隐藏 tools，只剩 vision + maxContext）
- custom provider 与 builtin **共用**此组件

`ModelDropdown` 改造（modal 宿主放 dropdown 内部，自管理 `editingModel` 状态）：

- **新增**：「+添加自定义模型」从"输入框直接塞 id"改成**打开 `ModelMetaEditor`**（新增模式，id 可编辑）→ 保存 → `onAddCustomModel(id, meta)`
- **编辑**：自定义模型项的 × 旁加铅笔图标 → 打开 `ModelMetaEditor`（编辑模式，id 只读）→ 保存 → `onUpdateCustomModelMeta(id, meta)`
- **badge**：`m.meta` 现在对自定义模型也能填充（从 `pcmm`）→ **vision** badge 按配置亮；tools badge 因 `tools` 恒 true、无信息量，对 builtin 自定义模型不渲染（dropdown 渲染时对自定义项跳过 tools badge）
- 因 modal 宿主在 `ModelDropdown` 内，`InstanceForm` 与 `NewConfigWizard` 复用 dropdown 即**自动获得一致的新增/编辑体验**，无需各自重造 UI

回调签名变更（向调用方冒泡）：

| 旧 | 新 |
|---|---|
| `onAddCustomModel(id)` | `onAddCustomModel(id, meta)` —— 写 `pcm` 池 + `pcmm` |
| —（新增） | `onUpdateCustomModelMeta(id, meta)` —— 写 `pcmm` |
| `onRemoveCustomModel(id)` | 不变，但实现额外删 `pcmm` |

`ModelDropdown` 需接收当前 provider 的 `pcmm`（一个 `customModelMetas: Record<id, StoredCustomModelMeta>` prop）用于填充 `m.meta` 与编辑预填。`InstanceForm` / `Settings` / `NewConfigWizard` 相应加载并下传。

### 5. 默认值（两边统一 256K）

- `ModelMetaEditor` 新增模式默认：`vision=false` / `maxContextTokens=256_000`（builtin）；custom 额外 `tools=true`（不变）
- 抽公共常量 `DEFAULT_CUSTOM_MODEL_MAX_CONTEXT = 256_000`
- **顺带把 `CustomProviderForm.tsx:99` 的 openAddModel 默认从 `128_000` 升到 `256_000`**（仅影响 custom provider 新增模型的预填值，不动已存模型），使两边对齐到一处常量

### 6. 迁移

**无**。现有用户的 `string[]` 池原样工作；自定义模型在"被编辑过属性之前"行为与今天完全一致（`resolveModelMeta` 走回退 null）。

## 测试计划

- `provider-custom-model-meta.test.ts`：CRUD；空 get；set/get round-trip；remove；删除连带清理
- `registry.test.ts`：`resolveModelMeta` builtin 自定义 id 命中 `pcmm`；**预置优先于 `pcmm`（不可覆盖）**；都 miss → null
- `ModelMetaEditor`：抽出后 custom provider 行为不回归；`showTools=false` 时不渲染 tools 字段；新增/编辑保存回调
- `ModelDropdown`：自定义模型有 meta 时显示 **vision** badge（不显示 tools badge）；「+添加」打开 modal；铅笔打开 modal（id 只读）
- vision 生效：配 `vision=true` 的 builtin 自定义模型 → attach 按钮启用
- 默认值：新增默认 256K；`CustomProviderForm` openAddModel 默认 256K

提交前须过 `pnpm test`、`pnpm typecheck`、`pnpm build`（CLAUDE.md 门禁）。

## 受影响文件

**新增**
- `src/lib/provider-custom-model-meta.ts` + `.test.ts`
- `src/sidepanel/components/ModelMetaEditor.tsx`（从 `CustomProviderForm` 抽出）+ 测试

**修改**
- `src/lib/model-router/providers/registry.ts` —— `resolveModelMeta` 加 `pcmm` 查询；`resolveModelVision` vision fallback
- `src/sidepanel/components/ModelDropdown.tsx` —— 新增/编辑 modal、badge、回调、`customModelMetas` prop
- `src/sidepanel/components/CustomProviderForm.tsx` —— 复用 `ModelMetaEditor`；默认 256K
- `src/sidepanel/components/InstanceForm.tsx` / `Settings.tsx` / `NewConfigWizard.tsx` —— 回调签名、加载并下传 `pcmm`
- `src/sidepanel/components/Chat.tsx` —— vision 从 `pcmm` 生效
- `CLAUDE.md` —— Project Structure 增 `provider-custom-model-meta.ts` 条目
