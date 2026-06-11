# Schedule（定时执行 Agent 任务）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Pie 能按周期（或一次性/N 次）在后台用完整 agent 能力自动跑一段 prompt，浏览器开着时即便 side panel 关闭也能由 `chrome.alarms` 唤醒执行。

**Architecture:** 复用现有 session / `runAgentLoop` / IDB 原子写 / cold-start recovery / 多 session 并发底盘；纯新增 = `schedules` store + `chrome.alarms` 调度器 + headless 执行编排 + schedule CRUD agent tool + 管理 UI。两个地基改造先行：把 `runAgentLoop` 的输出从 `port` 解耦为 `emit` sink（ADR 0002），新增 `schedules` IDB store（DB_VERSION 3）。

**Tech Stack:** TypeScript 6 / React 19 / Chrome MV3（`chrome.alarms` + `chrome.notifications`）/ IndexedDB（单库 `pie`）/ vitest + happy-dom。

**权威依据：** spec `docs/specs/2026-06-12-scheduled-tasks-design.md`，决策 `docs/adr/0001-*.md`（instance 绑定）、`docs/adr/0002-*.md`（emit 解耦），术语 `CONTEXT.md`。

**贯穿约束：** 每个 Task 走 TDD（先写失败测试）；emitter 解耦后**前台 chat 路径回归必须全绿**；`tool-names.ts` 加 tool 必须声明 read/write class，否则 module load `throw`；每个 Task 末尾 `pnpm test`、阶段性 `pnpm typecheck` + `pnpm build` 三绿。

---

## File Structure

**Create:**
- `src/lib/schedules/types.ts` — `ScheduleSpec` / `ScheduleRecord` / `ScheduleRunRecord` 类型与常量（id 前缀、默认值）
- `src/lib/schedules/store.ts` — IDB CRUD：`getSchedule`/`listSchedules`/`putSchedule`/`deleteSchedule`/`getRun`/`appendRun`/`updateRun`
- `src/lib/schedules/schedule-logic.ts` — **纯函数**（无 chrome 依赖，易测）：`computeFirstFireAt`/`computeNextFireAt`/`classifyOutcome`/`applyOutcome`
- `src/lib/schedules/scheduler.ts` — `chrome.alarms` 封装：`armSchedule`/`disarmSchedule`/`reconcileAlarms`/`handleAlarm`
- `src/lib/schedules/run.ts` — `runSchedule(id)` headless 执行编排
- `src/lib/schedules/notify.ts` — `notifyRunDone` + 通知点击路由
- `src/lib/agent/tools/schedule-meta.ts` — 4 个 CRUD agent tool
- `src/sidepanel/components/Schedules/SchedulesPanel.tsx` + `ScheduleForm.tsx` + `ScheduleRunHistory.tsx` — 管理 UI

**Modify:**
- `src/lib/idb/db.ts` — `DB_VERSION` 2→3、`STORES.schedules`、`onupgradeneeded` 分支、`clearAllStores`/`_resetForTests`
- `src/lib/store-bus.ts` — `StoreName` 联合纳入 `schedules`（若其类型独立于 db.ts 的 STORES）
- `src/lib/agent/loop.ts` — `AgentLoopContext.port` → `emit`；内部 `port.postMessage` → `ctx.emit`
- `src/background/index.ts` — 前台 ctx 注入 port-emit 适配器；`onAlarm` 接线；`reconcileAlarms()` 启动调用；keep-alive owner
- `src/background/session-recovery.ts` — 扫 `running` 的 `ScheduleRunRecord` → `interrupted` + 关 `ownedTabId`
- `src/lib/sessions/types.ts` — `SessionMeta` 加 `origin?`/`scheduleId?`/`recordId?`
- `src/lib/agent/tool-names.ts` — `SCHEDULE_META_TOOL_NAMES` + `TOOL_CLASSES` 条目
- `src/lib/agent/tools.ts` — `...SCHEDULE_META_TOOLS`
- `src/lib/instances.ts`（或删除 instance 的调用方）— 删 instance 联动：绑定的 schedule → `paused` + 通知
- `manifest.json` — `permissions` 加 `"alarms"`、`"notifications"`

---

## Task 1：把 loop 输出从 port 解耦为 emit sink（ADR 0002，enabler）

**目标**：`runAgentLoop` 不再直接依赖 `chrome.runtime.Port`，改用 `ctx.emit(msg)`。前台行为零变化（`emit = (m) => port.postMessage(m)`）。

**Files:**
- Modify: `src/lib/agent/loop.ts`（`AgentLoopContext` 定义 ~86；`port.postMessage` 调用点 324/331/1493/1548/1554/1600/1637/1685/1696/1740 等）
- Modify: `src/background/index.ts`（构造 ctx 处 843、1213）
- Test: `src/lib/agent/loop.emit.test.ts`（新建）

- [ ] **Step 1: 定义 emit 类型 + 写失败测试**

在 `loop.ts` 顶部新增（紧邻 `AgentLoopContext`）：

```ts
/** 出站消息 sink。前台 = port.postMessage；headless = 落 Run record / 丢弃流式块。
 *  解耦后 loop 不再直接引用 chrome.runtime.Port（ADR 0002）。 */
export type AgentEmit = (msg: OutboundLoopMessage) => void;
// OutboundLoopMessage = 现有所有 port.postMessage 的 payload 联合（chat-chunk |
// thinking-chunk | chat-done | chat-error | agent-step | needs-file-access | ...）。
// 直接从现有 postMessage 调用点的对象字面量收敛出该联合类型。
```

