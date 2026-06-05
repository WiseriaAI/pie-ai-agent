# abort 中途停止的消息丢失 — 调查与修复设计

- 日期：2026-06-06
- 状态：A 已修复（TDD 完成）；B 设计已批准，待 plan
- 触发：用户反馈 loop 中途停止后，sidepanel 里 agent 最近几段消息会消失；且怀疑下一轮发给 LLM 时丢失最新 messages。

## 背景：一次任务有两份独立存储

| 存储 key | 内容 | 服务对象 |
|---|---|---|
| `session_${id}_agent` | raw `agentMessages`（含完整 tool args / tool_use / tool_result） | LLM resume / 下一轮上下文 |
| `session_${id}_meta` | `DisplayMessage[]` | sidepanel 渲染 |

中途点"停止"时，SW 的 loop 在 streaming 中被 `signal.aborted` 打断直接 return（`loop.ts:1558`），**不发 `chat-done`**，而是走 `finally → emitDone("abort")`（`loop.ts:2100+`）。emitDone 给 panel 发 `agent-done-task`，给 `_agent` 写一个 tombstone。

用户的两个观察分别命中两层的两个独立缺陷。

---

## 根因 A（UI 层）：中断瞬间正在流式输出的 assistant 气泡被丢弃

panel 端所有会清空流式累积（`accumulated` / `streamingThinking`）的 handler，**只有 `agent-done-task` 这一条不先 flush**：

- `chat-done`（port-handlers.ts:106）✅ 先 `buildAssistant` flush 再清
- `chat-error`（:124）✅ flush
- `agent-step`（:146）✅ flush
- disconnect handler（:299）✅ flush
- **`agent-done-task`（:183-205）❌ 直接 `patchSlot({ accumulated:"", streamingThinking:"", streamingText:"" })`，没有 `buildAssistant`**

abort 走的正是 `agent-done-task`。当用户在 LLM **正流式输出思考/正文的中途**点停止 → 屏幕上那段正在流的内容被直接丢弃，既不转成正式消息也不持久化，取而代之只追加一条"任务已取消"的灰色 summary，再 `persistMessages` 把不含流式内容的数组写回 `_meta`（:203）—— reload 也回不来，永久丢失。

### 修复（已完成，TDD）

`port-handlers.ts` 的 `agent-done-task` handler 在追加 summary 前先 `buildAssistant(baseMessages, accumulated, thinking)` flush，和其它四条路径对齐。

- 测试：`port-handlers.test.ts` 新增 "flushes in-flight streamed text/thinking before the summary on mid-stream abort"。
- 原有空 slot 用例（accumulated 为空 → `buildAssistant` 返回 base 不变）仍通过。
- `pnpm test src/sidepanel/hooks/useSession/` → 68 passed。

---

## 根因 B（LLM 层）：被中断任务对下一轮只剩一句"任务已取消"

emitDone 给 `_agent` 写的 tombstone 是 `(agentMessages=[], stepIndex=0)`，**完全清空** raw 历史（`loop.ts:580-597`，merge 时 bypass、full replace），只把整段任务压缩成一个 `lastTaskSynth` 文本摘要。

而 `synthesize-agent-turn.ts:138-160`：`stepListPart`（最近 5 步 tool 列表）**已经算好了**，`success`/`fail`/`max-steps` 三条分支都拼了它，**唯独 abort 分支（:156-160）没拼**，body 只有 `[任务中断] 任务已取消`。

跨 task 边界，pie 本就只传 user/assistant 文本 + `lastTaskSynth` 一句摘要重建 LLM history（`background/index.ts:1138-1154`），从不传工具历史。所以 abort 后下一轮 LLM 完全不知道被中断任务读了什么页、调了什么工具、拿到什么结果。

### 决策：这不是"补摘要"，而是改"abort 不该被当成任务结束"

