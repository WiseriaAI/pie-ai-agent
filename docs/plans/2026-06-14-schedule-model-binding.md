# Schedule 实例解析兜底 + 模型绑定 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> ⚠️ 本计划在 worktree `.claude/worktrees/fix-schedule-instance-resolution/` 执行。派 subagent 时务必 `cd` 到该 worktree 绝对路径（subagent cwd 不随 worktree 切换，见 CLAUDE.md）。所有 Write/Edit 用**相对路径**或 worktree 绝对路径，勿用主仓库路径（worktree-absolute-path-trap）。

**Goal:** 修复 issue #181（schedule 创建报 "no active instance configured"），并让 schedule 绑定 `(instance, model)` —— chat 路径绑当前会话模型、手动表单复用 ModelPicker 显式选模型。

**Architecture:** schedule 的"默认挑实例"复用权威链 `resolveSelection({})`，chat 路径优先绑运行中会话的 `(instance, model)`（经工具 ctx 透入）。`ScheduleRecord` 新增可选 `model?`，运行时优先用绑定值、缺省回退 `firstModelForProvider`（零迁移）。手动表单把只选 instance 的 `<select>` 换成复用 Composer 的 `ModelPicker`。

**Tech Stack:** React 19 + TS · vitest + happy-dom · IndexedDB（`pie` 库）· chrome.alarms（schedule）

**前置：** 进 worktree 后 `pnpm install`（node_modules 未共享）。每个 Task 末尾 commit。

---

## 文件结构（改动地图）

| 文件 | 职责 / 改动 |
|---|---|
| `src/lib/schedules/types.ts` | `ScheduleRecord` 加 `model?: string` |
| `src/lib/schedules/schedule-ops.ts` | `CreateScheduleInput.model?`；`UpdateScheduleInput.instanceId?`+`model?`；写入/patch |
| `src/lib/schedules/panel-actions.ts` | `ScheduleCreatePayload.model?`；`ScheduleUpdatePayload.instanceId?`+`model?` |
| `src/lib/schedules/run.ts` | 模型解析：`sched.model ?? firstModelForProvider(...)` |
| `src/lib/agent/types.ts` | `ToolHandlerContext` 加 `currentInstanceId?`/`currentModel?` |
| `src/lib/agent/loop.ts` | `AgentLoopContext.instanceId?`；工具 ctx 透传 `currentInstanceId`/`currentModel` |
| `src/background/index.ts` | chat 起 / resume 两处 loop 构造补 `instanceId` |
| `src/lib/agent/tools/schedule-meta.ts` | create_schedule 解析顺序（显式→会话 ctx→resolveSelection→错误）+ 绑 model |
| `src/sidepanel/components/Schedules/ScheduleForm.tsx` | 复用 ModelPicker，状态扩成 `(instanceId, model)`，创建+编辑 |
| `src/sidepanel/components/Schedules/SchedulesPanel.tsx` | 默认 `(instance,model)` 来自 resolveSelection；payload 拼 model |
| `docs/adr/0002-schedule-model-binding.md` | 新 ADR（扩展 ADR 0001） |

---

## Task 1: 数据模型 — `ScheduleRecord.model` + ops 写入/patch

**Files:**
- Modify: `src/lib/schedules/types.ts`（`ScheduleRecord`）
- Modify: `src/lib/schedules/schedule-ops.ts`（`CreateScheduleInput` / `UpdateScheduleInput` / 写入 / patch）
- Modify: `src/lib/schedules/panel-actions.ts`（payload 类型）
- Test: `src/lib/schedules/schedule-ops.test.ts`

- [ ] **Step 1: 写失败测试（create 写入 model + update patch instanceId/model）**

在 `src/lib/schedules/schedule-ops.test.ts` 末尾追加（紧邻最后一个 `});` 之前的合适位置，放进顶层 describe 内或新建一个 describe）：

```ts
describe("model 绑定（issue #181 增强）", () => {
  beforeEach(async () => { await _resetForTests(); vi.clearAllMocks(); });

  it("createScheduleOp 写入绑定的 model", async () => {
    const res = await createScheduleOp({
      title: "T", prompt: "p", instanceId: "inst_1", model: "claude-opus-4-7",
    });
    expect(res.ok).toBe(true);
    const all = await listSchedules();
    expect(all[0]!.model).toBe("claude-opus-4-7");
  });

  it("createScheduleOp 不传 model → 记录无 model（运行时回退）", async () => {
    const res = await createScheduleOp({ title: "T", prompt: "p", instanceId: "inst_1" });
    expect(res.ok).toBe(true);
    const all = await listSchedules();
    expect(all[0]!.model).toBeUndefined();
  });

  it("updateScheduleOp patch instanceId 与 model", async () => {
    await createScheduleOp({ title: "T", prompt: "p", instanceId: "inst_1", model: "m1" });
    const id = (await listSchedules())[0]!.id;
    const res = await updateScheduleOp({ id, instanceId: "inst_2", model: "m2" });
    expect(res.ok).toBe(true);
    const rec = await getSchedule(id);
    expect(rec!.instanceId).toBe("inst_2");
    expect(rec!.model).toBe("m2");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/schedules/schedule-ops.test.ts`
