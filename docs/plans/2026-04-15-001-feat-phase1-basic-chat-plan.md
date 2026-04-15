---
title: "feat: Phase 1 — 基础对话能力（Model Router + 页面问答 + API Key 管理）"
type: feat
status: active
date: 2026-04-15
origin: docs/design.md
---

# feat: Phase 1 — 基础对话能力

## Overview

实现 Chrome AI Agent 的最小可用闭环：用户配置自己的 API key，打开任意网页，在侧边栏中用自然语言提问，AI 结合页面内容给出回答，响应以流式方式实时展示。

## Problem Frame

用户已经为 LLM 订阅付费（Claude Max / ChatGPT Plus），不应再为浏览器 AI 能力重复买单。Phase 1 建立 BYOK 模式的基础能力：统一的 LLM 接口（Model Router）、安全的 API key 存储、页面内容提取、以及流式对话 UI。这是后续 Agent 操控和标签管理能力的基座。（see origin: docs/design.md Phase 1 定义）

## Requirements Trace

- R1. 支持 Anthropic 和 OpenAI 两个 LLM provider，通过统一接口调用（see origin: Phase 1 scope）
- R2. API key 使用 Web Crypto API (AES-GCM) 加密后存入 chrome.storage.local（see origin: 安全设计）
- R3. 用户能在 Settings tab 配置 API key、选择模型、验证连通性
- R4. Content Script 能提取当前页面的标题、正文、meta 信息
- R5. Chat tab 支持流式对话，AI 回答结合当前页面内容作为上下文
- R6. 所有 LLM 调用直接从浏览器发出，不经任何中间服务器（see origin: 安全设计）
- R7. 对话以 session 为单位管理，不同页面可以有独立对话上下文

## Scope Boundaries

- **不包含** Phase 0 Spike（元素定位验证）— 那是 Phase 2 Agent 能力的前置
- **不包含** Agent Engine（任务拆解、多步执行）
- **不包含** Tab Manager（标签分析、分组）
- **不包含** Gemini 和 Ollama provider — 推迟到 Phase 3
- **不包含** 对话历史持久化到 storage — Phase 1 仅维护内存中的 session 级对话
- **不包含** 测试框架搭建 — 当前脚手架未配置任何测试工具，不在 Phase 1 范围

## Context & Research

### Relevant Code and Patterns

- `src/lib/model-router/index.ts` — 已有 `Provider`、`ModelConfig`、`ChatMessage`、`ChatResponse` 类型定义，`chat()` 函数签名已定义但抛 "not yet implemented"
- `src/sidepanel/App.tsx` — 四 tab 导航（chat/agent/tabs/settings），各 tab 为 placeholder。使用 `useState` 管理 tab 切换，内联 TailwindCSS 类名
- `src/background/index.ts` — 仅处理图标点击打开侧边栏，无消息监听
- `src/content/index.ts` — 空占位，仅 console.log
- `manifest.json` — 权限已声明：`activeTab`、`sidePanel`、`storage`、`tabs`、`scripting`。host_permissions 仅有 `http://localhost/*`
- 项目约定：union string literal 替代 enum，interface 替代 type alias，functional components + useState，无 CSS modules

### Key Technical Findings

1. **不能使用 Anthropic/OpenAI 官方 SDK** — SDK 依赖 Node.js 内置模块，Service Worker 环境不支持。必须用 raw `fetch` 直接调 REST API
2. **Service Worker 空闲超时约 30 秒**（非设计文档中写的 5 分钟）— 需要 keep-alive pattern（定期调用 `chrome.runtime.getPlatformInfo` 重置计时器）保持流式调用期间 worker 存活
3. **流式响应需使用 Port 连接** — `chrome.runtime.sendMessage` 是一次性的，不适合流式。应用 `chrome.runtime.connect()` 建立长连接 port，Service Worker 通过 `port.postMessage` 逐 chunk 推送
4. **manifest.json 需增加 host_permissions** — `https://api.anthropic.com/*` 和 `https://api.openai.com/*`，否则 fetch 被 CORS 阻断
5. **vite.config.ts 缺少 path alias 配置** — tsconfig.json 声明了 `@/* -> src/*`，但 vite 未配置对应 `resolve.alias`，构建时会失败
6. **`chrome.scripting.executeScript` 的 func 不能闭包捕获外部变量** — 函数被序列化后发送到 tab，必须通过 `args` 传参
7. **Web Crypto API 在 Service Worker 中可用** — `crypto.subtle` 无需 `window.` 前缀