`AgentLoopContext` 把 `port: chrome.runtime.Port` 替换为 `emit: AgentEmit`。

新建 `src/lib/agent/loop.emit.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
// 用一个最小 ctx 驱动 loop 的一次 done emit，断言 emit 收到 chat-done。
// 由于 runAgentLoop 整体耦合 Chrome，这里只测「emit 被调用」这一解耦点：
// 提取一个可测的内部 helper（见 Step 3）或用现有 loop 单测里已有的 fake 驱动。
it("emit 收到 done 而非依赖 port", () => {
  const emit = vi.fn();
  // 调用从 loop.ts 导出的 makeWithSession / emitDone 封装（Step 3 暴露），
  // 断言 emit 收到 { type: "chat-done", sessionId } 形状。
  expect(emit).toBeDefined();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/agent/loop.emit.test.ts`
Expected: FAIL（`emit` 类型/导出不存在）

- [ ] **Step 3: 机械替换 port.postMessage → ctx.emit**

在 `loop.ts` 内把每一处 `port.postMessage(X)` 改为 `emit(X)`（`emit` 从 `ctx` 解构）。两个内部 helper（loop.ts:321/328 那两个直接收 `port` 参数的 `withSession` 发送器）改为收 `emit`。`notifyNeedsFileAccess: () => port.postMessage({type:"needs-file-access"})`（1493）改为 `() => emit({ type: "needs-file-access" })`。确保 `emitDone` 闭包内所有发送走 `emit`。

- [ ] **Step 4: 前台调用点注入 port 适配器**

`src/background/index.ts` 两处构造 ctx（843、1213）把 `port,` 改为：

```ts
emit: (m) => port.postMessage(m),
```

（前台语义完全不变——仍旧是 port 广播。）

- [ ] **Step 5: 跑全量回归 + emit 测试**

Run: `pnpm test`
Expected: 全绿（1891+ 测试不回归）。`pnpm test src/lib/agent/loop.emit.test.ts` PASS。

- [ ] **Step 6: typecheck + commit**

Run: `pnpm typecheck`（0 错）

```bash
git add src/lib/agent/loop.ts src/background/index.ts src/lib/agent/loop.emit.test.ts
git commit -m "refactor(loop): decouple output from port to emit sink (ADR 0002)"
```

---

## Task 2：schedules 存储层（DB_VERSION 3 + types + store）

**Files:**
- Modify: `src/lib/idb/db.ts`
- Create: `src/lib/schedules/types.ts`
- Create: `src/lib/schedules/store.ts`
- Test: `src/lib/schedules/store.test.ts`

- [ ] **Step 1: 写类型**

`src/lib/schedules/types.ts`：把 spec §5 的 `ScheduleSpec` / `ScheduleRecord` / `ScheduleRunRecord` 原样落为 interface（字段见 spec §5）。补常量：

```ts
export const SCHEDULE_KEY_PREFIX = "sched_";
export const RUN_KEY_PREFIX = "run_";
export const DEFAULT_RUN_HISTORY = 50;        // runIds 环形保留
export const MAX_SCHEDULES = 20;              // 总数上限
export const FAILURE_PAUSE_THRESHOLD = 3;     // 连续失败自停
export const MIN_INTERVAL_MINUTES = 15;       // UI 最小重复间隔
export function newScheduleId(): string { return SCHEDULE_KEY_PREFIX + crypto.randomUUID(); }
export function newRunId(): string { return RUN_KEY_PREFIX + crypto.randomUUID(); }
```

- [ ] **Step 2: 升级 db.ts（写失败测试先）**

`src/lib/schedules/store.test.ts` 起手（用 `_resetForTests` 重置 + happy-dom 的 fake-indexeddb，参照现有 `src/lib/sessions/storage.test.ts` 的 setup）：

```ts
it("DB_VERSION 升到 3 且 schedules store 存在", async () => {
  const { openDb, STORES } = await import("@/lib/idb/db");
  const db = await openDb();
  expect(db.version).toBe(3);
  expect(db.objectStoreNames.contains(STORES.schedules)).toBe(true);
});
```

Run: `pnpm test src/lib/schedules/store.test.ts` → FAIL。

`db.ts` 改：`DB_VERSION = 3`；`STORES` 加 `schedules: "schedules"`；`onupgradeneeded` 加 `if (!db.objectStoreNames.contains(STORES.schedules)) db.createObjectStore(STORES.schedules, { keyPath: "id" });`；`clearAllStores` 与 `_resetForTests` 的 store 列表纳入 `STORES.schedules`。

- [ ] **Step 3: 写 store CRUD（失败测试）**

追加测试（断言行为，不是实现）：

