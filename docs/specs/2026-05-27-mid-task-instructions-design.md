# Mid-Task Instructions — Design

> 状态：spec / brainstorm 阶段
> 日期：2026-05-27
> 作者：wenkang
> 相关 issue：#34

## 1. 背景与动机

当前 Pie agent 在执行 task 期间，sidepanel 的 Composer 输入框被 `disabled={streaming}` 锁死（`Chat.tsx:1480`）。用户一旦发起 task，只能等待整个循环结束、或点 STOP 中断后重发，无法基于 agent 的中间输出动态追加指令。

issue #34 提出"中途插队指令"机制：用户在 loop 进行中可以继续发送指令，这些指令不打断当前 ReAct step，但会在下一轮 LLM 调用前作为新的 user message 注入上下文，被模型在后续推理中纳入。

本设计落地该机制。

## 2. 目标 / 非目标

### 目标
- 用户可在 loop streaming 期间发送新指令；textarea 在 streaming 时保持 enabled
- 新指令进入 per-session pending queue，在当前 ReAct step 结束后、下一轮 LLM 调用前合并注入
- 用户可在新指令被消费前撤回单条
- pending queue 与 `agentMessages` 一同随 session 严格持久化，应对 SW restart / panel reload / disconnect
- UI 显式反馈 pending 状态（待处理 badge、× 撤回、Queue 按钮 affordance）

### 非目标
- **不**打断当前 ReAct step / 当前 LLM stream / 当前 tool 执行
- **不**为中途指令引入额外 confirm 层（与 Pie 现有 no-confirm 哲学一致）
- **不**区分"补充"vs"覆盖"语义；由 LLM 自行根据上下文判断
- 不引入 pending 数量 / 长度上限（第一版）；超长导致 token 错误走现有 error 路径
- 不修改 system prompt（无需"教模型识别 mid-task"，靠 wrapper 属性即可）

## 3. 用户故事

1. **U1（补充任务）**：用户让 agent "把所有 Reddit 标签页归到一个 group"。agent 工作中，用户想到"顺手也把 HN 的归进去"。textarea 中输入指令 → 在 STOP 旁边出现 Queue 按钮 → 提交 → 当前 step 结束后，agent 收到这条补充。
2. **U2（修方向）**：用户让 agent "在所有打开的标签页里找登录入口"。agent 进行了几步后用户意识到只关心 GitHub。用户直接在 Composer 输入"只看 github.com 就行"。下一轮 agent 收到调整。
3. **U3（错发撤回）**：用户输入完发现错了或者后悔了。在 pending bubble 上点 × → 立即从 queue 移除，模型不会看到。
4. **U4（SW 重启）**：用户连发两条 pending 后手机锁屏几分钟，SW 被 Chrome evict。回来时 panel 重连，pending 列表与 task 状态一同恢复，task resume 后下一轮 drain。
5. **U5（abort 后重启）**：用户在 loop 中连发两条 pending 但发现思路错了，点 STOP 中止任务。pending 保留在 queue。用户重新输入新的起始指令并提交 → 新 task 第一轮 LLM 同时收到新起始指令 + 之前 pending 的合并。

## 4. 架构

### 4.1 文件结构

**新增**
- `src/lib/sessions/pending-instructions.ts` — pending queue CRUD（`addPending` / `cancelPending` / `drainPending`），SW-side 唯一权威
- `src/__tests__/agent/pending-queue.test.ts` — unit
- `src/__tests__/agent/loop-drain.test.ts` — unit
- `src/__tests__/cross-layer/mid-task-instructions.test.ts` — cross-layer 主场景
- `src/__tests__/cross-layer/mid-task-recovery.test.ts` — SW restart / panel reload
- `src/__tests__/sessions/persist-pending.test.ts` — writeAtomic round-trip

**修改**
- `src/lib/sessions/types.ts` — `SessionAgentState` 增 `pendingInstructions: PendingInstruction[]`
- `src/types/` — port 消息类型新增 `chat-instruction-add` / `chat-instruction-cancel` / `chat-instruction-state` / `chat-instruction-rejected`
- `src/lib/agent/loop.ts` — for 循环顶部（`readFocusFromStorage` 后、LLM 调用前）增 drain 步骤
- `src/background/index.ts` — listener 处理三类新消息；reconnect 时主动 broadcast state
- `src/sidepanel/components/Chat.tsx` — textarea `disabled` 条件改写；action row 增 Queue 按钮；新增 `addPendingInstruction()` action 分发
- `src/sidepanel/hooks/useSession/index.ts` — 新增 `addPendingInstruction` / `cancelPendingInstruction` action；处理 `chat-instruction-state` broadcast

