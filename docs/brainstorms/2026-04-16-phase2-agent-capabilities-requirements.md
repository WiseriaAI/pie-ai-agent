---
date: 2026-04-16
topic: phase2-agent-capabilities
---

# Phase 2 — Agent Capabilities

## Problem Frame

Chrome AI Agent 已完成 Phase 1（基础对话 + 页面上下文 + 流式响应 + 多 Provider 支持）。用户目前只能和 AI 对话获取信息，无法让 AI 代替自己在页面上执行操作。Phase 2 要让用户通过自然语言指令，驱动 Agent 在当前页面上自主执行 DOM 操作（点击、输入、滚动、提取等），并提供基础 Skill 框架支持可复用的自定义操作。

## Requirements

**Agent Loop（核心执行引擎）**

- R1. Agent 使用 ReAct 模式（观察→思考→行动）循环执行，每一轮：获取页面快照 → 发送给 LLM（含 tool 定义）→ LLM 返回 tool_call → 执行操作 → 返回观察结果 → 下一轮
- R2. Agent Loop 持续运行直到：LLM 调用 `done` tool（任务完成）、LLM 调用 `fail` tool（任务失败）、达到最大步数限制、或用户手动中止
- R3. Agent Loop 运行期间通过已有的 port 长连接保持 Service Worker 存活，并向 Side Panel 实时推送每一步的执行状态
- R4. 若 Service Worker 在任务执行中意外重启，向用户显示错误提示并允许重新发起任务（状态持久化 + crash recovery 延后到加固阶段）

**Tool-Use 集成（LLM 工具调用）**

- R5. 扩展 model-router 支持 LLM 原生 tool calling（Anthropic `tool_use` / OpenAI `function_calling`）
- R6. DOM 操作和 Skill 统一注册为 tool，Agent 在 ReAct 循环中通过 tool_call 调用
- R7. 每轮 Agent Loop 发送给 LLM 的上下文包含：system prompt、任务描述、当前页面交互元素列表、最近 N 步操作历史
- R8. 上下文管理：只保留当前页面状态 + 最近操作历史（固定滑动窗口，如最近 10-15 步），超出窗口的历史直接丢弃

**DOM 操作（Content Script 执行层）**

- R9. Content Script 提供页面快照能力：遍历当前页面所有可交互元素，返回结构化元素列表（index、tag、type、role、text/label、placeholder、disabled 状态、bounding box）
- R10. 核心操作集：`click(elementIndex)`、`type(elementIndex, text, clear?)`、`scroll(direction, amount?)`、`select(elementIndex, value)`、`wait(seconds)`、`done(result)`、`fail(reason)`
- R11. 扩展操作集（明确延后，不阻塞 Phase 2 交付）：`hover(elementIndex)`、`pressKey(key)`、`goBack()`、`extractData(description)`

**安全与确认**

- R12. 操作分级：低风险操作（scroll、extractData、hover、wait）自动执行；高风险操作（click submit/delete 类按钮、navigate away、表单提交）暂停并在 Chat 中请求用户确认
- R13. 任务级别的最大步数限制（如默认 30 步），防止 Agent 无限循环
- R14. 用户可随时在 Chat 中中止正在执行的 Agent 任务

**UI/UX（Chat 内 Agent 体验）**

- R15. Agent 在 Chat Tab 内运行，不需要独立的 Agent Tab。用户在聊天中用自然语言触发 Agent 操作（如"帮我填写这个表单"）
- R16. Agent 执行过程中，Chat 界面实时显示每一步的操作和结果（如"正在点击'登录'按钮..."、"已在邮箱字段输入 xxx"）
- R17. 高风险操作需要确认时，在 Chat 中显示确认卡片（操作描述 + 确认/取消按钮）
- R18. 任务完成或失败时，显示汇总信息（执行了哪些步骤、结果）

**基础 Skill 框架**

- R19. 定义 Skill 格式：每个 Skill 包含 name、description、tools（Skill 注册的高层 tool 定义，包含参数 schema）、prompt（注入 Agent 的指令模板）
- R20. 用户可在 Chat 中通过指令手动触发已安装的 Skill（如"/skill 表单填写"或从 Skill 列表点击运行）
- R21. Skill 同时作为 tool 注册到 Agent 的 tool 列表中，Agent 在 ReAct 循环中也可自主选择调用
- R22. 用户可在 Settings 中查看已安装的 Skill 列表，手动启用/禁用
- R23. 提供 1 个内置示例 Skill（如"页面数据提取到 JSON"）作为参考实现，验证 Skill 框架可用性