### Institutional Learnings

无 — 项目处于初始阶段，`docs/solutions/` 目录尚未创建。

## Key Technical Decisions

- **Raw fetch 替代 SDK**：Anthropic 和 OpenAI 的官方 JS SDK 都依赖 Node.js 内置模块（如 `node:fs`、`node:stream`），无法在 Chrome Extension Service Worker 中使用。直接使用 `fetch` 调用 REST API，代码量可控且无兼容风险。

- **Port 连接用于流式传输**：`chrome.runtime.sendMessage` 是 request-response 模式，无法持续推送流式 chunk。使用 `chrome.runtime.connect()` 建立命名 port（如 `"chat-stream"`），Service Worker 解析 SSE 后通过 `port.postMessage` 逐 chunk 推送到 Side Panel，port 保持 worker 存活。

- **加密密钥策略：首次安装时随机生成**：设计文档提到「用户设置的 PIN 或首次使用时随机生成」。Phase 1 选择后者 — 安装时生成 256-bit 随机密钥存入 `chrome.storage.session`（浏览器关闭时清除）。PIN 模式作为后续增强。这提供了合理的安全性（防止其他扩展读取 storage）同时避免 UX 摩擦。

- **Model Router 架构：Provider 类 + 统一流式接口**：每个 provider 实现一个 class（`AnthropicProvider`、`OpenAIProvider`），暴露统一的 `streamChat()` 方法返回 `AsyncGenerator<string>`。路由层根据 `ModelConfig.provider` 分发。非流式 `chat()` 作为流式的便利封装。

- **Content Script 动态注入**：遵循设计文档的 `activeTab` + `chrome.scripting.executeScript()` 方案。不在 manifest 声明 `content_scripts`，仅在用户主动发起对话时注入，最小化权限暴露。

## Open Questions

### Resolved During Planning

- **SDK 还是 raw fetch？** → Raw fetch。SDK 在 Service Worker 中不可用（see Context & Research #1）
- **消息传递用 sendMessage 还是 port？** → 流式用 port，非流式用 sendMessage。Port 连接保持 worker 存活且支持持续推送
- **加密密钥从哪来？** → 首次安装时 `crypto.getRandomValues` 生成，存 `chrome.storage.session`。浏览器重启后 key 需重新生成，已加密的 API key 需用户重新输入（可接受的 tradeoff — 用户不需要记 PIN，且 API key 通常只配置一次后很少改动）

### Deferred to Implementation

- **长页面内容截断策略**：不同 LLM 的 context window 不同（Claude 200k vs GPT-4o 128k），具体截断阈值需要在实现时根据 token 计算确定
- **SSE 解析的边缘情况**：Anthropic 和 OpenAI 的 SSE 格式有差异（Anthropic 无 `[DONE]` 标记），具体解析逻辑在实现 provider 时处理
- **React 组件拆分粒度**：Chat UI 的组件拆分（MessageList、MessageBubble、InputArea 等）在实现时根据复杂度决定

## Implementation Units

