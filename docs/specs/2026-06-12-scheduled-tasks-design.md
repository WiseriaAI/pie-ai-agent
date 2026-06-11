# Schedule — 定时执行 Agent 任务

> 设计 spec。状态：已 grill 收敛，待进入 planning。
> 日期：2026-06-12
> 相关决策：[ADR 0001](../adr/0001-schedule-binds-to-instance-at-creation.md)（绑定 instance）、[ADR 0002](../adr/0002-decouple-loop-output-from-port-to-emitter.md)（loop 输出解耦为 emitter）。术语见根目录 `CONTEXT.md`。

## 1. 这是什么

让 Pie 能**按周期自动跑一个完整的常规 agent 任务**。用户给一段 prompt + 调度参数，Pie 到点就在后台用与手动 chat 完全相同的能力去执行，跑完通知用户、结果落进一个 session 供回看，且每次执行留下一条可寻址的执行记录。

命名刻意避开 "Loop"：Pie 内部 `loop.ts` / `runAgentLoop` 已经是 agent ReAct loop 的专有概念，再用 Loop 命名定时功能会撞车。整个功能统一叫 **Schedule**（术语对齐见 `CONTEXT.md`）。

### 术语

| 术语 | 含义 |
|---|---|
| **Schedule** | 一条定时计划（一段 prompt + 调度参数）。`ScheduleRecord` 是它的持久化记录。 |
| **Run** | 一条 Schedule 的某次到点执行。`ScheduleRunRecord` 是它的持久化记录，有稳定 `recordId`。 |
| **Session** | 一次 Run 跑出来的聊天会话（复用现有 session 底盘），承载完整对话/产物。 |
| **headless run** | 不依赖 side panel / port 的后台执行路径（本设计新增）。 |

## 2. 核心约束与可行性（已调研确认）

Pie 是纯本地 BYOK 扩展（MV3），**没有服务端**。定时器只能活在浏览器进程里：

- **浏览器没开 → 不能跑。** 硬限制，无法绕过，这是正确的 baseline。补偿：`chrome.alarms` 持久化，错过的触发（浏览器当时没开）会在**下次打开浏览器时补跑一次**。
- **浏览器开着 → 能跑，且与 side panel 是否打开无关。** `chrome.alarms` 的关键特性是 **alarm 到点会主动唤醒已被 Chrome idle（30s）杀掉的 service worker**。这正是"side panel 关着也能跑"的实现基础。

现状（调研结论）：仓库**零后台定时能力**，无 `chrome.alarms` / `chrome.notifications` 使用，manifest 未声明这两个权限；agent loop 由 per-session port 驱动，port disconnect 会立即 abort task。**已核实可复用的底盘**：session 状态机、`runAgentLoop`、ModelConfig 快照、IDB 原子写、多 session 并发（`runningSessionIds` Set + R7 跨 session tab lock）、cold-start recovery（`session-recovery.ts`）。

## 3. 架构总览

三处新增、其余复用：

| 维度 | 现状 | 本设计 |
|---|---|---|
| 触发器 | 无 | `chrome.alarms` + `onAlarm` 监听 → dispatch headless run |
| 存储 | `pie` 库 5 store, `DB_VERSION=2` | 升 `DB_VERSION=3`，加 `schedules` store（存 Schedule + Run 两类记录） |
| 执行路径 | port 驱动，断开即 abort | 新增 headless run（输出走 emitter sink，无 port 也能跑完，见 ADR 0002） |
| 创建/管理 | 无 | schedule CRUD agent tool + 管理 UI |
| 通知 | 仅 side panel UI | `chrome.notifications` |

**实体关系（Schedule 1—N Run 1—1 Session）：**