Expected: 新 3 例 FAIL（`model` 属性不存在 / patch 未生效）。

- [ ] **Step 3: 加 `model?` 到 `ScheduleRecord`**

`src/lib/schedules/types.ts` —— 在 `ScheduleRecord` 的 `instanceId: string;` 之后加：

```ts
  instanceId: string;                   // bound at creation (ADR 0001)
  /** 绑定的 model id（ADR 0002）。缺省 = 运行时回退 firstModelForProvider。 */
  model?: string;
```

- [ ] **Step 4: ops 写入 model + update patch instanceId/model**

`src/lib/schedules/schedule-ops.ts`：

(a) `CreateScheduleInput` 接口加字段（在 `instanceId: string;` 后）：
```ts
  instanceId: string;
  model?: string;
```

(b) `createScheduleOp` 构造 `rec` 时，在 `instanceId: input.instanceId,` 后加：
```ts
    instanceId: input.instanceId,
    ...(isNonEmptyString(input.model) ? { model: input.model } : {}),
```

(c) `UpdateScheduleInput` 接口加字段：
```ts
  id: string;
  instanceId?: string;
  model?: string;
```

(d) `updateScheduleOp` 在 `patch` 组装处（`if (input.maxRunMs !== undefined) patch.maxRunMs = input.maxRunMs;` 之后）加：
```ts
  if (input.instanceId !== undefined) {
    if (!isNonEmptyString(input.instanceId)) return fail("instanceId must be a non-empty string");
    patch.instanceId = input.instanceId;
  }
  if (input.model !== undefined) {
    patch.model = isNonEmptyString(input.model) ? input.model : undefined;
  }
```

- [ ] **Step 5: payload 类型同步（直传契约）**

`src/lib/schedules/panel-actions.ts`：
```ts
export interface ScheduleCreatePayload {
  title: string;
  prompt: string;
  instanceId: string;
  model?: string;
  spec?: ScheduleSpec;
  startUrl?: string;
  maxStepsPerRun?: number;
  maxRunMs?: number;
}

export interface ScheduleUpdatePayload {
  id: string;
  instanceId?: string;
  model?: string;
  title?: string;
  prompt?: string;
  spec?: Partial<ScheduleSpec>;
  startUrl?: string;
  maxStepsPerRun?: number;
  maxRunMs?: number;
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm test src/lib/schedules/schedule-ops.test.ts`
Expected: 全 PASS。

- [ ] **Step 7: Commit**

```bash
git add src/lib/schedules/types.ts src/lib/schedules/schedule-ops.ts src/lib/schedules/panel-actions.ts src/lib/schedules/schedule-ops.test.ts
git commit -m "feat(schedule): ScheduleRecord 绑定可选 model + ops 写入/patch"
```

---

## Task 2: 运行时模型解析回退（`run.ts`）

**Files:**
- Modify: `src/lib/schedules/run.ts:247-252`
- Test: `src/lib/schedules/run.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/lib/schedules/run.test.ts` 的 `describe("runSchedule — success path", ...)` 内追加：

```ts
it("sched.model 存在 → 用绑定 model,不调 firstModelForProvider", async () => {
  const { runSchedule } = await import("./run");
  const fakeLoop = vi.fn(async () => {});
  const firstModelForProvider = vi.fn(async () => FAKE_MODEL);
  const resolveModelConfig = vi.fn(async () => FAKE_CFG);
  await putSchedule(makeSched({ id: "sched_bound", instanceId: "inst_1", model: "claude-opus-4-7" }));
  await runSchedule(
    "sched_bound",
    okDeps({ runAgentLoop: fakeLoop, firstModelForProvider, resolveModelConfig }),
  );
  expect(firstModelForProvider).not.toHaveBeenCalled();
  expect(resolveModelConfig).toHaveBeenCalledWith("inst_1", "claude-opus-4-7");
});
```

> `makeSched` 用 `...override` 透传，`{ model: ... }` 会落进记录（依赖 Task 1 的字段）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/schedules/run.test.ts`
Expected: FAIL —— 当前代码无视 `sched.model`，`firstModelForProvider` 仍被调用、`resolveModelConfig` 收到 `FAKE_MODEL` 而非绑定值。

- [ ] **Step 3: 实现回退解析**

`src/lib/schedules/run.ts` —— 把：
```ts
  const inst = await deps.getInstance(sched.instanceId);
  const model = inst
    ? await deps.firstModelForProvider(inst.provider, sched.instanceId)
    : null;
