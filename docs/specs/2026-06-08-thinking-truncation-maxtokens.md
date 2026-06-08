# 长思考截断导致 loop 中断 — 设计 spec

> 日期：2026-06-08
> 状态：设计已确认，待写实施 plan

## 问题

reasoning 模型思考很长时，响应会在 thinking 中途被截断，整个 agent loop 随之"静默收工"中断。表现为：任务没做完，但 loop 当成 LLM 给了最终答复就结束了。

## 根因（两个因素叠加）

### 因素 1：Anthropic-wire 家族被写死 `max_tokens: 4096`

- `src/lib/model-router/providers/_shared/anthropic-sdk-core.ts:145`：`max_tokens: config.maxTokens ?? 4096`。
- `max_tokens` 是**输出**上限，且 reasoning 模型的 **thinking token 算进同一个预算**。长思考吃光 4096 → 服务端从 thinking 中途截断 → `stop_reason: "max_tokens"`。
- 影响范围：**anthropic / deepseek / minimax / mimo**（全部走官方 `@anthropic-ai/sdk`）。其中 Anthropic 官方模型我们**没发 `thinking` 参数**（请求体 142-150 无 thinking 字段，官方 adaptive thinking 默认关），故官方模型不思考、不受影响；真正受害的是**自动产出 reasoning 的第三方模型 deepseek-reasoner / minimax / mimo**。

#### 为什么不能"直接不传 max_tokens"

- 官方 SDK 类型 `MessageCreateParamsBase.max_tokens: number` 是**必填**（`node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:1955`，无 `?`），Anthropic Messages API 缺它会 400。anthropic-wire 走官方 SDK，**送不出"不带 max_tokens"的请求**。
- 对照：**OpenAI-compat 家族**（`openai-compat-core.ts:133` = `maxTokens != null && {max_tokens}`）没设就不发、直接吃 provider 默认——**这条路已经是"取消"的现状，无需改动**。
- 结论：anthropic-wire 必须送一个值，只能把 4096 换成**该模型的真实最大输出**。

### 因素 2：loop 把"截断"误判为"任务完成"

- provider 已把 `max_tokens` 映射成 `stopReason: "length"`（`anthropic-sdk-core.ts:91`）并在 `done` 事件带出。
- loop 的 `done` 处理（`loop.ts:1552-1558`）**只读 `event.usage`，丢弃 `stopReason`**。
- 截断响应常无 tool call（预算烧在 thinking 上）→ 命中 `loop.ts:1648` 的 `completedToolCalls.length === 0` 分支（"Pure text response — finish as normal chat"）→ `chat-done`、loop 结束。
- loop 无法区分"LLM 干净收工"和"被从思考中途砍断"——两者都是"0 tool call → 收工"。

## 设计

### 因素 1：按模型给足 `max_tokens`

1. `ModelMeta`（`src/lib/model-router/providers/registry.ts`）新增可选字段 `maxOutputTokens?: number`（与现有 `maxContextTokens` 并列；后者=输入窗口，前者=输出上限）。
2. registry 各 anthropic-wire 模型按其真实最大输出填值。
3. builtin 自定义模型走 `pcmm_${provider}` sidecar（`provider-custom-model-meta.ts`）一并挂 `maxOutputTokens`。
4. `anthropic-sdk-core.ts:145` 改为：`config.maxTokens ?? <resolved maxOutputTokens> ?? <通用兜底>`，通用兜底取一个比 4096 大得多的安全值。
5. 解析优先级：**用户 instance 手填 `maxTokens` > 模型 meta `maxOutputTokens` > wire 家族兜底默认**。
6. **OpenAI-compat 路径完全不动**（已正确：不填则用 provider 默认）。

#### 硬约束（来自用户）

- **每个 anthropic-wire 模型的 `maxOutputTokens` 必须从对应 provider 官方文档逐个查证，严禁臆造。**
- 需查文档的 provider：anthropic（Opus/Sonnet/Haiku）、deepseek、minimax、mimo。
- 查不到真实值的模型：**标 TODO + 留空**（退回通用兜底），不填假数。
- 红线：`max_tokens` 不能超过模型真实输出上限，否则 400 → 所以必须是"按模型填真实 max"，不是统一一个大数。

### 因素 2：loop 感知截断（兜底）

1. 把 `done` 事件的 `stopReason` 接进 loop（现在被丢弃）。
2. 当 `stopReason === "length"` 且本步无终止性 tool call 时，**不再当作"纯文本正常收工"**。
3. 策略：**自动用翻倍后的 `max_tokens` 重试本步**（封顶到该模型 `maxOutputTokens`）。
   - 选这条而非"注入 notice 让 LLM 续写"：截断常发生在 thinking 中途，Anthropic-wire 的 thinking 块此时**无 signature**，回喂历史会 400；重试不污染历史、直接对症。
   - 契合本项目哲学："终止只由 LLM/用户 abort 触发"——截断是技术性事件，不该被误当成 LLM 主动收工。
4. 重试到封顶仍截断：注入一条 trusted `<system_notice>` 告知 LLM 输出被上限截断，由它自行决定 `fail` 还是换策略。
5. OpenAI-compat 路径不发 max_tokens、走 provider 大默认，截断罕见：若发生，跳过重试、直接注入 notice（因为我们没在给它设上限、无从"翻倍"）。

配合因素 1 抬高基准预算后，因素 2 基本只在极端长推理时触发。

## 不做（YAGNI / 超范围）

- 不给 Anthropic 官方模型启用 adaptive thinking / effort（那是独立增强，与本次截断问题无关）。
- 不动 OpenAI-compat 的 max_tokens 行为。

## 涉及文件（预估）

- `src/lib/model-router/providers/registry.ts` — `ModelMeta.maxOutputTokens` + 各模型填值
- `src/lib/provider-custom-model-meta.ts` — pcmm sidecar 加 `maxOutputTokens`
- `src/lib/model-router/providers/_shared/anthropic-sdk-core.ts` — 改默认解析
- maxTokens 解析处（ModelConfig 组装/`instances.ts`/model 选择）
- `src/lib/agent/loop.ts` — 接 `stopReason` + 截断重试 + notice 注入
- 相应测试
