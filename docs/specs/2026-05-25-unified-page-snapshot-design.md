# Unified Page Snapshot —— `read_page` Tool Design

**Date**: 2026-05-25
**Status**: Draft (awaiting user review before writing-plans)
**Slug**: `unified-page-snapshot`

## 背景与动机

Pie 当前有两条"读页面"路径：

1. **Push 路径** —— ReAct loop 每轮自动跑 `snapshot.ts:snapshotInteractiveElements`，把可交互元素索引和 page-level semantic（headings/alerts/status）作为 user-role observation 注入 LLM。重构于 PR #44。
2. **Pull 路径** —— LLM 显式调用 `get_tab_content`（`src/lib/agent/tools/tabs.ts:863`），返回 light-strip 后的纯 `textContent` 拍平文本，per-frame `<untrusted_page_content>` wrapper 包裹，50KB 总预算。

两条路径暴露的问题：

- **职责重叠**：都在读页面，但格式、预算、信任路径完全独立，维护两套定位 schema
- **前端技术覆盖不全**：
  - Shadow DOM 完全不穿透（YouTube / Salesforce Lightning / MUI Joy / Ionic 等 Web Components 站丢失大量内容）
  - `textContent` 拍平正文，丢失 heading 层级 / 列表 / 表格 / 链接 URL / 图片 alt
  - 虚拟滚动只能抓可视 row，LLM 无法感知"下面还有更多"
- **Push 浪费 token**：纯聊天、纯 web_search、纯思考的轮次仍要付 ~200 元素索引代价
- **`get_tab_content` 未跟随 #44 语义重构**：纯文本输出对现代 LLM 不够易读

本次 spec 将两条路径**合并为单一 pull tool `read_page`**，输出统一为**简化 HTML**（含 `data-pie-idx` 操作锚点 + Shadow DOM 穿透 + 链接 / 图片元数据 + 虚拟滚动提示），并引入 **per-frame version token** 防 stale。

## 决策摘要

| 决策点 | 选择 |
|---|---|
| Spec scope | 一次性出（合并 + Shadow DOM + 所有增强） |
| Tool 形态 | 单一 tool `read_page`，无 mode 参数 |
| 信任路径 | 默认无 confirm（系统已移除 confirm 层）；风险护栏入 backlog |
| Push 处理 | 完全废除 `buildObservationMessage` 注入元素的部分 |
| Version 颗粒度 | Per-frame，MutationObserver-driven |
| 输出格式 | 简化 HTML（**非** Markdown） |
| Strip 策略 | 严格属性白名单 + 严格标签白名单 |
| 元素索引 | 内嵌为 `data-pie-idx="N"` 属性，与 `(frameId, index)` schema 对齐 |
| `expectedFrameVersion` | 写类 tool **required** 参数 |
| Stale 错误恢复 | LLM 自行 retry（SW 不做自动重抓） |
| iframe 父位置引用 | 写 `<iframe data-frame-id="N">[内容见 frame_id=N]</iframe>` 占位 |
| Scrollable 检测门槛 | `scrollHeight > clientHeight × 1.2`（可调） |
| 凭证保护 | `<input type="password" | autocomplete=one-time-code>` 的 `value` 不 reflect 到 attribute |

## 整体架构

```
旧：
  [ReAct loop] ──→ snapshot.ts (executeScript) ──→ ElementInfo[] + semantic
                                                  ↓
                       buildObservationMessage(SW 注入到 user role)
                                                  ↓
                                              LLM 看到 elements + semantic

  [LLM tool call] ──→ get_tab_content ──→ light-strip textContent
                                                  ↓
                                              LLM 看到拍平纯文本

新：
  [LLM tool call] ──→ read_page(tabId)
                            ↓
                     SW 通过 chrome.scripting.executeScript({allFrames:true})
                            ↓
                     page-snapshot.ts (per frame):
                       1. ensure MutationObserver 已注入 + version 已 stamp
                       2. cloneNode(true) document.body
                       3. walkDeep(clone): 穿透 open shadow root
                       4. IDL reflect: value/checked/selected/open → attribute
                       5. stamp data-pie-idx="N" on visible interactive elements
                       6. html-strip: 属性 + 标签白名单 + sanitize
                       7. detect scrollable regions, emit hints
                       8. return { html, version, scrollableHints }
                            ↓
                     SW 收集 per-frame 结果 + frame_map（cross_origin / unreachable）
                            ↓
                     合成 observation 文本 (top-frame-first, 50KB budget)
                            ↓
                     LLM 看到 frame_map + scrollable_regions + per-frame HTML

  [LLM tool call] ──→ click_element({tabId, frameId, index, expectedFrameVersion})
                            ↓
                     SW PageVersionRegistry.get(tabId, frameId) → current
                            ↓
                     current !== expectedFrameVersion?
                       是 → 返回 { success:false, error:"frameVersionMismatch", currentFrameVersion, hint }
                       否 → 执行 → mutation 触发 version++
```