## Success Criteria

- 用户通过自然语言在 Chat 中指令 Agent 完成单页面操作任务（如填写表单、提取数据），Agent 能自主循环执行直到完成
- 高风险操作会暂停等待用户确认，用户可随时中止
- Service Worker 意外重启时，向用户显示明确的错误提示
- 基础 Skill 框架就位，内置示例 Skill 可被手动触发并正常执行

## Scope Boundaries

- **不含**跨页面/跨 Tab 任务自动化（Phase 3+）
- **不含**操作录制和 Skill 自动生成（后续 Phase）
- **不含**基于页面匹配的 Skill 自动触发（后续 Phase）
- **不含** Agent 自主建议 Skill（后续 Phase）
- **不含**视觉/截图定位（取决于 Phase 0 spike 结论，如果 DOM 遍历足够则不需要）
- **不含** `chrome.debugger` / CDP 方案（除非 Phase 0 证明 DOM 遍历不可靠）

## Key Decisions

- **架构模式 → Tool-Use ReAct Agent**：LLM 使用原生 tool calling 驱动操作，而非自由文本解析。理由：结构化输出可靠、Skill 统一为 tool 概念、主流 Provider 都支持
- **Agent 在 Chat 内 → 不设独立 Agent Tab**：统一交互界面降低认知负担，Agent 操作结果作为 Chat 消息呈现
- **安全策略 → 按操作类型分级确认**：低风险自动执行提升效率，高风险暂停确认保障安全
- **Phase 0 先行**：元素定位验证结论决定 DOM 交互层方案，Phase 2 的 Content Script 实现依赖此结论

## Dependencies / Assumptions

- **Phase 0 spike 已完成（2026-04-17）**：Content Script DOM 遍历方案验证通过，元素定位可靠，按语义区域（main/nav/header/footer/aside）过滤可有效降噪。Phase 2 确定采用此方案，不需要 CDP 或视觉 fallback
- 用户使用的 LLM Provider 支持 tool calling（Anthropic / OpenAI / OpenRouter 均支持；如 Provider 不支持，需要降级方案或提示用户）
- manifest 需要 `<all_urls>` host_permission（Phase 0 已确认 `activeTab` 在 Side Panel 常驻场景下权限会过期，必须改为 `<all_urls>`，已在 Phase 0 期间落地）

## Phase 0 Findings (2026-04-17)

- ✅ **DOM 遍历可靠**：`document.querySelectorAll` + 标准 selector 集合（`a, button, input, select, textarea, [role=*], [contenteditable], [onclick], [tabindex]`）能稳定找到页面交互元素
- ✅ **可见性过滤有效**：`getBoundingClientRect` + `getComputedStyle` + `offsetParent` 三重检查能过滤隐藏元素
- ✅ **区域语义化分类可行**：通过向上遍历祖先查找 landmark 标签/ARIA role，可将元素标记为 main/nav/header/footer/aside/other，在内容丰富的页面上 Main Only 过滤能显著降噪
- ✅ **元素标签质量足够**：aria-label > innerText > placeholder > title 的优先级足以让 LLM 识别目标
- ⚠️ **权限约束**：`activeTab` 对 Side Panel 场景不够（切 tab / 导航后失效），必须 `<all_urls>`
- 📋 **Phase 2 需继续验证**：Shadow DOM 穿透、iframe 跨域、动态加载元素的检测时机（见 Deferred Questions）

## Outstanding Questions

### Deferred to Planning

- [Affects R5][Technical] model-router 扩展 tool calling 的具体实现方式——Anthropic 和 OpenAI 的 tool calling 协议差异如何统一抽象？
- [Affects R8][Needs research] 滑动窗口大小的合理默认值——需要平衡上下文长度和 token 成本
- [Affects R9][Needs research] 页面交互元素的遍历策略细节——Shadow DOM 处理、动态加载元素的检测时机
- [Affects R14][Needs research] 高风险操作的识别规则——除了按钮文本匹配，还有哪些信号可以判断操作风险等级？
- [Affects R19][Technical] Skill 定义格式的具体 schema 设计——需要多大的灵活性？是否需要参数化模板？

## Next Steps

→ Phase 0 spike 已完成，阻塞解除
→ 运行 `/ce:plan` 进行 Phase 2 的结构化实现规划
