# Chrome Web Store — Submission Copy

Copy-paste source for the CWS Developer Dashboard submission of `pie-0.5.0.zip`. Each section below corresponds to one field in the CWS form.

---

## Single purpose description

> Pie is an AI assistant in a browser side panel that uses **your own API key** to read the current page on demand and, with your confirmation for any sensitive action, automate multi-step browsing tasks across your tabs.

---

## Permission: `activeTab`

> Pie's action icon click is the user-gesture entry point that opens the side panel and binds the current tab as the task's pinned tab. `activeTab` gives the click handler immediate, scoped access to that one tab for the duration of the navigation, which is exactly what the side-panel binding needs.
>
> We acknowledge a partial overlap with the broader `<all_urls>` host permission also requested by Pie. `activeTab` is retained because (a) it preserves Pie's behavior when a user later restricts host access via Chrome's "On click / On specific sites" settings, and (b) it carries the user-gesture provenance that some `chrome.scripting` paths verify.

---

## Permission: `sidePanel`

> Required to use the `chrome.sidePanel` API. Pie's entire user interface — chat, settings, session list, agent step bubbles, confirmation cards — lives in Chrome's side panel surface. This permission lets Pie register the side-panel HTML entry point (`src/sidepanel/index.html`), open the panel in response to the user clicking Pie's action icon, and keep the panel attached as the user switches tabs. Pie does not perform any background side-panel injection.

---

## Permission: `storage`

> Required to use `chrome.storage.local` for on-device persistence of:
>
> - Encrypted API keys (AES-GCM ciphertext, never transmitted to anyone other than the matching LLM provider).
> - Conversation sessions (chat / agent turns, pinned-tab metadata, skill execution state).
> - User-created skills (prompt template, parameter schema, tool whitelist).
> - User preferences (provider selection, CDP-keyboard toggle, theme).
>
> `chrome.storage.sync` is **not** requested. All Pie data lives locally and is removed when the extension is uninstalled. Pie does not write to host pages' `localStorage` or IndexedDB.

---

## Permission: `tabs`

> Required for the cross-tab agent tools that the user invokes from chat: `list_tabs`, `activate_tab`, `close_tabs`, `get_tab_content`, `move_tabs`. These tools read basic tab metadata (id, title, URL, pinned/active flags, window id) and switch the active tab.
>
> They are called **only** in response to an explicit user request (chat message or `/skill` invocation). Tab metadata is wrapped in `<untrusted_tab_metadata>` markers in the LLM prompt so a malicious tab title cannot become an injected instruction. Cross-origin tab operations are classified as **high-risk** and require the user to approve a confirmation card — listing each affected tab's origin and title — before the tool actually runs.

---

## Permission: `tabGroups`

> Required for the user-invoked built-in skill `auto_group_tabs` (and similar skills users may write). The skill calls `chrome.tabs.group` and `chrome.tabGroups.update` to organize the user's open tabs into themed groups (e.g. by domain or topic).
>
> This permission is exercised **only** as part of an explicit user invocation — Pie never modifies tab groups in the background. Group titles are sanitized (control characters stripped, untrusted-content wrappers escaped) before being applied, to defeat prompt-injected group names that could confuse later agent reasoning.

---

## Permission: `scripting`

> Required to inject DOM-action helpers via `chrome.scripting.executeScript` when the user invokes an agent task that needs to read or interact with a page — for example "click the Submit button", "extract the article text", "scroll to load more". The toolset covers click, type, select, scroll, and a structured snapshot of interactive elements (links, buttons, inputs).
>
> All injected functions are bundled with the extension at build time. They live as pure functions in `src/lib/dom-actions/`, are passed via the `func` parameter, and receive arguments via the `args` parameter. There is no `eval`, no string-to-function conversion, and **no remote code is fetched or executed**. The injection target is always the user-pinned tab for the active task.

---

## Permission: `debugger`

