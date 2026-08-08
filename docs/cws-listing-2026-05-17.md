# Pie · CWS Listing Refresh (v0.11.0 SEO Update)

> **Date:** 2026-05-17
> **Supersedes:** the **Short description**, **Listing description (long)**, and **Pre-submission checklist** sections of [`chrome-web-store-submission.md`](./chrome-web-store-submission.md).
> All **permission justifications**, **single-purpose description**, **remote-code disclosure**, and **data-usage disclosures** in that older doc remain accurate and authoritative — product behavior is unchanged.

This file holds the SEO-optimized CWS dashboard copy used for the v0.11.0 publish. Target keywords (in priority order): `AI agent`, `browser AI`, `open-source AI agent`, `BYOK`, `chrome ai automation`.

---

## 1. Listing title (manifest `name`)

Source: `_locales/{en,zh_CN}/messages.json` → `extension_name.message`. Already committed.

| Locale | Value | Chars |
|---|---|---|
| en | `Pie · Open-Source AI Agent for Browser & Tabs` | 45 |
| zh_CN | `Pie · 开源浏览器 AI Agent · 多 Tab 自动化` | 22 |

CWS displays this as the listing title and toolbar tooltip. `manifest.json` `action.default_title` is still `Open Pie` — that's the per-click tooltip on the toolbar icon, intentionally kept short.

---

## 2. Short description (manifest `description`)

Source: `_locales/{en,zh_CN}/messages.json` → `extension_description.message`. Already committed.

### English (125 chars)

```
Open-source AI browser agent. Bring your own Claude / ChatGPT / Gemini key — no backend, no telemetry, no proxy. 8 providers.
```

### 简体中文 (under 132 chars)

```
开源 AI 浏览器 Agent。自带 Claude / ChatGPT / Gemini API Key —— 无后端、无遥测、无代理。已支持 8 家厂商。
```

CWS displays this as the search-result snippet underneath the title. Keyword density tuned for `AI agent` / `browser AI` / `BYOK` / `open-source`.

---

## 3. Detailed description (long) — English

Paste into the CWS dashboard → **Store listing** → **Detailed description** (English locale).

```
Pie is an open-source AI browser agent for Chrome. Type a task in
natural language — "summarize this page", "close inactive tabs",
"fill out this form using my saved data" — and Pie's AI agent plans
the steps and executes them across your browser tabs.

✨ What makes Pie different:

🔑 BYOK (BRING YOUR OWN KEY) — No subscription, no Pie backend, no
telemetry, no proxy. Your API key is encrypted locally with AES-GCM
and only ever sent as the Authorization header on direct calls to
your chosen provider. Supported providers (8 and counting):
• Anthropic Claude (native tool_use)
• OpenAI ChatGPT / GPT-4 (function calling)
• Google Gemini (native API)
• OpenRouter (any model)
• DeepSeek, MiniMax, ZhiPu 智谱, Bailian 百炼

🤖 NATIVE TOOL CALLING — Not a prompt-glued wrapper. Pie uses
Anthropic tool_use blocks and OpenAI function_calling to drive a
typed tool registry: DOM actions, cross-tab orchestration, page
content extraction.

🎯 SKILLS — Save any prompt as a reusable skill with a scoped tool
whitelist. Run with /skill_name. The AI agent can author its own
skills too, so workflows the model just figured out can be replayed
next session.

⌨️ CANVAS EDITOR SUPPORT — Pie supports Chrome DevTools Protocol
keyboard injection (opt-in), so it works with canvas-based editors
like Google Docs, Notion, and Lark Docs where standard DOM events
fail.

📑 MULTI-SESSION — Conversations survive Service Worker restarts.
Archived sessions evict on storage pressure (LRU + 30-day delete).
Pin tabs per session so Pie's agent stays scoped to your task.

🌐 SIDE PANEL, NOT POPUP — Pie lives in Chrome's side panel and
stays open while you browse. Chat, run AI tasks, manage tabs
without losing context.

🔒 PRIVACY-FIRST — No Pie servers. No analytics. No third parties.
Page content sent to the LLM is wrapped in <untrusted_*> markers to
defeat prompt-injection attempts from page DOM. Apache 2.0 licensed
— source at github.com/WiseriaAI/pie-ai-agent.

⚙️ How to use:
1. Install Pie
2. Open the side panel, go to Settings, paste your API key
3. Switch to Chat and tell Pie what to do

Requires Chrome 114+ or any Chromium browser with side-panel
support (Edge, Brave). On browsers that accept the side-panel API
but never render it (Arc), right-click any page and choose "Open
Pie in a separate window" — Pie remembers the choice.

Pie is open-source software. Found a bug? Want a feature? Issues
and PRs welcome at github.com/WiseriaAI/pie-ai-agent.
```

---

## 4. Detailed description (long) — 简体中文