```
改成：
```ts
  const inst = await deps.getInstance(sched.instanceId);
  // ADR 0002 — 优先用 schedule 绑定的 model；缺省回退该 instance 当前第一个 model。
  const model = inst
    ? (sched.model ?? (await deps.firstModelForProvider(inst.provider, sched.instanceId)))
    : null;
```

- [ ] **Step 4: 跑测试确认通过 + 不回归**

Run: `pnpm test src/lib/schedules/run.test.ts`
Expected: 全 PASS（新例通过；原 "resolveModelConfig 收到 firstModelForProvider 结果" 等用例仍绿，因它们的 sched 无 model）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/schedules/run.ts src/lib/schedules/run.test.ts
git commit -m "feat(schedule): 运行时优先用绑定 model,缺省回退 firstModelForProvider"
```

---

## Task 3: 工具 ctx 类型 + `create_schedule` 解析与绑定（底座 + chat ctx）

**Files:**
- Modify: `src/lib/agent/types.ts`（`ToolHandlerContext` 加两字段）
- Modify: `src/lib/agent/tools/schedule-meta.ts`（解析顺序 + 绑 model + handler 接 ctx + 删死代码）
- Test: `src/lib/agent/tools/schedule-meta.test.ts`

- [ ] **Step 1: `ToolHandlerContext` 加 `currentInstanceId?`/`currentModel?`**

`src/lib/agent/types.ts` —— 在 `ToolHandlerContext` 末尾（`removePinnedTab?` 之后）加：

```ts
  /**
   * issue #181 — 运行中 task 的当前选择，使 create_schedule 默认绑定
   * "你正在对话的那个模型"。loop 从 AgentLoopContext.instanceId +
   * modelConfig.model 填入；非 chat 发起方（eval 等）可缺省。
   */
  currentInstanceId?: string;
  currentModel?: string;
```

- [ ] **Step 2: 改写 schedule-meta.test.ts 的测试基建（隔离 + seed 真实例 + 三新例）**

替换文件顶部 import 区与 helper：

(a) import 区——把 `import { getConfig, setConfig } from "../../idb/config-store";` 这一行替换为下列多行，并新增 chromeMock/createInstance/reset/ToolHandlerContext：
```ts
import { chromeMock } from "@/test/setup";
import { createInstance } from "../../instances";
import { _resetForTests } from "../../idb/db";
import { _resetKeyForTests } from "../../crypto";
import type { ToolHandlerContext } from "../types";
```
（删掉 `getConfig`/`setConfig` 的 import —— 迁移后不再用。）

(b) 把 `const ctx = {} as never;` 改为：
```ts
const EMPTY_CTX = {} as ToolHandlerContext; // 无会话选择 → 走 resolveSelection 兜底
```
并将文件内**所有** `, ctx)` 调用改为 `, EMPTY_CTX)`（除非该用例显式构造带 currentInstanceId 的 ctx，见 Step 4）。

(c) 删除 `ACTIVE_KEY` 常量、`setActiveInstanceId` helper；替换 `clearAll` 与新增 `seedInstance`：
```ts
const TEST_INSTANCE_ID = "test-instance-001";

/** seed 一个真实例（镜像全新 V2：配了 provider 但没写 active_instance_id）。
 *  create_schedule 无显式 instanceId 时经 resolveSelection 兜底解析到它。 */
async function seedInstance(): Promise<string> {
  return createInstance({ provider: "anthropic", nickname: "A", apiKey: "k" });
}

async function clearAll() {
  chromeMock.storage.local.__store = {};
  await _resetForTests();
  _resetKeyForTests();
  vi.clearAllMocks();
}
```

- [ ] **Step 3: 机械迁移现有用例（active → seed）**

对每个原先 `await setActiveInstanceId(TEST_INSTANCE_ID);` 起头、且依赖**默认路径成功**的用例，改为 `const seededId = await seedInstance();`，并把其中断言 `.instanceId).toBe(TEST_INSTANCE_ID)` 改为 `.instanceId).toBe(seededId)`。具体涉及的用例（标题）：
- "create_schedule 写入 store 并调用 armSchedule" → 断言改 `toBe(seededId)`
- "create_schedule 缺省 instanceId = active instance" → 标题改 "缺省 instanceId = resolveSelection 兜底实例"，断言改 `toBe(seededId)`
- 其余仅需"默认路径不报错"的用例（允许 MIN 边界 / 接受 ISO startAt / 初始 status / update 系列 / delete / list / 拒绝 restricted startUrl / 超过 MAX_SCHEDULES / 拒绝 interval<MIN）：把 `await setActiveInstanceId(TEST_INSTANCE_ID);` 改为 `await seedInstance();`
- 纯前置校验、在解析实例前就返回的用例（"拒绝空 title"、"拒绝空 prompt"、"拒绝非法 startAt 字符串"）：删掉该 `setActiveInstanceId` 行即可（无需 seed）。
- "create_schedule 使用显式 instanceId 覆盖 active"：删 `setActiveInstanceId("other-instance")`，改为 `await seedInstance();`（作为"会被覆盖的默认"），其余不变（显式 `instanceId: TEST_INSTANCE_ID` 仍生效、断言不变）。