> Used **only** for keyboard input simulation via the Chrome DevTools Protocol — `Input.dispatchKeyEvent` and `Input.insertText` — inside canvas-based rich-text editors (Lark Docs, Google Docs) where standard DOM `input` events are not honored. The only CDP domain Pie attaches to is `Input`. Pie never inspects, records, or modifies network traffic, console output, storage, other extensions, or DevTools sessions.
>
> This feature is **disabled by default**. The user must explicitly enable a "CDP keyboard simulation" toggle in Settings before any `chrome.debugger.attach` call is made.
>
> Safety mechanisms:
>
> - Per-task lazy attach scoped to one tab; Chrome's "Pie started debugging this browser" infobar is shown.
> - Detach is idempotent across 5 paths (explicit, abort signal, `onDetach`, kill-switch, finally) — no orphaned debugger session can persist.
> - An owner-token guard prevents one Pie side-panel instance from detaching another's session.
> - Every CDP call re-verifies the active tab and origin to prevent input on an unrelated tab.
> - Every CDP-driven keystroke is classified as **high-risk** and requires a user confirmation card before execution.

---

## Host permissions (`<all_urls>` + 6 LLM provider endpoints)

> **`<all_urls>`** — Pie's side panel is a persistent UI. The user can ask "summarize this page" or "do X on this page" while looking at any website they have chosen to visit. Pie cannot enumerate ahead of time which sites the user will want to use it on.
>
> Page reads happen **only** in response to an explicit user request (chat message or skill invocation). Pie does not read pages in the background, does not crawl, does not observe page navigation events, and does not register any `webNavigation` or `webRequest` listeners.
>
> The host list also enumerates the six supported LLM provider API endpoints — `api.anthropic.com`, `api.openai.com`, `openrouter.ai`, `api.minimax.chat`, `open.bigmodel.cn`, `dashscope.aliyuncs.com` — so that the service worker can send the user's BYOK requests directly to the provider chosen in Settings, with no developer-operated proxy in between.

---

## Remote code use

> **Pie does NOT use remote code.** All JavaScript that runs in the extension (service worker, side panel, and `chrome.scripting.executeScript` injections) is bundled into the extension package at build time. The extension makes outbound network requests **only** to the LLM provider API endpoints declared in `host_permissions`, and only with the request bodies the user generated by chatting or invoking a skill. No code is fetched, evaluated, or imported at runtime from any remote source.

---

## Data usage disclosures (Privacy Practices form — what to check)

Tick **only** the categories that apply, in line with `PRIVACY.md`:

- ☑ **Authentication information** — the user's LLM API key, stored encrypted on-device, transmitted only to the matching provider.
- ☑ **User activity** — chat messages, page snippets, and tool-call results are sent to the LLM provider the user configured. *Not* sent to any developer-operated server (there is none).
- ☑ **Website content** — page text and DOM snapshots are read on demand and forwarded to the user's chosen LLM provider as part of an explicit task.
- ☐ Personally identifiable information — not collected.
- ☐ Health information — not collected.
- ☐ Financial / payment information — not collected.
- ☐ Personal communications — not collected. (Chat with the LLM is conducted by the user with their own provider account; Pie is the transport.)
- ☐ Location — not collected.
- ☐ Web history — not collected.

**Certifications to confirm:**

- ☑ I do not sell or transfer user data to third parties, outside of the approved use cases.
- ☑ I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes.

---

## Listing description

CWS detailed-description field is plain text (markdown does not render). Use unicode bullets `•` and blank lines for paragraphs. The field accepts up to 16,000 characters.

### Short description — English (≤132 chars)

```
Bring your own LLM API key. Pie reads, summarizes, and automates pages in a side panel — local keys, no servers, full consent.
```

### Short description — 简体中文 (≤132 chars)

```
自带 LLM API Key 的浏览器 AI Agent。侧边栏常驻，理解页面、自动化任务、管理标签页——本地加密 Key、无服务器、每步可控。
```

### Detailed description — English