Paste into the CWS dashboard → **Store listing** → **Detailed description** (`zh_CN` locale).

```
Pie 是一款开源的 Chrome 浏览器 AI Agent。用自然语言描述任务 ——
"总结这个页面"、"关闭不活跃的标签页"、"用我保存的数据填写表单"
—— Pie 会自动规划步骤并跨标签页执行。

✨ Pie 的差异化：

🔑 BYOK（自带 API Key）—— 不用订阅，不走 Pie 服务器，不收集遥测，
不经任何代理。你的 API Key 用 AES-GCM 在本地加密，只在直接调用你
选定的 AI 服务商时作为 Authorization header 发出。已支持 8 家：
• Anthropic Claude（原生 tool_use）
• OpenAI ChatGPT / GPT-4（function calling）
• Google Gemini（原生 API）
• OpenRouter（任意模型）
• DeepSeek、MiniMax、智谱、百炼

🤖 原生 Tool Calling —— 不是 prompt 拼接的 wrapper。Pie 用
Anthropic 的 tool_use blocks 和 OpenAI 的 function_calling
驱动一个类型化的工具注册表：DOM 操作、跨标签页编排、页面内容提取。

🎯 Skill 系统 —— 把任何 prompt 保存为可复用的 skill，工具白名单可
精细配置。用 /skill_name 调用。AI Agent 还可以自己写 skill ——
刚走通的工作流，下个 session 就能一键回放。

⌨️ Canvas 编辑器支持 —— Pie 支持 Chrome DevTools Protocol 键盘
注入（默认关闭，需手动启用），所以能驾驭 Google Docs、Notion、
飞书文档这类不响应标准 DOM 事件的 canvas 编辑器。

📑 多会话 —— 对话在 Service Worker 重启后依然保留。归档的会话在
存储压力下按 LRU + 30 天硬删除自动清理。每个会话可固定标签页 ——
让 AI Agent 专注当前任务范围。

🌐 Side Panel 模式 —— Pie 不是 popup，而是常驻 Chrome 侧边栏。
边浏览边聊天、跑 Agent 任务、管理标签页，不丢失上下文。

🔒 隐私优先 —— 没有 Pie 服务器、没有分析统计、没有第三方。所有
发给 LLM 的页面内容都用 <untrusted_*> 标记包裹，对抗来自页面 DOM
的 prompt injection。Apache 2.0 开源协议，源码：
github.com/WiseriaAI/pie-ai-agent

⚙️ 使用步骤：
1. 安装 Pie
2. 打开侧边栏，进入 Settings，粘贴你的 API Key
3. 切到 Chat，告诉 Pie 你想做什么

需要 Chrome 114+ 或任何支持 side panel 的 Chromium 浏览器
（Edge、Brave）。若浏览器接受侧边栏 API 却从不渲染面板（如 Arc），
在任意页面右键选择「在独立窗口中打开 Pie」，Pie 会记住该选择。

Pie 是开源软件。发现 bug 或想要新功能？欢迎到 GitHub 提 issue / PR：
github.com/WiseriaAI/pie-ai-agent
```

---

## 5. Dashboard configuration changes

### Category — change from `Productivity` → `Developer Tools`

**Why:** "AI agent" / "browser AI" in the Productivity category competes against Monica / Sider / Merlin / HARPA AI / MaxAI (all 100k+ installs). The Developer Tools category has weaker SEO competition for the same keywords, and Pie's user persona (BYOK + open-source) skews developer-leaning anyway.

If you'd rather not move the category for fear of losing existing Productivity-search traffic, keep `Productivity` for now and revisit after 30 days of SEO data.

### ~~Search labels~~ — REMOVED FROM CWS

The "Search labels / Search tags" field was retired during the CWS dashboard redesign (~2022, fully enforced by 2023) — there is **no longer a place to set keyword tags** in the new dashboard. CWS now indexes keywords directly from:

- Manifest `name` (highest weight)
- Manifest `description` (short description)
- Detailed description (long description)
- Category
- Screenshot captions (see section 6 — still indexed and still worth keyword-tuning)

All of these are already keyword-tuned in this listing refresh, so no action is needed here. If you encounter older third-party CWS SEO guides telling you to set "search tags", they are referencing the retired dashboard.

### Locale list

Add `zh_CN` if not already enabled — the Chinese description above unlocks China-region CWS search traffic and competition is much lower there.

---

## 6. Screenshots & promo tile (SEO + CTR levers)

### Screenshots (5 × 1280×800 PNG)

Each screenshot has a caption that CWS indexes. **Embed target keywords in captions.**