> 7.5 cascade 那组用 `makeRecord`/`putSchedule` 直插、不走默认路径，无需改（但它们的 `beforeEach(clearAll)` 现在会 `_resetForTests`，仍正确）。

- [ ] **Step 4: 加三个新用例（会话 ctx 绑定 / 兜底 / 零配置）**

在主 describe 内 "使用显式 instanceId 覆盖 active" 用例后追加：

```ts
it("create_schedule: 会话 ctx → 绑定当前会话 (instance, model) (#181)", async () => {
  const ctx = { currentInstanceId: "inst_live", currentModel: "claude-opus-4-7" } as ToolHandlerContext;
  const r = await create.handler({ title: "T", prompt: "p" }, ctx);
  expect(r.success).toBe(true);
  const all = await listSchedules();
  expect(all[0]!.instanceId).toBe("inst_live");
  expect(all[0]!.model).toBe("claude-opus-4-7");
});

it("create_schedule: 无 ctx + active 为 null + 有实例 → resolveSelection 兜底成功 (#181)", async () => {
  const id = await seedInstance();
  const r = await create.handler({ title: "T", prompt: "p" }, EMPTY_CTX);
  expect(r.success).toBe(true);
  const all = await listSchedules();
  expect(all[0]!.instanceId).toBe(id);
});

it("create_schedule: 真零配置(无实例 + 无 ctx) → 清晰错误 (#181)", async () => {
  const r = await create.handler({ title: "T", prompt: "p" }, EMPTY_CTX);
  expect(r.success).toBe(false);
  expect(r.error).toMatch(/provider/i);
});
```

- [ ] **Step 5: 跑测试确认失败（RED）**

Run: `pnpm test src/lib/agent/tools/schedule-meta.test.ts`
Expected: 三新例 + 部分迁移例 FAIL（当前 handler 仍裸读 `active_instance_id`、不读 ctx、不绑 model、零配置错误文案不含 "provider"）。

- [ ] **Step 6: 实现 handler 解析顺序 + 绑 model + 删死代码**

`src/lib/agent/tools/schedule-meta.ts`：

(a) import 区：删 `import { getConfig } from "../../idb/config-store";`，加 `import { resolveSelection } from "../../model-selection-resolver";` 和 `import type { ToolHandlerContext } from "../types";`。

(b) 删除 `const ACTIVE_KEY = "active_instance_id";` 与 `getActiveInstanceId` 函数。

(c) `createScheduleTool.handler` 签名改为带 ctx，并替换实例解析块：
```ts
  handler: async (args: unknown, ctx: ToolHandlerContext): Promise<ActionResult> => {
    const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;

    if (!isNonEmptyString(a.title)) return err("title is required and must be a non-empty string");
    if (!isNonEmptyString(a.prompt)) return err("prompt is required and must be a non-empty string");

    const spec: ScheduleSpec = {};
    if (a.spec && typeof a.spec === "object") {
      const s = a.spec as Record<string, unknown>;
      if (s.startAt !== undefined) {
        const r = coerceStartAt(s.startAt);
        if (!r.ok) return err(r.error);
        spec.startAt = r.ms;
      }
      if (s.intervalMinutes !== undefined) spec.intervalMinutes = s.intervalMinutes as number;
      if (s.maxRuns !== undefined) spec.maxRuns = s.maxRuns as number;
    }

    // 解析 (instanceId, model)：显式 arg → 当前会话 ctx → resolveSelection 兜底 → 错误。
    // model 仅在来源是会话/兜底（已解析出具体 (instance, model)）时绑定；显式
    // instanceId 无配对 model 时留空，运行时回退 firstModelForProvider。
    let instanceId: string;
    let model: string | undefined;
    if (isNonEmptyString(a.instanceId)) {
      instanceId = a.instanceId;
    } else if (isNonEmptyString(ctx.currentInstanceId)) {
      instanceId = ctx.currentInstanceId;
      model = isNonEmptyString(ctx.currentModel) ? ctx.currentModel : undefined;
    } else {
      const sel = await resolveSelection({});
      if (!sel) return err("no AI provider configured — add one in Settings, or pass an explicit instanceId");
      instanceId = sel.instanceId;
      model = sel.model;
    }

    const res = await createScheduleOp({
      title: a.title,
      prompt: a.prompt,
      instanceId,
      ...(model ? { model } : {}),
      spec,
      ...(isNonEmptyString(a.startUrl) ? { startUrl: a.startUrl } : {}),
      ...(a.maxStepsPerRun !== undefined ? { maxStepsPerRun: a.maxStepsPerRun as number } : {}),
      ...(a.maxRunMs !== undefined ? { maxRunMs: a.maxRunMs as number } : {}),
    });
    if (!res.ok) return err(res.error);

    return {
      success: true,
      observation: `schedule created: id=${res.id} title="${a.title.trim()}" instanceId=${instanceId}${model ? ` model=${model}` : ""}. It will run automatically as scheduled.`,
    };
  },
```