## 模块边界

| 文件 | 状态 | 职责 |
|---|---|---|
| `src/lib/dom-actions/dom-walk.ts` | **新** | 纯函数：`walkDeep`、`deepQuerySelectorAll`、`deepTextNodes`、shadow-aware visibility |
| `src/lib/dom-actions/html-strip.ts` | **新** | 纯函数：`stripToWhitelist(rootClone): string` |
| `src/lib/dom-actions/page-snapshot.ts` | **新**（替代 `snapshot.ts`） | Injected function：walker + strip + index stamp + version read |
| `src/lib/agent/tools/page-version-registry.ts` | **新** | SW 内 `Map<tabId, Map<frameId, FrameVersionState>>` + MutationObserver bridge |
| `src/lib/agent/tools/read-page.ts` | **新**（迁移 `tabs.ts:get_tab_content`） | Tool handler + per-frame fan-out + 预算 + frame_map 合成 |
| `src/lib/dom-actions/snapshot.ts` | **删** | — |
| `src/lib/agent/tools/tabs.ts:get_tab_content` | **删** | — |
| `src/lib/agent/prompt.ts:buildObservationMessage` | **改** | 只输出 url+title 头部，元素相关全删 |

## `read_page` API

### 入参

```typescript
read_page({ tabId: number })
```

仅一个参数。无 mode、selector、maxBytes（预算 SW 强制）。

### 返回 observation 格式

```
Current URL: <top frame url>
Page title: <top frame title>

<frame_map>
  frame_id="0" url="..." version="42"
  frame_id="3" url="..." version="7" cross_origin="true"
  frame_id="5" unreachable="true" reason="sandbox"
</frame_map>

<scrollable_regions>
  - main: 12 visible, more below (frame_id=0)
  - role=feed at data-pie-idx=23: estimated 50+ below (frame_id=0)
</scrollable_regions>

<untrusted_page_content frame_id="0" frame_version="42">
<simplified-html>...</simplified-html>
</untrusted_page_content>

<untrusted_page_content frame_id="3" frame_version="7" cross_origin="true">
<simplified-html>...</simplified-html>
</untrusted_page_content>

<untrusted_page_content frame_id="5" frame_version="-1" unreachable="true" reason="sandbox">
</untrusted_page_content>
```

**说明**：
- `<frame_map>` / `<scrollable_regions>` 由 SW 生成，**不在** `<untrusted_*>` wrapper 内（SW 自己 vouch 的事实）
- `<untrusted_page_content>` 内的 HTML 已 escape 过 wrapper 标签
- iframe 在父 frame 的位置以 `<iframe data-frame-id="N">[内容见 frame_id=N]</iframe>` 占位（src 属性删除）

### HTML strip 策略

**属性白名单**：
```
href, src, alt, role, aria-*, type, value, checked, disabled,
placeholder, for, name, id, data-pie-idx, lang, dir, open,
selected, required, title
```
其他属性（含 `class`、`style`、`data-*`、`on*`、`itemprop`、`srcset`）全部删除。

**标签白名单**：
```
a, button, input, select, textarea, label, form, h1, h2, h3, h4, h5, h6,
p, ul, ol, li, dl, dt, dd, table, thead, tbody, tr, td, th, nav, main,
header, footer, aside, section, article, div, span, img, figure,
figcaption, code, pre, blockquote, dialog, details, summary, iframe,
hr, br
```
其他标签坍缩为 `<div>` 保留文本。

