# Schedule — 定时执行 Agent 任务

> 设计 spec。状态：待评审。
> 日期：2026-06-12
> 关联：用户提出"类似 Claude Code loop 的定时执行功能"。

## 1. 这是什么

让 Pie 能**按周期自动跑一个完整的常规 agent 任务**。用户给一段 prompt + 调度参数，Pie 到点就在后台用与手动 chat 完全相同的能力去执行，跑完通知用户、结果落进一个 session 供回看，且每次执行留下一条可寻址的执行记录。

命名刻意避开 "Loop"：Pie 内部 `loop.ts` / `runAgentLoop` 已经是 agent ReAct loop 的专有概念，再用 Loop 命名定时功能会撞车。整个功能统一叫 **Schedule**。

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
- **浏览器开着 → 能跑，且与 side panel 是否打开无关。** `chrome.alarms` 的关键特性是 **alarm 到点会主动唤醒已被 Chrome idle（30s）杀掉的 service worker**。这正是"side panel 关着也能跑"的实现基础，比现有 25s `getPlatformInfo()` keep-alive 心跳（仅在有 in-flight task 时维持、port 断即 abort）可靠得多。

现状（调研结论）：仓库**零后台定时能力**，无 `chrome.alarms` / `chrome.notifications` 使用，manifest 未声明这两个权限；agent loop 由 per-session port 驱动，**port disconnect 会立即 abort task**（`src/background/index.ts` 的 `port.onDisconnect`）。session 状态机、`runAgentLoop`、ModelConfig 快照、IDB 原子写底盘均现成可复用。

## 3. 架构总览

三处新增、其余复用：

| 维度 | 现状 | 本设计 |
|---|---|---|
| 触发器 | 无 | `chrome.alarms` + `onAlarm` 监听 → dispatch headless run |
| 存储 | `pie` 库 5 store, `DB_VERSION=2` | 升 `DB_VERSION=3`，加 `schedules` store（存 Schedule + Run 两类记录） |
| 执行路径 | port 驱动，断开即 abort | 新增 headless run（无 port，可独立跑完） |
| 创建/管理 | 无 | schedule CRUD agent tool + 管理 UI |
| 通知 | 仅 side panel UI | `chrome.notifications` |

**实体关系（Schedule 1—N Run 1—1 Session）：**

```
┌──────────────────────────────────────────────┐
│ Schedule  (ScheduleRecord)                     │
│   id, title, prompt                            │
│   startAt? · intervalMinutes? · maxRuns?  ←三旋钮│
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

不区分 interval/daily（过度设计）。把"什么时候跑"拆成三个独立旋钮，"每天定点" = interval 1440 分钟 + 对齐的 `startAt`，自然涵盖：

```ts
interface ScheduleSpec {
  startAt?: number;          // 首次运行时间戳；缺省 = 立即
  intervalMinutes?: number;  // 重复周期；缺省 = 不重复（只跑一次）
  maxRuns?: number;          // 总执行次数上限；缺省 = 无限
}
```

收敛成两条无歧义规则：
- **没设 `intervalMinutes` → 强制只跑一次**（等价 `maxRuns=1`）。
- **设了 `intervalMinutes`**：有 `maxRuns` 跑 N 次，没有则无限。

覆盖用户要的全部语义：

| 语义 | startAt | intervalMinutes | maxRuns | 结果 |
|---|---|---|---|---|
| 只执行一次（立即） | 缺省 | 缺省 | — | 创建后马上跑 1 次 → `completed` |
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
  instanceId?: string;         // 用哪个 provider instance；缺省跟随 global active
  enabled: boolean;            // 用户开关，与 status 正交
  status: "active" | "paused" | "completed";
  maxStepsPerRun?: number;     // 可选 per-run 步数预算，默认不设（见 §11）
  maxRunMs?: number;           // 可选 per-run 时长预算，默认不设
  createdAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  runCount: number;            // 已执行次数（skipped 不计、failed 计入）
  consecutiveFailures: number;
  runIds: string[];            // 指向 ScheduleRunRecord，环形保留最近 N 条引用
}

interface ScheduleRunRecord {   // 一等实体，后续操作的稳定锚
  recordId: string;            // "run_<uuid>"  ← 独立于 sessionId
  scheduleId: string;
  runIndex: number;            // 第几次（从 1 起）
  sessionId?: string;          // 1:1 指向这次跑的 session；失败/skipped 可能无
  startedAt: number;
  endedAt?: number;
  status: "running" | "success" | "failed" | "interrupted" | "skipped";
  summary?: string;            // 一句话结果（取自 agent done/最终文本）
  error?: string;
  outputs?: unknown;           // 预留：结构化产出/文件引用，供"后续实操作"
}
```