```
┌──────────────────────────────────────────────┐
│ Schedule  (ScheduleRecord)                     │
│   id, title, prompt                            │
│   startAt? · intervalMinutes? · maxRuns?  ←三旋钮│
│   instanceId (创建时绑定, ADR 0001)              │
│   enabled · status(active/paused/completed)    │
│   runCount · consecutiveFailures · nextRunAt   │
│   runIds[]  ← 指向自己的 Run 记录                │
└───────────────┬────────────────────────────────┘
                │ 1
                │ N
                ▼
┌──────────────────────────────────────────────┐
│ Run  (ScheduleRunRecord)        ← recordId 一等 │
│   recordId · scheduleId · runIndex             │
│   status(running/success/failed/…) · summary   │
│   ownedTabId? ← 后台开的 tab,供孤儿清理          │
│   outputs?  ← 预留给"后续实操作"                  │
└───────────────┬────────────────────────────────┘
                │ 1
                │ 1
                ▼
┌──────────────────────────────────────────────┐
│ Session  (复用现有 session 底盘)                 │
│   sessionId · origin="schedule"                │
│   scheduleId · recordId  ← 反向标记便于回查      │
│   agentMessages / 产物                          │
└──────────────────────────────────────────────┘
```

## 4. 调度模型：三个正交旋钮

不区分 interval/daily（过度设计）。"每天定点" = interval 1440 分钟 + 对齐的 `startAt`：

```ts
interface ScheduleSpec {
  startAt?: number;          // 首次运行时间戳；缺省 = 立即
  intervalMinutes?: number;  // 重复周期；缺省 = 不重复（只跑一次）
  maxRuns?: number;          // 总执行次数上限；缺省 = 无限
}
```

两条无歧义规则：
- **没设 `intervalMinutes` → 强制只跑一次**（等价 `maxRuns=1`）。
- **设了 `intervalMinutes`**：有 `maxRuns` 跑 N 次，没有则无限。

| 语义 | startAt | intervalMinutes | maxRuns | 结果 |
|---|---|---|---|---|
| 只执行一次（立即） | 缺省 | 缺省 | — | 创建后尽快跑 1 次 → `completed` |
| 只执行一次（定时） | 明天 9:00 | 缺省 | — | 明早 9 点跑 1 次 → `completed` |
| 执行特定次数（如 3 次） | 明天 9:00 | 1440 | 3 | 连续 3 天每早 9 点 → `completed` |
| 无限循环 | 立即/指定 | 60 | 缺省 | 每小时跑，直到用户停 |

## 5. 数据模型

```ts
interface ScheduleRecord {
  id: string;                  // "sched_<uuid>"
  title: string;
  prompt: string;
  spec: ScheduleSpec;          // §4 三旋钮
  startUrl?: string;           // 可选：触发时后台打开的起始页面，见 §8
  instanceId: string;          // 绑定的 provider instance（ADR 0001）
  enabled: boolean;            // 用户开关，与 status 正交
  status: "active" | "paused" | "completed";
  maxStepsPerRun?: number;     // 可选 per-run 步数预算，默认不设（见 §11）
  maxRunMs?: number;           // 可选 per-run 时长预算，默认不设
  createdAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  runCount: number;            // 已执行次数（skipped/interrupted 不计、failed 计入）
  consecutiveFailures: number;
  runIds: string[];            // 指向 ScheduleRunRecord，环形保留最近 N 条引用
}

interface ScheduleRunRecord {   // 一等实体，后续操作的稳定锚
  recordId: string;            // "run_<uuid>"  ← 独立于 sessionId
  scheduleId: string;
  runIndex: number;            // 第几次（从 1 起）
  sessionId?: string;          // 1:1 指向这次跑的 session；失败/skipped 可能无
  ownedTabId?: number;         // headless 后台开的 tab，供孤儿清理（§8）
  startedAt: number;
  endedAt?: number;
  status: "running" | "success" | "failed" | "interrupted" | "skipped";
  summary?: string;            // 一句话结果（取自 agent done/最终文本）
  error?: string;
  outputs?: unknown;           // 预留：结构化产出/文件引用，供"后续实操作"
}
```

**instanceId 绑定语义（ADR 0001）**：创建时绑定当刻 active 的 `instanceId`（缺省值；agent/用户可显式指定）。绑的是**引用（id）而非配置快照**——instance 内部 apiKey/model 更新对 Schedule 仍生效（key 轮换不破）。该 instance 被删除 → Schedule 自动转 `paused` + 通知（删 instance 的路径上加联动 hook），不静默回退到别的 instance。