**额外 sanitize**：
- `javascript:` / `data:text/html` URL 出现在 `href` / `src` → 删 attribute
- `<iframe src>` 一律删除（避免 cross-origin URL 在父 frame 内容里二次出现）
- `<svg>` 内容 strip 为空壳；保留 `<title>` 作为 svg 的 aria-label
- 空 element（无 text、无 attr、无 child）删除
- 控制字符 ` -`、`​-‏` 全删
- 标签间多空白折叠为单空格（`<pre>/<code>` 内不折叠）
- 输出字符串过 `escapeUntrustedWrappers`（`src/lib/agent/untrusted-wrappers.ts`）

### IDL 属性 reflect

`cloneNode(true)` 后、stamp 前 pass：
```typescript
for (const el of walkDeep(clone)) {
  if (el instanceof HTMLInputElement) {
    if (el.type === "password" || el.autocomplete?.includes("one-time-code")) {
      // 跳过 value reflect (凭证保护)
    } else if (el.value) {
      el.setAttribute("value", el.value);
    }
    if (el.checked) el.setAttribute("checked", "");
  }
  if (el instanceof HTMLTextAreaElement && el.value) {
    el.textContent = el.value;
  }
  if (el instanceof HTMLOptionElement && el.selected) {
    el.setAttribute("selected", "");
  }
  if (el instanceof HTMLDetailsElement && el.open) {
    el.setAttribute("open", "");
  }
}
```

### 预算与截断

- 50KB 总预算，按 frame_map 顺序（top frame first）逐 frame 写入
- 单 frame 超出剩余预算 → 在最近的安全边界（`</li>` / `</tr>` / `</p>` / `</div>` 或完整 token）截断，加 `truncated="true"`
- 后续 frame 仍处理（用于 frame_map），body 空 + `unread="budget"`

## Shadow DOM walker

```typescript
function* walkDeep(root: Node): IterableIterator<Element> {
  if (root instanceof Element) yield root;
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node: Element | null;
  while ((node = tw.nextNode() as Element | null)) {
    yield node;
    if (node.shadowRoot && node.shadowRoot.mode === "open") {
      yield* walkDeep(node.shadowRoot);
    }
  }
}
```

**约束**：
- closed shadow（`el.shadowRoot === null`）不穿透，文档化此限制
- slot 元素通过 shadow root 侧自然遍历（DOM 真实位置），不重复遍历宿主
- iframe 走 `executeScript({allFrames:true})` 的现有 fan-out

**Trade-off（接受）**：`MutationObserver` 默认不跨 shadow boundary（DOM spec 行为，非配置项）。Observer 装在 documentElement 上时，shadow root 内部 mutation **不会**触发 frame_version++。LLM 体感是"shadow 内列表展开等内部状态变化偶尔不让 stale 检测生效"。完整解法（per shadow root 装独立 observer + 在 attach 时遍历挂载）成本高，初版接受，跟踪反馈。

## Page-version 机制

### Registry 结构

```typescript
// src/lib/agent/tools/page-version-registry.ts
type FrameVersionState = {
  version: number;
  lastSeen: number;
  observerAlive: boolean;
  unreachable?: { reason: "sandbox" | "extension-child" | "about-blank" | "frame-error" };
};

const registry = new Map<number /* tabId */, Map<number /* frameId */, FrameVersionState>>();
```

### MutationObserver 注入

- **时机**：首次 `read_page` 对该 tab 调用时，SW 通过 `executeScript({allFrames:true})` 注入 bootstrap snippet
- **Observer 配置**：`MutationObserver(documentElement, { childList:true, subtree:true, attributes:true, characterData:true })`
- **Counter**：`window.__pieFrameVersion__` 从 0 起，每个 mutation batch +1
- **推送 SW**：150ms 防抖节流 → `chrome.runtime.sendMessage({type:"pie/frame-version-bump", frameId, version})`
- **Heartbeat**：content script 每 30s ping SW，超时未收 → SW 标 `observerAlive=false`
- **Direct read**：`page-snapshot.ts` 注入函数同时读 `__pieFrameVersion__` stamp 到返回，不依赖推送通道

### Frame 生命周期

