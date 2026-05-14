---
status: ready-for-plan
issue: https://github.com/WiseriaAI/Pie/issues/38
preview: docs/specs/2026-05-14-issue-38-preview.html
---

# Issue #38 v1 设计 — 引用页内内容

> 输入时支持引用页内内容（文字 + 元素截图）+ side panel 引用面板。

## 0. 背景

Issue #38 原 scope 含 4 个独立子系统：(A) 文字引用、(B) 元素引用、(C) 划词智能组件边界、(D) 引用面板，加 SPA / iframe / Canvas+OCR 兼容性 3 条。单 spec 装不下。本设计锁 v1 = **A + B + D**；C 智能边界 / iframe / Canvas / OCR 全部推 v2。

ROADMAP §12 P2 已记录该 issue 与 R15 image untrusted boundary、Phase 5 image attach pipeline、`<all_urls>` host_permission 的协作关系。本设计在这些既有能力上加一个常驻 content script（Pie 首个）+ 一个 thin SW 模块 + sidepanel chip 行扩展。

## 1. brainstorm 决策摘要

| # | 问题 | 答案 |
|---|---|---|
| Q1 | v1 scope | A 文字 + B 元素截图 + D chip 行 |
| Q2 | 触发方式 | 划词 → floating bubble；元素 → sidepanel picker |
| Q3 | 元素表征 | 截图（image content block）+ 结构化 metadata（新 untrusted wrapper） |
| Q4 | 容量上限 | v1 不设；image chip 仍受 Phase 5 R13/R14 evict |
| Q5 | 架构 | 常驻 content script（`content_scripts: all_urls, run_at: document_idle, all_frames: false`） |

12 条 §9 设计细节用户已确认（见 preview HTML §9 复核清单），具体细则在下文展开。

## 2. 架构总览

3 层组件，单向数据流，content script 不持久化。

```
┌──────────────────────────────────────┐
│ PAGE · NEW content script            │
│   src/content/quote/                 │
│  • SelectionListener + FloatingBubble│
│  • ElementPicker overlay              │
│  • Bbox metadata 抽取                 │
└──────────────────────┬───────────────┘
                       │ chrome.runtime.sendMessage
                       ▼
┌──────────────────────────────────────┐
│ SW · thin QuoteBridge module         │
│   src/background/quote-bridge.ts     │
│  • Route quote payloads              │
│  • captureVisibleTab + bbox crop     │
│  • Picker start/stop RPC             │
│  • 不持久化、不进 agent loop          │
└──────────────────────┬───────────────┘
                       │ panel port (existing) + 新 type
                       ▼
┌──────────────────────────────────────┐
│ SIDEPANEL · existing + extension     │
│   useSession + Chat composer         │
│  • quotes per-session Map state      │
│  • Composer chip row 扩展             │
│  • Pre-submit serialize wire         │
└──────────────────────────────────────┘
```

### 2.1 关键不变量

- **常驻 content script 仅承担引用功能**。click / type / snapshot / screenshot 等现有 DOM 工具一律不迁，保留 `chrome.scripting.executeScript`。
- **chip 与 pinned tab 解耦**。引用可来自任意 tab；每条 chip 自带 `sourceUrl` + `sourceTabId`，LLM 在 wrapper 上看到来源（区别于 `untrusted_page_content` 是 pinned tab 上下文）。
- **chip 不持久化**。SW QuoteBridge 不写 storage；sidepanel quote state 不写 storage；切 session / SW 重启 / panel 重启 → chip 清空（同 textarea 草稿）。
- **quotes per-session**。复用 M3-U6 `Map<sessionId, T>` 模型，并发会话独立。
- **send → 序列化 → 清空**。chip 不"挂"在持续上下文里；只在该 turn 的 user message 出现；后续 turn 不重复携带（避免 BYOK token 失控）。

## 3. Content Script 实现

### 3.1 模块结构

新目录 `src/content/quote/`：

- `index.ts` — entry，注册 listeners、handle SW messages
- `selection-listener.ts` — `mouseup` + `selectionchange` 监听
- `floating-bubble.ts` — Shadow DOM bubble render + click handler
- `element-picker.ts` — hover-highlight overlay、click 选定、Esc 退出
- `bbox-extractor.ts` — 元素 metadata 抽取（role / accessibleName / textContent / outerHTML 截断 / bbox）

`src/content/index.ts` 现有 placeholder 改为 import `./quote/index.ts`。

### 3.2 manifest 改动

```json
"content_scripts": [{
  "matches": ["<all_urls>"],
  "js": ["src/content/index.ts"],
  "run_at": "document_idle",
  "all_frames": false,
  "match_origin_as_fallback": false
}]
```

v1 不维护 `exclude_matches` deny-list；CSP 严格站点（GitHub / Stripe / GMail 等）实测后再补。