- [ ] **Unit 1: 构建配置修复 + 消息类型基础设施**

  **Goal:** 修复已知的构建问题，建立 Service Worker ↔ Side Panel ↔ Content Script 之间的类型安全消息传递基础。

  **Requirements:** 所有后续 Unit 的前置

  **Dependencies:** 无

  **Files:**
  - Modify: `vite.config.ts` — 添加 `resolve.alias` 配置 `@/ -> src/`
  - Modify: `manifest.json` — 添加 `host_permissions`: `https://api.anthropic.com/*`, `https://api.openai.com/*`
  - Create: `src/types/messages.ts` — 定义所有组件间消息的 discriminated union 类型
  - Modify: `src/types/index.ts` — 重新导出 messages 类型

  **Approach:**
  - vite.config.ts 中使用 `resolve: { alias: { "@": path.resolve(__dirname, "src") } }`
  - messages.ts 定义 `type ExtensionMessage = { type: "extract-page" } | { type: "page-content", data: PageContent } | { type: "chat-start", ... } | ...` 的 discriminated union
  - 消息类型覆盖：Side Panel → Service Worker（chat 请求、设置更新）、Service Worker → Content Script（页面提取请求）、Content Script → Service Worker（提取结果）、Service Worker → Side Panel（流式 chunk via port）

  **Patterns to follow:**
  - 现有类型定义风格：union string literal、interface、named exports
  - 已有的 `ChatMessage`、`ChatResponse` 接口作为基础

  **Test scenarios:**
  - Happy path: TypeScript 编译通过，`@/` 路径别名在 import 中正确解析
  - Happy path: `pnpm build` 成功产出 dist/ 目录

  **Verification:**
  - `pnpm build` 无错误完成
  - 新的消息类型在后续 Unit 中能被正确 import 和类型检查

---

- [ ] **Unit 2: API Key 加密存储模块**

  **Goal:** 实现 API key 的加密存储和读取，为 Settings UI 和 Model Router 提供安全的密钥管理。

  **Requirements:** R2, R6

  **Dependencies:** Unit 1（类型）

  **Files:**
  - Create: `src/lib/crypto.ts` — AES-GCM 加密/解密函数 + 密钥派生/管理
  - Create: `src/lib/storage.ts` — chrome.storage 封装：保存/读取/删除 provider 配置（含加密 API key）

  **Approach:**
  - `crypto.ts`：使用 Web Crypto API 实现 `encrypt(plaintext, key)` 和 `decrypt(ciphertext, key)`。AES-GCM-256，每次加密生成随机 IV（12 bytes），输出格式为 `base64(iv + ciphertext)`
  - 加密密钥管理：`getOrCreateEncryptionKey()` — 检查 `chrome.storage.session` 中是否有密钥，没有则 `crypto.getRandomValues(new Uint8Array(32))` 生成并存入
  - **注意**：`chrome.storage.session` 默认仅 Service Worker 可访问。需在 Service Worker 启动时调用 `chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })` 以允许 Side Panel 访问，或将所有加密/解密操作路由到 Service Worker 通过消息传递完成
  - `storage.ts`：`saveProviderConfig(provider, config)` 加密 API key 后存入 `chrome.storage.local`；`getProviderConfig(provider)` 读取并解密；`deleteProviderConfig(provider)` 删除
  - 存储结构：`chrome.storage.local` 中 key 为 `provider_${provider}` → `{ encryptedKey: string, model: string, baseUrl?: string }`
  - 当前活跃 provider 存储在 `chrome.storage.local` 的 `active_provider` key

  **Patterns to follow:**
  - 现有的 `Provider` 和 `ModelConfig` 类型

  **Test scenarios:**
  - Happy path: 加密后的字符串与原文不同，解密后与原文一致
  - Happy path: 存入 chrome.storage.local 后能正确读回并解密
  - Edge case: 浏览器重启后 session key 丢失，`getOrCreateEncryptionKey()` 生成新 key，旧加密数据无法解密 — 应返回明确错误而非静默失败
  - Edge case: 存储中不存在指定 provider 的配置时，`getProviderConfig` 返回 null
  - Error path: 传入空字符串作为 API key 时拒绝保存

  **Verification:**
  - 在 Chrome Extension 环境中能完成 key 的加密存储和读取循环
  - `chrome.storage.local` 中存储的值是密文，不可直接读取原始 key

---

