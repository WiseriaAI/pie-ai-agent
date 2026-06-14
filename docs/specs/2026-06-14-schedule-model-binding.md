# Schedule 实例解析兜底 + 模型绑定（issue #181）

- 日期：2026-06-14
- 关联：issue #181（`create_schedule` 报 "no active instance configured"）
- 状态：设计已定，待 plan

## 背景与问题

定时任务（schedule）创建时要确定"用哪份凭据跑"。两个症状同一根因：

- **Agent 工具 `create_schedule`**：报 `no active instance configured — provide instanceId explicitly`。
- **手动表单 SchedulesPanel**：拿不到默认实例。

根因：schedule 的"默认挑实例"直接裸读 config key `active_instance_id` 且**无兜底**（`schedule-meta.ts:170-172`、`SchedulesPanel.tsx:133`）。但 `active_instance_id` 在正常 V2 使用中几乎从不被写（只有 V1→V2 迁移、删当前实例重指、eval 写它；`createInstance` 与 Composer 选模型都不写）。全新 V2 用户该 key 恒为 null → schedule 失败。聊天不受影响，因为它走另一条**有兜底**的权威链 `resolveSelection()`（`session pin → last_model_selection → 第一个 instance`，不读 `active_instance_id`）。

## 目标

分两层：

1. **底座（修 bug）**：schedule 的"默认挑实例"复用权威的 `resolveSelection({})`，agent 工具与手动表单两条路径都修好。
2. **增强**：手动表单复用 Composer 的 `ModelPicker`，让用户显式选 `(instance, model)`；schedule 持久化绑定的 model。

## 关键事实（现状）

- `ScheduleRecord` **只绑 `instanceId`，不存 `model`**（ADR 0001："model 由 instance 运行时解析"）。运行时 `run.ts:247-252` 用 `firstModelForProvider(provider, instanceId)` 取该 instance 的**第一个**可用 model。
- `ModelPicker`（`src/sidepanel/components/ModelPicker.tsx`）是 Composer 在用的 `(instance, model)` 选择器，接口 `onSelect(instanceId, model)`；其 `modelsFor(inst)` 已 `export`，可直接复用。
- 写入链极薄：`handleScheduleAction` 把 panel payload 原样直传 `createScheduleOp` / `updateScheduleOp`。给 op 的 input 类型 + payload 类型同步加字段即可贯通。

## 设计

### 1. 数据模型

`ScheduleRecord` 新增**可选**字段：

```ts
model?: string;   // 创建时绑定的模型 id；缺省 = 运行时回退 firstModelForProvider
```

可选是关键 —— 旧记录与 agent 建的记录没有它，运行时自动回退，**零迁移**。

### 2. 两条创建路径（有意不同）

| 路径 | 绑 instance | 绑 model |
|---|---|---|
| 手动表单 | 用户在 `ModelPicker` 里选 | 用户在 `ModelPicker` 里选 → 写入 `model` |
| Agent 工具 `create_schedule` | **当前会话的 instanceId**（运行中的 task ctx） | **当前会话的 model**（`ctx.modelConfig.model`）→ 写入 `model` |

**Agent 工具不加 `model` 参数**（本期）。chat 建 schedule 默认**绑定当前正在对话的 `(instance, model)`** —— "你用哪个模型聊，定时任务就用哪个"，比"取实例第一个模型"更贴合意图，且把模型绑定在 chat 路径上顺手吃掉。

> **延后项**：当用户想给定时任务指定一个**不同于当前对话**的模型时，弹"挂起式模型选择卡片"让其选 —— 见 **issue #184**（复用 `cdp-input-onboarding` 的 loop-pause 范式）。本期不做卡片、不动 loop。

### 3. 底座：实例解析的兜底

**`schedule-meta.ts` create_schedule handler**（`:165-173`）解析顺序：
1. 显式 `instanceId` 参数（优先级最高，**完全不变**）。
2. **当前会话 ctx**：`instanceId` = 运行中 task 的 instanceId（由 loop 发起方透入）；`model` = `ctx.modelConfig.model` → 绑定 `(instance, model)`。
3. 兜底 `resolveSelection({})`（ctx 缺失等边界）：`sel.instanceId`。
4. 都没有 → `err("no AI provider configured — add one in Settings, or pass an explicit instanceId")`。