参照 Claude Code 等 coding agent，中断后完整 context 还在，下一句接着原 context 干。pie 把 abort 当"已完成任务"压缩，丢了"我想插话/纠正后继续"的语义。

关键发现：**pie 早就有"带完整 raw 历史续接"的能力 —— `resume-task` 路径**（`handleResumeRequest`，`background/index.ts:696`，从 `_agent` 读 `resumedAgentMessages` + `resumedFromStep` 续接），用于"SW 死 / reload → paused → Resume task 按钮"。abort 现在走的是完全相反的路径。B 的本质就是让 abort 接上这条已有能力。

`runAgentLoop` 同时支持两种 seed：`messages`（string 重建，chat-start 用）与 `resumedAgentMessages`+`resumedFromStep`（raw 续接，resume-task 用）。

---

## B 设计：abort 保留完整历史、自动续接

### 用户决策（已确认）
- 续接方式：**直接接着聊，自动续接**（无按钮）。
- 放弃出口：**新建 session**（零额外 UI）。

### 1. emitDone 按 `terminationReason` 分叉
- **success / fail / max-steps**：维持现状（tombstone 清空 + `lastTaskSynth` 摘要压缩）。
- **abort**：**不写清空 tombstone**，保留 `agentMessages` + `stepIndex`（及 `hasImageContent` / `currentFocusTabId` / `contextUsage`），**不生成** `lastTaskSynth`。

abort 在存储层留下的即一个"in-flight 中断点"，形态等同"SW 死时任务没跑完"。

### 2. 续接触发：两条路径统一复用现有续接能力
1. **panel 存活（主路径）**：用户直接打字 → 正常 chat-start → SW 检测 `_agent` 有保留的 in-flight 历史（`agentMessages` 非空 & `stepIndex>0`）→ 以 `resumedAgentMessages` seed loop + 把用户新消息作为新一轮 user turn 追加 → 续接。无按钮。
2. **panel reload / SW 死**：现有 M1-U5 cold-start 扫到 `stepIndex>0` → 标 paused → 已有 "Resume task" 按钮 → 走 resume-task 续接。

### 3. 新消息如何并入
chat-start 续接时：`history = 保留的 raw agentMessages + {role:"user", content: 新消息}`。loop 从此 seed 跑。（实现走 `runAgentLoop` 的 `resumed*` 参数 + 一条追加 user turn，plan 阶段定细节。）

### 4. 历史何时真正清空
- 续接出来的那次任务正常完成（success/fail）→ 届时 tombstone 清空（现状逻辑自然生效）。
- 用户新建 session 开全新任务 → 旧 session 历史留着不复用，无影响。

### 5. context 安全
续接带完整工具历史，但 loop 每轮跑 sliding window + token budget + compaction（`loop.ts:1450-1490`）兜底，不会爆 context。

### 6. abort 后 status 落点
- panel 存活时 status 须保持可输入态（输入 gating 靠 `streaming` 标志，abort 后 `agent-done-task` 已翻 `streaming=false`，可直接输入）。
- cold-start（reload / SW 死）仍按 `stepIndex>0` 判 paused → 走 Resume 按钮。
- 两条路都续接完整历史，一致。

### 影响文件
- `src/lib/agent/loop.ts` — emitDone 按 `terminationReason` 分叉（abort 不清空 / 不 synth）
- `src/background/index.ts` — chat-start 检测保留历史 → resumed seed + 追加新 user 消息
- 可能 `runAgentLoop` 入参 — 支持"续接 + 一条新 user 消息"
- 测试 — loop abort 分支、chat-start 续接

### 不做（YAGNI）
- 不加任何"放弃/重开"UI（新建 session 即可）。
- 不动 success/fail/max-steps 的压缩行为。
- 不再给 abort 补 stepListPart（不走摘要了）。

### 已知 trade-off
abort 后即使输入完全无关的新任务，也会拖着旧历史（靠新 user turn + sliding window 缓解）——"直接接着聊"的固有代价，用户已认可。