**两层状态，不混：**
- `ScheduleRecord.status`：`active` → `paused`（失败自停 / 用户暂停 / instance 被删）/ `completed`（次数耗尽，终态）。
- `ScheduleRunRecord.status`：`running` / `success` / `failed` / `interrupted`（run 中途 SW 被强杀）/ `skipped`。

**recordId 独立于 sessionId**：record 是 schedule 域的执行账本，session 是聊天域的产物。一次 run 天然产生一个 session（完整产物在里面），record 只 1:1 引用、不重复存内容。后续"针对某次执行做实操作"即锚在 `recordId` 上。

## 6. 存储层

`src/lib/idb/db.ts`：`DB_VERSION` 2→3；`STORES` 加 `schedules: "schedules"`；`onupgradeneeded` 加 `if (!contains) createObjectStore(STORES.schedules, { keyPath: "id" })`；`clearAllStores` 与 `_resetForTests` 同步纳入。

`schedules` store 同时存两类记录，按 key 前缀区分：`sched_*`（ScheduleRecord）与 `run_*`（ScheduleRunRecord）。`ScheduleRecord.runIds` 持有引用列表（环形保留最近 N 条，默认 50）；被挤出的 run record 一并删除。完整 run record 可凭 `recordId` 单独 `get`。

新增 `src/lib/schedules/store.ts`：`getSchedule` / `listSchedules` / `putSchedule` / `deleteSchedule` / `getRun` / `appendRun` / `updateRun`，走 `tx`/`txMulti`（schedule 与其 run 写入同事务，保 D9 原子）。变更通知走 `store-bus`（`publishChange`/`onStoreChange`），管理 UI 实时刷新。

## 7. 调度器与 dispatch

`src/lib/schedules/scheduler.ts`（SW 侧），alarm name = `"schedule:<id>"`：

- `armSchedule(rec)`：定时（`startAt` 指定）→ `chrome.alarms.create({ when: startAt })`；立即（`startAt` 缺省）→ 直接 dispatch 首个 Run。
- **每次跑完手动重排下一次**：`when = 计划锚点 + intervalMinutes`（基于锚点累加，不是 `now + interval`），防执行耗时导致定点漂移。**不用** `periodInMinutes` 自动重复——次数/漂移/skip 全部精确可控。
- `disarmSchedule(id)`：`chrome.alarms.clear`（paused / completed / 删除）。
- `reconcileAlarms()`（SW 顶层 + `onStartup`）：对 `active` schedule，若 `nextRunAt` 已过期且无 alarm，补排（SW 重装/升级丢 alarm、重排链断裂兜底）。
- `chrome.alarms.onAlarm` → 解析 id → `runSchedule(id)`（§8）。

**dispatch 上下文**：每次 Run 都是**独立 session、独立执行**（与触发它的任何前台 loop 无父子关系）。`create_schedule` 在前台 agent loop 内被调用时，"立即执行"的首个 Run 由 tool handler **fire-and-forget** 起一个独立 headless run，不 `await`、不嵌套。是否经 alarm 中转是 plan 阶段实现细节。

**并发**：schedule 的 Run 复用现有多 session 并发机制（sessionId 加进 `runningSessionIds`，R7 lock 自动仲裁跨 session tab 冲突），**不是新机制**。唯一 schedule 特有的「N 个 schedule 撞同一时刻批量唤醒」峰值 → **plan 阶段加一个全局并发上限（同时最多 N 个，超出排队）**，记为 plan 待办。

**最小间隔产品约束**：`chrome.alarms` 技术上支持约 30s 周期，但本功能无人值守、烧用户自己 token，UI 层 `intervalMinutes` 最小允许 **15 分钟**（不暴露更短）；one-shot 不受此限。

## 8. 后台执行路径（headless run）+ tab 策略

新增 `src/lib/schedules/run.ts` + SW 接入。本设计最核心的改造。