- [ ] **Unit 3: Model Router — Anthropic + OpenAI Provider 实现**

  **Goal:** 实现两个 LLM provider 的流式调用，通过统一接口暴露。

  **Requirements:** R1, R6

  **Dependencies:** Unit 1（消息类型）, Unit 2（读取 API key）

  **Files:**
  - Create: `src/lib/model-router/providers/anthropic.ts` — Anthropic Messages API 流式调用
  - Create: `src/lib/model-router/providers/openai.ts` — OpenAI Chat Completions API 流式调用
  - Modify: `src/lib/model-router/index.ts` — 实现 `chat()` 和新增 `streamChat()`，路由到具体 provider

  **Approach:**
  - 每个 provider 实现 `streamChat(config: ModelConfig, messages: ChatMessage[]): AsyncGenerator<StreamEvent>` 接口
  - `StreamEvent` 类型：`{ type: "text-delta", text: string } | { type: "done", usage?: { inputTokens: number, outputTokens: number } } | { type: "error", error: string }`
  - Anthropic provider：POST `https://api.anthropic.com/v1/messages`，headers 含 `x-api-key` 和 `anthropic-version: 2024-10-22`（需确认与目标模型的兼容性），body 含 `stream: true`。解析 SSE 事件：提取 `content_block_delta` 的 `delta.text`，`message_delta` 的 usage 和 stop_reason
  - OpenAI provider：POST `https://api.openai.com/v1/chat/completions`，headers 含 `Authorization: Bearer`，body 含 `stream: true`。解析 SSE：提取 `choices[0].delta.content`，识别 `data: [DONE]` 终止标记
  - 两个 provider 共享 SSE 行解析逻辑（ReadableStream → TextDecoder → 按行分割 → 解析 `data:` 前缀）
  - Model Router `index.ts` 中 `streamChat()` 根据 `config.provider` 分发到对应 provider。对 Phase 1 未实现的 provider（`google`、`ollama`）抛出描述性错误（如 "Gemini provider will be supported in Phase 3"），而非静默失败
  - 非流式 `chat()` 作为 `streamChat()` 的便利封装：收集所有 text-delta 拼接返回
  - Service Worker keep-alive：在流式调用期间每 25 秒调用 `chrome.runtime.getPlatformInfo()` 重置空闲计时器

  **Patterns to follow:**
  - 现有的 `ModelConfig`、`ChatMessage` 接口
  - 使用 `AsyncGenerator` 和 `yield` 进行流式输出

  **Test scenarios:**
  - Happy path: Anthropic provider 发送正确的请求格式（headers、body），解析 SSE 流并 yield text chunks
  - Happy path: OpenAI provider 发送正确的请求格式，解析 SSE 流并 yield text chunks
  - Happy path: Model Router 根据 provider 字段正确路由到对应 provider
  - Happy path: 非流式 `chat()` 收集所有 chunks 返回完整响应
  - Error path: API 返回 401（无效 key）时抛出包含 provider 名称的明确错误
  - Error path: API 返回 429（限流）时抛出包含 retry-after 信息的错误
  - Error path: 网络断开时 fetch 抛出 TypeError，包装为用户友好的错误消息
  - Edge case: SSE 流中间断开（partial chunk），解析器不崩溃，报告中断错误
  - Integration: keep-alive 机制在流式调用期间保持 Service Worker 存活

  **Verification:**
  - 使用真实 API key 在 Chrome Extension 环境中完成一次完整的流式对话
  - 两个 provider 都能正确流式输出文本并报告 token 用量

---