### 3.3 Floating Bubble

- 监听 `mouseup` + `selectionchange`
- 非空 selection（trim 后 ≥ 1 字符）→ 计算锚点：**selection 结束位置上方**（避开光标 / 鼠标轨迹）
  - 顶部空间不够时 fallback 至下方
- Shadow DOM 隔离样式（防站点 CSS 污染、防 site CSP `style-src 'unsafe-inline'` 拒绝 — Shadow DOM 内 `<style>` 不受外部 CSP 约束）
- 点 bubble → `chrome.runtime.sendMessage({type: 'quote-text-captured', payload: {text, sourceUrl}})`
- 同 selection 多次点击 = 多次添加 chip（不去重）
- selection 清空 → bubble 自动消失

### 3.4 Element Picker

- sidepanel 按 "拾取元素" → SW broadcast `picker:enter` → content script 进入 picker 模式
- `mousemove` 命中元素：加 outline 高亮 + 顶部角标显 `<tagName> · accessibleName`
- click → 抽 bbox + role + accessibleName + textContent + outerHTML(截断 **1000** 字符) + sourceUrl，textContent 截断 **500** 字符
- 退出 picker 三方式：Esc / 右键 / 再次点 sidepanel 按钮
  - 不加"点击外部退出"——与正常点击歧义
- picker 期间不挡 textarea 输入；可与文字 chip 并存
- 多 tab：picker 绑当前 active tab（不绑 pinned tab）

### 3.5 元素截图

- page 端只抽 bbox（getBoundingClientRect + devicePixelRatio）
- SW 端调 `chrome.tabs.captureVisibleTab(tabId)` → OffscreenCanvas crop → JPEG q85
- bbox **紧贴**，不加 padding
- 复用 Phase 5 image normalize util（长边 1568px clamp）

### 3.6 SPA / CSP 兼容

- 不依赖 `DOMContentLoaded`，纯运行时 listener 注册 → SPA route change 自动跟随
- Bubble / picker overlay 都是 Shadow DOM 容器，挂在 `document.documentElement`，DOM 重渲染不影响
- 常驻 script 不动态执行任意代码（无 `eval` / `Function()` / inline 注入）
- 样式走 Shadow DOM `<style>`，不依赖 `style-src 'unsafe-inline'`
- 截图 crop 在 SW，content script 不需要 `img-src data:`

## 4. SW QuoteBridge

新文件 `src/background/quote-bridge.ts`。Thin module，只做路由 + 截图 crop。不持久化、不参与 agent loop。

### 4.1 消息协议

| 方向 | type | payload | 用途 |
|---|---|---|---|
| content → SW | `quote-text-captured` | `{ text, sourceUrl }` | 用户点 bubble 后 |
| content → SW | `quote-element-captured` | `{ bbox, role, accessibleName, textContent, outerHTMLTruncated, sourceUrl }` | picker click 后 |
| SW → panel port | `quote-added` | `{ id, kind, ...payload, sourceTabId, imageDataUrl? }` | chip 投递；imageDataUrl 仅元素 chip |
| panel → SW | `picker:start` | `{ tabId }` | 启动 picker |
| panel → SW | `picker:stop` | `{ tabId }` | 取消 picker |
| SW → content | `picker:enter` / `picker:exit` | `{ }` | 广播给指定 tab |

### 4.2 不变量

- 所有 content→SW 消息必须校验 `sender.tab.id`，丢 null sender
- chip id 由 SW 端生成（`crypto.randomUUID()`），content script 不参与 id 分配
- 截图 crop 走 Phase 5 已有的 image-normalize util（JPEG q85，长边 1568px clamp）
- QuoteBridge 不进 task loop；agent 看不到 "用户正在输入引用"
- `captureVisibleTab` 失败（permission / chrome:// / extension page）→ 元素 chip 仍可加但 imageDataUrl=null

## 5. Sidepanel UI

### 5.1 Composer chip 行

复用 Phase 5 image attach chip 行容器，扩展为三类 chip：

| chip | 视觉 | 内容 |
|---|---|---|
| 文字 | 蓝边 + `"` + 前 28 字截断 | hover popover 显完整文本 + sourceUrl |
| 元素 | 绿边 + `⊞` + `role · "accessibleName"` | hover popover：有 `imageDataUrl` 时显小缩略图 + role/name/textContent；null 时仅显 "[截图不可用]" + metadata |
| 图片 | 橙边 + `🖼` + 文件名截断 | Phase 5 现有视觉 |

- chip 点 × 移除
- 多 chip 容器自动 wrap，不限单行
- chip 不去重（同段文本可重复添加）

### 5.2 Picker 启动 UX