### 4.2 数据结构

```ts
// src/lib/sessions/types.ts
interface SessionAgentState {
  // ...existing fields
  pendingInstructions: PendingInstruction[];
}

interface PendingInstruction {
  chatMessageId: string;        // panel 生成的 ulid，对应 DisplayMessage.id（关联键，不重复内容）
  content: string;              // 用户输入文本（用于 drain 时拼合并 user message）
  expandedForLLM?: string;      // 若 panel 做了 slash-expand，drain 时优先用此字段（与 sendMessage 流程一致）
  attachments?: Attachment[];   // 若用户带了图（streaming 期间 ToolsMenu 隐藏，第一版多数情况为空）
  quotes?: Quote[];             // 同上
  createdAt: number;
}
```

**为什么 SW 端要存内容（而非纯索引）**：chat history (`slot.messages`) 是 panel-owned，SW 不读 panel 状态。drain 在 SW 内闭环（loop 顶部 → 拼合并文本 → push agentMessages → LLM 调用），不能依赖 panel 回送内容。所以 PendingInstruction 自带完整 payload。

**`chatMessageId` 作为关联键的用途**：
- panel 侧：cross-reference `slot.messages[i].id` 与 `pendingInstructions[j].chatMessageId`，决定 bubble 是否显示 pending badge
- 撤回 path：panel 用 chatMessageId 同时操作两边（删 DisplayMessage + 发 cancel）

**双写一致性**：因为 panel 和 SW 各自写自己的存储字段（`session_{id}_meta` vs `session_{id}_agent`），不是同一字段双写；通过 `chatMessageId` 关联两侧。撤回时 panel 先删 DisplayMessage（自己的字段），SW 收到 cancel 删 PendingInstruction（自己的字段），异步两步收敛。最坏情况（panel 删了但 SW cancel 丢失）：下一轮 drain 仍会消费这条 pending，LLM 收到一条"幽灵"补充 — 行为退化为"未撤回成功"，非数据破坏。

### 4.3 Port 消息类型

```ts
// panel → SW
{ type: "chat-instruction-add",     sessionId, chatMessage: ChatMessage }
{ type: "chat-instruction-cancel",  sessionId, instructionId: string }

// SW → panel（每次 queue 变更后 broadcast）
{ type: "chat-instruction-state",   sessionId, pending: PendingInstruction[] }

// SW → panel（add 时 loop 已结束）
{ type: "chat-instruction-rejected", sessionId, reason: "not-streaming" }
```

### 4.4 数据流

#### 添加路径
```
panel.Chat.tsx: streaming && input.trim() → Queue 按钮可见
   ↓ onSend
useSession.addPendingInstruction({ content, attachments, quotes, expandedForLLM })
   ↓ chatMessageId = ulid()                                  // panel-generated
   ↓ slot.messages.push({ role: "user", content, id: chatMessageId, ... })
   ↓ persistMessagesById(sessionId, updated)                 // 写 session_{id}_meta
   ↓ port.postMessage chat-instruction-add { sessionId, chatMessageId, content,
                                              attachments?, quotes?, expandedForLLM? }
SW.background.index.ts: listener
   ↓ if (!isStreaming(sessionId)) → reply chat-instruction-rejected → panel 降级 chat-start
   ↓ pendingInstructions.push({ chatMessageId, content, attachments?, ...createdAt })
   ↓ writeAtomic session_{id}_agent
   ↓ broadcast chat-instruction-state { sessionId, pending }
panel 收 state → cross-reference slot.messages[i].id 与 pendingInstructions[j].chatMessageId
                → 给匹配的 bubble 加 pending badge
```

**所有权分明**：
- panel 是 `slot.messages` (`DisplayMessage[]`) 的唯一 writer；chat history bubble 由 panel 直接 append
- SW 是 `SessionAgentState.pendingInstructions` 与 `agentMessages` (LLM IR) 的唯一 writer
- 两侧通过 `chatMessageId` (panel 生成 ulid) 关联；SW 不需要回写 chat history
- pending **完整内容**（text/attachments/quotes/expandedForLLM）也保存在 `PendingInstruction` 内（SW 端必须能在 drain 时独立构造合并 user message，不依赖 panel 回送）— 这是 §4.2 "queue 只存索引" 的修订，原因见下