**两层状态，不混：**
- `ScheduleRecord.status`：`active` → `paused`（失败自停 / 用户暂停）/ `completed`（次数耗尽，终态）。
- `ScheduleRunRecord.status`：`running` / `success` / `failed` / `interrupted`（run 中途 SW 被强杀）/ `skipped`。

**recordId 独立于 sessionId**（已定）：record 是 schedule 域的执行账本，session 是聊天域的产物。一次 run 天然产生一个 session（完整产物在里面），record 只 1:1 引用、不重复存内容。独立 id 让未来"一次 run 多 session / 失败无 session"仍有稳定锚。后续"针对某次执行做建议的实操作"即锚在 `recordId` 上 → 找到 session/outputs → 再发起动作。

## 6. 存储层

`src/lib/idb/db.ts`：`DB_VERSION` 2→3；`STORES` 加 `schedules: "schedules"`；`onupgradeneeded` 加 `if (!contains) createObjectStore(STORES.schedules, { keyPath: "id" })`；`clearAllStores` 与 `_resetForTests` 同步纳入新 store。

`schedules` store 同时存两类记录，按 key 前缀区分：`sched_*`（ScheduleRecord）与 `run_*`（ScheduleRunRecord）。`ScheduleRecord.runIds` 持有引用列表（环形保留最近 N 条，默认 50）；被挤出的 run record 一并删除（其 session 按现有 session 保留策略走）。完整 run record 可凭 `recordId` 单独 `get`——这是"一等可寻址"的落点。

新增 `src/lib/schedules/store.ts`：`getSchedule` / `listSchedules` / `putSchedule` / `deleteSchedule` / `getRun` / `appendRun` / `updateRun`，走 `tx`/`txMulti`（schedule 与其 run 的写入同事务，保持 D9 原子）。跨上下文变更通知走现有 `store-bus`（`publishChange` / `onStoreChange`），让管理 UI 实时刷新。

## 7. 调度器

`src/lib/schedules/scheduler.ts`（SW 侧），alarm name = `"schedule:<id>"`：

- `armSchedule(rec)`：
  - 立即（`startAt` 缺省）→ 直接 dispatch 首个 run，不排 alarm。
  - 定时（`startAt` 指定）→ `chrome.alarms.create("schedule:<id>", { when: startAt })`。
- **每次跑完手动重排下一次**：`when = 计划锚点 + intervalMinutes`（基于计划锚点累加，不是 `now + interval`），防止执行耗时导致定点慢慢漂移。**不用** `periodInMinutes` 自动重复——这样次数、漂移、skip 全部精确可控。
- `disarmSchedule(id)`：`chrome.alarms.clear`（paused / completed / 删除时）。
- `reconcileAlarms()`（SW 顶层 + `onStartup`）：对每个 `active` schedule，若 `nextRunAt` 已过期且无 alarm，补排——覆盖 SW 重装/升级后 alarm 丢失、或重排链意外断裂。
- `chrome.alarms.onAlarm` → 解析 id → `runSchedule(id)`（§9）。

**最小间隔产品约束**：`chrome.alarms` 技术上支持约 30s 的周期，但本功能无人值守、烧用户自己的 token，UI 层 `intervalMinutes` 最小允许 **15 分钟**（不暴露更短）。这是省 token / 防滥用的有意默认，只约束"重复周期"；one-shot（不重复）不受此限。

## 8. 后台执行路径（headless run）+ tab 策略

新增 `src/lib/schedules/run.ts` + SW 接入。这是本设计最核心的改造。

1. **新建 Run 记录 + fresh session**：生成 `recordId`，写入 `running` 的 ScheduleRunRecord；新建独立 session（每次独立，不累积），标记 `origin="schedule"` + `scheduleId` + `recordId`，便于回查与 UI 区分。
2. **tab 上下文**：
   - 有 `startUrl` → `chrome.tabs.create({ url, active: false })` 开一个**非聚焦 background tab**（不抢焦点、不打断用户当前页面），pin 给这个 session，agent 在上面跑，**run 结束后自动关闭该 tab**。
   - 无 `startUrl` → 不开 tab，等同"无初始页面"的常规任务，agent 需要页面时自己用工具开。