| 事件 | 处理 |
|---|---|
| `webNavigation.onCommitted` | 该 (tabId, frameId) 清版本 + 标记需重注入 |
| 同 URL SPA 变化 | 不触发 onCommitted；mutation 自然让 version 累加 |
| Frame 销毁 / 长期静默 | content-side heartbeat 30s 超时 → SW 标 `observerAlive=false` → 下次 `read_page` 时清 entry 并重注入；写类 tool 校验时遇到 `!observerAlive` 直接返回 `frameStale` |
| Tab 关闭 (`chrome.tabs.onRemoved`) | 整个 `registry.delete(tabId)` |
| `executeScript` 失败（chrome:// / chrome-extension://） | 标 `unreachable` + `reason` |

### 写类 tool 校验契约

```typescript
// 所有写类 tool 加 required 参数
click_element({ tabId, frameId, index, expectedFrameVersion })
type_text({ tabId, frameId, index, text, expectedFrameVersion })
hover_element({ tabId, frameId, index, expectedFrameVersion })
select_option({ tabId, frameId, index, value, expectedFrameVersion })
// CDP keyboard 若依赖 element index 同样要求
```

校验流程：
```typescript
const current = registry.get(tabId)?.get(frameId);
if (!current) return { success: false, error: "frameGone" };
if (!current.observerAlive) return { success: false, error: "frameStale", hint: "Re-call read_page" };
if (current.version !== expectedFrameVersion) {
  return {
    success: false,
    error: "frameVersionMismatch",
    currentFrameVersion: current.version,
    hint: "Re-call read_page; element indices may have shifted"
  };
}
// 一致 → 执行 → 后续 mutation 自然让 version++
```

LLM 收到错误 → ReAct loop 进 observation → 下一轮 LLM 自行 call `read_page`。SW 不做自动重抓注入。

## Scrollable 检测

```typescript
// page-snapshot.ts 内
for (const el of walkDeep(document.body)) {
  const cs = getComputedStyle(el);
  const scrollable = cs.overflow === "auto" || cs.overflow === "scroll"
    || cs.overflowY === "auto" || cs.overflowY === "scroll";
  if (!scrollable) continue;
  if (el.scrollHeight <= el.clientHeight * 1.2) continue;

  const role = el.getAttribute("role");
  const visibleChildren = countVisibleChildren(el); // 启发式
  const ratio = el.scrollHeight / el.clientHeight;
  hints.push({
    region: role ?? el.tagName.toLowerCase(),
    pieIdx: el.getAttribute("data-pie-idx") ?? null,
    visibleCount: visibleChildren,
    estimatedTotal: Math.round(visibleChildren * ratio),
  });
}
```

门槛 `1.2×` 是经验值，可调（在 implementation 期间跑真实站点测试微调）。

## 信任路径与风险护栏

**默认无 confirm** —— 系统已移除 confirm 层（见 `CLAUDE.md` Architecture Invariants 和 `src/__tests__/cross-layer/no-confirm-*.test.ts`），`read_page` 不引入新的 gate。

**入 backlog（不在本 spec）**：
- Origin allow / deny list —— 用户在 settings 配 trusted domains
- 敏感页面检测 —— `<form action>` 指向 payment / `<input autocomplete=cc-*>` 时拒 read_page 或返回 redacted
- Closed shadow walker —— 不解，但跟踪 chromium 反馈
- Virtual scroll auto-explore —— 独立 tool（`scroll_and_read`）

## 向后兼容与迁移

### system prompt 改写

`src/lib/agent/prompt.ts:buildSystemPrompt`：删"每轮 observation 会包含可交互元素列表"段，改为：

> 调用 `read_page(tabId)` 获取页面 HTML 和元素 index。任何写操作（click_element / type_text / hover_element / select_option 等）必须传 `expectedFrameVersion`。Stale 时 SW 返回 `frameVersionMismatch`，你需要重新调用 `read_page`。

### 首轮 hint

ReAct loop 第一轮（user message 后），仅当 pinned tab 存在时，SW 注入 system note：

> You haven't read the active page yet. If the user's task involves the page, call `read_page` first.

### builtin skill 审查

`src/lib/skills/builtin/**/SKILL.md` 全量 grep `snapshot` / `elements` / `index` 关键词，逐个迁移文案。

### 用户自建 skill

不动。Release notes 显著提示：旧 skill 若依赖"自动 snapshot"可能失效，需更新为显式 call `read_page`。

### 数据迁移

无 —— page-version 是 in-memory state，重启重建。