- [ ] **Unit 4: Settings UI — API Key 配置界面**

  **Goal:** 用户能在侧边栏 Settings tab 中配置、验证、管理 API key。

  **Requirements:** R2, R3

  **Dependencies:** Unit 2（加密存储模块）, Unit 3（用于连通性测试）

  **Files:**
  - Create: `src/sidepanel/components/Settings.tsx` — Settings tab 完整 UI
  - Modify: `src/sidepanel/App.tsx` — 替换 Settings placeholder 为 Settings 组件

  **Approach:**
  - Settings UI 包含：provider 选择卡片（Anthropic / OpenAI，后续可扩展）、API key 输入框（password type + 显示/隐藏切换）、模型名称输入框（带默认值如 `claude-sonnet-4-20250514` / `gpt-4o`）、可选的 Base URL 输入框（用于 OpenRouter 等兼容 API）
  - "测试连接" 按钮：调用对应 provider 的轻量请求（如发送 "Hi" 并限制 `max_tokens: 1`），显示成功/失败状态
  - "保存" 按钮：调用 storage 模块加密存储
  - 已配置的 provider 显示绿色状态标记，未配置显示灰色
  - 当前活跃 provider 的选择持久化到 `chrome.storage.local`
  - 加载时从 storage 读取已配置的 provider 列表和活跃 provider

  **Patterns to follow:**
  - 现有的 App.tsx 组件风格：functional component、inline TailwindCSS、暗色主题（neutral-950 背景）
  - 小组件可内联在 Settings.tsx 中，复杂后再拆分

  **Test scenarios:**
  - Happy path: 输入有效 API key → 点击测试 → 显示成功 → 保存 → 重新打开 Settings 能看到已配置状态
  - Happy path: 切换活跃 provider → 保存 → Chat tab 使用新 provider
  - Edge case: API key 输入框为空时保存按钮禁用
  - Edge case: 已保存的 key 显示为遮罩（`sk-...xxxx`），不直接展示完整 key
  - Error path: 测试连接失败（无效 key / 网络错误）→ 显示错误信息，不保存
  - Error path: 浏览器重启后 session key 丢失 → Settings 显示 "需要重新配置" 提示

  **Verification:**
  - 能完成 API key 的配置、验证、保存、读取全流程
  - 已保存的 key 在 chrome.storage.local 中是加密的

---

- [ ] **Unit 5: Content Script — 页面内容提取**

  **Goal:** 能提取当前页面的核心文本内容，为 Chat 提供页面上下文。

  **Requirements:** R4

  **Dependencies:** Unit 1（消息类型）

  **Files:**
  - Modify: `src/content/index.ts` — 实现页面内容提取逻辑
  - Modify: `src/background/index.ts` — 添加消息路由：接收 Side Panel 的提取请求，通过 `chrome.scripting.executeScript()` 注入提取函数，返回结果

  **Approach:**
  - Content Script 提供 `extractPageContent()` 函数，返回 `{ title: string, url: string, description: string, content: string }`
  - 提取策略（优先级递减）：`<article>` → `<main>` → `[role="main"]` → `<body>`，过滤 `<script>`、`<style>`、`<nav>`、`<footer>`、`<header>` 等非内容元素
  - 文本清理：合并多余空白、去除不可见字符、限制最大长度（初始设为 ~50,000 字符，约 15k tokens）
  - 提取 meta description（`<meta name="description">`）和 Open Graph 数据作为补充
  - Service Worker 中使用 `chrome.scripting.executeScript({ target: { tabId }, func: extractPageContent })` 动态注入执行。注意：func 不能引用外部作用域变量
  - Service Worker 消息路由：监听 `{ type: "extract-page" }` 消息，获取 active tab，注入脚本，返回结果

  **Patterns to follow:**
  - 使用 `chrome.scripting.executeScript` 的 `func` + `args` 模式
  - 返回值必须是 JSON-serializable

  **Test scenarios:**
  - Happy path: 在普通新闻/博客页面上提取到标题和正文内容
  - Happy path: 在 React SPA 页面上（已渲染后）能提取到动态内容
  - Edge case: 页面没有 `<article>` 或 `<main>` 标签时 fallback 到 `<body>`
  - Edge case: 页面内容超过 50,000 字符时截断，并保留完整句子
  - Edge case: 空白页面或 `about:blank` 返回空内容，不报错
  - Error path: `chrome://` 等受限页面无法注入脚本时，返回明确的 "无法访问此页面" 错误
  - Error path: Tab 已关闭或导航到新页面时注入失败，不崩溃

  **Verification:**
  - 在 3 种不同类型的真实网页上（新闻/文档/SPA）成功提取到有意义的文本内容
  - 提取结果能被 Model Router 作为上下文发送给 LLM

---