- 点 "拾取元素" → 按钮变 **"拾取中… (Esc 取消)"**，焦点回到页面
- 用户在页面 click 命中后回到 sidepanel，按钮复原，chip 自动加
- picker 模式期间不挡 textarea 输入；可与文字 chip 并存

### 5.3 useSession state

```typescript
type Quote =
  | {
      id: string;
      kind: "text";
      text: string;
      sourceUrl: string;
      sourceTabId: number;
    }
  | {
      id: string;
      kind: "element";
      role: string;
      accessibleName: string;
      textContent: string;       // 截断 500
      outerHTMLTruncated: string; // 截断 1000
      imageDataUrl: string | null; // 元素 bbox crop JPEG；captureVisibleTab 失败时为 null
      sourceUrl: string;
      sourceTabId: number;
    };

// useSession state 扩展
type SessionUIState = {
  // ... existing
  quotes: Quote[]; // 不写 storage
};

// hub 层（M3-U6 后）
type Slot = {
  // ... existing
  quotes: Quote[];
};
```

复用 M3-U6 per-session state 模型（`Map<sessionId, T>` slots / slotsRef hub）。切 session → 看见对应 session 的 quotes。

### 5.4 Pre-submit serialize

send 时（按 chip 添加顺序）：

1. 构造 user message content array：
   - 先 image content blocks（元素 chip 的 imageDataUrl 非 null 部分 + 用户上传图，按 chip 添加顺序）
   - 再 text content block（含所有 wrapper + 纯文本输入）
2. quotes 清空
3. 重置 image attach state（Phase 5 现有行为）

## 6. LLM wire 协议

### 6.1 新增 wrapper

注册到 `src/lib/agent/untrusted-wrappers.ts` 的 `KNOWN_WRAPPERS` 列表：

| wrapper | 用途 | 内容 |
|---|---|---|
| `untrusted_page_quote` | 文字 chip | 用户选中的纯文本 |
| `untrusted_page_element` | 元素 chip 的结构化 metadata | role / name / textContent / outerHTML truncated |

两者复用全套 closing-tag confusable sanitize 防御（8 种攻击向量），与 R15 image untrusted boundary 同质。

### 6.2 序列化示例（Anthropic shape）

```json
{
  "role": "user",
  "content": [
    { "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": "..." } },
    { "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": "..." } },
    {
      "type": "text",
      "text": "<untrusted_page_quote source_url=\"https://example.com/docs\">\nVivamus ultrices urna eget elit ornare, vitae malesuada nisi rhoncus.\n</untrusted_page_quote>\n\n<untrusted_page_element source_url=\"https://github.com/foo/bar/issues\" role=\"button\" name=\"Create issue\">\ntext_content: \"New issue\"\nouter_html: \"&lt;button class=\\\"Button--primary\\\"&gt;New issue&lt;/button&gt;\"\n</untrusted_page_element>\n\n帮我看下这个按钮点了会发生什么"
    }
  ]
}
```

OpenAI / OpenRouter / 其他 OpenAI-compat provider 走对应 image_url + text 块，wire 结构同源。

### 6.3 不变量

- 2 个新 wrapper 走 `untrusted-wrappers.ts` 已有 sanitize（无单独 sanitize 入口）
- 截图 base64 在 `untrusted_page_element` wrapper **外**，作为独立 image content block；wrapper 内不嵌 base64
- 不在 system prompt 提到 quote — 工具不感知，LLM 仅在 user message 看到
- send 后 quotes 清空；后续 turn 不重复携带
- 纯文字输入不套 wrapper — 用户直接输入仍走 R15 现有 `untrusted_user_message` 边界
- image content block 顺序 = 元素 chip 截图按 chip 添加顺序 + 用户上传图按 chip 添加顺序

## 7. 错误处理与边界

### 7.1 容错

| 场景 | 行为 |
|---|---|
| `captureVisibleTab` 失败（permission / chrome:// / extension page） | 元素 chip 仍可加，imageDataUrl = null；LLM 只看到 metadata wrapper |
| tab 已关闭（截图前 tab 没了） | chip 添加失败，sidepanel toast 提示 |
| content script 注入失败（chrome:// / PDF viewer / blob:） | 用户无法在该 tab 用划词 / picker；sidepanel 按钮文案不变 |
| picker 期间用户切 tab | picker 仍在原 tab 等点击；sidepanel 按钮显示等待中 tab；Esc 取消 |
| send 时 quotes 还在但 textarea 空 | 允许发，user message 只含 chip + wrapper（"看下这个" 场景） |

### 7.2 明确不防

- **用户主动引用 prompt injection 内容** — wrapper sanitize 防 LLM context 被 break，但若用户主动选中"忽略前面指令"这种文本，LLM 仍可能被诱导。与 R15 现有 `untrusted_user_message` 同质。
- **BYOK token 失控** — v1 不设上限（brainstorm Q4 决定）；观察期看是否需要 chip 数量 / 总字符 / 总 image bytes 三个轴的 reactive 限制（v1.1 backlog）。