```
Pie is an AI assistant that lives in Chrome's side panel. It reads the page you're on, automates multi-step browsing tasks, and helps you manage tabs — using your own LLM API key. There is no Pie account, no developer-operated server, and no subscription.

WHY "BRING YOUR OWN KEY"

Most AI extensions sit between you and the model: they take your prompts, send them through their server, charge a monthly fee, and become another company that has to be trusted with your data. Pie inverts that. You paste your API key from a provider you already have — Anthropic, OpenAI, OpenRouter, or one of four China-region providers — and Pie sends your requests directly to that provider over HTTPS. No proxy. No telemetry. No backend.

Your key is encrypted with AES-GCM in chrome.storage.local. The encryption key is generated locally on first run and never leaves your device.

WHAT PIE CAN DO

• Chat with awareness of the current page. Ask "summarize this article", "explain this code block", "translate this section" — Pie extracts the visible text (with credential-looking inputs scrubbed out) and sends only that to your LLM.

• Run multi-step agent tasks. Describe what you want in natural language; the model plans steps and executes them through Pie's tool registry — clicking, typing, selecting, scrolling, taking structured snapshots of interactive elements, switching tabs.

• Manage your tabs. Built-in skills auto-group tabs by topic, close duplicates, or close long-inactive tabs. Seven cross-tab tools (list, activate, close, group, ungroup, move, fetch readable content from another tab) are also available individually.

• Save your own skills. A skill is a saved prompt template with an explicit tool whitelist. Run any skill from chat by typing /skill_name. The agent itself can author skills, too — useful for capturing a workflow you just walked through so it's reusable in the next session.

• Type into canvas editors (opt-in). For Lark Docs, Google Docs, and other editors that don't honor standard DOM input events, Pie can simulate keyboard input via the Chrome DevTools Protocol. This feature is OFF BY DEFAULT and must be explicitly enabled in Settings before any debugger session is attached.

ASKS BEFORE IT ACTS

Pie classifies every tool call before it runs. Anything irreversible or cross-origin requires you to approve a confirmation card first. The card shows you:

• The exact tool name and the raw argument the agent intends to pass — so you can spot a mistake or a prompt-injected instruction in page DOM before it runs.
• The origin and tab title for each affected tab, called out separately when an action would cross the original task's pinned origin.
• Approve, Reject, or Discard buttons (Discard abandons the agent's plan entirely).

If you reject three actions on the same task, Pie terminates the task automatically — rather than burning your tokens on a plan you've already disagreed with.

SUPPORTED PROVIDERS

• Anthropic Claude — native API, native tool_use blocks
• OpenAI — function_calling
• OpenRouter — OpenAI-compatible
• MiniMax — OpenAI-compatible
• ZhiPu (智谱) — OpenAI-compatible
• Bailian (阿里云百炼) — OpenAI-compatible

Adding a provider is a registry entry plus a host permission. Gemini and local Ollama support are on the public roadmap.

PRIVACY AT A GLANCE

• Your API key never leaves your device, except as an Authorization header on the direct provider call.
• Page content is sent only to the LLM provider you configured, only as part of an explicit task you triggered.
• Pie has no developer-operated server. No telemetry. No analytics. No third parties.
• All your data — sessions, skills, preferences — lives in chrome.storage.local. Uninstalling Pie deletes all of it.

Full privacy policy: https://github.com/WiseriaAI/Pie/blob/main/PRIVACY.md

KNOWN LIMITATIONS (MVP)

• Gemini and local Ollama support are not in this release.
• Skills do not yet auto-trigger on URL match — you invoke them manually as /skill_name.
• Recording your manual interactions to autogenerate skills is on the roadmap.
• Keyboard shortcuts are not wired up yet.

OPEN SOURCE

Pie is open source under the Apache License 2.0. Source code, roadmap, and issue tracker:
https://github.com/WiseriaAI/Pie
```

### Detailed description — 简体中文