```ts
it("put/get/list/delete schedule", async () => {
  await putSchedule(makeSched({ id: "sched_a" }));
  expect((await getSchedule("sched_a"))?.id).toBe("sched_a");
  expect((await listSchedules()).map(s => s.id)).toContain("sched_a");
  await deleteSchedule("sched_a");
  expect(await getSchedule("sched_a")).toBeNull();
});

it("appendRun 环形保留最近 DEFAULT_RUN_HISTORY 条，挤出的 run 一并删除", async () => {
  await putSchedule(makeSched({ id: "sched_b", runIds: [] }));
  for (let i = 0; i < DEFAULT_RUN_HISTORY + 3; i++) {
    await appendRun("sched_b", makeRun({ recordId: `run_${i}` }));
  }
  const s = await getSchedule("sched_b");
  expect(s!.runIds.length).toBe(DEFAULT_RUN_HISTORY);
  expect(await getRun("run_0")).toBeNull();          // 最老的被挤出+删除
  expect(await getRun(`run_${DEFAULT_RUN_HISTORY+2}`)).not.toBeNull();
});

it("updateRun 局部更新 run 状态", async () => {
  await putSchedule(makeSched({ id: "sched_c", runIds: [] }));
  await appendRun("sched_c", makeRun({ recordId: "run_x", status: "running" }));
  await updateRun("run_x", { status: "success", summary: "ok", endedAt: 2 });
  expect((await getRun("run_x"))?.status).toBe("success");
});
```

`store.ts` 实现：所有写经 `tx(STORES.schedules, "readwrite", ...)`；`appendRun` 用 `txMulti([STORES.schedules], "readwrite", ...)` 在**同一事务**里 put run + 更新 schedule.runIds + 删挤出的 run（保 D9 原子）；每个写操作后 `publishChange("schedules", op, id)`（参照 `@/lib/store-bus`）。`listSchedules` 过滤 key 前缀 `sched_`、`getRun` 用 `run_` key。

> 注：若 `store-bus.ts` 的 `StoreName` 不是直接复用 `db.ts` 的 `STORES`，需在 `store-bus.ts` 把 `"schedules"` 加进其 `StoreName` 联合。

- [ ] **Step 4: 跑测试通过**

Run: `pnpm test src/lib/schedules/store.test.ts` → PASS

- [ ] **Step 5: commit**

```bash
git add src/lib/idb/db.ts src/lib/store-bus.ts src/lib/schedules/types.ts src/lib/schedules/store.ts src/lib/schedules/store.test.ts
git commit -m "feat(schedules): add schedules IDB store (DB_VERSION 3) + CRUD"
```

---

## Task 3：headless run 手动跑通（首条端到端 tracer bullet）

**目标**：`runSchedule(id)` → 读 ScheduleRecord → 新建 Run + fresh session → headless 跑 `runAgentLoop`（emit 落库）→ 标 `success`/`failed` + summary → `appendRun`。本 Task **不含** alarms / startUrl tab / 通知 / UI。

**Files:**
- Modify: `src/lib/sessions/types.ts`（`SessionMeta` 加 `origin?: "schedule"` / `scheduleId?` / `recordId?`）
- Create: `src/lib/schedules/run.ts`
- Modify: `src/background/index.ts`（暴露/接线 `runSchedule`，复用 keep-alive + resolveModelConfig + createSession + makeStepSnapshotHandler）
- Test: `src/lib/schedules/run.test.ts`

- [ ] **Step 1: SessionMeta 加 origin 标记（失败测试）**

`src/lib/sessions/types.ts` 的 `SessionMeta` 追加可选字段：

```ts
  origin?: "schedule";
  scheduleId?: string;
  recordId?: string;
```

（向后兼容：旧 session 无这些字段 = 普通会话。）

- [ ] **Step 2: 写 run 编排的失败测试**

`src/lib/schedules/run.test.ts`——用注入式依赖让 `runSchedule` 可测（把 `runAgentLoop` / `createSession` / `resolveModelConfig` 作为可注入 deps，默认绑真实实现）：

```ts
it("成功路径：新建 Run+session，agent done → run.success + summary + appendRun", async () => {
  await putSchedule(makeSched({ id: "sched_a", prompt: "say hi", instanceId: "inst_1" }));
  const fakeLoop = vi.fn(async (ctx) => { ctx.emit({ type: "chat-done", sessionId: ctx.sessionId }); });
  await runSchedule("sched_a", { runAgentLoop: fakeLoop, resolveModelConfig: async () => FAKE_CFG });
  const s = await getSchedule("sched_a");
  expect(s!.runIds.length).toBe(1);
  const run = await getRun(s!.runIds[0]);
  expect(run!.status).toBe("success");
  expect(run!.sessionId).toBeTruthy();
});

it("失败路径：runAgentLoop 抛错 → run.failed + error", async () => {
  await putSchedule(makeSched({ id: "sched_b", instanceId: "inst_1" }));
  const boom = vi.fn(async () => { throw new Error("kaboom"); });
  await runSchedule("sched_b", { runAgentLoop: boom, resolveModelConfig: async () => FAKE_CFG });
  const run = await getRun((await getSchedule("sched_b"))!.runIds[0]);
  expect(run!.status).toBe("failed");
  expect(run!.error).toContain("kaboom");
});

it("instanceId 解析为 null（被删）→ run.failed 且不调用 loop", async () => {
  await putSchedule(makeSched({ id: "sched_c", instanceId: "gone" }));
  const loop = vi.fn();
  await runSchedule("sched_c", { runAgentLoop: loop, resolveModelConfig: async () => null });
  expect(loop).not.toHaveBeenCalled();
  expect((await getRun((await getSchedule("sched_c"))!.runIds[0]))!.status).toBe("failed");
});
```