## 8. 测试策略

按 CLAUDE.md "cross-layer integration test 模板" feedback：任何跨 panel↔SW 新 wire 字段必须有 wire→DisplayMessage 透传 regression test。本 feature 含 6 个新 wire type，cross-layer 是 P0 不可省。

| 层 | 测试范围 | 关键 case |
|---|---|---|
| content unit | SelectionListener / FloatingBubble / ElementPicker / BboxExtractor | mouseup 触发 bubble；空 selection 不触发；Shadow DOM 隔离；Esc 退 picker |
| SW unit | QuoteBridge 路由 + 截图 crop | null sender 拒绝；captureVisibleTab 失败 → imageDataUrl: null |
| sidepanel unit | useSession quote state + Composer chip 行 + Pre-submit serialize | chip 加 / 删 / send 清空；per-session 隔离；3 类 chip 视觉 |
| **cross-layer integration** | **content → SW → panel → DisplayMessage** 透传 | quote-text-captured 全链路；quote-element-captured 含截图全链路；切 session 中断 picker |
| wire shape | 序列化为 LLM user message | image 块顺序遵循 chip 添加顺序的 image 子序列；wrapper sanitize 双角度（closing-tag confusable / 用户引用文本含 `<untrusted_page_quote>` 字面字符串的嵌套攻击）；纯文字 + chip 并存 |
| untrusted-wrappers | 新增 2 wrapper 复用现有 sanitize | regression：KNOWN_WRAPPERS 列表 build-time check（同 risk.ts 模式） |

## 9. v1 明确不做（v2 推迟）

| 项 | 原因 |
|---|---|
| C 智能组件边界高亮 | 需 heuristic 算法（React fiber root 探测 / 语义化标签 / aria-label boundary），单独 v2 项 |
| iframe 内容引用 | `all_frames: false`；跨域 + same-origin policy + nested frames 复杂度高，v2 评估 |
| Canvas / OCR 兜底 | OCR pipeline 独立工程（tesseract.js vs server-side），与 BYOK 模型成本叠加风险 |
| chip 持久化 | 与 chip "一次性引用" 语义冲突；textarea 草稿同行为 |
| chip 容量上限 | brainstorm Q4 决议；BYOK cost 失控由 v1.1 reactive 收口 |
| 划词后自动展开 side panel | `chrome.sidePanel` API 仅允许 user gesture 触发 open，content script mouseup 不算 user gesture；v1 假设 sidepanel 已开（Pie 当前使用习惯一致）；v1.1 评估 `action.openSidePanel` + `tabs.onUpdated` 钩子 |
| 引用历史 | "看历史引用过什么"属于 v2 范畴 |
| 引用快捷键 | manifest `commands` 字段；v1 划词触发已足够，v1.1 评估 |

## 10. 文件清单

### 新增

- `src/content/quote/index.ts`
- `src/content/quote/selection-listener.ts`
- `src/content/quote/floating-bubble.ts`
- `src/content/quote/element-picker.ts`
- `src/content/quote/bbox-extractor.ts`
- `src/background/quote-bridge.ts`
- 对应单元测试 `*.test.ts`
- 一个或多个 cross-layer integration test 文件

### 修改

- `manifest.json` — 加 `content_scripts` 字段
- `src/content/index.ts` — 由 placeholder 改为 import `./quote/index.ts`
- `src/lib/agent/untrusted-wrappers.ts` — KNOWN_WRAPPERS 加 `untrusted_page_quote` / `untrusted_page_element`
- `src/sidepanel/hooks/useSession.ts` — 加 quotes state（per-session Map）
- `src/sidepanel/components/Chat.tsx` — composer chip 行扩展（文字 / 元素 chip）+ "拾取元素" 按钮 + pre-submit serialize
- `src/background/index.ts` — wire QuoteBridge module + panel port message dispatch
- `src/types/` — Quote 类型、QuoteBridge wire schema

## 11. 不变量参考索引

| 编号 | 名称 | 出处 |
|---|---|---|
| R15 | image untrusted boundary system prompt | Phase 5 v1 |
| R13/R14 | image cache LRU evict + image-bearing paused→failed | Phase 5 v1 |
| M3-U6 | per-session state hub `Map<sessionId, T>` | 2026-05-08 #30 |
| untrusted-wrappers 8 种 confusable sanitize | closing-tag attack 防御 | `src/lib/agent/untrusted-wrappers.ts` |

## 12. 下一步

1. 用户复核本 spec
2. 走 superpowers writing-plans skill → 产出 `docs/plans/2026-05-14-issue-38-page-content-reference.md`
3. plan 拆 task / 串行依赖 / 进入执行
