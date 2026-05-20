# Prompt Caching — Anthropic `cache_control` 断点（Issue #57 Step 1）

> 日期：2026-05-20 · Issue [#57](https://github.com/WiseriaAI/Pie/issues/57) · ROADMAP 第一梯队 #3
> Scope：本次只落地 issue 建议方案的 **Step 1（零重构、最高 ROI）**——native Anthropic provider 的稳定前缀缓存。Step 2/3 与跨 provider 见末尾「未做」。

## 目标

排查发现 `src/lib/model-router/` 里**没有任何 `cache_control` / prompt caching**。后果：一个最长 30 步的 ReAct 循环把同一份 **system prompt + 全部 tool definitions** 原样重发 30 次、零缓存。tool defs 在工具数量较多的 agent 里是很大一块常量，是最直接的浪费。

目标：给任务内恒定的两段前缀（tool definitions + 静态 system prompt）打 `cache_control: { type: "ephemeral" }` 断点，让 Anthropic 在同一任务的后续步骤从缓存读取，而不是每步重新计费。

## 关键事实（落地前核实）

- **任务内 system + tools 恒定**：`buildAgentSystemPrompt` 在 task 开始 build 一次、复用整个循环；tool definitions 每步相同。→ 任务内缓存必然命中（前提是超过 Anthropic 最小可缓存长度）。
- **observation 本质不可缓存**：每步 observation 塞整页 snapshot，每步天然不同。它在尾部 user message，是「稳定前缀 + 易变后缀」结构里的后缀，**故意不缓存**。
- **缓存是前缀累积的**：Anthropic 的缓存前缀顺序为 `tools → system → messages`。一个 `cache_control` 断点缓存它之前的全部内容。
- **低于最小长度自动忽略**：达不到最小可缓存 token 数时，Anthropic 静默忽略断点，不报错。→ 永远可以安全设置。

## 处理过程（TDD）

改动集中在单文件 `src/lib/model-router/providers/anthropic.ts`。

1. **RED**：在 `anthropic.test.ts` 新增 `describe("anthropic prompt caching")`，5 个 case 断言期望的 wire shape，依赖一个尚不存在的 `_buildRequestBodyForTest`。运行 → 5 failed（`_buildRequestBodyForTest is not a function`）。
2. **GREEN**：把 `streamChat` 内联的 body 构造抽成 `buildRequestBody(config, messages, tools)`，并：
   - **tools**：在 `wireTools` **最后一个** tool 上挂 `cache_control: { type: "ephemeral" }`——这一个断点缓存整个 tools 前缀。非末尾 tool 不挂（多挂浪费断点额度，4 个上限）。
   - **system**：把原本的 top-level string 提升为单元素 block 数组 `[{ type: "text", text: system, cache_control: { type: "ephemeral" } }]`。该断点缓存 `tools + system` 整段前缀。
   - 其余字段（model / messages / stream / max_tokens / tool_choice）保持不变。
   - `streamChat` 改为调用 `buildRequestBody`。
3. **Verify GREEN**：全量 `pnpm test` → 941 passed（含原有 `toWireMessages` image 回归）。`pnpm build` 通过（manifest invariant + 类型）。

新增 test-only 导出 `_buildRequestBodyForTest`，与既有 `_toWireMessagesForTest` 同一约定。

## 结论 / 不变量

- **Anthropic wire 不变量（新增）**：`/v1/messages` body 的 `system` 永远是「带 `cache_control` 的 text block 数组」而非裸 string；`tools` 非空时**最后一个** tool 必带 `cache_control: { type: "ephemeral" }`。trailing user message（observation）永不缓存。
- **provider 隔离**：仅改 Anthropic native module；OpenAI / DeepSeek 等走自动前缀缓存，无需改；dispatch / registry / 其他 provider 零改动。
- **行为安全**：缓存只影响计费与延迟，不改变模型可见内容；低于最小长度自动降级。
- 文件：`src/lib/model-router/providers/anthropic.ts`（+`buildRequestBody` / `CACHE_CONTROL_EPHEMERAL`）、`src/lib/model-router/providers/anthropic.test.ts`（+5 case）。

## 未做（明确 punt，留后续 issue/iteration）

- **Step 2 — 把 `<user_task>` 从 system 挪到 user role**（`prompt.ts:182`）：跨任务缓存头号杀手，task 变 → 整个 system block 变。issue 评估「几乎免费」，但触及 prompt 构造 + loop 消息拼接，风险高于 Step 1，单独做。
- **OpenRouter 路由到 Anthropic 模型的 cache_control 透传**：OpenRouter 走 `_shared/openai-compat-core.ts`，需按 OpenAI-compat 格式注入 cache_control，provider-specific，单独评估。
- **cache usage 可视化**：缓存命中后 usage 会区分 `cache_creation_input_tokens` / `cache_read_input_tokens`；当前 `message_start` 仅读 `input_tokens`。展示缓存收益属 Issue [#59](https://github.com/WiseriaAI/Pie/issues/59) scope。
- **滑动窗口 / token budget 从 head 丢对会破前缀**（`window.ts` / `window-token-budget.ts`）：任务内长任务命中时缓存失效，与 Issue [#58](https://github.com/WiseriaAI/Pie/issues/58) compaction「尽量少改前缀」协同处理。