(d) 更新文件顶部注释第 14 行 `instanceId defaults to the active instance when not provided` → `instanceId/model default to the current chat session, else resolveSelection`。

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm test src/lib/agent/tools/schedule-meta.test.ts`
Expected: 全 PASS。

- [ ] **Step 8: Commit**

```bash
git add src/lib/agent/types.ts src/lib/agent/tools/schedule-meta.ts src/lib/agent/tools/schedule-meta.test.ts
git commit -m "fix(schedule): create_schedule 解析改走会话 ctx + resolveSelection 兜底,绑 model (#181)"
```

---

## Task 4: loop 管线 — 把会话 `(instance, model)` 透进工具 ctx

**Files:**
- Modify: `src/lib/agent/loop.ts`（`AgentLoopContext.instanceId?` + 工具 ctx 透传）
- Modify: `src/background/index.ts`（chat 起 / resume 两处补 `instanceId`）
- Modify: `src/lib/schedules/run.ts`（计划运行 loop 构造补 `instanceId`，一致性）

> 说明：本 task 是端到端打通管线，主要由 `pnpm typecheck` + 既有 loop/run 测试守。无新单测（loop 集成面巨大、由 schedule-meta 的 ctx 契约测试覆盖行为）。

- [ ] **Step 1: `AgentLoopContext` 加 `instanceId?`**

`src/lib/agent/loop.ts` —— 在 `AgentLoopContext` 的 `modelConfig: ModelConfig;` 后加：
```ts
  modelConfig: ModelConfig;
  /** issue #181 — 本 task 绑定的 instanceId（task start 已解析）。loop 转发它
   *  + modelConfig.model 进 ToolHandlerContext.currentInstanceId/currentModel，
   *  使 create_schedule 默认绑"正在对话的模型"。 */
  instanceId?: string;
```

- [ ] **Step 2: 工具 ctx 透传**

`src/lib/agent/loop.ts:2218` —— 在 `await tool.handler(tc.args, { ... })` 的 ctx 对象里加两行（与 `pinMode: ctx.pinMode,` 同级）：
```ts
            currentInstanceId: ctx.instanceId,
            currentModel: ctx.modelConfig.model,
```

- [ ] **Step 3: chat 起 + resume 两处补 `instanceId`**

`src/background/index.ts`：
- chat 起的 `runAgentLoop({ ... })` 构造里加 `instanceId: chatSel.instanceId,`（`chatSel` 在该作用域已存在，见 `:1313`）。
- resume 的 `runAgentLoop({ ... })` 构造里加 `instanceId: resumeSel.instanceId,`（`resumeSel` 见 `:961` 区）。

> 用 `grep -n "runAgentLoop({" src/background/index.ts` 定位两处构造块，分别加入对应变量。

- [ ] **Step 4: 计划运行补 `instanceId`（一致性）**

`src/lib/schedules/run.ts:400` 的 `runAgentLoop` 调用（经 `deps.runAgentLoop`）所传 ctx 对象里，在 `modelConfig: cfg,` 后加 `instanceId: sched.instanceId,`。

> headless 计划运行已排除 create_schedule（HEADLESS_EXCLUDE_TOOL_NAMES），此处非载荷、仅一致性。

- [ ] **Step 5: typecheck + 相关测试**

Run: `pnpm typecheck`
Expected: 0 错（`instanceId?` 可选，eval-bridge 等不强制补；新增 ctx 字段可选）。

Run: `pnpm test src/lib/schedules/run.test.ts src/background`
Expected: 全 PASS（构造点新增可选字段不破坏既有断言）。

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent/loop.ts src/background/index.ts src/lib/schedules/run.ts
git commit -m "feat(agent): loop 透传会话 (instance, model) 进工具 ctx (#181)"
```

---

## Task 5: 手动表单复用 `ModelPicker`（创建 + 编辑）