3. **执行 `runAgentLoop`，但不依赖 port**：
   - chunk/step 回调由 port `postMessage` 改为可选 sink：side panel 恰好打开 → 仍可 attach 看实时进度；关着 → 回调只负责把每步 snapshot 写进 session（持久化照常）。**关键不变量：headless run 不因 "无 port" 而 abort**。
   - run 期间 SW 保活：复用 `src/background/keep-alive.ts` 的心跳机制，owner 从 port 改为 schedule run id（`KeepAlive` 控制器本身与 port 无耦合，只需换触发点）。run 结束 `stop`。
4. **结束**：取 agent 最终 `done`/文本作 `summary`，`updateRun` 落 `success`/`failed`；关闭后台 tab；发通知；进入 §11 的计次/自停判定与重排。
5. **run 期间 SW 被强杀**（keep-alive 兜不住的极端情况）：该 session 落到 `paused`，对应 Run 记录标 `interrupted`。**不自动 resume 半截 run**——schedule 是周期性的，下个周期会重新 fresh 跑，比 resume 半截简单且语义清晰。

## 9. 一次触发的生命周期

```
 创建 Schedule
   └─ armSchedule：按 startAt(或立即) 排首次
        │
        ▼
   status = active ───────────────────────► (用户 pause/删除) ─► disarm
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
   headless 执行 runAgentLoop（无 port 不 abort）
        │
        ├─ 成功 ─► Run.success，summary 落库，consecutiveFailures=0
        └─ 失败 ─► Run.failed，consecutiveFailures++
        │
        ▼
   runCount++（成功/失败都计；skipped 不计）
        │
        ▼
   判定（失败自停优先于次数耗尽）：
   ┌── consecutiveFailures ≥ 3 ─────► status=paused，disarm，通知
   ├── maxRuns 命中(runCount≥maxRuns)► status=completed，disarm，通知
   └── 否则 ───────────────────────► 重排下次 alarm(when=锚点+interval)，通知
```

## 10. 通知

manifest 加 `notifications` 权限。run 结束 `chrome.notifications.create`（成功/失败 + 一句 `summary`）。点击通知 → 打开 side panel 并定位到该 run 的 session（复用现有"打开某 session"路径）。前台不打扰：side panel 即便开着也不强行跳转，只在通知点击时跳。

## 11. Guardrails

- **计次规则（已定）**：`runCount` 中 **`skipped` 不计、`failed` 计入**（否则 `maxRuns=3` 会因失败永远跑不完；且有 consecutiveFailures 兜底）。
- **重叠（skip-if-running）**：alarm 触发时若该 schedule 已有 `running` 的 Run，记一条 `outcome: "skipped"` 的 Run 记录并跳过，不排队不并发，不消耗 `runCount`。
- **失败自停（优先于次数耗尽）**：`consecutiveFailures` 达阈值（默认 **3**）→ `status="paused"` + `disarm` + 通知，即使没到 `maxRuns`。成功一次清零。429/认证错误/异常都计失败，不特判。
- **次数耗尽**：`runCount ≥ maxRuns` → `status="completed"`（终态）+ `disarm` + 通知。
- **可选 per-run 预算（默认关）**：尊重"agent loop 纯 LLM 控制终止、无硬后底"这一既定不变量（见 memory `agent-loop-llm-controlled-termination`）——默认不设上限。每个 schedule 可选填 `maxStepsPerRun` / `maxRunMs`，填了才生效：超了硬停当前 run + 标 `failed` + 通知。给无人值守场景一个**可选**保险。
- **递归创建防护**：headless run 内执行的 agent **不得调用 `create_schedule`/`update_schedule`**（防止定时任务自我繁殖）。实现：headless run 的 allowedTools 过滤掉 schedule-meta 的 write tool（`list_schedules` 可保留）。
- **总数上限**：schedule 总数硬上限（默认 **20**），`create_schedule` 超限报错。
- **用户随时能停**：管理 UI 与 `update_schedule` 都能 disable / delete，立即 `disarmSchedule`。

## 12. Agent tool（schedule CRUD）

仿 `src/lib/agent/tools/skill-meta.ts` 模式，新增 `src/lib/agent/tools/schedule-meta.ts`，4 个 tool：

