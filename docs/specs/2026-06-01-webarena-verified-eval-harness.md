# WebArena-Verified 评测 Harness — 设计 Spec

Date: 2026-06-01
Status: Approved design (待 plan)
Slug: webarena-verified-eval-harness

> 取代并修正 `docs/plans/2026-05-31-browsergym-eval-integration.md`(Codex 草案)。该草案有两个致命问题:
> ① artifact 的 `status` 取自 agent 自报的 `done`/`fail`,**不是客观 ground-truth**;② 架构骑墙——既想让扩展驱动真实 Chrome、又想"start BrowserGym environment",而 BrowserGym 自己起 Playwright、不能 attach 外部浏览器、reward 只来自 `env.step()`,二者互斥。本 spec 用 webarena-verified 的离线确定性评估器一并解掉这两点。

---

## 1. Context

### 1.1 形态约束(为什么不直接接 BrowserGym)

Pie 是 MV3 Chrome 扩展,agent **自己驱动**真实浏览器(LLM 调 `read_page` 观测、调 `click`/CDP 执行)。BrowserGym 是反转控制权的 Python 环境:**env 拥有浏览器**,agent 只是 `obs→action` 策略,reward 来自 `env.step(action)`。已 web 核实(2026-06-01):

- BrowserGym 用 `gym.make()` 内部起并管理自己的 Playwright Chromium,**无 attach 外部浏览器的 API**。
- Agent 严格 `obs, reward, terminated, truncated, info = env.step(action)`,action 用 `bid` 标号。

→ 直接接 BrowserGym(称"路径 A")需要 Node↔Python 桥 + obs/action 双向翻译层,且 BrowserGym 的 AXTree ≠ 真实 Chrome DOM,可能系统性低估 Pie 真实能力。本项目选 **路径 B:让 Pie 原样驱动真实 Chrome,复用 ~100% agent 代码**。

### 1.2 解锁路径 B 的关键发现

`ServiceNow/webarena-verified` 提供**独立的确定性离线评估器**:

- 输入:**agent 最终回答 + HAR 网络 trace + 任务定义**;
- 输出:确定性 score + status(**去掉 LLM-as-judge**,用 type-aware normalization + 结构比对);
- **明确支持第三方 agent**:只要产出 HAR + 规定格式 response 即可被打分,**完全不经过 BrowserGym 的 env**。

这同时解掉:**控制反转**(Pie 照常驱动 live docker,Playwright 原生 `recordHar` 抓 HAR,无需 `env.step()`)与 **ground-truth 缺失**(打分喂给 verified evaluator,拿客观分,而非 agent 自报)。

> 风险:webarena-verified 仍在 active development、需从源码装,**第三方打分输入契约未必稳定**。故第 7 节把"契约 spike"前置为 Step 0。

---

## 2. Goal / Scope / Non-Goals

### Goal
用真实 Chrome + Pie 跑 WebArena-Verified 任务,产出**客观、可复现**的能力分数,且**不改动 agent loop 的生产代码**。

### Scope(本 spec = 首个端到端竖切片)
走通一条完整链路:启 Chrome+Pie → 注入**一个** WebArena-Verified 任务 → Pie 驱动 live docker → 抓 HAR + 取最终答案 → 确定性评估器打分 → 输出一份 artifact bundle + `score.json`。

### Non-Goals(本期明确不做)
- 批量跑、并发、per-task profile 池化调度。
- CI smoke gate、回归看板、指标趋势。
- 路径 A(接 BrowserGym env 拿标准 leaderboard 可比分)——后续单列。
- 真实在线站点(WebVoyager 风格)/ MiniWoB —— 后续可选。
- 若某类 WebArena 任务的离线打分仍需 live DB 查询,本期标 out-of-scope(见 4.3)。

---

## 3. 架构与组件边界

3 个组件 + 1 个胶水,边界均为文件/进程级,各自独立可测:

```
┌─────────────────────────────────────────────────────────────┐
│ eval/run-task.sh  (胶水: 先 orchestrator, 再 scorer)           │
└───────────────┬─────────────────────────────┬─────────────────┘
                │                             │
   ┌────────────▼────────────┐   ┌────────────▼──────────────┐
   │ ① Node Orchestrator (TS) │   │ ③ Python Scorer            │
   │   Playwright-node        │   │   webarena-verified eval   │
   │   启 Chrome+Pie / 注入 /  │   │   读 artifact → score.json │
   │   抓 HAR / 收答案 / 落盘   │   └────────────▲──────────────┘
   └────────────┬────────────┘                │ artifact bundle
                │ serviceWorker.evaluate()     │ (har+answer+task)
   ┌────────────▼─────────────────────────────┴──────────────┐
   │ ② Eval Bridge (扩展内, dev-only, build-flag 隔离)          │
   │   globalThis.__pieEval = {seedConfig,startTask,           │
   │   waitForDone, getTrace, reset}  ← 走现有 runAgentLoop      │
   └──────────────────────────────────────────────────────────┘
```

| 组件 | 输入 | 输出 | 依赖 |
|---|---|---|---|
| ① Orchestrator | task 定义(goal + start URL) | artifact bundle | Playwright-node + `dist-eval/` |
| ② Eval Bridge | `__pieEval` 方法调用 | EvalTrace(self-report / answer / steps / usage) | 现有 `runAgentLoop` |
| ③ Scorer | artifact bundle | `score.json`(客观分 + status) | Python `webarena-verified` |

**关键决策——bridge 经 `serviceWorker.evaluate()` 可达,不用 `externally_connectable`:**
Playwright-node 拿扩展 SW handle(`context.serviceWorkers()`),在其中 `evaluate()` 调 `globalThis.__pieEval.*`。零 manifest 改动、不起控制页;`__pieEval` 仅 eval build 挂载,release build 不存在。

---

## 4. 组件契约

### 4.1 Eval Bridge(`src/background/eval-bridge.ts`,dev-only)

```ts
interface PieEvalBridge {
  seedConfig(cfg: {provider; model; apiKey; baseUrl?}): Promise<{instanceId}>
  startTask(opts: {goal: string}): Promise<{sessionId}>
  waitForDone(opts: {sessionId; timeoutMs}): Promise<{status: "done"|"error"|"timeout"}>
  getTrace(opts: {sessionId}): Promise<EvalTrace>
  reset(opts?: {keepConfig?: boolean}): Promise<void>
}

interface EvalTrace {
  sessionId: string
  agentSelfReport: { success: boolean; summary: string }  // 来自 done/fail —— 非 ground-truth, 仅附加观测
  answer: string            // 给 WebArena 信息检索类打分用的最终答案
  steps: Array<{ stepIndex; tool; argsRedacted; status }>
  usage: { inputTokens; outputTokens }
  startedAt: number; endedAt: number
  error: string | null
}
```

四个设计点:

1. **MockPort 复用 `runAgentLoop`(不改生产代码)。** 现状链路:panel → port `chat-stream-${sessionId}` → `handleChatStream`(`src/background/index.ts`)→ `runAgentLoop({port,...})`(`src/lib/agent/loop.ts`)。bridge 造一个满足 `chrome.runtime.Port` 形状的 **MockPort**,`postMessage` 收进 buffer,原样传给 `runAgentLoop`。`runAgentLoop` 一行不改。buffer 见到 `agent-done-task` → `waitForDone` resolve;`getTrace` 从同一 buffer 取数。dev-only 代码完全锁在 `eval-bridge.ts`。

2. **答案抽取。** Orchestrator 给 WebArena goal 薄包一句"完成时把最终答案作为 `done` 的 summary"。bridge 从终止的 `done` tool call 取 `answer`,只做最小规整(type-aware 归一交给 scorer)。

3. **dev-only 隔离。** Vite `define` 标志 `__PIE_EVAL__`(prod=false)。`if (__PIE_EVAL__) globalThis.__pieEval = makeBridge()` 在 prod 被 dead-code-eliminate。新增 **build-time invariant**(仿现有 `tool-names.ts`/`tools.ts` 的 throw 惯例):prod `dist/` 含 `__pieEval` 字符串即 CI fail。eval build 走单独命令 `pnpm build:eval` → `dist-eval/`。

4. **seedConfig** 复用现有 `src/lib/instances.ts` 的 CRUD + 加密路径写一个 instance、设 `active_instance_id`,不另起逻辑(避免与生产配置分叉)。

### 4.2 Node Orchestrator(`eval/runner/`,TS)