删除变成死代码的 `getActiveInstanceId()` / `ACTIVE_KEY` 常量 / `getConfig` import。

> chat 路径在运行中的会话里 instanceId 恒非空 → issue #181 的"no active instance"在 chat 侧由会话 instanceId 直接消除；手动表单侧由 `resolveSelection` 兜底消除。

**`SchedulesPanel.tsx`**（`:133`）：
```ts
void resolveSelection({}).then((sel) => setActiveInstanceId(sel?.instanceId ?? null));
```
（变量名仍叫 `activeInstanceId`，只是来源改成权威链。）

### 3b. chat ctx 管线（让 `create_schedule` 拿到会话 `(instance, model)`）

- `model`：`ctx.modelConfig.model` 已在 loop 内（`AgentLoopContext.modelConfig`）。
- `instanceId`：`ModelConfig` **不含** instanceId；由 loop 发起方（task start 时已解析出 instanceId）透入 —— 给 `AgentLoopContext` 加 `instanceId`，再在工具 ctx（`loop.ts:2218` 的 `tool.handler(args, { ... })`）暴露 `currentInstanceId` / `currentModel`（或一个 `currentSelection` 小对象）。
- 调用 `create_schedule` 的两处发起方都已知 instanceId：前端 chat（task start 解析）/ 计划运行 `run.ts`（`sched.instanceId`）。

**`SchedulesPanel.tsx`**（`:133`）：
```ts
void resolveSelection({}).then((sel) => setActiveInstanceId(sel?.instanceId ?? null));
```
（变量名仍叫 `activeInstanceId`，只是来源改成权威链。）

### 4. 运行时解析（`run.ts:247-252`）

```ts
const inst = await deps.getInstance(sched.instanceId);
const model = inst
  ? (sched.model ?? await deps.firstModelForProvider(inst.provider, sched.instanceId))
  : null;
```
有绑定 model 用绑定的，否则回退现有逻辑。保留"instance 被删 → 失败"的护栏（`inst` 仍需存在）。

### 5. 手动表单 UI（`ScheduleForm.tsx`）

- 把只选 instance 的 `<select>`（`:196-211`）换成复用 `ModelPicker`。
- 表单状态从 `instanceId` 扩成 `(instanceId, model)`；`ModelPicker.onSelect(instanceId, model)` **成对更新两者** —— 用户是在某个 provider 下点一个具体 model，所以换 instance 必然携带一个属于它的合法 model，不会出现 instance 与 model 错配的孤儿态。
- 默认选中态来自 `resolveSelection({})` 解析的 `(instanceId, model)`（由 SchedulesPanel 解析后传入）。
- **创建与编辑模式都显示**（去掉 `:195` 的 `!isEdit` 限制）。编辑模式可改 `(instance, model)`。
- 校验：无任何实例 → 维持 `errSelectConfig`（引导去设置）；instance 选了但 model 仍空（如懒加载 provider 未刷新）→ 提示先选模型。
- 集成细节（留给 plan）：`onRefreshModels`（openrouter 懒加载）照 Composer 接一份；`onManage` 在表单语境下路由到设置或 no-op；popover 默认向上弹（`bottom-full`），若在表单顶部裁切则加定位调整。

### 6. 编辑路径加字段

- `ScheduleUpdatePayload`（panel-actions）+ `UpdateScheduleInput`（schedule-ops）加 `instanceId?` 与 `model?`，`updateScheduleOp` 写进 patch。
- `ScheduleCreatePayload` + `CreateScheduleInput` 加 `model?`。
- 改 instanceId 不触发 re-arm（re-arm 只看 spec 时序），但需保证 patch 正确写入。

### 7. 面板默认（`SchedulesPanel.tsx`）