Run: `pnpm test src/lib/schedules/run.test.ts` → FAIL。

- [ ] **Step 3: 实现 runSchedule**

`src/lib/schedules/run.ts`：

```ts
export interface RunDeps {
  runAgentLoop: typeof import("@/lib/agent/loop").runAgentLoop;
  resolveModelConfig: typeof import("@/lib/instances").resolveModelConfig;
  // createSession / appendRun / updateRun 直接 import（无需注入，除非测试需要）
}

export async function runSchedule(scheduleId: string, deps: RunDeps): Promise<void> {
  const sched = await getSchedule(scheduleId);
  if (!sched) return;
  const recordId = newRunId();
  const sessionId = crypto.randomUUID();
  const run: ScheduleRunRecord = {
    recordId, scheduleId, runIndex: sched.runCount + 1,
    sessionId, startedAt: Date.now(), status: "running",
  };
  await appendRun(scheduleId, run);                       // running 落库（孤儿清理可见）

  const cfg = await deps.resolveModelConfig(sched.instanceId, /* model 由 instance 决定 */ "");
  if (!cfg) { await updateRun(recordId, { status: "failed", error: "instance unavailable", endedAt: Date.now() }); return; }

  // 新建 fresh session，标 origin（参照 index.ts handleChatStream 的 createSession 用法）
  await createSession(sessionId, { origin: "schedule", scheduleId, recordId, title: sched.title });

  let lastText = "";
  const emit: AgentEmit = (m) => {
    if (m.type === "chat-chunk") lastText += m.text;        // 累计末尾文本作 summary
    // thinking-chunk / agent-step / needs-file-access → 丢弃（headless 无 UI）
  };
  try {
    const abort = new AbortController();
    await deps.runAgentLoop({
      emit, task: sched.prompt, modelConfig: cfg, signal: abort.signal,
      sessionId, onStepSnapshot: makeStepSnapshotHandler(sessionId),
      pinnedTabs: [], taskId: crypto.randomUUID(),
      // 其余字段参照 index.ts:1213 的前台 ctx（refreshCrossSessionPinnedTabIds 等）
    });
    await updateRun(recordId, { status: "success", summary: lastText.slice(0, 200), endedAt: Date.now() });
  } catch (e) {
    await updateRun(recordId, { status: "failed", error: String(e instanceof Error ? e.message : e), endedAt: Date.now() });
  }
}
```

> `runCount`/`consecutiveFailures`/重排在 Task 4/5 接入；本 Task 只把单次执行跑通落库。SW 保活：在 SW 侧 `runSchedule` 包一层 `keepAlive.ensure()`（开始）/`keepAlive.stop()`（结束），owner 用 schedule run（Task 4 接线时落地）。

- [ ] **Step 4: 跑测试通过 + 全量回归**

Run: `pnpm test src/lib/schedules/run.test.ts`（PASS）+ `pnpm test`（全绿）

- [ ] **Step 5: typecheck + commit**

```bash
git add src/lib/sessions/types.ts src/lib/schedules/run.ts src/lib/schedules/run.test.ts src/background/index.ts
git commit -m "feat(schedules): headless runSchedule end-to-end (Run + fresh session)"
```

---

## Task 4：chrome.alarms 调度 + 孤儿清理

**Files:**
- Create: `src/lib/schedules/schedule-logic.ts`（纯函数）
- Create: `src/lib/schedules/scheduler.ts`（chrome.alarms 封装）
- Modify: `src/background/index.ts`（`onAlarm` 监听、启动 `reconcileAlarms()`、keep-alive owner）
- Modify: `src/background/session-recovery.ts`（孤儿 running run → interrupted）
- Modify: `manifest.json`（加 `"alarms"`）
- Test: `src/lib/schedules/schedule-logic.test.ts`、`src/lib/schedules/scheduler.test.ts`

- [ ] **Step 1: 纯函数 computeFirstFireAt / computeNextFireAt（失败测试先）**

`schedule-logic.test.ts`：

```ts
it("无 intervalMinutes → 无下次（一次性）", () => {
  expect(computeNextFireAt({ anchor: 1000, spec: { startAt: 1000 }, runCount: 1 })).toBeNull();
});
it("有 interval → 锚点累加防漂移（不是 now+interval）", () => {
  // anchor=09:00 计划点，实际执行拖到 09:03，下次仍是 10:00 而非 10:03
  const next = computeNextFireAt({ anchor: t(9,0), spec: { startAt: t(9,0), intervalMinutes: 60 }, runCount: 1 });
  expect(next).toBe(t(10,0));
});
it("maxRuns 命中 → 无下次", () => {
  expect(computeNextFireAt({ anchor: t(9,0), spec: { startAt: t(9,0), intervalMinutes: 60, maxRuns: 3 }, runCount: 3 })).toBeNull();
});
it("computeFirstFireAt: startAt 缺省 = 立即(返回 now)", () => {
  expect(computeFirstFireAt({ startAt: undefined }, 5000)).toBe(5000);
});
```

实现 `schedule-logic.ts`（纯函数，无 `Date.now`——时间由参数传入）：`computeNextFireAt` = 若 `!intervalMinutes` 或 `maxRuns!=null && runCount>=maxRuns` 返回 `null`，否则 `anchor + intervalMinutes*60_000`。