- `create_schedule` — `{ title, prompt, spec:{ startAt?, intervalMinutes?, maxRuns? }, startUrl?, instanceId?, maxStepsPerRun?, maxRunMs? }`
- `update_schedule` — `{ id, ...patch }`
- `delete_schedule` — `{ id }`
- `list_schedules` — 列出 id/title/spec/enabled/status/nextRunAt/runCount

接入 `tool-names.ts`：加 `SCHEDULE_META_TOOL_NAMES` 进 `KNOWN_BUILT_IN_TOOL_NAMES`，并在 `TOOL_CLASSES` 声明 class（`create/update/delete = write`，`list = read`，与 skill-meta 同理）。**build-time invariant**：tool-names.ts 末尾的 exhaustive check 会对未分类的新 tool 在 module load 时 throw —— 漏分类发不出去。

handler 返回 `ActionResult`，创建后 `armSchedule`，删除后 `disarmSchedule`。

用户原话"做成一个工具"由这组 tool 满足：在 chat 里说"每天早上帮我汇总 X"，agent 调 `create_schedule` 即可。

## 13. 管理 UI

side panel 加一个 "Schedules" 入口（形态接近现有 Settings tab / SessionDrawer，无需新基建）：

- 列表：每条显示 title / 调度（间隔·次数·下次运行）/ 状态（active·paused·completed）/ 最近一次结果。
- 操作：启停开关、立即跑一次（`runSchedule` 手动触发，测试用）、编辑、删除、展开看 Run 历史（点某条 Run → 打开它的 session）。
- 创建/编辑表单：title + prompt + 三旋钮（开始时间 startAt + 间隔 intervalMinutes + 次数 maxRuns）+ 可选 startUrl + 可选 per-run 预算 + instance 选择。

agent tool 与 UI 共用 §6 store + §7 scheduler，互为镜像。

## 14. Manifest 变更

`manifest.json` permissions 加 `"alarms"`、`"notifications"`。无需 `background`（MV3 SW 本就常驻事件）、无需 `idle`、无需 `unlimitedStorage`。

## 15. 体验风险（需在文档/首次创建时告知用户）

- agent 一旦在 background tab 上用 CDP（键盘/编辑器类工具），Chrome 会挂"正在调试此浏览器"的横幅——后台自动冒出来可能让用户困惑。无法消除（手动用也有），只能说明。
- 后台自动跑会消耗用户自己 provider 的 token。失败自停 + 可选预算 + 最小 15 分钟间隔是三道节流。

## 16. 非目标（YAGNI，v1 明确不做）

- 完整 cron 表达式（只做单一 `intervalMinutes` 周期 + `startAt` 锚点 + `maxRuns` 次数）。
- 累积上下文 / 跨 run 接续对话（每次 fresh session）。
- 多 schedule 链式依赖 / 工作流编排。
- 基于 Run record 的"后续实操作"本身（仅预留 `recordId` + `outputs` 锚点，操作能力另立 spec）。
- 强制硬步数上限（保持 LLM 控制终止，上限可选）。
- 秒级 / 高频触发。

## 17. 测试策略

- `db.ts` 升级：3 版本 onupgradeneeded 幂等、`schedules` store 建出、旧库平滑升级。
- `schedules/store.ts`：Schedule/Run 两类 CRUD + `appendRun` 环形截断（连带删被挤出的 run）+ `getRun` 单独寻址 + store-bus 通知 + 同事务原子。
- `schedules/scheduler.ts`：三旋钮 → alarm 参数（立即/定时首次、锚点累加重排防漂移、maxRuns 终止、reconcileAlarms 补排断链）、disarm。
- `schedule-meta.ts` tool：参数校验、总数上限、`armSchedule`/`disarmSchedule` 联动；tool-names build-time class 不变量通过。
- headless run：无 port 不 abort、startUrl 开/关 tab、skip-if-running（不计次）、计次规则（failed 计入/skipped 不计）、失败自停优先于次数耗尽、completed 终态、可选预算硬停、递归创建被过滤、interrupted 标记。
- 通知点击 → 定位 session。
- 全程 `pnpm test` / `pnpm typecheck` / `pnpm build` 三绿（build-time invariants 在 tool-names.ts / tools.ts 会 throw）。

## 18. 开放问题

- `startAt` / `intervalMinutes` 锚点时区：用浏览器本地时区，v1 不做时区选择。
- 通知图标：复用扩展现有 icon。
- Run record 保留条数（默认 50）与 session 清理的衔接：v1 从简（挤出即删 run record，session 走现有保留策略），如不够再调。