1. **新建 Run 记录 + fresh session**：生成 `recordId`，写 `running` 的 ScheduleRunRecord；新建独立 session，标 `origin="schedule"` + `scheduleId` + `recordId`。
2. **tab 上下文**：
   - 有 `startUrl` → `chrome.tabs.create({ url, active: false })` 开**非聚焦 background tab**（不抢焦点），`tabId` 存进 Run record（`ownedTabId`），pin 给 session，agent 在上面跑，**run 结束自动关闭**。
   - 无 `startUrl` → 不开 tab，agent 需要页面自己用工具开。
   - **restricted `startUrl`**（chrome:// / Web Store / 不可注入页）：`create_schedule` 时校验，restricted 直接拒绝创建（早失败）；运行时才变 restricted → 该 Run 标 `failed` + summary 说明。
3. **执行 `runAgentLoop`，输出走 emitter sink（ADR 0002）**：把 `ctx.port` 抽象为 `ctx.emit(msg)`。前台 `emit = port.postMessage`；headless `emit` 丢弃流式 chunk、`done`/`error` 落 Run record。**已核实 loop 控制流不依赖 port inbound**（无 `port.onMessage`、无等用户 confirm 的阻塞、abort 走 `AbortSignal`），所以解耦只动输出去向，loop 推进/终止/中断三要素一字不动。
   - **副作用降级**：需用户当场介入的副作用（如 `needs-file-access`）headless 下 `emit` 丢弃 → 对应 tool 返回 error → agent 自行处理或 `fail`，**不阻塞 loop**。无人值守永不僵死。
   - run 期间 SW 保活：复用 `keep-alive.ts` 心跳，owner 从 port 改为 schedule run id。run 结束 `stop`。
   - headless run 自持一个 `AbortController`，支持用户点停 / `maxRunMs` 超时硬停。
4. **结束**：取 agent 最终 `done`/文本作 `summary`，`updateRun` 落 `success`/`failed`；关闭 `ownedTabId`；发通知；进入 §11 计次/自停判定与重排。
5. **run 中途 SW 被强杀**：见 §11 的孤儿清理——SW 下次唤醒时统一标 `interrupted` 并关闭 `ownedTabId`，不自动 resume 半截 run（下个周期 fresh 重跑）。

## 9. 一次触发的生命周期

```
 创建 Schedule
   └─ armSchedule：按 startAt(或立即) 起首个 Run
        │
        ▼
   status = active ───────────────────────► (用户 pause/删除/instance删) ─► disarm
        │
        │  ⏰ alarm 触发 → runSchedule(id)
        ▼
   enabled 且 status==active？ ──no──► 忽略
        │ yes
        ▼
   已有 running 的 Run？ ──yes──► 记一条 skipped Run（不计 runCount）─► 重排下次
        │ no
        ▼
   新建 Run(recordId) + session，Run.status=running
        │
        ▼
   headless 执行 runAgentLoop（输出走 emit，无 port 不阻塞）
        │
        ├─ agent done ─► Run.success，summary 落库，consecutiveFailures=0
        └─ agent fail / 异常·401·网络 / 硬停超时 ─► Run.failed，consecutiveFailures++
        │
        ▼
   runCount++（success/failed 都计；skipped/interrupted 不计）
        │
        ▼
   判定（失败自停优先于次数耗尽）：
   ┌── consecutiveFailures ≥ 3 ─────► status=paused，disarm，通知
   ├── maxRuns 命中(runCount≥maxRuns)► status=completed，disarm，通知
   └── 否则 ───────────────────────► 重排下次 alarm(when=锚点+interval)，通知
```

## 10. 通知

manifest 加 `notifications` 权限。run 结束 `chrome.notifications.create`（成功/失败 + 一句 `summary`）。

**点击通知打开 session 有 user-gesture 约束**：`chrome.sidePanel.open()` 要求 user gesture，而 `notifications.onClicked` 大概率不算（已知 Chrome 限制，实现时实测确认）。降级：能直接开 panel 就开；不能则把该 Run 标"未读"，用户下次手动开 panel 时高亮定位到它。前台不打扰：side panel 即便开着也不强行跳转。

