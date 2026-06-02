# Page Tools Locator Gap — 设计 Spec

Date: 2026-06-02
Status: Approved design (待 plan)
Slug: page-tools-locator-gap
Issue: https://github.com/WiseriaAI/pie-ai-agent/issues/113

> 目标: 修掉 Gmail 等大型富交互页面里的系统性盲区: `read_page` 因总量预算截断丢掉关键可操作元素,而 `search_page` 只能搜文本,找不到空白 `contenteditable` / 输入区。方案同时吸收 #44/#45 的 page-tool 可用性建议,但不展开成全工具体系重构。

---

## 1. Context

当前 page tools 已经从早期 push snapshot 演进到 pull-mode:

- `read_page(tabId)` 注入所有 frame,返回 `<frame_map>`、`<scrollable_regions>`、以及每 frame 的 `<untrusted_page_content>` stripped HTML。可交互元素在 DOM 上盖 `data-pie-idx`,写类工具用 `frameId + elementIndex` 操作。
- `search_page(tabId, query, mode)` 重新复用同一套盖号算法,跨 frame 搜可见文本,返回匹配文本附近的 `pie_idx`,避免 `read_page` 的 50KB HTML 截断。
- `click`/`hover` 已升级 CDP 输入;`type`/`select` 仍依赖最新 DOM 上的 `data-pie-idx`。

Issue #113 暴露了一个三角盲区:

| 工具 | 能找到什么 | 找不到什么 |
|---|---|---|
| `read_page` | 结构 + HTML 中出现的元素索引 | 总预算截断后的 DOM 后半段 |
| `search_page` text/all | 页面文本、带文本按钮/链接 | 空白 `contenteditable` / 空白输入区 |
| `search_page` interactive | 有文本的可交互元素 | 没有文本或 accessible name 的编辑区 |

Gmail 回复任务中,compose box 位于线程底部、DOM 深处、初始为空。它可能被 `read_page` 的 50KB 总预算裁掉,又无法被 `search_page` 的文本匹配命中,导致 agent 只能反复滚动/重读,但始终拿不到可用于 `type` 的 `data-pie-idx`。

---

## 2. Goals / Non-Goals

### Goals

1. 大页面中,关键可操作元素即使不在返回 HTML 预算内,也能被 agent 发现并拿到 `frame_id + pie_idx`。
2. `read_page` 支持按任务意图读取:找操作目标、读正文、或尽量完整结构,减少模型猜该用哪个工具。
3. `search_page` 支持非文本定位维度,能查 role/tag/attribute,覆盖空白编辑区。
4. 保持现有写类工具协议:不改 `click`/`type`/`select` 的 `frameId + elementIndex` 调用形态。
5. 所有页面来源文本继续走 `<untrusted_*>` wrapper 和 sanitize/escape 路径。

### Non-Goals

- 不做全量工具重命名或高层 `interact_with_page` 路由器。
- 不在 P0 暴露任意 CSS selector 工具作为默认路径。
- 不改变 cross-session R7 lock、tab pin/focus 语义。
- 不用 OCR 或 screenshot 做空白编辑区定位兜底。
- 不解决 closed shadow root、无法注入 frame、Chrome PDF viewer 等既有平台限制。

---

## 3. Recommended Design

### 3.1 `read_page` 增加 mode + 可控预算

扩展参数:

```ts
interface ReadPageArgs {
  tabId: number;
  mode?: "auto" | "interactive" | "content" | "full";
  max_bytes?: number;
}
```

默认值:

- `mode: "auto"`
- `max_bytes`: 不传时按 mode 取默认预算。

预算策略:

| mode | 默认预算 | 硬上限 | 语义 |
|---|---:|---:|---|
| `auto` | 120KB | 300KB | 默认模式。返回交互索引 + 适量内容 HTML,适合多数任务。 |
| `interactive` | 60KB | 160KB | 找按钮/输入框/菜单/表单。优先完整返回交互索引,HTML 只保留薄上下文。 |
| `content` | 160KB | 300KB | 阅读正文/邮件/表格/状态信息。保留交互索引,但 HTML 预算偏向正文内容。 |
| `full` | 220KB | 300KB | 尽量完整读取结构与内容,用于 agent 明确需要更大页面上下文时。 |

说明:

- 现有 50KB 偏保守。当前项目已有 explicit pull-mode、stale observation elision、token budget guard,默认放宽到 120KB 是合理的。
- `max_bytes` 是请求级 hint,会被硬上限 clamp。这样 agent 可以在知道上下文足够时放宽,但单页不会无限挤爆一轮上下文。
- `max_bytes` 只控制 HTML/content 体量,不应挤占 protected interactive index。

### 3.2 新增 protected `<interactive_index>`

`read_page` observation 结构调整为:

```xml
Current URL: ...
Page title: ...

<frame_map>
  frame_id="0" url="..."
</frame_map>

<interactive_index mode="auto" total="123" truncated="false">
  <interactive_element frame_id="0" pie_idx="41" tag="div" role="textbox" contenteditable="true" name="" placeholder="" label="Message body" section="Conversation reply">...</interactive_element>
</interactive_index>

<scrollable_regions>
  ...
</scrollable_regions>

<untrusted_page_content frame_id="0">
  ...
</untrusted_page_content>
```

`<interactive_index>` 的职责:

- 列出所有可见可交互元素,不依赖 HTML 是否被预算截断。
- 输出紧凑字段,供模型定位 `frame_id + pie_idx`。
- 尽量覆盖无文本目标: `contenteditable`, `input`, `textarea`, ARIA textbox/combobox, `[tabindex]`, role button/link/menuitem 等。
- 不输出危险原始 HTML;文本字段做长度 caps + wrapper escaping。

建议字段:

| 字段 | 来源 | 说明 |
|---|---|---|
| `frame_id` | Chrome injection result | 写类工具目标 frame。 |
| `pie_idx` | 盖号算法 | 写类工具目标 index。 |
| `tag` | DOM tag | `input`, `textarea`, `div`, `button` 等。 |
| `role` | explicit role 或 inferred role | `contenteditable` 推导为 `textbox`。 |
| `name` | accessible name 轻量计算 | aria-label / aria-labelledby / title / direct text。 |
| `placeholder` | input/textarea/contenteditable | Gmail 等编辑区可能为空,但 placeholder 有时可用。 |
| `label` | `<label for>` / ancestor label / nearby text | 复用 semantic snapshot 经验,但长度 cap。 |
| `type` | input type | password/otp 不泄露 value。 |
| `contenteditable` | attr/IDL | 空白 compose box 的关键信号。 |
| `disabled` / `checked` / `selected` | IDL/attr | 状态辅助。 |
| `section` | nearest heading/dialog/form/role region | 给模型 within 上下文,不追求完美。 |
| `text` | direct text, capped | 按钮/链接名的补充。 |

预算:

- `<interactive_index>` 独立小预算,默认最多 300 个元素或 40KB,先按 visible + interactable 顺序输出。
- 若超出,返回 `truncated="true"` 和 `total`,并保留高价值元素优先级: editable/input/textarea/select/button/link/role/tabindex。
- 这个 index 不算进 `max_bytes` HTML 预算,否则会重新产生“HTML 抢走操作目标”的问题。

### 3.3 HTML 内容按 mode 裁剪

`pageSnapshotInjected` 当前返回单一 stripped HTML。改造后应返回:

```ts
interface PageSnapshotResult {
  html: string;
  interactiveElements: InteractiveElementSummary[];
  scrollableHints: ScrollableHint[];
}
```

SW handler 根据 mode 决定如何裁 HTML:

- `interactive`: HTML 只保留与可交互元素有关的薄上下文,例如 form/dialog/section/headings + 交互元素周边片段。若第一版实现成本过高,可先保留现有 stripped HTML,但用较小 HTML 预算;真正的可操作目标由 `<interactive_index>` 保证。
- `content`: HTML 优先保留正文语义节点: headings、paragraphs、lists、tables、alerts/status、form labels、dialog content。可交互元素完整性由 index 保证。
- `auto`: `interactive_index` + 当前 stripped HTML,预算 120KB。
- `full`: 当前 stripped HTML,预算更宽。

P0 推荐实现顺序:先做 `interactive_index` + mode budgets;HTML 精细裁剪可作为同 spec 的第二阶段。这样最小改动即可修 #113。

---

## 4. `search_page` 扩展非文本定位

扩展参数:

```ts
interface SearchPageArgs {
  tabId: number;
  query: string | string[];
  max_results?: number;
  mode?: "all" | "interactive" | "text";
  regex?: boolean;
  search_by?: "text" | "role" | "tag" | "attribute";
}
```

默认 `search_by: "text"` 完全保持现有行为。

### 4.1 `search_by: "role"`

匹配 interactive summary 的 role/inferred role:

```json
{"tabId": 123, "search_by": "role", "query": "textbox", "mode": "interactive"}
```

返回 role 为 `textbox` 的输入区、`contenteditable`、ARIA textbox 等。适合 Gmail compose、Docs-like editor、搜索框、combobox。

### 4.2 `search_by: "tag"`

匹配 tag 或少量虚拟 tag:

- `input`
- `textarea`
- `button`
- `select`
- `contenteditable` (虚拟 tag,匹配 `contenteditable=true` 元素)

示例:

```json
{"tabId": 123, "search_by": "tag", "query": "contenteditable"}
```

### 4.3 `search_by: "attribute"`

支持有限 allowlist,避免变成任意 selector:

- `contenteditable=true`
- `aria-label=<literal>`
- `placeholder=<literal>`
- `name=<literal>`
- `type=<literal>`
- `role=<literal>`

示例:

```json
{"tabId": 123, "search_by": "attribute", "query": "contenteditable=true"}
```

匹配仍返回 `<untrusted_page_match>` 或新增 `<untrusted_page_element_match>`。建议沿用 `search_page` 根标签,增加 `search_by` 属性:

```xml
<search_page total_matches="2" mode="interactive" search_by="role">
  <untrusted_page_match frame_id="0" pie_idx="41" tag="div" role="textbox" matched="textbox">contenteditable=true label="Message body"</untrusted_page_match>
</search_page>
```

输出文本全部 escape,并复用 `search_page` 的 allFrames 注入、restricted URL、PDF tab guard、time budget。

---

## 5. CSS Selector Tool Decision

Issue #113 提到新增:

```ts
find_element({tabId, selector: "div[contenteditable='true']", frameId: 0})
```

本 spec 不把它列为 P0 默认方案。

理由:

1. selector 容易诱导模型写脆弱 DOM 结构,页面一改就失效。
2. 任意 selector 暴露的能力过宽,需要额外限制复杂度、伪类、作用域、返回量和错误文案。
3. `interactive_index + search_by role/tag/attribute` 已覆盖 #113 的空白编辑区主场景。

保留 P2 fallback:

- 如果真实 Gmail/Docs/Notion 回归仍失败,再加 `find_element`。
- 只允许简单 selector 子集: tag、`[attr=value]`、`.class` 是否允许需另评估;禁止 `:has`,复杂组合和大范围后代链。
- 返回同样的 `frame_id + pie_idx + summary`,不返回 raw element HTML。

---

## 6. Data Flow

### 6.1 `read_page(mode="interactive")`