#### 撤回路径
```
panel.PendingBubble: × click on chatMessageId=X
   ↓ useSession.cancelPendingInstruction(X)
   ↓ slot.messages = filter(m => m.id !== X)                  // panel 自己删 DisplayMessage
   ↓ persistMessagesById(sessionId, updated)
   ↓ port.postMessage chat-instruction-cancel { sessionId, chatMessageId: X }
SW: listener
   ↓ pendingInstructions = filter(p => p.chatMessageId !== X) // SW 自己删 PendingInstruction
   ↓ writeAtomic session_{id}_agent
   ↓ broadcast chat-instruction-state { pending }
panel 收 state-update → reconcile（通常已经一致，no-op）
```

#### 消费路径（drain）
```
runAgentLoop for 循环顶部:
   readFocusFromStorage(...)
   if (signal.aborted) break
   ▼
   const pending = await drainPendingInstructions(sessionId)
   //   原子：读 queue + 清空 + writeAtomic + broadcast state pending=[]
   if (pending.length > 0) {
     const merged = pending.map((p, i) =>
       `${i+1}. ${escapeUntrustedWrappers(p.expandedForLLM ?? p.content)}`
     ).join("\n\n")
     agentMessages.push({
       role: "user",
       content: `<untrusted_user_message source="mid_task">\n${merged}\n</untrusted_user_message>`,
     })
   }
   ▼
   LLM 调用

panel 端：收到 broadcast pending=[] 后，slot.messages 里的 bubble 失去 cross-reference 匹配，
        pending badge 自然消失（仅显示为普通 user message bubble）。slot.messages 不变。
```

#### Abort 路径
```
user 点 STOP → existing internalController.abort()
   loop break → status 转 idle
   pendingInstructions 不清空（保留）
后续 user chat-start { sessionId, content }:
   SW 在 handleChatStream 起 loop 前：
   ─ const pending = drainPendingInstructions(sessionId)
   ─ if (pending.length > 0):
       第一条 user message 内容 = content + "\n\n[Earlier mid-task additions]\n" + merged_pending
       （新输入 + 残留 pending 合成一条；merged_pending 沿用 drain 的拼接格式）
   ─ 起 loop 进入正常流程（loop 顶部本身不会再次 drain，因为已空）
```

#### Recovery 路径
```
SW idle eviction:
   pendingInstructions 已在 writeAtomic 持久化
   下次 SW 启动 → loadSession → state.pendingInstructions 回到内存
panel reconnect:
   port.onConnect → SW 主动 broadcast chat-instruction-state（每 active session）
   panel 校正本地视图
```

### 4.5 输入框行为表

| session.status | loop streaming | textarea 状态 | 输入回车走哪条路径 | 右下按钮 |
|---|---|---|---|---|
| active | 否 | enabled | `chat-start`（原） | PieSendButton（input 非空时显示） |
| active | 是 | **enabled**（新） | `chat-instruction-add`（新） | STOP 始终显示；Queue 按钮在 `input.trim()` 时显示在 STOP 左 |
| paused | — | disabled | — | — |
| failed / archived | — | disabled | — | — |

## 5. UI 设计

参见 Paper artboard `12 — Composer · Mid-Task Pending · Dark`（file: "Pie Frontend"）。

### 5.1 Composer 修改（`Chat.tsx:1471-1564`）

- **textarea `disabled` 条件**：`disabled={streaming}` 改为 `disabled={!sessionAllowsInput}`，其中 `sessionAllowsInput = status === "active"`；placeholder **不变**
- **action row**：
  - streaming 时 `ToolsMenu` 仍隐藏（`!streaming` 现有条件）
  - `InstanceSelector` 仍 `locked={streaming}`（dimmed pill）
  - `ContextRing` 仍渲染
  - STOP 按钮 `streaming` 时始终渲染（沿用现有）
  - **新增** Queue 按钮：仅在 `streaming && input.trim()` 时渲染，**STOP 左侧**，复用 `PieSendButton` 视觉（白底箭头 icon-only）
  - 非 streaming 时维持现状（STOP 不显示，PieSendButton 显示）

### 5.2 Pending List 区

Composer 容器上方（仍在 `border-t` 内的同一块），结构：