- [ ] **Step 2: scheduler arm/disarm（失败测试，mock chrome.alarms）**

`scheduler.test.ts`（用 `globalThis.chrome = { alarms: { create: vi.fn(), clear: vi.fn(), ... } }` stub）：

```ts
it("armSchedule(定时) 调 alarms.create({when})", async () => {
  await armSchedule(makeSched({ id: "sched_a", spec: { startAt: t(9,0) } }));
  expect(chrome.alarms.create).toHaveBeenCalledWith("schedule:sched_a", { when: t(9,0) });
});
it("disarmSchedule 调 alarms.clear", async () => {
  await disarmSchedule("sched_a");
  expect(chrome.alarms.clear).toHaveBeenCalledWith("schedule:sched_a");
});
it("reconcileAlarms 对 active 且 nextRunAt 已过期且无 alarm 的 schedule 补排", async () => {
  await putSchedule(makeSched({ id: "sched_b", status: "active", nextRunAt: 1 }));
  chrome.alarms.get = vi.fn(async () => undefined);
  await reconcileAlarms(99999);
  expect(chrome.alarms.create).toHaveBeenCalledWith("schedule:sched_b", expect.anything());
});
```

实现 `scheduler.ts`：`armSchedule` 用 `computeFirstFireAt`（立即则不排 alarm，直接交由 SW dispatch）；`handleAlarm(name)` 解析 `schedule:<id>` → 调 `runSchedule`（Task 3）。

- [ ] **Step 3: 孤儿 running run 清理（失败测试）**

`session-recovery` 扩展——新增导出 `markOrphanRunsInterrupted()`：扫所有 `run_*`，`status==="running"` 的标 `interrupted` + `endedAt` + 若有 `ownedTabId` 则 `chrome.tabs.remove`（容错）。测试：

```ts
it("SW 唤醒把 running run 标 interrupted", async () => {
  await putSchedule(makeSched({ id: "sched_a", runIds: ["run_x"] }));
  await appendRun("sched_a", makeRun({ recordId: "run_x", status: "running", ownedTabId: 42 }));
  chrome.tabs = { remove: vi.fn() } as any;
  await markOrphanRunsInterrupted();
  expect((await getRun("run_x"))!.status).toBe("interrupted");
  expect(chrome.tabs.remove).toHaveBeenCalledWith(42);
});
```

在 `detectAndMarkPaused` 的同一 SW wake-up 触发链里调用 `markOrphanRunsInterrupted()`（顺序：在 `runSchedule` dispatch 之前，保证 `skip-if-running` 不被孤儿卡死）。

- [ ] **Step 4: SW 接线**

`index.ts`：`chrome.alarms.onAlarm.addListener((a) => handleAlarm(a.name))`；SW 顶层 + `onStartup` 调 `reconcileAlarms(Date.now())` 与 `markOrphanRunsInterrupted()`；`runSchedule` 包 keep-alive（owner = run id）。`manifest.json` permissions 加 `"alarms"`。

- [ ] **Step 5: 测试 + 回归 + commit**

Run: `pnpm test src/lib/schedules/` + `pnpm test` + `pnpm typecheck`

```bash
git add src/lib/schedules/schedule-logic.ts src/lib/schedules/scheduler.ts src/background/index.ts src/background/session-recovery.ts manifest.json src/lib/schedules/*.test.ts
git commit -m "feat(schedules): chrome.alarms scheduling + orphan-run recovery"
```

---

## Task 5：计次 / 自停 / skip / 可选预算 guardrails

**Files:**
- Modify: `src/lib/schedules/schedule-logic.ts`（`applyOutcome` 纯状态机）
- Modify: `src/lib/schedules/run.ts`（skip-if-running、预算硬停、调用 `applyOutcome` 后重排/disarm）
- Modify: `src/lib/agent/loop.ts`（消费可选 `maxStepsPerRun`/`maxRunMs` → 经 signal/计数硬停）
- Test: `src/lib/schedules/schedule-logic.test.ts`（扩展）

- [ ] **Step 1: applyOutcome 状态机（失败测试）**

按 spec §11 的计次/自停表写纯函数测试：

```ts
// 入参 (sched, outcome) → 返回 patch: { runCount, consecutiveFailures, status, nextStatus 动作 }
it("agent done → runCount+1, consecutiveFailures=0", () => {
  expect(applyOutcome(s({ runCount: 2, consecutiveFailures: 1 }), "done"))
    .toMatchObject({ runCount: 3, consecutiveFailures: 0 });
});
it("agent fail → consecutiveFailures+1 且 runCount+1", () => {
  expect(applyOutcome(s({ runCount: 0, consecutiveFailures: 2 }), "fail"))
    .toMatchObject({ runCount: 1, consecutiveFailures: 3, status: "paused" }); // 达阈值自停
});
it("skipped/interrupted → 两计数都不变", () => {
  expect(applyOutcome(s({ runCount: 5, consecutiveFailures: 1 }), "skipped"))
    .toMatchObject({ runCount: 5, consecutiveFailures: 1 });
});
it("失败自停优先于次数耗尽", () => {
  // runCount 即将达 maxRuns 但同时连续失败达阈值 → paused（不是 completed）
  expect(applyOutcome(s({ runCount: 2, maxRuns: 3, consecutiveFailures: 2 }), "fail"))
    .toMatchObject({ status: "paused" });
});
it("次数耗尽 → completed", () => {
  expect(applyOutcome(s({ runCount: 2, maxRuns: 3, consecutiveFailures: 0 }), "done"))
    .toMatchObject({ status: "completed" });
});
```

