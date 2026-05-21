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
| 摘要形态 | **append-only 累积**:合成对持久留在 history,下次只压它之后的新步骤 |
| 状态模型 | **in-place 重写 `ctx.history`(agentMessages)并持久化**,非 wire-time 副本 |
| 实现位置 | **独立模块** `src/lib/agent/compact-react-window.ts`,摘要器依赖注入 |
| LLM 调用 | 复用 `generateStuckSummary` 模式(无 tool `streamChat`),用当前任务同一 model |
| 失败回退 | summarizer 返回 `null` → 本步跳过 compaction(不改 history),交给 wire-time 兜底 |

## 3. 核心:状态模型(in-place 持久重写)

这是本设计与现有 transform 的关键区别,务必先理解:

现有三个 transform(`applySlidingWindow` / `elideStaleObservations` / `applyTokenBudget`)是**无状态纯函数**,作用于每轮的 wire-time 副本,源 `ctx.history` 不变。它们便宜(纯计算),每轮重算无所谓。

compaction **不能**这么做:它含 LLM 调用,每轮重算会贵且非确定,违背"稀疏、压一次缓存住"。所以 compaction 是**有状态的 in-place 重写**:

- 直接修改 `ctx.history`(= `agentMessages`,SW 内部 LLM working context):超阈值时把最旧可压步骤摘成合成对,`splice` 替换进 history。**原始旧步骤就此丢弃**(这正是 compaction 的语义)。
- 之后 history 继续累积新步骤;下一步从已压缩的 history 出发。
- **append-only 天然成立**:合成对留在 history,下次超阈值时压的是"合成对之后新增的原始步骤",产出第二个合成对追加其后;已有合成对一字不改 → 前缀稳定,对齐 #57 caching。

**持久化与 side panel(关键澄清)**:存储是 D2 split 的两套(`sessions/storage.ts`):

- `session_${id}_meta.messages`(`DisplayMessage[]`)= **side panel 会话历史**,panel 自己经 `redactArgsForPanel` 累积持久化。**compaction 完全不碰这里,用户照样看到完整原始对话。**
- `session_${id}_agent.agentMessages` = **LLM working context**,`onStepSnapshot`(已有,每步 `structuredClone(history)` 写入)负责持久化。compaction 改了 history,该步 snapshot 自然持久化压缩版;SW 重启 resume(`resumedAgentMessages`)从压缩版恢复并继续累积。

> R28 v2 澄清:其 "agentMessages is RAW" 指**不做 panel 脱敏**(keyboard text 等保留真实值供 resume),**不是**"内容不可重写"。合成对仍是未脱敏的 LLM IR,compaction **不违反** R28 v2。

## 4. pipeline 接入与 `compactReactWindow` 算法

主循环每步、在 observation 合入 history 后、在 wire-time 整形之前,先跑 in-place compaction:

```
// loop.ts 主循环,约 1300-1319
await compactReactWindow(history, maxContextTokens, summarizer, signal); // in-place 改 history
// 随后维持现有 wire-time 整形(作用于副本,源 history 已是压缩版):
const slid    = applySlidingWindow(history, BIG_CAP);   // 12 → BIG_CAP 兜底
const elided  = elideStaleObservations(slid);
const budgeted = await applyTokenBudget(elided, provider); // head 段,不变
```

- **触发判定先于 elision**:用 `estimateTokens(elideStaleObservations(history)) > 0.8 × maxContextTokens` 判定——以"elide 后的等效大小"为准,与最终实际发送量一致,避免被尚未 elide 的旧 observation 撑高而过度触发。
- **摘要喂原始 observation**:compaction 改的是 history(elide 之前的原始内容),所以摘要器能看到完整 observation(关键发现还在),把"5 个航班 ¥800/¥950…"这类数据留进合成对;elision 随后只压 wire-time 副本里保留区的 DOM。职责互补。
- `applySlidingWindow` 的 12 对硬 cap 放宽为 `BIG_CAP` 兜底:react 段保留量改由 compaction(in-place)+ token 阈值驱动,sliding window 仅防异常无界增长。

```
compactReactWindow(history, maxContextTokens, summarizer, signal):  // 返回 void,in-place 改 history
  1. fast path:若 estimateTokens(elideStaleObservations(history)) <= 0.8 × maxContextTokens → return。
  2. 若 signal.aborted → return。
  3. 定位 react 段(findReactStartIdx);head 段不动。
  4. react 段切三块:
       - 已压缩区:过往产出的合成对(靠 user 那条含 <untrusted_compacted_steps> 标记识别)。
       - 可压原始对:已压缩区之后、保鲜区之前的原始 (assistant, user) 对。
       - 保鲜区:最近 KEEP_RECENT 对原始步骤,永不压。
  5. 从最旧「可压原始对」累积 victim,直到 elide 后估算降到阈值下,或只剩保鲜区。
  6. 一次 compaction 事件 = 一次 LLM 调用:
       summary = await summarizer(victimPairs, signal)
       若 summary === null(失败/abort/空)→ 本步不改 history,return(交给 wire-time budget/provider 兜底)。
       否则 → 用一个合成对替换 history 里的 victim 段(in-place splice),合成对落在已压缩区末尾。
```