一个 task 的时序:

```
1. pnpm build:eval                → dist-eval/
2. Playwright launchPersistentContext(headful, --load-extension=dist-eval,
                                       recordHar={path})
3. 取 SW handle, 等其 active
4. sw.evaluate → __pieEval.seedConfig(从 env 读 BYOK key)
5. 导航 active tab 到 WebArena 任务起始 URL
6. sw.evaluate → __pieEval.startTask({goal: 包过的 goal}) → sessionId
7. sw.evaluate → __pieEval.waitForDone({sessionId, timeoutMs})
8. sw.evaluate → __pieEval.getTrace({sessionId})         → EvalTrace
9. sw.evaluate → __pieEval.reset()
10. context.close()               → flush HAR 落盘
11. 写 artifact bundle
```

- 第 5 步在 startTask 之前——bridge 沿用现有"task start 时 pin 当前 active tab"语义。
- **HAR 清洗(安全必做)**:HAR 会录下 Pie 调 LLM provider 的请求,其 `Authorization` header 带 **BYOK API key**。落盘前后处理:**只保留 WebArena host 条目、剥掉 auth header**。既护 key,又正好是 scorer 唯一关心的流量。
- 时间戳:orchestrator 是普通 Node 进程,`Date.now()` 自由用。
- 强隔离默认:**一 task 一个全新 persistent context**(用完即弃 userDataDir);`reset()` 作同 context 复用时的备选。

**Artifact bundle(一 task run 一目录):**

```
runs/<taskId>-<stamp>/
  task.json      # 从 WebArena-Verified 数据集拷:taskId/goal/startUrl/evalType/refAnswer...
  run.json       # EvalTrace
  answer.txt     # 抽出的最终答案(同 run.json.answer, 分出便于 scorer)
  network.har    # 清洗后的整段 HAR
  meta.json      # model / extensionVersion / chromeVersion / stamp
  ──────── scorer 产出 ────────
  score.json     # {taskId, score, status, evaluator:"webarena-verified", details}
```

### 4.3 Python Scorer(`eval/scorer/`)

**Step 0 — 评估器契约 spike(搭任何上游前 de-risk):**
1. 从源码装 `webarena-verified`,定位评估入口。
2. 手搓最小假 artifact(已知 WebArena task + 手写正确答案 + 极简/手录 HAR),直接喂评估器。
3. 确认四件事:入参签名 / HAR schema 要求(要 request·response body 吗?认哪些 host?)/ answer 格式 / 输出形状。
4. 产出 `eval/EVALUATOR_CONTRACT.md` 冻结 I/O,上游一切按它建。
> **最便宜的 kill point**:若契约不可行(需 BrowserGym 内部状态等),Step 0 即知。

**Scorer 实现**(`eval/scorer/score.py`):吃一个 run 目录 → 读 `task.json`+`answer.txt`+`network.har` → 按冻结契约适配 → 调 `webarena-verified` → 写 `score.json`。**纯函数式**(无 Chrome/无 Pie),artifact 在手即可反复重打分。

**两类任务都要离线可打分:**
- 信息检索类(答案匹配)→ 用 `answer.txt`;
- 状态改变类(动作须真改服务端状态)→ 走 HAR 的 network trace(故 orchestrator 录全程 HAR)。
- spike 须确认两类都能仅凭 (answer + HAR) 离线打分;若某类仍需 live DB,**v1 只收离线评估器支持的类型**。

---

## 5. 数据流(端到端)

```
WebArena-Verified 数据集 ──(task.json)──► Orchestrator
                                            │
   ┌──── seedConfig(BYOK key from env) ─────┤
   │                                        ▼
   │   Pie(真实 Chrome) ◄── startTask(goal) ── 驱动 live WebArena docker
   │        │ runAgentLoop(MockPort)              ▲
   │        │                                     │ HTTP (recordHar 捕获)
   │        ▼                                      │
   │   done(summary=answer) ──► EvalTrace          │
   │                                               │
   └──► artifact bundle: task.json + run.json + answer.txt + network.har(清洗)
                                            │
                                            ▼
                                   Scorer(离线) ──► score.json (客观 pass/fail)
```

ground-truth 只从 `score.json` 来;`agentSelfReport.success` 仅作"agent 自评 vs 真实结果"的差异观测。