`resolveSelection({})` 解析出的 `(instanceId, model)` 连同 `instances` 一起喂给 `ScheduleForm` 当默认；`handleCreate` / `handleEditSave` 把 `model`（+ 编辑时 `instanceId`）拼进 payload。

### 8. ADR

新增一条 ADR（`docs/adr/`），记录："schedule 绑 `(instance, model)`；`model` 可选；运行时优先绑定值、缺省回退 `firstModelForProvider`；agent 路径只绑 instance"。扩展 ADR 0001。

## 触点清单

底座：
1. `src/lib/agent/tools/schedule-meta.ts`
2. `src/sidepanel/components/Schedules/SchedulesPanel.tsx`

增强：
3. `src/lib/schedules/types.ts` — `ScheduleRecord.model?`
4. `src/lib/schedules/schedule-ops.ts` — create/update input + 写入
5. `src/lib/schedules/panel-actions.ts` — payload 类型
6. `src/lib/schedules/run.ts` — 模型解析回退
7. `src/lib/agent/loop.ts` — `AgentLoopContext.instanceId` + 工具 ctx 暴露 `currentInstanceId`/`currentModel`
8. `src/lib/agent/tools/schedule-meta.ts` — chat ctx 绑会话 `(instance, model)`
9. `src/sidepanel/components/Schedules/ScheduleForm.tsx` — 复用 ModelPicker
10. `src/sidepanel/components/Schedules/SchedulesPanel.tsx` — 默认 (instance,model) + payload 拼装
11. `docs/adr/` — 新 ADR

## 测试策略（TDD）

底座（`schedule-meta.test.ts`）：
- **会话 ctx 绑定**：`create_schedule` 在带 `currentInstanceId`/`currentModel` 的 ctx 下（无显式 instanceId、`active_instance_id` 为 null）→ 绑定该会话 `(instance, model)`、成功。
- **resolveSelection 兜底**：ctx 缺失 + `active_instance_id` 为 null + 有实例 → 解析到该实例、成功。
- 真零配置（无实例、无 ctx）→ 清晰错误（匹配 `/provider/i`）。
- 显式 `instanceId` 路径不变。
- 现有用例从"setActiveInstanceId"迁移为 seed 真实实例（`createInstance` + `_resetForTests` 隔离）。

增强：
- `schedule-ops`：`createScheduleOp` 写入 `model`；`updateScheduleOp` patch `instanceId`/`model`。
- `run.ts`：`sched.model` 存在 → 用它（不调 firstModelForProvider）；缺省 → 回退。
- `ScheduleForm`：复用 ModelPicker，选 `(instance, model)` 后 onSubmit payload 带 model；编辑模式可改。
- `SchedulesPanel`：默认预选来自 `resolveSelection({})`（多实例时跟 `last_model_selection` 一致，而非 `instances[0]`）。

## 验收标准（issue #181）

- [ ] chat 建 schedule（运行中会话、`active_instance_id` 为 null）→ 绑定当前会话 `(instance, model)`，不再报"no active instance"。
- [ ] ctx 缺失兜底：有 ≥1 实例时 `create_schedule`（无显式 instanceId）经 `resolveSelection` 解析成功。
- [ ] SchedulesPanel 手动新建能预选默认实例。
- [ ] 显式传 `instanceId` 路径不变。
- [ ] 真零配置给清晰错误（引导去设置）。
- [ ] 新增单测覆盖 "会话 ctx 绑定成功"、"resolveSelection 兜底成功"、"零配置错误" 三种情况。
- [ ] （增强）手动表单可选 `(instance, model)`，创建与编辑均可，绑定的 model 在运行时生效；chat 建的 schedule 绑会话当前 model 并在运行时生效。

## 非目标 / 延后

- 不改 schedule 仍持久化一个固定 instanceId 的设计。
- 不给 agent 工具加 model 参数。
- 不做任何存储迁移（`model` 可选向后兼容）。
- **挂起式模型选择卡片**（chat 里让用户选一个不同于当前对话的模型）→ 延后至 **issue #184**（复用 `cdp-input-onboarding` loop-pause 范式）。本期 chat 建 schedule 一律绑会话当前 `(instance, model)`。