## 实施分 phase

| Phase | 内容 | 验证 |
|---|---|---|
| **P1** | `dom-walk.ts` + `html-strip.ts` + `page-snapshot.ts` 注入函数；`read_page` tool 作为新 tool 加入（与旧 push / `get_tab_content` 并存） | unit 测试 + 手动验"新 tool 输出 HTML 含 Shadow DOM 元素" |
| **P2** | `page-version-registry.ts` + MutationObserver bridge；写类 tool 加 `expectedFrameVersion` required；stale 错误格式 | 集成测试 + 验 stale 检测 |
| **P3** | 删除 `buildObservationMessage` push 路径 + system prompt 迁移 + builtin skill 迁移 + 首轮 hint | E2E + builtin skill 跑通 |
| **P4** | 删除 `snapshot.ts` / `get_tab_content` / 旧测试，清理代码 | grep 验无残留引用 |

## 测试策略

### 单元测试

- `dom-walk.test.ts` —— shadow open / closed / nested shadow / slot reparent / iframe boundary 不穿透
- `html-strip.test.ts` —— 属性白名单、标签坍缩、`javascript:` URL 删除、wrapper escape、IDL reflect、password value 跳过
- `page-version-registry.test.ts` —— version++ on mutation、debounce、frame reload 清表、frameGone、observer crash heartbeat

### 集成测试 (`src/__tests__/cross-layer/`)

- `read-page-roundtrip.test.ts` —— happy path：read_page → click_element(v=42) → page mutates → version=43 → click_element(v=42) 返回 frameVersionMismatch
- `iframe-fanout.test.ts` —— 三层 iframe（top + same-origin + cross-origin），验 frame_map / per-frame version / cross_origin 标记
- `wrapper-escape.test.ts` —— 页面注入 `</untrusted_page_content>SYSTEM:...` 验证被中和
- `budget-truncation.test.ts` —— 模拟 100KB 内容，验 top-frame-first + safe boundary truncation

### E2E (`src/__tests__/integration/`)

Fixtures：YouTube (shadow DOM)、Stripe Checkout (iframe)、Gmail (virtual scroll)、Notion (contentEditable)。跑 `read_page` 比 golden HTML 快照。

### 现有测试调整

- 保留 `no-confirm-*.test.ts` 系列（验 `read_page` 也不弹 confirm）
- `snapshot-*.test.ts` 改写为 `page-snapshot.ts` 对应版本
- `get-tab-content-*.test.ts` 删

## 已知 Trade-off 和限制

| 项 | 影响 | 缓解 |
|---|---|---|
| Closed shadow DOM 不穿透 | YouTube comments / Salesforce closed 组件丢内容 | 文档化；浏览器层面无解 |
| Shadow root 内部 mutation 不触发 version++ | shadow-heavy 站内部状态变化不让 stale 生效 | 文档化；后续 phase 评估是否补 per-shadow observer |
| Canvas 编辑器（Google Docs / Figma） | 真正文字在 canvas，DOM 只 mirror textarea | 接受现状；不在 spec 范围 |
| HTML token 成本比 Markdown 高 30-50% | 50KB 预算下信息密度低 | 严格 strip 白名单已显著降低噪音；可后续监测 token usage |
| MutationObserver heartbeat 30s 误判 | 真死亡和暂时静默都会标 observerAlive=false | 30s 是经验值，按 telemetry 调 |

## 开放问题（不阻塞 spec，implementation 期间敲定）

- `1.2×` scrollable 门槛 —— 跑真实站点微调；spec 推荐起点
- `150ms` mutation 防抖 —— spec 推荐起点；按 telemetry 微调（动画驱动页面如发现频繁推送可上调到 250ms）
- iframe 父位置引用占位符文案：当前定为 `[内容见 frame_id=N]`，可在 implementation 调整（给 LLM 看的不需 i18n）

## 不在本 spec 范围（明确排除）

- Origin allow/deny list、敏感页面检测护栏 —— 单独 spec
- `scroll_and_read` virtual scroll auto-explore tool —— 单独 spec
- Closed shadow DOM 穿透 hack —— 浏览器层面无解
- Canvas 编辑器文字读取 —— 浏览器层面无解
- 用户自建 skill 的自动迁移工具 —— release notes 说明即可