---

## 6. 错误处理(status 分类)

把"任务结果"与"基建故障"分开,别让基建抖动污染分数:

`status` ∈ `done` / `timeout` / `error`(agent·provider) / `harness-error`(启动·seedConfig·SW 未起) / `scorer-error`

仅 **`done`** 的 run 进 scorer 拿真实 pass/fail;其余带 status 记录、排除出成功率分母或标记重试。

| 失败 | 处理 |
|---|---|
| SW 未起 / 扩展未加载 | 等 SW active 带超时,超 → `harness-error` |
| seedConfig / key 坏 | navigate 前 fail fast → `harness-error` |
| agent 超时 | `waitForDone` timeoutMs 到 → abort session、记 `timeout`、**仍存部分 trace + HAR**;打分计 fail |
| 跑中 LLM/provider 报错 | MockPort 收 `chat-error` → resolve `error`;记类别供聚合决定重试 |
| HAR 无 WebArena host 条目 | **大声告警**(不静默),仍落盘,scorer 多半判 0/error |
| scorer 崩 / 契约漂移 | 写 `score.json` status=`scorer-error`+异常;**artifact 全保留可重打分** |

---

## 7. 实现顺序(竖切片内的 phasing)

1. **Step 0 — 评估器契约 spike**(4.3):冻结 `EVALUATOR_CONTRACT.md`。**最高优先,gating 后续一切。**
2. **Eval bridge + MockPort**(4.1):含单测,不需真 Chrome。
3. **build:eval 构建 + dev-only 不变量**(4.1 点 3)。
4. **Orchestrator**(4.2):Playwright 启动、SW evaluate、HAR 清洗、artifact 落盘。
5. **Scorer**(4.3):按冻结契约实现,含 golden test。
6. **胶水 + 端到端 smoke**:一个真实 WebArena-Verified 任务跑通,肉眼核 `score.json`。

---

## 8. 测试策略

边界文件/进程级,三组件独立测:

1. **Eval bridge 单测(vitest)** `eval-bridge.test.ts`:MockPort 正确收事件;`getTrace` 从 `done` 抽 answer;`waitForDone` 在 agent-done-task/chat-error/timeout 各 resolve;`reset` 清干净。mock `chrome.*` + 假 runAgentLoop 事件流,**不需真 Chrome**。
2. **Build 不变量测试**:断言 prod `dist/` 不含 `__pieEval`(仿 `tool-names.ts`/`tools.ts` throw 惯例),进 CI。
3. **Scorer 单测(Python)**:喂 spike 冻结的假 artifact(一对、一错)→ 断言 `score.json` 符预期。钉在 `EVALUATOR_CONTRACT.md` 的 golden test。
4. **端到端 smoke(先手动)**:一个真实 WebArena-Verified 任务跑完整切片、肉眼核 `score.json`。**本地稳定前不进 CI**;文档给手动运行命令。

---

## 9. 决策日志

- **路径 B**(扩展驱动真实 Chrome)over 路径 A(接 BrowserGym env)—— 复用全部 agent 代码、测真实形态;标准可比分后续再说。
- **首发目标 = WebArena-Verified** —— 其离线确定性评估器给客观 ground-truth,一并解掉控制反转 + 自评打分两个缺陷。
- **范围 = 首个端到端竖切片** —— 单一可实现 plan;批量/CI/看板后置。
- **任务注入 = dev-only eval 通道(`__pieEval` via SW evaluate)** —— 稳定、机器可读、零 manifest 改动、build-flag 严格隔离出 release。
- **编排 = 方案 A(Node orchestrator + 离线 Python scorer)** —— 90% 留 TS、Python 收敛为无状态打分黑盒、运行/打分解耦可重跑(契合 webarena-verified 离线哲学)。

## 10. 待验证风险

- `webarena-verified` 第三方打分输入契约未文档化、在 active development → **Step 0 spike 先冻结契约**。
- 状态改变类任务能否仅凭 HAR 离线打分待 spike 确认;不行则该类本期 out-of-scope。
- WebArena docker 环境一次性搭建成本(按官方 README)。
- headful 限制:加载扩展需非 headless;CI 化需 xvfb/有头环境(本期仅本地手动,不阻塞)。