| # | Visual | Caption (SEO-optimized) |
|---|---|---|
| 1 | Side panel chat with a multi-step agent task in progress | `Open-source AI agent for Chrome — type tasks in plain English` |
| 2 | Cross-tab automation result (e.g., auto-group skill) | `AI browser automation across tabs — Pie's agent in action` |
| 3 | Settings panel with multiple provider entries listed | `BYOK — 8 LLM providers: Claude, ChatGPT, Gemini, OpenRouter` |
| 4 | Skill list / running a `/skill_name` from chat | `Reusable AI skills — save any prompt and run with /command` |
| 5 | Session drawer with pinned tabs + multi-session | `Multi-session AI agent — pin tabs per task, persist across restarts` |

### Promo tile (440×280 small; optional 1400×560 marquee)

Show: **Pie logo + 1 differentiator line + 1 keyword line**

Recommended small tile composition:
```
[Pie icon]
PIE
Open-Source AI Agent for Browser
BYOK · 8 providers · no backend
```

---

## 7. Pre-submission checklist (v0.11.0)

- [ ] Confirm `manifest.json` version field matches the zip name (currently 0.11.0 — bump if needed)
- [ ] `pnpm test` passes
- [ ] `pnpm build` succeeds; zip `dist/` as `pie-0.11.0.zip`
- [ ] CWS dashboard → upload new zip
- [ ] Verify the **listing title** auto-renders from manifest `name` (should show `Pie · Open-Source AI Agent for Browser & Tabs`)
- [ ] Verify the **short description** auto-renders from manifest `description`
- [ ] Replace **Detailed description** (English locale) with section 3 above
- [ ] Enable `zh_CN` locale; paste section 4 into the Chinese **Detailed description**
- [ ] Change **Category** from `Productivity` → `Developer Tools` (optional, see section 5)
- [ ] Re-upload screenshots with the captions from section 6 (if existing screenshots have old captions like "Pie helps you ...", they should be replaced)
- [ ] Re-upload promo tile per section 6
- [ ] **Privacy policy URL** — confirm it still points to the raw `PRIVACY.md`. No change since v0.5.0.
- [ ] **Permission justifications, remote-code disclosure, data-usage disclosures** — no change needed. They are correctly described in [`chrome-web-store-submission.md`](./chrome-web-store-submission.md) and product behavior is unchanged.
- [ ] Distribution: `Public` (or `Unlisted` for a soft launch)
- [ ] Submit. Expect 5–14 days review window.

---

## 8. Post-launch SEO tracking & cold-start playbook

### Keyword tracking (check weekly in CWS search results)

| Target keyword | Search this in CWS | Goal |
|---|---|---|
| `ai agent` | High competition | Page 2 within 30 days; page 1 within 90 days |
| `browser ai` | Medium-high competition | Page 1 within 60 days |
| `open source ai agent` | Low competition | Page 1 within 14 days (achievable from launch) |
| `byok` | Very low competition | #1 result within 7 days |
| `chrome ai automation` | Low-medium competition | Page 1 within 30 days |

### Cold-start install + review channels (first 2 weeks)

CWS search ranking weighs install count + review count + rating heavily. SEO copy is the prerequisite; **external traffic is the multiplier**.

1. **Product Hunt** — schedule a Tuesday or Wednesday launch (best visibility). Position: "Open-source AI browser agent — BYOK, no backend."
2. **Hacker News** — `Show HN: Pie — an open-source AI browser agent that brings your own API key`. Lead with the open-source / privacy angle, not the AI angle (HN audience is skeptical of AI hype but loves OSS + BYOK).
3. **reddit** — `r/ChromeExtensions`, `r/LocalLLaMA`, `r/ChatGPTPro`, `r/SideProject`. Different angles per sub.
4. **Twitter/X** — AI/extension/dev circles. Pin a single thread with screenshots + GitHub link.
5. **V2EX / 即刻** (中文区) — leverage the `zh_CN` listing for a separate launch push.

### Review-rate booster (deferred — requires UX work)

After ~10 completed tasks, show a non-intrusive toast: *"Enjoying Pie? Rate us on the Chrome Web Store ★★★★★"*. Respect dismissals (never re-prompt the same install). This significantly accelerates the review count.

---

## 9. Decisions made (record for next iteration)

- **Brand kept:** "Pie" stays as the leading brand anchor. Did not rename to a keyword-heavy alternative because it would forfeit existing install count, reviews, and listing tenure.
- **Single listing, not republish:** Same extension ID, same CWS listing. Republishing as a new listing would reset all SEO weight and reviews to zero.
- **CTA in long description ditched:** No "Install now" or "★★★★★ Rate us" CTA inside the description body. CWS users already see Install/Rate buttons on the listing chrome; in-body CTAs feel spammy.
- **Confirm-card section removed from long description:** The risk-confirmation UX has been relaxed in recent releases; not the strongest selling point to highlight in marketing copy. Permission justification doc still documents it accurately.
- **BYOK promoted to differentiator-section-first:** Was the second standalone paragraph in V1; moved into "What makes Pie different" as the leading bullet so the first 200 chars are the highest keyword + value density.