```
LLM
  └─ read_page({tabId, mode:"interactive"})
      └─ SW readPageTool
          ├─ chrome.tabs.get / restricted guards / PDF guard
          ├─ executeScript(allFrames:true, pageSnapshotInjected)
          │   ├─ stamp data-pie-idx on live DOM
          │   ├─ build interactiveElements[]
          │   ├─ build stripped HTML
          │   └─ build scrollableHints[]
          ├─ webNavigation.getAllFrames
          ├─ render frame_map
          ├─ render protected interactive_index
          ├─ render mode-budgeted page_content
          └─ observation → LLM
```

LLM 可直接拿 `interactive_index` 里的 `frame_id/pie_idx` 调 `type`:

```json
{"frameId": 0, "elementIndex": 41, "text": "Thanks for the update."}
```

### 6.2 `search_page(search_by="role")`

```
LLM
  └─ search_page({tabId, search_by:"role", query:"textbox"})
      └─ SW searchPageTool
          └─ executeScript(allFrames:true, searchPageInjected)
              ├─ stamp data-pie-idx using same algorithm
              ├─ build interactive summaries
              ├─ match role/tag/attribute
              └─ return compact matches
```

`search_page` 继续不依赖 `read_page` 历史。它会重新 stamp,并必须通过 parity tests 保证与 `read_page` 同 DOM 状态下盖号一致。

---

## 7. Error Handling / Edge Cases

| Case | Expected behavior |
|---|---|
| Page too large in `auto` | 返回完整 `<interactive_index>`; HTML block 标 `truncated="true"` 或后续 frame 标 `unread="budget"`。 |
| Too many interactive elements | `<interactive_index truncated="true" total="N">`;优先保留 editable/input/textarea/select/button/link。 |
| Empty contenteditable | 出现在 `interactive_index` 中,`role="textbox"`、`contenteditable="true"`、`name/label` 可为空。 |
| Password / OTP fields | 可列出元素和 type,但不返回 value。沿用当前 credential value suppression。 |
| Cross-origin iframe | 继续 per-frame 注入;frame map 标 `cross_origin="true"`;无法注入则 unreachable block。 |
| Search invalid attribute query | fail-fast: `invalid_attribute_query`,说明支持的格式。 |
| PDF tab | `read_page` 返回 `pdf_tab`;`search_page` 提示用 `search_pdf`。 |
| Restricted scheme / discarded tab | 维持现有错误。 |
| Page changes between read and write | 写类工具仍可能 Element not found;模型 re-run `read_page`。 |

---

## 8. Prompt / Tool Guidance Updates

`READ_PAGE_GUIDANCE` 需要更新:

- 说明 `read_page` 支持 `mode`.
- 引导任务:
  - 找按钮/输入框/编辑区 → `read_page({mode:"interactive"})` 或 `search_page({search_by:"role"/"tag"})`
  - 阅读正文/总结页面 → `read_page({mode:"content"})`
  - 页面结构复杂且前两者不足 → `read_page({mode:"full", max_bytes: ...})`
- 明确 `<interactive_index>` 是操作目标的首选来源;`<untrusted_page_content>` 是上下文来源。
- 强化:只能用最新 read/search 返回的 `pie_idx`,不要猜 index。

`search_page` tool description 需要补:

- 默认搜文本。
- 无文本目标用 `search_by:"role"` / `"tag"` / `"attribute"`.
- 对空白编辑区优先查 `role:"textbox"` 或 `tag:"contenteditable"`。

---

## 9. Testing Plan

### Unit tests

- `page-snapshot.test.ts`
  - `contenteditable` 空白元素进入 `interactiveElements`,推导 `role="textbox"`。
  - input/textarea/select/button/link/role/tabindex 的 summary 字段正确。
  - password/otp 不泄露 value。
  - wrapper tag 注入文本被过滤/escape。

- `read-page.test.ts`
  - 默认 mode 是 `auto`,默认预算从 50KB 放宽。
  - `mode:"interactive"` 输出 `<interactive_index>`。
  - HTML 截断时 `<interactive_index>` 仍包含后半段元素。
  - `max_bytes` 被 hard cap clamp。
  - 超多 interactive elements 时 index 标 `truncated`.