**Files:**
- Modify: `src/sidepanel/components/Schedules/ScheduleForm.tsx`
- Test: `src/sidepanel/components/Schedules/ScheduleForm.test.tsx`

- [ ] **Step 1: 写失败测试（默认选择提交 + 切模型 + 编辑模式可见）**

`src/sidepanel/components/Schedules/ScheduleForm.test.tsx` —— import 区加 `waitFor`（`import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";`）。

> ⚠️ ModelPicker 触发器对 **builtin** provider 显示 registry 名（"Anthropic"/"OpenAI"），不是 nickname。测试一律用**确定性的 model id**（触发器 aria-label = `${providerName} ${currentModel}`，含 model id）定位，勿用 nickname。

顶部 `instances` 改为带确定性 customModels（让 ModelPicker 行可预测）：

```ts
const instances: DecryptedInstance[] = [
  { id: "inst_1", provider: "anthropic", nickname: "Claude", apiKey: "k", createdAt: 1, customModels: ["model-a1", "model-a2"] },
  { id: "inst_2", provider: "openai", nickname: "GPT", apiKey: "k", createdAt: 2, customModels: ["model-b1"] },
];
```

`renderForm` 加 `activeModel` 默认值：
```ts
function renderForm(props: Partial<React.ComponentProps<typeof ScheduleForm>> = {}) {
  return render(
    <ScheduleForm
      instances={instances}
      activeInstanceId="inst_1"
      activeModel="model-a1"
      onSubmit={props.onSubmit ?? vi.fn().mockResolvedValue({ ok: true })}
      onCancel={props.onCancel ?? vi.fn()}
      {...props}
    />,
  );
}
```

追加用例：
```ts
it("提交时带上默认 (instanceId, model)", async () => {
  const onSubmit = vi.fn().mockResolvedValue({ ok: true });
  renderForm({ onSubmit });
  fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Digest" } });
  fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: "summarize" } });
  fireEvent.click(screen.getByRole("button", { name: /create/i }));
  await waitFor(() =>
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: "inst_1", model: "model-a1" }),
    ),
  );
});

it("用 ModelPicker 切到另一模型后提交带新 model", async () => {
  const onSubmit = vi.fn().mockResolvedValue({ ok: true });
  renderForm({ onSubmit });
  fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Digest" } });
  fireEvent.change(screen.getByLabelText(/prompt/i), { target: { value: "summarize" } });
  // 打开 ModelPicker（trigger aria-label 含当前 model id model-a1），当前实例默认展开 → 点 model-a2
  fireEvent.click(screen.getByRole("button", { name: /model-a1/ }));
  fireEvent.click(screen.getByRole("button", { name: "model-a2" }));
  fireEvent.click(screen.getByRole("button", { name: /create/i }));
  await waitFor(() =>
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: "inst_1", model: "model-a2" }),
    ),
  );
});

it("编辑模式也显示 ModelPicker（不再隐藏实例选择）", async () => {
  const editing = {
    id: "sched_e", title: "Old", prompt: "p", spec: { intervalMinutes: 60 },
    instanceId: "inst_2", model: "model-b1", enabled: true, status: "active" as const,
    createdAt: 1, runCount: 0, consecutiveFailures: 0, runIds: [],
  };
  renderForm({ editing });
  // ModelPicker trigger aria-label 含编辑记录的 model id（model-b1）
  expect(screen.getByRole("button", { name: /model-b1/ })).toBeTruthy();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/Schedules/ScheduleForm.test.tsx`
Expected: FAIL —— `activeModel` prop 不存在 / 仍是 `<select>` / 编辑模式隐藏选择。

- [ ] **Step 3: 改 ScheduleForm —— 复用 ModelPicker**

`src/sidepanel/components/Schedules/ScheduleForm.tsx`：

(a) import 加：
```ts
import ModelPicker from "../ModelPicker";
```

(b) `Props` 加 `activeModel`：
```ts
interface Props {
  instances: DecryptedInstance[];
  activeInstanceId: string | null;
  activeModel?: string | null;
  editing?: ScheduleRecord;
  onSubmit: (payload: ScheduleCreatePayload | ScheduleUpdatePayload) => Promise<ScheduleActionResponse>;
  onCancel: () => void;
}
```

(c) `FormState` 加 `model`：在 `instanceId: string;` 后加 `model: string;`。