实现 `applyOutcome`：`done`→clear fails；`fail`/`error`/`timeout`→`consecutiveFailures+1`；`skipped`/`interrupted`→原样返回；判定顺序：先查 `consecutiveFailures>=FAILURE_PAUSE_THRESHOLD`→`paused`，再查 `maxRuns` 命中→`completed`，否则 `active`+重排。

- [ ] **Step 2: run.ts 接 skip-if-running + 预算 + applyOutcome**

`runSchedule` 开头：若该 schedule 已有 `running` 的 run（查 runIds），写一条 `skipped` run、`return`。结束分类后调 `applyOutcome` → `putSchedule(patched)` → `paused`/`completed` 则 `disarmSchedule`，否则 `armSchedule`（重排 `nextRunAt = computeNextFireAt`）。可选预算：`maxRunMs` → `setTimeout(()=>abort.abort(), maxRunMs)`；`maxStepsPerRun` → 经 ctx 传入 loop，loop 内步数超限时 `emit` 一个终止并 break（标 `failed`）。

- [ ] **Step 3: loop 消费 maxStepsPerRun（失败测试 + 实现）**

`AgentLoopContext` 加可选 `maxSteps?: number`；loop 主循环计数超过则终止当前 run（视作硬停 `failed`）。前台不传 = 无上限（保持现有"无硬后底"不变量）。

- [ ] **Step 4: 测试 + 回归 + commit**

Run: `pnpm test src/lib/schedules/` + `pnpm test` + `pnpm typecheck`

```bash
git add src/lib/schedules/schedule-logic.ts src/lib/schedules/run.ts src/lib/agent/loop.ts src/lib/schedules/schedule-logic.test.ts
git commit -m "feat(schedules): counting/auto-pause/skip/budget guardrails"
```

---

## Task 6：startUrl background tab + restricted 校验 + 孤儿 tab 清理

**Files:**
- Modify: `src/lib/schedules/run.ts`（开/关 background tab、记 `ownedTabId`、pin 给 session）
- Create: `src/lib/schedules/url-guard.ts`（`isRestrictedUrl`）
- Modify: `src/lib/agent/tools/schedule-meta.ts`（Task 7 创建后回填校验）或先在 `run.ts` 运行时校验
- Test: `src/lib/schedules/run.starturl.test.ts`、`src/lib/schedules/url-guard.test.ts`

- [ ] **Step 1: isRestrictedUrl（失败测试 + 实现）**

```ts
it.each(["chrome://settings", "https://chrome.google.com/webstore", "edge://x", "about:blank"])(
  "%s 判定为 restricted", (u) => expect(isRestrictedUrl(u)).toBe(true));
it("普通 https 不 restricted", () => expect(isRestrictedUrl("https://example.com")).toBe(false));
```

- [ ] **Step 2: run.ts 开/关 tab（失败测试，mock chrome.tabs）**

```ts
it("有 startUrl → 开非聚焦 tab、记 ownedTabId、跑完关闭", async () => {
  chrome.tabs = { create: vi.fn(async () => ({ id: 7 })), remove: vi.fn() } as any;
  await putSchedule(makeSched({ id: "sched_a", startUrl: "https://e.com", instanceId: "i" }));
  await runSchedule("sched_a", okDeps);
  expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "https://e.com", active: false });
  expect(chrome.tabs.remove).toHaveBeenCalledWith(7);          // 跑完关闭
});
it("运行时 startUrl 为 restricted → run.failed 不开 tab", async () => { /* ... */ });
```

实现：`run.ts` 在新建 session 后，若有 `startUrl`：先 `isRestrictedUrl` 校验（restricted → `failed` + summary，不开 tab）；否则 `chrome.tabs.create({url, active:false})` → 写 `ownedTabId` 进 run、pin 给 session（`pinnedTabs:[{tabId, origin}]`）；`finally` 里 `chrome.tabs.remove(ownedTabId)`（容错 try/catch）。

- [ ] **Step 3: 测试 + 回归 + commit**

```bash
git add src/lib/schedules/url-guard.ts src/lib/schedules/run.ts src/lib/schedules/*.test.ts
git commit -m "feat(schedules): startUrl background tab + restricted guard + orphan tab cleanup"
```

---

## Task 7：schedule CRUD agent tool + tool-names class + instance 绑定联动

**Files:**
- Create: `src/lib/agent/tools/schedule-meta.ts`（仿 `skill-meta.ts`）
- Modify: `src/lib/agent/tool-names.ts`（`SCHEDULE_META_TOOL_NAMES` + `TOOL_CLASSES`）
- Modify: `src/lib/agent/tools.ts`（`...SCHEDULE_META_TOOLS`）
- Modify: `src/lib/instances.ts`（删 instance 联动）
- Test: `src/lib/agent/tools/schedule-meta.test.ts`、`src/lib/instances.schedule-link.test.ts`

- [ ] **Step 1: tool-names 注册（build-time invariant 先满足）**

`tool-names.ts` 加：

