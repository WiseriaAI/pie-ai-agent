# 思考过程（thinking / reasoning）渲染与回喂

- 日期：2026-06-01
- 关联 issue：#93（[MiniMax] Chat 界面未对模型的 `<think>` 标签思考过程做单独渲染）
- 状态：设计已确认，待写实施 plan

## 背景与问题

当前全链路没有任何"思考过程"概念：

- `StreamEvent` 只有 `text-delta` / `tool-call-*` / `done` / `error`。
- `ChatMessage` / `DisplayMessage` 的 assistant 内容是纯 `string`；`ContentBlock` 只有 `text` / `tool_use` / `tool_result` / `image`。
- `openai-compat-core.ts:194` 只读 `delta.content` → `text-delta`。结果：
  - `reasoning_content`（DeepSeek-R1 系）/ `reasoning`（OpenRouter 系）字段被**直接丢弃**，思考完全不显示。
  - `<think>…</think>` 内联在 `content` 里 → 当普通文本进气泡（即 #93）。
- `anthropic-sdk-core.ts` 只处理 `text_delta` / `input_json_delta`，**忽略** thinking content block。

#93 原本是 MiniMax 走 OpenAI-compat 时的现象；MiniMax 改走 Anthropic 接口后该实例消失，但其他 OpenAI-compat provider 仍存在同类问题。

## 目标

1. **OpenAI-compat provider**：把思考（`reasoning_content`/`reasoning` 字段 + `<think>` 内联标签）从正文里分离出来，单独渲染。**仅展示，不回喂 LLM**（避免 DeepSeek 类接口对 `reasoning_content` 回传返回 400，以及 `<think>` 文本污染正文）。
2. **Anthropic-wire provider**（anthropic / deepseek / minimax / mimo 经 `anthropic-sdk-core`）：把原生 thinking content block 单独渲染，**并按 Anthropic 的 tool-use 回放规则保留回喂**（thinking block 前插进 assistant 轮次、带签名）。
3. 两类 provider 的思考用**同一种 UI 形式**渲染。
4. 思考**持久化到 session**，刷新后仍可见。

## 非目标（v1）

- **不**在本次为真 Anthropic（Claude）主动开启 extended thinking（`thinking:{type:"enabled",budget_tokens}`）。Claude 默认不吐 thinking，本次只被动渲染 provider 原生产出的 thinking（minimax M3 / deepseek 经 anthropic 接口等）。Claude 的开关（带 budget UI + temperature=1 约束 + promptCache 交互）留作 fast-follow。
- **不**支持 `<thinking>` 等非 `<think>` 标签（留扩展）。
- **不**做交错 thinking（thinking→tool→thinking→tool）的精细顺序保持；按到达顺序前插即可。
- **不**做"丢弃旧 turn thinking"的 context 优化，旧 thinking 随 assistant 内容留存，裁剪交给现有 sliding window。

## 架构（分层）

数据流：provider 流 → core 解析为 `StreamEvent` → `loop.ts` 消费（累积 + 投 port + 构建 AgentMessage IR）→ port → panel state → 渲染。

### 1. StreamEvent（`src/lib/model-router/types.ts`）

新增三段式事件（仿 `tool-call-start/delta/end`）：

```ts
| { type: "thinking-start"; replay: boolean }
| { type: "thinking-delta"; text: string }
| { type: "thinking-end"; signature?: string }
```

- `replay`：`true` = 该思考应保留进 AgentMessage 回喂（anthropic-wire）；`false` = 仅展示（openai-compat）。由 core 决定，`loop` 据此分流，保持 `loop` 对 provider 无关。
- `signature`：anthropic thinking block 的回放签名，仅 anthropic-wire 在 `thinking-end` 携带（可能缺省）。

### 2. ContentBlock IR（`src/lib/model-router/types.ts`）

```ts
| { type: "thinking"; thinking: string; signature?: string }
```

加入 `ContentBlock` 联合类型。仅 anthropic-wire 回喂路径会生成。

### 3. openai-compat-core（产出 `replay:false`）

在 `streamChatOpenAICompat` 的 delta 处理中：

- **reasoning 字段**：读 `delta.reasoning_content`（DeepSeek 系）与 `delta.reasoning`（OpenRouter 系）。任一非空时：首个 reasoning chunk 前先发一次 `thinking-start{replay:false}`，随后每 chunk 发 `thinking-delta`。当首个正文 `delta.content` 到达或流结束时发 `thinking-end`（无签名）。
- **`<think>` 内联标签**：对 `delta.content` 走新增的流式状态机 `ThinkTagSplitter`（见下），把内部内容 → `thinking-delta`、外部 → `text-delta`，标签剥除。

两个来源独立判断、可并存但实际通常二选一。

#### ThinkTagSplitter（新文件 `src/lib/model-router/think-tag-splitter.ts`）

跨 chunk 的流式标签拆分器，纯函数式状态：

- 接口：`feed(chunk: string): Array<{ kind: "text" | "think"; text: string }>`，以及 `flush()` 收尾。
- 状态：`outside` | `inside`，外加一个 carry 缓冲处理被切断的标签（最多缓冲 `"</think>".length - 1` 个尾字符，避免把可能是标签前缀的字符误判为正文）。
- 行为：识别 `<think>` 进入 inside、`</think>` 退出；标签本身不输出；inside 文本标 `think`，outside 文本标 `text`。
- 可在无标签输入时零开销直通（性能：绝大多数 provider 不发 `<think>`）。

`openai-compat-core` 用它把 `delta.content` 切成 text/think 两路，分别 yield。