```
Pie 是常驻在 Chrome 侧边栏的 AI 助手。它能读懂你当前打开的网页、执行多步浏览任务、帮你整理标签页——全程使用你自己的 LLM API Key。没有 Pie 账号，没有任何服务器，没有订阅费。

为什么是 BYOK（自带 Key）

大多数 AI 扩展夹在你和模型之间：抓走你的 prompt，转发到它们的服务器，每月收费，又是一家需要被信任的公司。Pie 反其道而行——你粘贴自己已有的 API Key（Anthropic、OpenAI、OpenRouter，或四家中国大陆 provider），Pie 通过 HTTPS 直连发到 provider。没有代理，没有遥测，没有后端。

API Key 用 AES-GCM 加密存在 chrome.storage.local，加密密钥首次启动时本地生成，永不离开你的设备。

Pie 能做什么

• 基于当前页面对话。问"总结这篇文章"、"解释这段代码"、"翻译这一段"——Pie 抽取可见文本（密码、支付、邮箱等输入框会自动剥离），只把这部分发给你的 LLM。

• 多步 Agent 任务。用自然语言描述你想做什么，模型规划步骤并通过 Pie 的工具调用执行——点击、输入、选择、滚动、对页面交互元素做结构化快照、切换标签页。

• 标签页管理。内置 Skill 可一键按主题分组、关闭重复标签、关闭长期不动的标签。也可以单独调用 7 个跨标签 tool（列表 / 激活 / 关闭 / 分组 / 取消分组 / 移动 / 跨标签抓页面内容）。

• 保存自己的 Skill。Skill 是带工具白名单的 prompt 模板。在 chat 里输入 /skill_name 直接执行。Agent 自己也能创建 Skill——把刚走过一遍的流程沉淀下来，下个 session 直接复用。

• Canvas 编辑器键盘输入（可选）。飞书文档、Google Docs 这类不响应标准 DOM input 事件的编辑器，Pie 可以通过 Chrome DevTools Protocol 模拟真实键盘输入。该功能默认关闭，必须在 Settings 里手动打开后才会附加 debugger 会话。

每一步都问你

Pie 在每次工具调用前会做风险分类。任何不可逆或跨域的操作都必须经过你点 confirm 才会真的执行。Confirm 卡片会展示：

• 工具名 + agent 打算传入的原始参数——你可以亲眼检查模型有没有犯错、有没有把页面里的注入指令当真。
• 每个被影响标签页的 origin 和标题，跨当前任务 pinned origin 的单独标出。
• Approve / Reject / Discard 三个按钮，Discard 直接放弃整个任务。

同一个任务里你拒绝三次，Pie 就直接终止——不让模型继续烧你 token 跑你已经否决的计划。

支持的 Provider

• Anthropic Claude——原生 API + 原生 tool_use
• OpenAI——function_calling
• OpenRouter——OpenAI 兼容
• MiniMax——OpenAI 兼容
• ZhiPu 智谱——OpenAI 兼容
• Bailian 百炼——OpenAI 兼容

新增 provider 只需要 registry 一条 + 一条 host permission。Gemini、Ollama 本地模型在 roadmap 上。

隐私一句话

• API Key 永不离开你的设备，除非作为 Authorization header 直接发给对应 provider。
• 页面内容只在你显式触发任务时发给你选中的 LLM provider。
• 没有开发者服务器，没有遥测，没有分析平台，没有第三方。
• 所有数据（会话 / Skill / 偏好）都在 chrome.storage.local，卸载即删干净。

完整隐私政策：https://github.com/WiseriaAI/Pie/blob/main/PRIVACY.md

当前 MVP 限制

• 暂不支持 Gemini 和本地 Ollama
• Skill 还不能根据 URL 自动触发，需要手动 /skill_name 调用
• 录制手动操作自动生成 Skill 在 roadmap
• 键盘快捷键还没接入

开源

Pie 在 Apache License 2.0 下开源。源码 / Roadmap / Issue：
https://github.com/WiseriaAI/Pie
```

---

## Pre-submission checklist

- [ ] Verify the publisher email and complete trader / non-trader self-declaration in the dashboard.
- [ ] Upload `pie-0.5.0.zip` (179 KB).
- [ ] Paste single-purpose description, all permission justifications, and remote-code = NO.
- [ ] Tick Privacy Practices boxes per the table above.
- [ ] Link `PRIVACY.md` raw URL as the privacy policy URL.
- [ ] Upload 3–5 screenshots at 1280×800 (recommended set: side panel chat, agent task with confirm card, settings with CDP toggle off, skills list, tab-group result).
- [ ] Pick category `Productivity` and primary language `English` + secondary `Chinese (Simplified)`.
- [ ] Set distribution `Public` (or `Unlisted` for a soft launch).
- [ ] Submit for review. Expect 5–14 days given the `debugger` + `<all_urls>` + agent-style description combination.