- [ ] **Unit 6: Chat UI + 全链路串联**

  **Goal:** 实现 Chat tab 的完整对话界面，串联 Side Panel → Service Worker → Content Script → LLM → Side Panel 的全链路，完成 Phase 1 最小闭环。

  **Requirements:** R5, R7

  **Dependencies:** Unit 3（Model Router）, Unit 4（Settings — 需有 API key）, Unit 5（Content Script）

  **Files:**
  - Create: `src/sidepanel/components/Chat.tsx` — Chat tab 完整 UI（消息列表 + 输入框 + 流式展示）
  - Modify: `src/sidepanel/App.tsx` — 替换 Chat placeholder 为 Chat 组件，管理对话状态
  - Modify: `src/background/index.ts` — 添加 port 连接监听（`chrome.runtime.onConnect`），协调页面提取 + LLM 调用 + 流式推送

  **Approach:**
  - **Chat UI 组件**：消息列表（用户消息右侧蓝色气泡，AI 消息左侧深灰气泡）、底部输入框 + 发送按钮、流式输出时显示打字指示器、加载和错误状态展示
  - **Markdown 渲染**：Phase 1 仅处理基础格式（代码块用 `<pre><code>`、加粗、列表），不引入重量级 markdown 库。如果 LLM 回复中有代码块等复杂格式，在后续迭代中增强
  - **流式对话流程**：
    1. 用户在 Chat 输入消息 → Side Panel 通过 `chrome.runtime.connect({ name: "chat-stream" })` 建立 port
    2. Side Panel 通过 port 发送 `{ type: "chat-start", messages: [...] }`
    3. Service Worker 收到后：获取 active tab → 注入 Content Script 提取页面内容 → 从 storage 读取当前 provider 配置和解密的 API key → 构建 system prompt（含页面内容）→ 调用 `streamChat()`
    4. Service Worker 将每个 `text-delta` 通过 `port.postMessage({ type: "chunk", text })` 推送到 Side Panel
    5. 完成时发送 `{ type: "done", usage }` 并断开 port
  - **Port 断开处理**：监听 `port.onDisconnect`，当 Side Panel 关闭或用户导航离开时，使用 `AbortController.abort()` 中止正在进行的 LLM fetch 请求，避免浪费用户 API 额度
  - **System Prompt 设计**：`"你是一个浏览器 AI 助手。以下是用户当前浏览的页面内容：\n\n标题: {title}\nURL: {url}\n\n{content}\n\n请基于页面内容回答用户的问题。如果问题与页面无关，也可以正常回答。"`
  - **对话状态管理**：使用 React `useState` 维护 `messages: ChatMessage[]`，session 级别（页面刷新或关闭侧边栏后清空）
  - **无 API key 引导**：Chat tab 检测到未配置 provider 时，显示引导卡片引导用户去 Settings tab

  **Patterns to follow:**
  - 现有的 App.tsx 暗色主题风格
  - `chrome.runtime.connect()` port 模式用于流式通信

  **Test scenarios:**
  - Happy path: 用户发送消息 → AI 流式回复逐字显示 → 完成后消息固定在历史中
  - Happy path: 连续多轮对话，历史消息正确累积并发送给 LLM
  - Happy path: AI 回复中的代码块正确渲染为等宽字体
  - Edge case: 发送消息时正在等待上一条回复 → 发送按钮禁用
  - Edge case: 未配置 API key → 显示引导卡片，不发送请求
  - Edge case: 页面内容提取失败（受限页面）→ 仍可对话，但 system prompt 中不含页面内容，并提示用户
  - Error path: LLM 调用失败（网络/API 错误）→ 在消息列表中显示错误气泡，允许重试
  - Error path: 流式传输中途断开 → 显示已接收的部分内容 + 错误提示
  - Integration: 完整链路 — Side Panel 发消息 → Service Worker 协调 → Content Script 提取 → LLM 流式返回 → UI 实时更新

  **Verification:**
  - 打开任意网页，在侧边栏中提问关于页面的问题，AI 能基于页面内容给出有意义的回答
  - 回复以流式方式逐字显示
  - 能进行多轮连续对话

---