**常量(初值,plan 阶段可调)**:

- `KEEP_RECENT = 4` 对 —— **保鲜区下限(压缩的刹车)**。摘要必然有损(`navigate→click→type` 被压成"填了表单",丢掉 elementIndex、刚读到的页面状态),而 agent 的下一步决策最依赖最近几步的完整细节。所以无论 token 多紧张,最近 4 对原始步骤**永不压缩**:累积 victim 时累到只剩最后 4 对就停手,哪怕还没降到阈值下(剩余交给 `applyTokenBudget` / provider 截断)。保证 agent 眼前永远有 4 步未失真的近期记忆,避免"近视"导致重复操作或误判。
- `BIG_CAP = 60` 对 —— **`applySlidingWindow` 放宽后的兜底上限(增长的刹车)**。本设计让 token 阈值(而非固定步数)决定 react 段保留多少,故放宽现有的 12;但不能完全去掉上限——万一单步 observation 异常巨大、token 估算出 bug、或 summarizer 持续失败回退,react 段可能无界堆积。`BIG_CAP` 是安全网:正常路径下 token 阈值会在 60 对之前先触发 compaction,这个数永远轮不到,只在异常时防止 react 段撑爆。
- 阈值复用 `applyTokenBudget` 的 `0.8 × maxContextTokens`,`FALLBACK_MAX_CONTEXT_TOKENS = 32_000`。`maxContextTokens` 由调用方(loop.ts)`resolveProviderMeta(provider)` 解析后传入数值,使核心模块可用纯数值阈值单测、无需 mock provider 元数据。

> 正常工况下真正的调节阀是 token 阈值,`KEEP_RECENT`(下限)与 `BIG_CAP`(上限)都是边界保护,两个初值均为经验值,实现时可据实际 token 分布再调。

## 5. 摘要产物的消息结构(安全 + 交替不变式)

三条硬约束:
- react 段第一条必须是 assistant 且 `content` 为 `ContentBlock[]`(`findReactStartIdx` 据此定位 react 起点)。
- 合成对的 assistant / user 两条 `content` 都必须是 `ContentBlock[]`(否则合成对会被划进 head 段被 `applyTokenBudget` 误处理)。
- 不可信(页面来源)内容必须落在 **user role** 并包 `<untrusted_*>` wrapper(CLAUDE.md prompt-injection 不变式),**绝不**伪装成 assistant 可信话语。

LLM 摘要的输入含 untrusted 页面内容,**输出整体视为 untrusted-derived**。因此一个合成对 = 一组 **(assistant 占位, user 摘要)**:

```
assistant: [{type:"text", text:"[早期 N 步已压缩为摘要]"}]      ← 系统生成、可信占位、固定文案
user:      [{type:"text", text:
             "<untrusted_compacted_steps>\n" +
             "动作: navigate → read_page → click(...)\n" +
             "发现: 找到 5 个航班 ¥800/¥950/¥1020...;表单填到第 3 步\n" +
             "</untrusted_compacted_steps>"}]                     ← LLM 摘要,全部 untrusted
```

- 整段 LLM 摘要塞进 user 那条的 wrapper;assistant 占位只放系统生成的固定文案(含被压步数 N),不含任何 untrusted 内容。
- **新增 wrapper tag** `untrusted_compacted_steps`,登记进 `UNTRUSTED_WRAPPER_TAGS`(`untrusted-wrappers.ts`)**和** `snapshot.ts` 的 `sanitizeText` replace 链(两处 dual-list,受 `untrusted-wrappers.test.ts` 的 fs-read lock-step 检查强制);摘要正文经 `escapeUntrustedWrappers` 转义(中和页面文本里的 wrapper 字面量)。
- **append-only**:合成对落在已压缩区末尾,旧合成对一字不改。
- 序列保持严格交替:`...[user task][assistant占位][user摘要][assistant占位][user摘要][assistant 保留 tool_use]...`。
- **已压缩区识别**:user 那条含 `<untrusted_compacted_steps>` 即视为已压缩,下一步不重复压。

## 6. 摘要器接口(依赖注入)

