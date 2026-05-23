# Session Context 可视化 — Context Ring 设计

- 日期:2026-05-23
- Issue:#59
- 状态:设计已确认,待写实施 plan
- 关联:#57(prompt caching,缓存收益可视化的远期延伸)、#58(任务内 compaction,ring 回落即收益反馈)
- 视觉原型:Pie Frontend Paper 文件,artboard "ContextRing · States · Dark"

## 1. 背景与问题

补完 prompt caching(#57)与任务内 compaction(#58)后,上下文管理对用户仍是黑盒。期望用户能直观看到**这轮会话 LLM 实际吃了多少 token / 距离 model 上限还有多少**,辅助理解 sliding window / token budget / compaction 的触发时机。

**核心 gap(已核实)**:provider 层已经透出 `done.usage`,但 agent loop 把它丢了。

- `StreamEvent.done.usage`(`src/lib/model-router/types.ts:50-54`):`{ inputTokens: number; outputTokens: number }`
- Anthropic(`src/lib/model-router/providers/anthropic.ts:195-213`)与 OpenAI-compat(`src/lib/model-router/providers/_shared/openai-compat-core.ts:190`,已设 `stream_options.include_usage`)都填了真实 usage
- 非流式 `streamChat` wrapper(`src/lib/model-router/index.ts:121-133`)会把 usage 收进 `ChatResponse`
- 但 **agent loop 的流式消费循环(`src/lib/agent/loop.ts:1388-1430`)只处理 `text-delta` / `tool-call-*` / `error`,没有 `done` 分支** —— 每步真实 usage 直接落地

> 注意:`loop.ts:1668` 的 `"done"` 是 **`done` 工具**,不是 stream `done` 事件,勿混。

## 2. 已确认的核心决策

| 维度 | 决策 |
|---|---|
| ring 显示什么 | **上一步 LLM 调用的真实 input usage / model maxContextTokens** |
| 累计语义 | **跨任务**(SW 重启、新任务起步都保留) |
| 持久化位置 | `SessionAgentState.contextUsage`(SW 单写者,沿用 `session_${id}_agent` key) |
| 写入责任 | **SW**(loop done 分支 RMW),panel 仅订阅渲染、零 persist |
| wire 通道 | 新 `agent-usage` event(SW → panel),携带 last + total 两组数 |
| fallback | **无**。provider 不透出 usage → ring 不显示。不引入 estimateTokens 估算 |
| empty 状态 | **不渲染**(DOM 不挂载)。等首次 `agent-usage` 到达再出现 |
| UI 位置 | composer action row 右侧,InstanceSelector 与 Send 之间 |
| 交互 | hover → tooltip 单行,click → popover 三行(input / output / total) |
| 视觉阈值 | <60% slate、60-80% amber `#E07A4A`、≥80% red `#D9544A` |

## 3. 数据流 & wire 协议

```
[每步 LLM 调用结束]
  loop.ts stream 消费循环
    + else if (event.type === "done" && event.usage?.inputTokens > 0) {
    +   lastStepUsage = event.usage;     // 局部 capture
    + }
  ↓
  stream 退出后(循环正常结束)
    + if (lastStepUsage) {
    +   RMW 写 SessionAgentState.contextUsage(SW 单写):
    +     totalInputTokens  += lastStepUsage.inputTokens
    +     totalOutputTokens += lastStepUsage.outputTokens
    +     lastInputTokens    = lastStepUsage.inputTokens
    +     lastOutputTokens   = lastStepUsage.outputTokens
    +   port.postMessage({ type: "agent-usage", sessionId,
    +                      lastInputTokens, lastOutputTokens,
    +                      totalInputTokens, totalOutputTokens })
    + }

[Panel]
  port-handlers.ts 新 branch:
    case "agent-usage":
      patchSlot(sessionId, { usage: { ...payload } })    // 仅 in-memory,零 persist
  ↓
  Composer.tsx 订阅 slot.usage → 渲染 ContextRing

[Panel mount / 切 session]
  useSession 加载 SessionAgentState → 灌 slot.usage 初始值

[任务 emitDone tombstone]
  buildSessionAgentTombstone(synth, carryUsage) 保留 contextUsage
  → 跨任务累计活下来,下一个任务起步即可继续 +=
```

### wire 消息类型

`src/types/messages.ts`:

```ts
export interface AgentUsageMessage {
  type: "agent-usage";
  sessionId: string;
  /** 上一步 LLM 调用的真实 input usage(done.usage.inputTokens) */
  lastInputTokens: number;
  /** 上一步真实 output usage */
  lastOutputTokens: number;
  /** SW 累加后的总数 —— panel 直接替换不再 +=,避免双数据源 */
  totalInputTokens: number;
  totalOutputTokens: number;
}
```

加入 `PortMessageToPanel` 联合类型。

## 4. 存储:SessionAgentState.contextUsage

### 4.1 字段定义

`src/lib/sessions/types.ts`,在 `SessionAgentState` 加可选字段:

```ts
contextUsage?: {
  /** 跨任务累计:本 session 所有 LLM 调用的 input token 总和 */
  totalInputTokens: number;
  /** 跨任务累计:output token 总和 */
  totalOutputTokens: number;
  /** 上一步 LLM 调用的真实 input usage —— ring 占比的分子 */
  lastInputTokens: number;
  /** 上一步 LLM 调用的真实 output usage —— popover 展示 */
  lastOutputTokens: number;
};
```

老 session 无此字段 → ring 不渲染 → 下一步 LLM 调用后写入,零迁移代码。

### 4.2 RMW 与 merge 安全

`SessionAgentState` 已有多个 SW 写入点(step snapshot、tombstone、setLastTaskSynth、setPendingConfirm、setCurrentFocusTabId),全部走 `mergeSessionAgentSnapshot`(`src/lib/agent/loop.ts:574`)。当前 merge 策略:

- 非 tombstone:`{ ...existing, ...snapshot }` spread → 现有 contextUsage **自动保留**
- tombstone(`stepIndex===0 && agentMessages.length===0`):full replace → carry-over 须显式传入

### 4.3 tombstone carry-over

修改 `buildSessionAgentTombstone`(`src/lib/agent/loop.ts:534`)签名:

```ts
export function buildSessionAgentTombstone(
  lastTaskSynth?: string | null,
  carryUsage?: SessionAgentState["contextUsage"],   // ← 新增
): SessionAgentState {
  const base: SessionAgentState = {
    agentMessages: [],
    stepIndex: 0,
    hasImageContent: false,
  };
  if (lastTaskSynth != null) base.lastTaskSynth = lastTaskSynth;
  if (carryUsage != null) base.contextUsage = carryUsage;
  return base;
}
```

调用点(每个 `emitDone` 调 `buildSessionAgentTombstone` 的位置):先读现态 → 把 `contextUsage` carry 过去:

```ts
const prev = await getSessionAgent(sessionId);
const tombstone = buildSessionAgentTombstone(synth, prev?.contextUsage);
await setSessionAgent(sessionId, tombstone);
```

### 4.4 为什么不放 SessionMeta

`setSessionMeta`(`src/lib/sessions/storage.ts:295`)是**全字段 RMW 覆盖写**,且 panel(messages persist)与 SW(pinnedTabs / pinMode)已经是**双写者**(CLAUDE.md 警告)。再加 SW 写 contextUsage 会扩大 race 面。`SessionAgentState` 是 SW 单写 key,零 race,所以选这里。

### 4.5 为什么不开新 key

新 `session_${id}_usage` 在工程上干净,但需新加 storage helper、lifecycle.ts 的 archive/delete 路径联动、index 同步。`SessionAgentState` 已有完整 lifecycle,carry-over 一行就够,综合更轻。

## 5. UI:ContextRing 组件

视觉原型见 Paper artboard "ContextRing · States · Dark"(5 状态:before-first-call / low / mid + tooltip / high / popover open)。

### 5.1 渲染条件

```ts
const showRing =
  usage?.lastInputTokens != null &&
  usage.lastInputTokens > 0 &&
  maxContextTokens != null &&
  maxContextTokens > 0;

{showRing && <ContextRing … />}
```

**首次发送前 / SW 重启首步前 / custom provider 缺 maxContextTokens / provider 不透 usage** 全部走"不渲染"路径,无 empty 占位、无 dashed border 兜底。

### 5.2 视觉规范

| 区间 | stroke 色 | 中心数字色 | 中心字体 |
|---|---|---|---|
| pct < 60% | `#6E767D` slate | `#B0B0B6` | JetBrains Mono 500 9px |
| 60% ≤ pct < 80% | `#E07A4A` amber | `#E6E6E8` white | 同上 |
| pct ≥ 80% | `#D9544A` red | `#D9544A` bold | JetBrains Mono 600 9px |

- Ring 外径 22px、stroke 2px、轨道色 `#26262C`、起点 12 点钟方向、顺时针
- 中心数字:整数百分比,不带 `%` 符(节省视觉密度)
- Streaming 中:**不加 pulse 动画**(避免视觉噪音;数字本身就是状态)

### 5.3 hover tooltip

单行,float 在 ring 正上方,arrow 朝下对准 ring 中心:

```
Last call  124,003 / 200,000  62%
```

- 数字:Inter 500 11px、`font-variant-numeric: tabular-nums`
- 标签 "Last call":JetBrains Mono 10px 0.04em 字距
- 百分比染当前阈值色

### 5.4 click popover

```
SESSION USAGE
─────────────────
input       8,243
output      1,402
─────────────────
TOTAL       9,645
```

- 宽度 ~200px、padding 14px、shadow `0 8px 24px rgba(0,0,0,0.5)`
- 列:Inter 12px 标签 / Inter 500 12px 数字
- TOTAL 行:JetBrains Mono caps 10px 标签 / Inter 600 13px 数字、上方 hairline
- 关闭:再次点击 ring、点击外部、ESC

### 5.5 数字格式

- popover & tooltip:`Intl.NumberFormat("en")` → `8,243` 全展开
- ring 中心:整数百分比

### 5.6 挂载位置

`src/sidepanel/components/Chat.tsx` 内部 `Composer` 子组件(约 line 1380)的 action row,InstanceSelector 与 Send/Stop 之间:

```tsx
<InstanceSelector .../>
<ContextRing
  lastInputTokens={usage?.lastInputTokens}
  lastOutputTokens={usage?.lastOutputTokens}
  totalInputTokens={usage?.totalInputTokens ?? 0}
  totalOutputTokens={usage?.totalOutputTokens ?? 0}
  maxContextTokens={maxContextTokens}
/>
{streaming ? <stopBtn/> : <PieSendButton/>}
```

`maxContextTokens` 通过 `resolveModelMeta(provider, model)` 拿到(切 instance / model 即时变更)。

## 6. 边缘行为

| 场景 | 行为 |
|---|---|
| 新建 session、未发送 | ring 不渲染 |
| `done.usage` 缺失 | 不 persist、不 post、ring 不变 |
| `done.usage.inputTokens === 0` | 同上 |
| stream 多次 emit done(防御) | 取最后一次(while 循环天然) |
| 切 model / instance | maxContextTokens 立即换分母 → 百分比突变;下次 LLM 调用刷新 lastInputTokens |
| 任务 abort / error / max-steps | 已 persist 的 usage 不 rollback(真实发生过的开销) |
| compaction 砍 history | 不影响累计;下次 LLM 调用的 lastInputTokens 自然回落 → 用户看到收益 |
| SW 重启 / cold start | useSession mount 时从 SessionAgentState.contextUsage 读初始值灌 slot |
| 并发多 session | per-session port + sessionId routing 已有,`agent-usage` 自动定位 slot |
| 老 session 无字段 | ring 不渲染;下次 LLM 调用后出现 |
| chrome.storage 写失败 | warn log + 继续 post agent-usage(panel 显示即时即可) |
| custom provider 缺 maxContextTokens | ring 不渲染(无分母无意义) |

## 7. 测试策略

### 7.1 单元测试

**`src/lib/agent/loop.test.ts`** 新增 describe "issue #59 — context usage":

- stream emit done.usage → `setSessionAgent` 被 called with 正确 contextUsage
- 多步累计:3 步 done.usage 不同 → 末态 total === sum
- stream 没 done.usage → 未 persist 未 post
- usage.inputTokens === 0 → skip
- RMW 保留现有 contextUsage(pre-set + 1 步增量验证)
- emitDone tombstone carry-over:pre-set state → emitDone → tombstone state 仍有 contextUsage

**`src/lib/agent/loop.test.ts`** 单独 unit:

- `buildSessionAgentTombstone(synth, carryUsage)` 签名 + 返回结构

**`src/lib/sessions/storage.test.ts`** 扩 `mergeSessionAgentSnapshot`:

- snapshot merge 保留 contextUsage
- tombstone full-replace + carry 字段

**`src/sidepanel/hooks/useSession/port-handlers.test.ts`** 新增 "agent-usage":

- 灌 slot.usage、不触发 persistMessages、sessionId 路由

**`src/sidepanel/components/__tests__/ContextRing.test.tsx`** 新文件:

- lastInputTokens undefined → 不渲染
- maxContextTokens undefined → 不渲染
- 三色阈值切换(24/62/87)
- click → popover open/close、ESC、外部点击关闭

### 7.2 Cross-layer 测试

**`src/__tests__/cross-layer/context-usage-end-to-end.test.ts`** 新文件:

- loop done → port post → panel slot 更新(完整链路)
- 跨任务累计(task1 → emitDone tombstone → task2,验证 total carry)
- SW 重启模拟(pre-write SessionAgentState → mount → slot 灌入)

### 7.3 手工 verification

写入 `docs/solutions/2026-05-23-context-ring-issue-59.md` 作为 release 前 self-check:

1. 新 session,无 ring
2. 发首条,ring 出现、色随真实 usage
3. hover → tooltip;click → popover
4. 再发一条,累计 +,ring 数字刷新
5. 切 session 来回,ring 跟随 session 独立
6. 切 model/instance,分母变,百分比突变
7. `chrome.runtime.reload` 模拟 SW 死,重 mount,ring 从存储读回

### 7.4 不测的范围

- provider 层 done.usage 透出(现状已工作,无变更)
- compaction / sliding window 与 usage 的交互(零耦合)
- 持久化 schema 迁移(字段 optional,零迁移代码)

## 8. 不做的事(out of scope)

- compaction / sliding-drop / token-budget 事件标记(不引入 chat 流内 chip,也不在 popover 计数)
- 单步 token 拆解(哪步 observation 最大)
- prompt caching #57 的 cached vs uncached 分项展示
- estimated fallback(provider 不透 usage 时 ring 直接不渲染,不估算)
- model id / instance 名展示在 popover(MVP 不需要)
- 跨 session 总览(SessionDrawer 不显示 ring,保持列表轻量)

## 9. 文件改动清单(供 plan 参考)

| 文件 | 改动 |
|---|---|
| `src/lib/sessions/types.ts` | `SessionAgentState` +contextUsage |
| `src/types/messages.ts` | +`AgentUsageMessage` + 联合类型 |
| `src/lib/agent/loop.ts` | done 分支 capture + RMW + postMessage + tombstone carry-over |
| `src/lib/sessions/storage.ts` 或 loop.ts | `mergeSessionAgentSnapshot` 已天然保留 spread,无需改 |
| `src/sidepanel/hooks/useSession/runtime-map.ts` | slot 加 usage 字段 |
| `src/sidepanel/hooks/useSession/port-handlers.ts` | agent-usage branch |
| `src/sidepanel/hooks/useSession/index.ts` | mount 时读 SessionAgentState.contextUsage 灌 slot |
| `src/sidepanel/components/Chat.tsx` | Composer action row 挂 `<ContextRing>` |
| `src/sidepanel/components/ContextRing.tsx`(新) | Ring + Tooltip + Popover 组件 |
| 测试见 §7 | |

不动:provider 层、`SessionMeta` schema、`setSessionMeta`、`ChatDoneMessage.usage` 字段(继续保持死代码,后续清理)、compaction / sliding window 算法。