## 11. Guardrails

**失败 / 计次语义（最终版）：**

| Run 结束情形 | runCount | consecutiveFailures |
|---|---|---|
| agent `done`（正常完成，含"无事可做") | +1 | 清零 |
| agent `fail`（LLM 主动判定失败） | +1 | +1 |
| 异常 / 401 / 网络错 | +1 | +1 |
| 超 `maxRunMs`/`maxStepsPerRun` 硬停 | +1 | +1 |
| `skipped`（重叠） | 不计 | 不计 |
| `interrupted`（SW 被强杀） | 不计 | 不计 |

> **正确用法提示**（写进 tool description + 文档）：监控类任务"这次没什么可做"应让 agent 调 **`done`**（任务成功完成：检查完毕、无新内容），**不要** `fail`。`fail` 保留给"真的失败了"——连续 `fail` 会触发自停，这是有意的：它说明这条 Schedule 的 prompt 在当前环境总是做不成，该停下来等用户看。

**其余 guardrail：**
- **重叠（skip-if-running）**：alarm 触发时若该 schedule 已有 `running` Run，记一条 `skipped` 并跳过，不排队不并发、不计 runCount。
- **失败自停（优先于次数耗尽）**：`consecutiveFailures` 达阈值（默认 **3**）→ `status="paused"` + `disarm` + 通知。成功（agent `done`）清零。
- **次数耗尽**：`runCount ≥ maxRuns` → `status="completed"`（终态）+ `disarm` + 通知。
- **孤儿清理（复用 cold-start recovery，不发明新机制）**：现有 `detectAndMarkPaused` 挂在 **SW top-level wake-up**（注释明确：不能只靠 `onStartup`，SW idle 死后再唤醒不触发它），30s `recoveryGuard` 去重。schedule 孤儿清理挂同一处：每次 SW 唤醒先扫所有 `status='running'` 的 Run → 标 `interrupted` + 关闭其 `ownedTabId`。**因为 alarm 唤醒时 top-level 先跑**，清理必然先于 `runSchedule` → `skip-if-running` 永不被孤儿卡死。
- **可选 per-run 预算（默认关）**：尊重"agent loop 纯 LLM 控制终止、无硬后底"不变量（memory `agent-loop-llm-controlled-termination`）——默认不设。每个 schedule 可选填 `maxStepsPerRun`/`maxRunMs`，填了才生效：超了硬停当前 run + 标 `failed`。
- **递归创建防护**：headless run 内的 agent **不得调用 `create_schedule`/`update_schedule`**（防自我繁殖）。实现：headless run 的 allowedTools 过滤掉 schedule-meta 的 write tool（`list_schedules` 可留）。
- **总数上限**：schedule 总数硬上限（默认 **20**），`create_schedule` 超限报错。
- **安全 / prompt injection 无人值守放大**：遵"和常规 chat 对齐、不限定能力"总原则——**不限制 headless 工具集**。缓解 = 文档警示 + 失败自停 + 可选预算 + 绑定 instance（ADR 0001）。接受残余风险（现有 `untrusted-*` wrapper 防护照常生效）。

## 12. Agent tool（schedule CRUD）

仿 `src/lib/agent/tools/skill-meta.ts`，新增 `src/lib/agent/tools/schedule-meta.ts`，4 个 tool：

- `create_schedule` — `{ title, prompt, spec:{ startAt?, intervalMinutes?, maxRuns? }, startUrl?, instanceId?, maxStepsPerRun?, maxRunMs? }`（缺省 instanceId = 当刻 active）
- `update_schedule` — `{ id, ...patch }`
- `delete_schedule` — `{ id }`
- `list_schedules` — 列出 id/title/spec/enabled/status/nextRunAt/runCount