- `search-page.test.ts`
  - `search_by:"text"` 与旧行为一致。
  - `search_by:"role"` 命中空白 textbox/contenteditable。
  - `search_by:"tag"` 命中 `contenteditable` 虚拟 tag。
  - `search_by:"attribute"` allowlist 生效;非法 query fail-fast。
  - read/search stamp parity 继续成立。

### Cross-layer tests

- 构造一个超过 120KB 的页面,关键 `contenteditable` 放在 HTML 尾部:
  - `read_page(mode:"auto")` HTML 可截断,但 index 有该元素。
  - `search_page(search_by:"role", query:"textbox")` 返回该元素 `pie_idx`。
  - `type` 使用该 `pie_idx` 成功。

- iframe fanout:
  - 子 frame 中空白编辑区可被 `interactive_index` 和 `search_by:"role"` 找到。

- Shadow DOM:
  - open shadow root 内的输入/按钮仍被 index 和 search 找到。

### Manual checks

- Gmail reply compose box。
- Gmail search box / compose modal。
- Notion/Docs-like contenteditable editor。
- Large GitHub issue / PR page: `content` mode 读正文,`interactive` mode 找 comment box。

---

## 10. Implementation Phasing

### Phase A: Contract + shared summary builder

- 新增 `InteractiveElementSummary` 类型。
- 在 `pageSnapshotInjected` 中生成 `interactiveElements`.
- 抽取或同步 `search_page` 与 `read_page` 的盖号/summary 逻辑,用 parity tests 防漂移。

### Phase B: `read_page` mode + budgets

- 扩参数 schema。
- 默认预算放宽到 120KB。
- 渲染 `<interactive_index>`.
- 根据 mode 选择默认预算和 hard cap。
- 更新 prompt/tests。

### Phase C: `search_page.search_by`

- 扩参数 schema。
- DOM 注入支持 role/tag/attribute 匹配。
- 输出 `search_by` 和额外 summary attrs。
- 更新 tests。

### Phase D: HTML precision improvements (optional within same milestone)

- 如果 Phase B 后仍 token 偏大,再实现 `interactive`/`content` 的 HTML 精细裁剪。
- 若 Gmail 回归已过,可把精细裁剪留作 backlog。

---

## 11. Compatibility / Migration

- `read_page({tabId})` 继续可用,行为变为更有信息量的 `auto`.
- `search_page` 默认 `search_by:"text"`,旧调用不变。
- 写类工具协议不变。
- Tool class 不变: `read_page` / `search_page` 仍是 read-class tools。
- Release notes 需标明: `read_page` observation 新增 `<interactive_index>`;默认 page read 体量变大,但历史 stale observation 仍会省略。

---

## 12. Acceptance Criteria

1. 大页面 HTML 截断时,尾部空白 `contenteditable` 仍可在 `<interactive_index>` 中被发现并用于 `type`。
2. `search_page({search_by:"role", query:"textbox"})` 可找到无文本编辑区。
3. `search_page({search_by:"tag", query:"contenteditable"})` 可找到 `contenteditable=true` 元素。
4. `read_page({mode:"content"})` 比 `interactive` 返回更多正文上下文;`interactive` 比 `content` 更稳定保留操作目标。
5. `read_page` 的 `max_bytes` 可放宽但被 300KB hard cap 限制。
6. PDF/restricted/discarded/cross-origin iframe 既有行为不回退。
7. `pnpm test` 和 `pnpm build` 通过。

---

## 13. Spec Self-Review

- Placeholder scan: 无 TBD/TODO 占位。
- Consistency: `interactive_index` 是 protected 操作索引;`max_bytes` 只控制 HTML/content 体量,两者不冲突。
- Scope: 聚焦 #113 的 page locator gap,没有展开全工具体系重构。
- Ambiguity: `find_element(selector)` 明确为 P2 fallback,不是 P0。