- Caption 行：暖金圆点 + `PENDING · N IN QUEUE`（JetBrains Mono 10/12，`#C9A268`），右侧 `SENT NEXT TURN` 微文案（`#525965`）
- 每条 pending row：
  - surface `#14181E`（比普通 surface `#1A1E25` 暗，表达"未生效"）；hover 提到 `#181D24`
  - border `#1F242C`；hover 提到 `#2A3038`
  - 左侧暖金圆点（6px，`#C9A268`），与 caption 同色
  - 中间文本（Inter 13/18，`#C2C7CF`）
  - 右侧 × 撤回按钮（10px svg，默认 `#525965`，hover `#C9C9CD`）
- 空 queue 时整个 Pending List 区不渲染

### 5.3 已消费视觉态

被 LLM 消费后（panel 收 broadcast `pending=[]` 或 pending 不再含该 chatMessageId）：
- bubble 失去 cross-reference 匹配 → pending badge / × 自动消失
- bubble 视觉切换为 chat history 里普通 user message bubble（沿用 `User Message` 的右对齐 + `#1A1E25` surface）
- DisplayMessage 本身不变（仍是同一条 `{ role: "user", content, id, ... }`），只是 panel 渲染时不再叠加 pending 样式
- pending caption 计数减少；归零时整个 Pending List 区消失

### 5.4 DisplayMessage 类型扩展

`src/types/messages.ts` 的 user 变体增加 optional `id` 字段：

```ts
| {
    role: "user";
    content: string;
    expandedForLLM?: string;
    attachments?: Attachment[];
    quotes?: Quote[];
    /** Issue #34 — ulid set by panel when message is added via
     *  addPendingInstruction during streaming. Used to cross-reference
     *  pendingInstructions broadcast from SW. Absent on normal user
     *  messages (sendMessage path). */
    id?: string;
  }
```

字段 optional，老消息无此字段 → 永远不显示 pending badge（向后兼容）。

## 6. 关键决策（why）

| 决策 | 原因 |
|---|---|
| LLM 自行判断"补充 vs 修方向"，不区分语义 | 与 Claude Code 等成熟产品的协作直觉一致；保持 UX 极简；模型从 wrapper `source="mid_task"` 与上下文足以判断 |
| ReAct step 结束后注入，不打断 | 不浪费已耗 tokens；不出现 tool 执行不一致；语义最干净 |
| 多条合并为单条 user message | 上下文紧凑；避免连续 user role 对部分 provider 不友好；与"会话风格"一致 |
| queue 随 session 严格持久化（writeAtomic） | 沿用现有 SessionAgentState 持久化路径；recovery 免费；SW eviction 不丢用户意图 |
| SW 是 queue 唯一权威 mutator | 与 Pie "SW 是 session 权威" 既有 invariant 一致；撤回/竞态/恢复都简单；panel 仅消费 broadcast |
| Pending 内容存 ChatMessage，queue 只存索引 | 避免双写不一致；UI 统一渲染走 chat history pipeline；撤回 = 删 ChatMessage + 删 index，对称 |
| 注入仍包 `<untrusted_user_message>` wrapper | 沿用现有 prompt-injection 防御；mid-task 不绕过 wrapper 路径；source 属性区分用途 |
| 不修改 system prompt | system 稳定不变；模型靠 wrapper 属性识别 mid-task 来源 |
| abort 后 queue 保留 | abort ≠ 否认这些指令；用户可能正是因为 pending 内容想换方向；下次 chat-start 时 drain |
| Queue 按钮仅在有输入时出现 | "何时出现"自然表达 affordance；无需多余提示文案；与现有按钮密度一致 |
| placeholder 不变 | 用户做"额外输入"的心智模型与平时发消息没差别；改变 placeholder 反而增加学习成本 |
| 无 confirm 层 | 与项目 no-confirm 不变量一致；撤回机制已经提供"后悔通道"，confirm 多余 |

## 7. 错误处理 & 边界

| 场景 | 处理 |
|---|---|
| panel 发 `chat-instruction-add` 时 SW 已不在 streaming | SW 回 `chat-instruction-rejected { reason: "not-streaming" }`；panel 降级为 `chat-start` 起新 task（等价于"我手快按晚一拍"） |
| panel 发 `chat-instruction-cancel` 时该 id 已被 drain | 幂等忽略；SW 返回当前 state（不含该 id）；panel UI 仍同步收到 broadcast |
| drain 后 LLM 调用失败 | queue 已 drain；与现有 chat-start 失败一致（toast + 用户重发）；不自动塞回 |
| streaming 中 user 点 STOP | queue 保留；下次 chat-start 时合并到第一轮 user message |
| SW restart / panel disconnect → reconnect | reconnect 时 SW 主动 broadcast `chat-instruction-state`；panel 同步 |
| panel reload | 走现有 session resume 路径；`pendingInstructions` 已持久化 |
| 多 session：A streaming + B idle，B 输入 | B 走 `chat-start`；A queue 不变（per-sessionId scope） |
| session paused | textarea disabled；queue 保留但不消费 |
| 单条 instruction 超长 | 第一版不限长；token 超限走现有 LLM error 路径 |
| Queue 过深 | 第一版不限条数；Pending List 区 max-height + 滚动 |
| 用户写 `</untrusted_user_message>` 等 escape 攻击 | `escapeUntrustedWrappers` 处理（沿用现有） |