```ts
export type ReactSummarizer = (
  pairs: AgentMessage[],
  signal: AbortSignal,
) => Promise<string | null>; // 返回 untrusted 摘要正文;null = 失败/abort/空
```

- 默认实现(在 `loop.ts` 注入)复用 `generateStuckSummary` 模式:无 tool 的 `streamChat(modelConfig, msgs, signal, [])` + signal 透传;prompt 要求"分两部分总结:① 执行过的动作序列;② 页面发现的关键数据/进度,保留具体数值"。
- 用**当前任务的同一个 model**(`modelConfig`)——BYOK 下无独立小 model 概念。
- prompt 构造抽成纯函数 `buildCompactionMessages(pairs): AgentMessage[]` 单测;`streamChat` 收集部分作薄 wrapper(与 `generateStuckSummary` 同样不强求单测,靠类型 + build + 集成)。
- 注入式让 `compact-react-window.ts` 逻辑零 LLM 依赖,单测可传 mock。

## 7. 错误处理 / 回退

- summarizer 返回 `null`(失败/abort/空输出)→ **本步跳过 compaction,不改 history**。原始旧步骤保留到下一步再试;若 history 真撑大,wire-time 的 `applyTokenBudget` / provider 截断兜底。比直接硬 splice 更不易丢信息。
- `signal.aborted` → 立刻 return,history 不变。
- provider `maxContextTokens` 缺失 → 调用方传入 32k fallback。
- 所有 provider 一视同仁(只要能 `streamChat`),无 gating。

## 8. 抖动 / 确定性控制

plan(2026-05-03)曾以"非确定性"拒 LLM 摘要。本设计的控制手段:
- **稀疏触发**:中位 5-8 步任务永不进 compaction(fast path)。
- **只在边界压一次,结果持久**:in-place 累积,合成对不重算 → 压完前缀稳定。
- **失败 graceful degrade**:本步跳过,不破坏任务推进。

## 9. 测试(TDD)

**纯逻辑(mock summarizer,in-place 断言)** — `compact-react-window.test.ts`:
- fast path:未超阈值 → history 不变(引用/内容相等)。
- 超阈值触发:victim 被替换为合成对;保鲜区 `KEEP_RECENT` 对原始保留;合成对结构正确(assistant 占位 ContentBlock[] + user wrapper ContentBlock[])。
- append-only:已含一个合成对的 history,再超阈值 → 旧合成对不变,新合成对追加其后,只压新原始步骤。
- summarizer 返回 `null` → history 不变(本步跳过)。
- abort:`signal.aborted` → history 不变。
- 交替不变式:输出无相邻同 role。
- wrapper 转义:victim 内容含 `</untrusted_compacted_steps>` 字面量被转义。

**安全 / 集成**:
- `untrusted-wrappers.test.ts` fs-read lock-step 自动覆盖新 tag(只要两处 dual-list 都加)。
- pipeline 顺序:compaction(in-place)在 wire-time 整形之前;触发判定用 elide 后大小。

## 10. 影响面 / 改动清单

- 新增 `src/lib/agent/compact-react-window.ts` + 测试。
- `untrusted-wrappers.ts`:`UNTRUSTED_WRAPPER_TAGS` 加 `untrusted_compacted_steps`。
- `snapshot.ts`:`sanitizeText` replace 链加 `.replace(/<\/?untrusted_compacted_steps>/gi, "[filtered]")`(dual-list lock-step,否则 `untrusted-wrappers.test.ts` fail)。
- `loop.ts`:主循环 pipeline(约 1300-1319)在整形前插入 `await compactReactWindow(history, maxCtx, summarizer, signal)`(in-place);`applySlidingWindow(history)` 改传 `BIG_CAP`;新增默认 summarizer(`buildCompactionMessages` + `streamChat`);`resolveProviderMeta(provider)` 解析 `maxContextTokens` 传入。
- 不动 `applyTokenBudget`(head 段职责不变)、不动 `elideStaleObservations` 内部、不动 panel 侧 `meta.messages` 持久化。
- `generateStuckSummary` 路径(798-820)**本期不接入** compaction(rare hard-stop 路径,YAGNI);保持现状。

## 11. 非目标(YAGNI)

- 不做 head 段(跨任务)compaction —— 已有 `lastTaskSynth` + `applyTokenBudget`。
- 不做 running-summary 单条重写形态(已选 append-only 累积)。
- 不引入独立小 model / 第二 provider。
- 不引入独立的 compaction 状态字段 / step-index 映射 —— 直接 in-place 改持久化的 `agentMessages` 即可。
- 不在本期实现 #57 caching 本身;仅保证 compaction 的 append-only 形态对其友好。
- `generateStuckSummary` 路径本期不接入。