(d) `initialState` 改签名与返回：
```ts
function initialState(
  editing: ScheduleRecord | undefined,
  activeInstanceId: string | null,
  activeModel: string | null | undefined,
  instances: DecryptedInstance[],
): FormState {
  const fallbackInstance = activeInstanceId ?? instances[0]?.id ?? "";
  if (!editing) {
    return {
      title: "", prompt: "", startAtLocal: "", intervalMinutes: "", maxRuns: "",
      startUrl: "", maxStepsPerRun: "", maxRunMs: "",
      instanceId: fallbackInstance,
      model: activeModel ?? "",
    };
  }
  return {
    title: editing.title,
    prompt: editing.prompt,
    startAtLocal: editing.spec.startAt != null ? toLocalInput(editing.spec.startAt) : "",
    intervalMinutes: editing.spec.intervalMinutes != null ? String(editing.spec.intervalMinutes) : "",
    maxRuns: editing.spec.maxRuns != null ? String(editing.spec.maxRuns) : "",
    startUrl: editing.startUrl ?? "",
    maxStepsPerRun: editing.maxStepsPerRun != null ? String(editing.maxStepsPerRun) : "",
    maxRunMs: editing.maxRunMs != null ? String(editing.maxRunMs) : "",
    instanceId: editing.instanceId,
    model: editing.model ?? "",
  };
}
```

(e) 组件签名 + useState 初始化：
```ts
export default function ScheduleForm({ instances, activeInstanceId, activeModel, editing, onSubmit, onCancel }: Props) {
  const t = useT();
  const isEdit = !!editing;
  const [form, setForm] = useState<FormState>(() => initialState(editing, activeInstanceId, activeModel, instances));
```

(f) 把 `{!isEdit && (<Field ...><select .../></Field>)}` 整块（约 `:195-211`）替换为（创建+编辑都显示）：
```tsx
      <Field label={t("schedules.fieldConfig")} htmlFor="sched-instance">
        <ModelPicker
          instances={instances}
          currentInstanceId={form.instanceId || null}
          currentModel={form.model || null}
          locked={false}
          onSelect={(instanceId, model) => setForm((p) => ({ ...p, instanceId, model }))}
          onManage={() => {}}
        />
      </Field>
```

(g) `validate()` 在 `if (!form.instanceId) return t("schedules.errSelectConfig");` 后加：
```ts
    if (!form.model) return t("schedules.errSelectModel");
```

(h) `handleSubmit` 的 payload 组装：create 分支加 `model`，edit 分支加 `instanceId`+`model`：
```ts
      const payload: ScheduleCreatePayload | ScheduleUpdatePayload = isEdit
        ? { id: editing!.id, instanceId: form.instanceId, model: form.model, ...common, startUrl: form.startUrl.trim() }
        : { instanceId: form.instanceId, model: form.model, ...common };
```

- [ ] **Step 4: 加 i18n key `schedules.errSelectModel`**

`grep -rln "errSelectConfig" src/lib/i18n` 找到所有语言字典，给每个补一条同级 `errSelectModel`（值用对应语言，如 en: `"Pick a model"`、zh-CN: `"请选择一个模型"`；其余语言照 errSelectConfig 风格翻译）。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/Schedules/ScheduleForm.test.tsx`
Expected: 全 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/components/Schedules/ScheduleForm.tsx src/sidepanel/components/Schedules/ScheduleForm.test.tsx src/lib/i18n
git commit -m "feat(schedule): 手动表单复用 ModelPicker,创建/编辑均可选 (instance, model)"
```

---

## Task 6: `SchedulesPanel` 默认走 resolveSelection + 透 model

**Files:**
- Modify: `src/sidepanel/components/Schedules/SchedulesPanel.tsx`
- Test: `src/sidepanel/components/Schedules/SchedulesPanel.test.tsx`

- [ ] **Step 1: 写失败测试（默认预选来自 resolveSelection，多实例时非 instances[0]）**

`src/sidepanel/components/Schedules/SchedulesPanel.test.tsx`：

(a) `@/lib/instances` mock 去掉 `getActiveInstance`，`listInstances` 返回两实例（带 customModels）：
```ts
vi.mock("@/lib/instances", () => ({
  listInstances: vi.fn(async (): Promise<DecryptedInstance[]> => [
    { id: "inst_1", provider: "anthropic", nickname: "Claude", apiKey: "k", createdAt: 1, customModels: ["m-a"] },
    { id: "inst_2", provider: "openai", nickname: "GPT", apiKey: "k", createdAt: 2, customModels: ["m-b"] },
  ]),
}));
```

(b) 新增 resolver mock（默认返回 inst_2，证明默认来自 resolveSelection 而非 instances[0]）：
```ts
vi.mock("@/lib/model-selection-resolver", () => ({
  resolveSelection: vi.fn(async () => ({ instanceId: "inst_2", model: "m-b" })),
}));
```

(c) 追加用例：
```ts
it("手动表单默认预选 resolveSelection 解析的实例（非 instances[0]）", async () => {
  render(<SchedulesPanel onOpenSession={vi.fn()} />);
  await screen.findByText(/no schedules/i);
  fireEvent.click(screen.getByRole("button", { name: /new schedule/i }));
  fireEvent.click(await screen.findByTestId("new-choice-manual"));
  // ModelPicker trigger aria-label 含 inst_2 的 model id（m-b），证明默认= resolveSelection 的 inst_2
  expect(await screen.findByRole("button", { name: /m-b/ })).toBeTruthy();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/Schedules/SchedulesPanel.test.tsx`