接入 `tool-names.ts`：加 `SCHEDULE_META_TOOL_NAMES` 进 `KNOWN_BUILT_IN_TOOL_NAMES`，在 `TOOL_CLASSES` 声明 class（`create/update/delete = write`，`list = read`）。**build-time invariant**：tool-names.ts 末尾的 exhaustive check 对未分类新 tool 在 module load 时 throw。handler 返回 `ActionResult`，创建后 `armSchedule`，删除后 `disarmSchedule`。

## 13. 管理 UI

side panel 加 "Schedules" 入口（形态接近现有 Settings tab / SessionDrawer）：

- 列表：title / 调度（间隔·次数·下次运行）/ 状态（active·paused·completed）/ 最近一次结果。
- 操作：启停、立即跑一次（手动触发，测试用）、编辑、删除、展开看 Run 历史（点某条 Run → 打开其 session）。
- 创建/编辑表单：title + prompt + 三旋钮 + 可选 startUrl + 可选 per-run 预算 + instance 选择。
- **update 一个正在 running 的 schedule**：update 只改定义、不动在跑的 Run；改 `interval`/`startAt` → 重排下次 alarm（disarm+arm）；改 prompt 下次生效。

agent tool 与 UI 共用 §6 store + §7 scheduler，互为镜像。

## 14. Manifest 变更

`manifest.json` permissions 加 `"alarms"`、`"notifications"`。无需 `background` / `idle` / `unlimitedStorage`。

## 15. 体验风险（文档/首次创建时告知）

- agent 在 background tab 上用 CDP（键盘/编辑器类工具）→ Chrome 挂"正在调试此浏览器"横幅，后台自动冒出来可能让用户困惑。无法消除，只能说明。
- 后台自动跑消耗用户自己 provider 的 token。失败自停 + 可选预算 + 最小 15 分钟间隔是三道节流。

## 16. 非目标（YAGNI，v1 明确不做）

- 完整 cron 表达式（只做 `intervalMinutes` + `startAt` + `maxRuns`）。
- 累积上下文 / 跨 run 接续对话（每次 fresh session）。
- 多 schedule 链式依赖 / 工作流编排。
- 基于 Run record 的"后续实操作"本身（仅预留 `recordId` + `outputs` 锚点，操作能力另立 spec）。
- 强制硬步数上限（保持 LLM 控制终止，上限可选）。
- 秒级 / 高频触发。

## 17. 测试策略

- `db.ts` 升级：3 版本 onupgradeneeded 幂等、`schedules` store 建出、旧库平滑升级。
- `schedules/store.ts`：两类 CRUD + `appendRun` 环形截断（连带删被挤出 run）+ `getRun` 单独寻址 + store-bus 通知 + 同事务原子。
- `schedules/scheduler.ts`：三旋钮 → alarm 参数（立即/定时首次、锚点累加防漂移、maxRuns 终止、reconcileAlarms 补排断链）、disarm。
- `schedule-meta.ts`：参数校验、总数上限、restricted url 拒绝、`arm/disarm` 联动、tool-names build-time class 不变量。
- emitter 解耦：前台 port 路径回归不变、headless emit 丢弃 chunk / 落 done·error、`needs-file-access` 降级为 tool error 不阻塞。
- headless run：startUrl 开/关 tab + `ownedTabId` 清理、skip-if-running（不计次）、计次/自停语义（agent fail 计入、interrupted/skipped 不计、失败优先于 completed）、可选预算硬停、递归创建被过滤。
- 孤儿清理：SW wake-up 把 `running` Run 标 `interrupted` + 关 `ownedTabId`，先于 runSchedule。
- instance 删 → 绑定的 schedule 转 paused + 通知。
- 全程 `pnpm test` / `pnpm typecheck` / `pnpm build` 三绿。

## 18. 开放问题（v1 已定向，留实现期确认）

- `chrome.sidePanel.open()` 在 `notifications.onClicked` 上的 user-gesture 行为：实现期实测，决定走"直接开"还是"标未读"降级（§10）。
- 批量唤醒全局并发上限的具体数值（§7）：plan 阶段定，默认建议同时 3 个。
- 通知图标：复用扩展现有 icon。
- `startAt`/`intervalMinutes` 锚点时区：用浏览器本地时区，v1 不做时区选择。