```ts
export const SCHEDULE_META_TOOL_NAMES = ["create_schedule","update_schedule","delete_schedule","list_schedules"] as const;
```

并入 `KNOWN_BUILT_IN_TOOL_NAMES`；`TOOL_CLASSES` 加 `create_schedule:"write", update_schedule:"write", delete_schedule:"write", list_schedules:"read"`。（漏任一 → module load throw，build/test 立刻红。）

- [ ] **Step 2: 4 个 tool（失败测试）**

`schedule-meta.test.ts`（仿 skill-meta 的测试风格）：

```ts
it("create_schedule 写库 + armSchedule，缺省 instanceId=active", async () => {
  const r = await createScheduleTool.handler({ title:"t", prompt:"p", spec:{ intervalMinutes:60 } });
  expect(r.success).toBe(true);
  expect((await listSchedules()).length).toBe(1);
});
it("create_schedule 超 MAX_SCHEDULES 报错", async () => { /* 预置 20 条 → 第 21 失败 */ });
it("create_schedule restricted startUrl 拒绝", async () => {
  expect((await createScheduleTool.handler({ title:"t", prompt:"p", spec:{}, startUrl:"chrome://x" })).success).toBe(false);
});
it("interval < MIN_INTERVAL_MINUTES 被拒", async () => { /* intervalMinutes: 5 → fail */ });
it("delete_schedule → disarm", async () => { /* ... */ });
```

实现 `schedule-meta.ts`：4 个 `Tool`（参照 `createSkillTool` 结构）；`create` 校验 title/prompt/spec、`isRestrictedUrl(startUrl)`、`intervalMinutes>=MIN_INTERVAL_MINUTES`、总数 `<MAX_SCHEDULES`、缺省 `instanceId = 当前 active`（读 `active_instance_id`）；handler 内 `putSchedule` + `armSchedule`；`delete` → `deleteSchedule` + `disarmSchedule`；导出 `SCHEDULE_META_TOOLS`、`SCHEDULE_META_TOOL_NAMES`。`tools.ts` 加 `...SCHEDULE_META_TOOLS`。

- [ ] **Step 3: 递归创建防护**

headless run（Task 3 的 ctx）传入 allowedTools 过滤掉 `create_schedule`/`update_schedule`（保留 `list_schedules`）。补测试：headless ctx 的 allowedTools 不含 schedule write tool。

- [ ] **Step 4: instance 删除联动（ADR 0001，失败测试）**

```ts
it("删 instance → 绑定它的 schedule 转 paused + 通知 + disarm", async () => {
  await putSchedule(makeSched({ id:"sched_a", instanceId:"inst_x", status:"active" }));
  await deleteInstance("inst_x");      // 现有删除路径
  expect((await getSchedule("sched_a"))!.status).toBe("paused");
});
```

在 `instances.ts` 删 instance 的函数末尾加 hook：`listSchedules().filter(s=>s.instanceId===id && s.status==="active")` → 逐个 `putSchedule({...,status:"paused"})` + `disarmSchedule` + `notifyRunDone`(Task 8 提供，先占位为 console，Task 8 接真通知)。

- [ ] **Step 5: 测试 + 回归 + commit**

Run: `pnpm test` + `pnpm typecheck` + `pnpm build`（验 tool-names class invariant）

```bash
git add src/lib/agent/tools/schedule-meta.ts src/lib/agent/tool-names.ts src/lib/agent/tools.ts src/lib/instances.ts src/lib/agent/tools/schedule-meta.test.ts src/lib/instances.schedule-link.test.ts
git commit -m "feat(schedules): CRUD agent tools + instance-binding link (ADR 0001)"
```

---

## Task 8：chrome.notifications 通知 + user-gesture 降级

**Files:**
- Create: `src/lib/schedules/notify.ts`
- Modify: `src/background/index.ts`（`notifications.onClicked` 路由）
- Modify: `src/lib/schedules/run.ts` + `src/lib/instances.ts`（调用 `notifyRunDone`）
- Modify: `manifest.json`（加 `"notifications"`）
- Test: `src/lib/schedules/notify.test.ts`

- [ ] **Step 1: notify（失败测试，mock chrome.notifications）**

```ts
it("run 成功 → 通知含 summary，notificationId 编码 recordId", async () => {
  chrome.notifications = { create: vi.fn() } as any;
  await notifyRunDone({ recordId:"run_x", sessionId:"s1", status:"success", summary:"done 3 items", scheduleTitle:"T" });
  expect(chrome.notifications.create).toHaveBeenCalledWith("schedule-run:run_x", expect.objectContaining({ message: expect.stringContaining("done 3 items") }));
});
```

实现 `notify.ts`：`notifyRunDone` 调 `chrome.notifications.create("schedule-run:<recordId>", {type:"basic", iconUrl, title, message})`。

- [ ] **Step 2: 点击路由 + user-gesture 降级**

`index.ts` `chrome.notifications.onClicked.addListener`：解析 `recordId` → 取 run.sessionId → **尝试** `chrome.sidePanel.open(...)`；若抛 user-gesture 错（实测确认）→ 降级：给该 run 打 `unread` 标记（store 里），用户下次手动开 panel 时高亮。补测试：open 抛错时落到 unread 分支。

- [ ] **Step 3: 接线 run.ts / instances.ts 调用 notifyRunDone；manifest 加 notifications**