- [ ] **Unit 7: 打磨与边缘情况处理**

  **Goal:** 处理首次使用引导、状态提示等边缘情况，使 Phase 1 达到可发布状态。

  **Requirements:** R5, R7

  **Dependencies:** Unit 1-6 全部完成

  **Files:**
  - Modify: `src/sidepanel/App.tsx` — 全局状态提示（如连接状态、活跃 provider 显示）
  - Modify: `src/sidepanel/components/Chat.tsx` — 空状态、欢迎消息、快捷操作
  - Modify: `src/background/index.ts` — 安装事件处理（`chrome.runtime.onInstalled`）

  **Approach:**
  - 首次安装后自动打开侧边栏并显示欢迎/配置引导
  - Chat tab 空状态：显示 3 个快捷操作建议（"总结这个页面"、"提取关键信息"、"翻译页面内容"），点击即发送
  - 侧边栏顶部显示当前活跃 provider 和模型名称的小标签
  - 页面导航时（URL 变化），清空当前对话上下文或提示用户可以继续/重新开始
  - 基础快捷键：Extension 图标点击（已实现）

  **Patterns to follow:**
  - 现有的暗色主题和 TailwindCSS inline 类名风格

  **Test scenarios:**
  - Happy path: 首次安装 → 自动打开侧边栏 → 引导用户配置
  - Happy path: 点击快捷操作 → 自动发送对应消息
  - Edge case: 在 Settings 中删除所有 API key 后 → Chat tab 恢复到未配置引导状态
  - Edge case: 页面导航到新 URL → 对话上下文更新

  **Verification:**
  - 从全新安装开始，能顺畅完成配置到首次对话的完整流程
  - 各 tab 切换、状态变化体验流畅

## System-Wide Impact

- **Interaction graph:** Side Panel ↔ Service Worker（port 连接 + sendMessage）↔ Content Script（executeScript 动态注入）。Service Worker 是中心协调者，处理所有消息路由和 LLM 调用。
- **Error propagation:** LLM API 错误 → Service Worker 捕获 → 通过 port 发送 error 消息 → Side Panel 显示错误 UI。Content Script 注入失败 → Service Worker 返回降级响应（无页面上下文）→ Side Panel 提示但不阻断对话。
- **State lifecycle risks:** Service Worker 可能在流式传输期间被终止 — keep-alive pattern 缓解。`chrome.storage.session` 中的加密密钥在浏览器重启后丢失 — 用户需重新配置 API key（可接受 tradeoff）。
- **API surface parity:** Phase 1 不涉及 Agent 或 Tab Manager 的 API surface，无跨模块耦合。
- **Unchanged invariants:** manifest.json 中的 `activeTab` + `scripting` 权限模型不变；Content Script 不自动注入（no `<all_urls>`）；Side Panel 作为唯一 UI 入口。

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Service Worker 在流式传输期间被终止 | keep-alive pattern（每 25s 调用 chrome API），port 连接本身也延长 worker 生命周期 |
| API key 加密密钥在浏览器重启后丢失 | 可接受 — 用户重新输入 API key 即可。后续版本可引入 PIN 模式 |
| CRXJS 插件与 Vite 8 的兼容性问题 | CRXJS 2.4.0 声称支持 Vite 8，已在脚手架阶段验证 build 通过。如遇问题，可降级 Vite 或切换构建工具 |
| Anthropic API 不允许浏览器端直接调用（CORS） | 研究确认 Anthropic API 允许扩展发起请求，但需要在 manifest host_permissions 中声明 |
| 页面内容提取在 SPA 上不完整 | Phase 1 仅做文本提取（已渲染的 DOM），不处理动态加载内容。SPA 页面在用户交互时通常已渲染完毕 |

## Sources & References

- **Origin document:** [docs/design.md](../design.md) — 完整产品设计和技术架构
- Related code: `src/lib/model-router/index.ts`（已有类型定义）, `src/sidepanel/App.tsx`（已有 tab 导航）
- Anthropic Messages API: streaming SSE format, `x-api-key` + `anthropic-version` headers
- OpenAI Chat Completions API: streaming SSE format with `data: [DONE]` sentinel
- Chrome Extension MV3: Service Worker lifecycle, `chrome.runtime.connect()` ports, `chrome.scripting.executeScript()`
- Web Crypto API: AES-GCM encryption with random IV, `crypto.subtle` in Service Worker context