Expected: FAIL —— 当前面板用 `getActiveInstance`（mock 已删→报错 / 默认落 instances[0]=Claude）。

- [ ] **Step 3: 改 SchedulesPanel**

`src/sidepanel/components/Schedules/SchedulesPanel.tsx`：

(a) import：`import { listInstances, getActiveInstance } from "@/lib/instances";` → `import { listInstances } from "@/lib/instances";`，并加 `import { resolveSelection } from "@/lib/model-selection-resolver";`。

(b) state 加 model：
```ts
  const [activeInstanceId, setActiveInstanceId] = useState<string | null>(null);
  const [activeModel, setActiveModel] = useState<string | null>(null);
```

(c) `useEffect` 里 `void getActiveInstance().then(setActiveInstanceId);` → 
```ts
    void resolveSelection({}).then((sel) => {
      setActiveInstanceId(sel?.instanceId ?? null);
      setActiveModel(sel?.model ?? null);
    });
```

(d) 两处 `<ScheduleForm ... activeInstanceId={activeInstanceId} ... />` 都加 `activeModel={activeModel}`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/Schedules/SchedulesPanel.test.tsx`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/Schedules/SchedulesPanel.tsx src/sidepanel/components/Schedules/SchedulesPanel.test.tsx
git commit -m "feat(schedule): SchedulesPanel 默认 (instance, model) 走 resolveSelection (#181)"
```

---

## Task 7: ADR

**Files:**
- Create: `docs/adr/0002-schedule-model-binding.md`

- [ ] **Step 1: 写 ADR**

```markdown
# ADR 0002 — Schedule 绑定 (instance, model)

## Status
Accepted (2026-06-14) — 扩展 ADR 0001。

## Context
ADR 0001 规定 schedule 只绑 instanceId，运行时用 `firstModelForProvider` 取该 instance 第一个 model。
issue #181 暴露两问题：(1) 创建时"默认挑实例"裸读 `active_instance_id`（全新 V2 恒 null）导致失败；
(2) 用户无法指定 schedule 用哪个 model（总是第一个）。

## Decision
1. 创建时"默认挑实例"复用权威链 `resolveSelection({})`；chat 路径优先绑**当前会话**的 (instance, model)。
2. `ScheduleRecord` 新增可选 `model?`；运行时**优先用绑定 model，缺省回退 `firstModelForProvider`**（零迁移）。
3. 写入来源：chat = 会话当前 (instance, model)（经工具 ctx）；手动表单 = 用户在 ModelPicker 选。
   agent 工具不加 model 参数。

## Consequences
- 旧记录 / 无 model 记录行为不变（回退路径）。
- "挂起式让用户在 chat 选不同模型" 延后至 issue #184。
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/0002-schedule-model-binding.md
git commit -m "docs(adr): 0002 schedule 绑定 (instance, model)"
```

---

## Task 8: 全量验证

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: 全绿（含迁移后的 schedule-meta + 新增用例）。

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 0 错。

- [ ] **Step 3: build**

Run: `pnpm build`
Expected: 成功（tool-names / tools 构建期不变量不 throw）。

- [ ] **Step 4: 真机同步（用户说"测试"时）**

Run: `pnpm build && pnpm sync:dist` → 让用户去 `chrome://extensions` 刷新。

真机回归清单：
1. 全新 V2（清扩展数据）→ 配一个 provider → chat 让 agent "建个每天9点的任务" → 成功、不报 no active instance。
2. 列表 → 该 schedule 绑的 model = 当前对话模型。
3. 面板"新建 → 填表" → ModelPicker 预选默认 (instance, model) → 改模型 → 创建成功。
4. 编辑该 schedule → ModelPicker 可改 (instance, model) → 保存 → 运行时生效。
5. 多实例 + 在 Composer 切到非第一个实例 → 面板默认预选与 Composer 一致。

---

## Self-Review 记录

- **Spec 覆盖**：底座(Task 3/6) / model 字段(Task 1) / 运行时回退(Task 2) / chat ctx 绑定(Task 3/4) / 手动 ModelPicker(Task 5) / 编辑 (instance,model)(Task 5) / ADR(Task 7) —— 全覆盖。
- **类型一致**：`model?`(types/ops/payload) 一致；`currentInstanceId`/`currentModel`(types↔loop↔schedule-meta) 一致；`activeModel`(panel↔form) 一致。
- **延后项**：挂起式模型卡 → issue #184，不在本计划。