### 4. anthropic-sdk-core（产出 `replay:true`）

在事件循环里新增：

- `content_block_start` 且 `content_block.type === "thinking"` → 记该 index 为 thinking 块，发 `thinking-start{replay:true}`。
- `content_block_delta`：`delta.type === "thinking_delta"` → 发 `thinking-delta{text: delta.thinking}`；`delta.type === "signature_delta"` → 累积签名（不 yield）。
- `content_block_stop`（thinking 块）→ 发 `thinking-end{signature}`。

`toSdkParams` 回传序列化：`ContentBlock` 为 `thinking` 时 → `{ type:"thinking", thinking, ...(signature?{signature}:{}) }`，且在 content 数组中**置于 text/tool_use 之前**。

> 风险点（交给真机测试）：把无签名的第三方 thinking 块回传给某些端点是否被接受、真 Anthropic 在未开启 extended thinking 时是否拒收 thinking 块。因本次不为 Claude 开启 extended thinking，Claude 不会产出 thinking，故不会向 Claude 回传 thinking；第三方（minimax/deepseek）回传按其自身模式。

### 5. loop.ts（消费与 IR 构建）

新增累积态：`thinkingAccum: string`、`thinkingReplay: boolean`、`thinkingSignature: string | undefined`、`thinkingBlocks: ThinkingBlock[]`。

- `thinking-start` → 重置 `thinkingAccum`/`thinkingSignature`，记 `thinkingReplay`。
- `thinking-delta` → `thinkingAccum += text`；`port.postMessage(withSession({type:"thinking-chunk", text}, sessionId))`。
- `thinking-end` → 记 `thinkingSignature = signature`；若 `thinkingReplay`，push `{type:"thinking", thinking:thinkingAccum, signature}` 进 `thinkingBlocks`。
- 构建 assistant AgentMessage（现 `loop.ts:1646` 附近）：`assistantBlocks` 组装时**前插** `thinkingBlocks`（到达顺序），再接 text/tool_use。`replay:false` 的思考从不进 `thinkingBlocks`，故不回喂。

### 6. Port 协议 + DisplayMessage（`src/types/messages.ts`）

- 新 port 消息：`{ type: "thinking-chunk"; text: string; sessionId: string }`。
- `DisplayMessage` 的 assistant 变体加可选字段 `thinking?: string`。
- `chat-done` 时，把面板累积的 thinking 落到该 assistant `DisplayMessage.thinking`。

### 7. Panel（`src/sidepanel/`）

- port-handlers 新增：累积 `thinking-chunk` → `streamingThinking`（与 `streamingText` 并行）；`chat-done` 时把 `streamingThinking` 写入新消息的 `thinking` 字段并清空。
- 新组件 `<ThinkingSection>`（`src/sidepanel/components/`），复用 `AgentStepGroup` 折叠模式：
  - **默认折叠**；toggle「思考过程」+ 可旋转 chevron；`aria-expanded`。
  - 展开内容用 `<MarkdownContent>` 渲染思考文本。
  - 折叠态样式沿用 `border-l border-line pl-2.5` 缩进。
- 在 `MessageBubble` assistant 分支、正文**之前**渲染（`message.thinking` 非空才显）。
- 流式中：`streamingThinking` 非空时显示折叠的「思考中…」+ spinner；用户可展开看实时；完成后保持折叠（默认）。

### 8. 持久化

- `DisplayMessage.thinking` 随 session render store 持久化 → 刷新后可见。
- anthropic-wire 的 `thinking` ContentBlock 随 raw `agentMessages` 持久化（LLM resume 回放需要原始 context）。
- `redactArgsForPanel` 不受影响（thinking 是文本，不是 tool args）。
- 纯新增可选字段，老 session 缺字段即不渲染，**无需 migration**。

## 测试

- **think-tag-splitter**：无标签直通；单 chunk 内完整 `<think>…</think>`；标签跨 chunk 切断（`<th|ink>` / `</thi|nk>`）；`<think>` 不在起始位置；多段 think。
- **openai-compat-core**：`reasoning_content` → `thinking-*`(replay:false)；`reasoning` 字段同理；`<think>` 内联被分流且 text 不含标签；无思考时行为不变（回归）。
- **anthropic-sdk-core**：`thinking_delta` → `thinking-delta`(replay:true)；`signature_delta` → `thinking-end{signature}`；`toSdkParams` 把 `thinking` block 序列化回 wire 且置于最前。
- **loop**：`thinking-delta` 投 `thinking-chunk`；`replay:true` 生成 `thinking` block 且前插 assistant 内容；`replay:false` 不进 AgentMessage。
- **panel/port-handlers**：`thinking-chunk` 累积进 `streamingThinking`；`chat-done` 落到 `DisplayMessage.thinking`；`<ThinkingSection>` 默认折叠、可展开、持久化后重渲染可见。

## 契约/不变量影响

- `StreamEvent` 与 `ContentBlock` 扩了成员 → 所有 `switch`/消费点需处理新分支（build-time 无强制，但 loop/cores 必须覆盖）。
- 新 port 消息类型纳入 `messages.ts` 的联合 + port-handlers 分发。
- 维持现有不变量：`<untrusted_*>` 包装不变（thinking 来自模型自身输出，非页面不可信内容，按 trusted 模型输出处理，渲染在 assistant 气泡内，不进 system role）。

## 已知 v1 简化（再次明确）

- 交错 thinking 顺序：按到达顺序前插，不精细重排。
- 旧 turn thinking 不主动裁剪，依赖现有 sliding window。
- 仅 `<think>` 标签；Claude extended thinking 开关留 fast-follow。
