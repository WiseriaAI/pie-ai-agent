# 任务内 react 段 LLM compaction(#58 子点 b)设计

- 日期:2026-05-22
- Issue:#58 子点 (b) — 任务内阈值触发的 LLM compaction
- 状态:设计已确认,待写实施 plan
- 关联:#57(prompt caching,缓存协同)、#58 子点 (a)(已在 PR #74,跨任务 recall)

## 1. 背景与问题

Pie 的多轮上下文 pipeline(`loop.ts:1300-1319`)当前对 react 段(任务内步骤)有两层减重:

1. `applySlidingWindow(history, 12)` — react 段固定保留最近 **12 对**(assistant tool_use + user tool_result),更早的步骤对**整对硬 splice 丢弃**(含 agent reasoning + tool_use + tool_result/observation),**无 token 感知、无摘要保留**。
2. `elideStaleObservations` — 把除最新外每个 observation 的交互元素列表换成 `STALE_OBSERVATION_MARKER`,保留语义 header(url/title/headings)。

而 `applyTokenBudget`(80% × `maxContextTokens`)只作用于 **head 段(跨任务旧轮)**,**不碰 react 段**。

**痛点**:长任务超过 12 对后,早期步骤被整对硬丢,且 `elideStaleObservations` 还会把保留区里旧 observation 的关键发现(如"5 个航班价格")换成 marker。结果是:任务前半段读到的具体数据在后半段彻底丢失,模型只能重读或干脆遗忘。