## 8. 测试策略

详见 §10 文件清单。覆盖 unit / cross-layer / recovery / isolation / invariant guard 五类。关键测试：

- **add → drain → 注入** 完整链路：LLM 收到末尾合并 user message
- **多条合并**：3 条 add → 一个 step 内 → drain 一次合并为 1 条 user message
- **撤回**：add → cancel → drain → 不注入
- **拒绝**：loop 刚结束 add → reject → panel 降级 chat-start
- **abort 保留**：streaming → abort → 下次 chat-start → drain 同步到第一轮
- **SW restart**：streaming + 非空 queue → eviction → reconnect → loop resume → drain
- **isolation**：多 session 不污染；paused session 不消费
- **escape**：用户输入含 `</untrusted_user_message>` → 安全包裹

## 9. Invariant 清单

新增/沿用：

- (P-MTI-1) `chat-instruction-add` / `cancel` 必须带 `sessionId`；SW 严格 scope，不跨 session
- (P-MTI-2) SW 是 `pendingInstructions` 唯一 mutator；所有变更顺序固定为 `mutate → writeAtomic → broadcast`
- (P-MTI-3) loop 顶部检查顺序：`abort check → drain → LLM call`；abort 已置则不 drain
- (P-MTI-4) `drainPendingInstructions` 是原子操作：读 queue + 清空 + 持久化 + broadcast 在同一调用内完成
- (P-MTI-5) 中途指令 **必须**包 `<untrusted_user_message source="mid_task">`；从不进 system role
- (P-MTI-6) `chatMessageId` (panel 生成 ulid) 是 panel `DisplayMessage.id` 与 SW `PendingInstruction.chatMessageId` 的关联键；两侧各自存所需视角的内容（panel 存显示用，SW 存 drain 用）
- (P-MTI-7) 撤回 = panel 删 DisplayMessage + SW 删 PendingInstruction（两侧各操作自己的字段，通过 chatMessageId 协调）；不留 placeholder
- (P-MTI-8) reconnect 时 SW 必须主动 broadcast `chat-instruction-state` 同步 panel
- (P-MTI-9) abort 不清 queue；queue 持久跨 abort，在下次 chat-start 第一轮 drain

## 10. 文件清单

**新增**
- `src/lib/sessions/pending-instructions.ts`
- `src/__tests__/agent/pending-queue.test.ts`
- `src/__tests__/agent/loop-drain.test.ts`
- `src/__tests__/cross-layer/mid-task-instructions.test.ts`
- `src/__tests__/cross-layer/mid-task-recovery.test.ts`
- `src/__tests__/sessions/persist-pending.test.ts`

**修改**
- `src/lib/sessions/types.ts`（`SessionAgentState` + `PendingInstruction`）
- `src/types/`（port 消息类型扩展）
- `src/lib/agent/loop.ts`（drain 步骤）
- `src/background/index.ts`（三类新消息 listener + reconnect broadcast + chat-start 前置 drain）
- `src/sidepanel/components/Chat.tsx`（textarea / action row / Pending List 渲染）
- `src/sidepanel/hooks/useSession/index.ts`（新 actions + state broadcast 处理）

**不动**
- system prompt（保持稳定）
- `untrusted-wrappers.ts`（仅复用现有 `untrusted_user_message`，加 `source="mid_task"` 属性）
- 现有 abort 路径
- multi-instance / multi-session 既有架构

## 11. Non-goals / 留作 follow-up

- pending 条数 / 单条长度上限（出现 token 错误后再评估）
- "立即打断"模式（power user 单独按钮 / shift+enter）— 待真实需求触发
- pending 跨 session 行为（目前严格 per-session，不引入跨 session 队列）
- pending 与 record/replay skill 的交互（待 R&R 自身设计稳定）