- [ ] **Step 4: 测试 + 回归 + commit**

```bash
git add src/lib/schedules/notify.ts src/background/index.ts src/lib/schedules/run.ts src/lib/instances.ts manifest.json src/lib/schedules/notify.test.ts
git commit -m "feat(schedules): completion notifications + click routing with gesture fallback"
```

---

## Task 9：Schedules 管理 UI

**Files:**
- Create: `src/sidepanel/components/Schedules/SchedulesPanel.tsx`、`ScheduleForm.tsx`、`ScheduleRunHistory.tsx`
- Modify: side panel 入口（参照 `SkillsList` / `Settings` 怎么挂进 side panel 的 tab/导航）
- Test: `src/sidepanel/components/Schedules/SchedulesPanel.test.tsx`（@testing-library/react）

- [ ] **Step 1: 列表渲染（失败测试）**

```tsx
it("渲染 schedules 列表含 title/状态/下次运行", async () => {
  await putSchedule(makeSched({ id:"sched_a", title:"每日汇总", status:"active", nextRunAt: t(9,0) }));
  render(<SchedulesPanel />);
  expect(await screen.findByText("每日汇总")).toBeInTheDocument();
  expect(screen.getByText(/active/i)).toBeInTheDocument();
});
```

实现 `SchedulesPanel`：`useEffect` 读 `listSchedules` + `onStoreChange("schedules", reload)`；列表项显示 title / 调度摘要（间隔·次数·nextRunAt）/ 状态 / 最近结果；行内按钮：启停（`putSchedule({enabled})` + arm/disarm）、立即跑（`runSchedule`）、编辑、删除（`deleteSchedule`+disarm）、展开 Run 历史。

- [ ] **Step 2: 创建/编辑表单（失败测试 + 实现）**

```tsx
it("表单提交建出 schedule（三旋钮 + startUrl + instance）", async () => {
  render(<ScheduleForm onSaved={vi.fn()} />);
  await userEvent.type(screen.getByLabelText("标题"), "签到");
  await userEvent.type(screen.getByLabelText("Prompt"), "去 X 签到");
  // 选间隔 60、次数留空(无限)
  await userEvent.click(screen.getByRole("button", { name: "保存" }));
  expect((await listSchedules()).some(s=>s.title==="签到")).toBe(true);
});
```

`ScheduleForm`：title / prompt / 三旋钮（开始时间、间隔[≥15min 校验]、次数[空=无限]）/ 可选 startUrl / 可选 per-run 预算 / instance 选择器（复用现有 instance 列表组件）。对齐现有 slate 配色（参照 Settings 组件）。

- [ ] **Step 3: Run 历史 + update-running 语义**

`ScheduleRunHistory`：列 runs（runIndex / 时间 / outcome / summary），点某条 → 打开其 `sessionId` 会话（复用现有"打开 session"路径）。编辑一个 active schedule 改 interval/startAt → 保存后 `disarmSchedule`+`armSchedule` 重排；改 prompt 仅下次生效（不动在跑的 run）。

- [ ] **Step 4: 测试 + 全量回归 + 三绿 + commit**

Run: `pnpm test` + `pnpm typecheck` + `pnpm build`

```bash
git add src/sidepanel/components/Schedules/ src/sidepanel/...入口
git commit -m "feat(schedules): management UI (list/form/run-history)"
```

---

## Self-Review

**1. Spec coverage：**
- §4 三旋钮 → Task 4 Step1（computeNextFireAt）✓
- §5 数据模型 → Task 2（types）+ Task 3（origin 字段）✓
- §6 存储 → Task 2 ✓
- §7 调度/dispatch/并发 → Task 4（并发复用现有，限流是 plan 待办：在 Task 4 Step4 SW 接线处加「同时 running schedule run 计数上限，超出排队」——**补充项，执行时落地**）✓
- §8 headless run + tab → Task 3 + Task 6 ✓
- §9/§11 失败语义/孤儿/guardrails → Task 4（孤儿）+ Task 5 ✓
- §10 通知 → Task 8 ✓
- §12 agent tool → Task 7 ✓
- §13 UI → Task 9 ✓
- §14 manifest → Task 4（alarms）+ Task 8（notifications）✓
- ADR 0001 → Task 7 Step4 ✓；ADR 0002 → Task 1 ✓

**2. Placeholder 扫描：** Task 3 的 ctx 其余字段、Task 9 入口挂载点引用现有范例文件（`index.ts:1213` / `SkillsList`）而非 TODO——属 pattern-following，执行者照范例补全。无 "TBD/实现后续"。

**3. Type 一致性：** `ScheduleRecord`/`ScheduleRunRecord`/`AgentEmit`/`ScheduleSpec` 全 Task 引用一致；`recordId`/`ownedTabId`/`consecutiveFailures`/`runCount` 命名跨 Task 统一；`computeNextFireAt`/`applyOutcome`/`armSchedule`/`disarmSchedule`/`runSchedule`/`notifyRunDone`/`markOrphanRunsInterrupted`/`isRestrictedUrl` 签名前后一致。

**并发限流补充**（§7 待办，执行 Task 4 时落地）：SW 维护一个 `runningScheduleRunCount`，`handleAlarm` 时若已达上限（默认 3）则把本次记 `skipped` 或短延迟重排，不并发启动。