**已排除的范围**:跨任务 recall(任务 A → 任务 B)已由子点 (a)(`synthesizeAgentTurnText` 成功路径带步骤列表 → `lastTaskSynth`,PR #74)覆盖,本设计**不重复**该职责,只聚焦**任务内** react 段。

## 2. 已确认的核心决策

| 维度 | 决策 |
|---|---|
| 作用区 | **react 段(任务内步骤)**,head 段维持现有 `applyTokenBudget` 不变 |
| 触发信号 | **provider-aware token 阈值**(复用 80% × `maxContextTokens`),非固定步数 |
| 摘要形态 | **append-only 多段**:每次事件追加一个合成对,旧摘要一字不改 |
| 实现位置 | **独立模块** `src/lib/agent/compact-react-window.ts`,摘要器依赖注入 |
| LLM 调用 | 复用 `generateStuckSummary` 模式(无 tool `streamChat`),用当前任务同一 model |
| 失败回退 | summarizer 返回 `null` → 回退当前硬 splice 行为 |

**逻辑推论(决定方案形态)**:`applySlidingWindow(12)` + `elideStaleObservations` 叠加后,12 对的 react 段 token 很小,token 阈值几乎永不触发。要让 token 驱动的 react compaction 真正生效,**必须放宽固定 12 对硬 cap**——把它降级为防单步爆炸的大上限兜底(`BIG_CAP`),让 react 段能吃满 provider 窗口,只在 token 真紧张时才把最旧步骤摘要移出。

## 3. 总体架构

新 pipeline 顺序(改 `loop.ts` 接入点,约 1300-1319):

```
applySlidingWindow(history, BIG_CAP)                          // 12 → 大兜底
  → compactReactWindow(messages, provider, summarizer, signal) // 新增:react 段语义压缩
  → elideStaleObservations                                     // 保留区旧 observation 去 DOM
  → applyTokenBudget(provider)                                 // head 段,不变
```

**为什么 compaction 在 elision 之前**:elision 把旧 observation 的交互元素列表(关键发现所在)换成 marker。若先 elide,compaction 就摘不到具体发现了。compaction 必须趁原始 observation 完整时摘要,把关键数据/进度留进合成摘要,再让 elision 去压保留区剩下的 DOM。两者职责互补:

- **compaction** 管「移出区」(将被丢的最旧步骤)的**语义留存**。
- **elision** 管「保留区」旧 observation 的 **DOM 瘦身**(轻量、确定性、每轮跑)。

> R28 v2 不变式延续:所有这些 transform 只作用于 wire-time 副本,at-rest `history.agentMessages` 保持 RAW。

## 4. `compactReactWindow` 算法

```
compactReactWindow(messages, provider, summarizer, signal):
  1. fast path:若 estimateTokens(elideStaleObservations(messages), provider) <= 80% × maxCtx
       → 原样返回。
     (用「elide 后的等效大小」判定,与最终实际发送量一致,避免被尚未 elide 的
      旧 observation 撑高而过度触发。)
  2. 若 signal.aborted → 原样返回。
  3. 定位 react 段(findReactStartIdx);head 不动。
  4. react 段切三块:
       - 已压缩区:过往 compaction 产出的合成对(靠 user 那条含
         <untrusted_compacted_steps> 标记识别)。
       - 可压原始对:已压缩区之后、保鲜区之前的原始 (assistant, user) 对。
       - 保鲜区:最近 KEEP_RECENT 对原始步骤,永不压。
  5. 从最旧「可压原始对」开始累积 victim,直到 elide 后估算降到阈值下,
     或可压原始对耗尽(只剩保鲜区)。
  6. 一次 compaction 事件 = 一次 LLM 调用:
       summary = await summarizer(victimPairs, signal)
       若 summary === null(失败/abort/空)→ 回退:splice 掉 victim(当前硬行为)。
       否则 → 用一个合成对替换 victim,合成对追加到「已压缩区」末尾。
  7. 重组 [head, ...已压缩区, ...保留原始对],返回。
```

**常量(初值,plan 阶段可调)**:

- `KEEP_RECENT = 4` 对 —— **保鲜区下限(压缩的刹车)**。摘要必然有损(`navigate→click→type` 被压成"填了表单",丢掉 elementIndex、刚读到的页面状态),而 agent 的下一步决策最依赖最近几步的完整细节。所以无论 token 多紧张,最近 4 对原始步骤**永不压缩**:`compactReactWindow` 累积 victim 时,累到只剩最后 4 对就停手,哪怕还没降到阈值下(剩余交给 `applyTokenBudget` / provider 截断)。保证 agent 眼前永远有 4 步未失真的近期记忆,避免"近视"导致重复操作或误判。
- `BIG_CAP = 60` 对 —— **`applySlidingWindow` 放宽后的兜底上限(增长的刹车)**。本设计让 token 阈值(而非固定步数)决定 react 段保留多少,故放宽现有的 12;但不能完全去掉上限——万一单步 observation 异常巨大、token 估算出 bug、或 summarizer 持续失败回退,react 段可能无界堆积。`BIG_CAP` 是安全网:**正常路径下 token 阈值会在 60 对之前先触发 compaction,这个数永远轮不到**,只在异常时防止 react 段撑爆。
- 阈值复用 `applyTokenBudget` 的 `0.8 × maxContextTokens`,`FALLBACK_MAX_CONTEXT_TOKENS = 32_000`。

> 正常工况下真正的调节阀是 token 阈值,`KEEP_RECENT`(下限)与 `BIG_CAP`(上限)都是边界保护,两个初值均为经验值,实现时可据实际 token 分布再调。

## 5. 摘要产物的消息结构(安全 + 交替不变式)

两条硬约束:
- react 段第一条必须是 assistant tool_use(`window.ts` 不变式)。
- 不可信(页面来源)内容必须落在 **user role** 并包 `<untrusted_*>` wrapper(CLAUDE.md prompt-injection 不变式),**绝不**伪装成 assistant 可信话语。

LLM 摘要的输入含 untrusted 页面内容,**输出整体视为 untrusted-derived**。因此一个合成对 = 一组 **(assistant 占位, user 摘要)**:

```
assistant: [早期 N 步已压缩为摘要]              ← 系统生成、可信占位、固定文案
user:      <untrusted_compacted_steps>
             动作: navigate → read_page → click(...)
             发现: 找到 5 个航班 ¥800/¥950/¥1020...;表单填到第 3 步
           </untrusted_compacted_steps>          ← LLM 摘要,全部 untrusted
```

- 整段 LLM 摘要塞进 user 那条的 wrapper;assistant 占位只放系统生成的固定文案(含被压步数 N),不含任何 untrusted 内容。
- **新增 wrapper tag** `untrusted_compacted_steps`,登记进 `UNTRUSTED_WRAPPER_TAGS`(`untrusted-wrappers.ts`),受 `untrusted-wrappers.test.ts` 的 fs-read 一致性检查覆盖;摘要正文经 `escapeUntrustedWrappers` 转义(中和页面文本里的 wrapper 字面量)。
- **append-only**:第二次 compaction 再生成一个合成对,插在已压缩区末尾,旧合成对**一字不改** → 前缀稳定,直接对齐 #57 caching("尽量少 compact、压完缓存住")。
- 序列保持严格交替:`...[user task][assistant占位][user摘要][assistant占位][user摘要][assistant 保留 tool_use]...`(assistant→user→assistant→user...)。
- **已压缩区识别**:user 那条含 `<untrusted_compacted_steps>` 即视为已压缩,下一轮不重复压。

## 6. 摘要器接口(依赖注入)

```ts
export type ReactSummarizer = (
  pairs: AgentMessage[],
  signal: AbortSignal,
) => Promise<string | null>; // 返回 untrusted 摘要正文;null = 失败/abort/空
```

- 默认实现(在 `loop.ts` 注入)复用 `generateStuckSummary` 模式:无 tool 的 `streamChat` + signal 透传;prompt 要求"分两部分总结:① 执行过的动作序列;② 页面发现的关键数据/进度,保留具体数值"。
- 用**当前任务的同一个 model**(`modelConfig`)——BYOK 下无独立小 model 概念。
- 注入式让 `compact-react-window.ts` 逻辑零 LLM 依赖,单测可传 mock。

## 7. 错误处理 / 回退

- summarizer 返回 `null`(失败/abort/空输出)→ **回退到当前硬行为**:直接 splice victim,不留摘要。绝不因摘要失败而卡住或丢用户任务。
- `signal.aborted` → 立刻停,返回当前 messages。
- provider `maxContextTokens` 缺失 → 沿用 32k fallback。
- 所有 provider 一视同仁(只要能 `streamChat`),无 gating。

## 8. 抖动 / 确定性控制

plan(2026-05-03)曾以"非确定性"拒 LLM 摘要。本设计的控制手段:
- **稀疏触发**:中位 5-8 步任务永不进 compaction(fast path)。
- **只在边界压一次**:一次事件一次 LLM 调用,append-only,压完前缀稳定。
- **失败 graceful degrade**:回退确定性硬 splice,不破坏任务推进。

## 9. 测试(TDD)

**纯逻辑(mock summarizer)** — `compact-react-window.test.ts`:
- fast path:未超阈值原样返回。
- 超阈值触发:victim 被替换为合成对;保鲜区 `KEEP_RECENT` 对原始保留。
- append-only:已有合成对不被重压,新合成对追加其后。
- summarizer 返回 `null` → 回退硬 splice(输出等价旧 splice 行为)。
- 交替不变式:输出无相邻同 role。
- wrapper 转义:victim 内容含 `</untrusted_compacted_steps>` 字面量被转义。
- abort:`signal.aborted` 时原样返回。

**安全 / 集成**:
- `untrusted-wrappers.test.ts` fs-read 一致性检查覆盖新 tag `untrusted_compacted_steps`。
- pipeline 顺序断言:compaction 在 elision 之前(摘要能看到原始 observation)。

## 10. 影响面 / 改动清单

- 新增 `src/lib/agent/compact-react-window.ts` + 测试。
- `untrusted-wrappers.ts`:加 `untrusted_compacted_steps` 到 `UNTRUSTED_WRAPPER_TAGS`(及 snapshot.ts inline regex 对齐,如该不变式要求)。
- `window.ts`:`applySlidingWindow` 默认 `maxSteps` 12 → 由调用方传 `BIG_CAP`(或新增带兜底的调用)。
- `loop.ts`:pipeline 接入点(约 1300-1319)插入 `compactReactWindow`,注入默认 summarizer;`generateStuckSummary` 路径(798-820)同步评估是否需要 compaction(长 stuck 历史也可能超窗,沿用同一 pipeline)。
- 不动 `applyTokenBudget`(head 段职责不变)、不动 `elideStaleObservations` 内部逻辑。

## 11. 非目标(YAGNI)

- 不做 head 段(跨任务)compaction —— 已有 `lastTaskSynth` + `applyTokenBudget`。
- 不做 running-summary 单条重写形态(已选 append-only)。
- 不引入独立小 model / 第二 provider。
- 不在本期实现 #57 caching 本身;仅保证 compaction 的 append-only 形态对其友好。
