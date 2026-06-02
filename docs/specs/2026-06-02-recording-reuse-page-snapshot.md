---
date: 2026-06-02
topic: recording-reuse-page-snapshot
status: brainstormed
related:
  - docs/specs/2026-05-04-record-and-replay-design.md  # 录制/回放 v1 原始设计
  - docs/solutions/2026-05-05-record-and-replay-v1-invariant-trace.md  # v1 落地不变量
  - docs/specs/2026-05-25-unified-page-snapshot-design.md  # page-snapshot 统一采集
  - docs/ROADMAP.md  # §2 Skill 框架进阶 / §5 #4 行为录制
---

# 录制 capture 复用 page-snapshot 采集基础设施（v1.2）

## Problem Frame

录制/回放 v1（2026-05-05 落地，PR #22 + reframe）之后基本未动，而这一年 agent 的 DOM 工具体系大幅进化：`page-snapshot.ts` 长出了 `data-pie-idx` 标记、role/value/checked 状态反射、shadow DOM、多 frame、可滚动区域检测，CDP 鼠标/键盘、contenteditable/canvas 编辑器处理、search_page、PDF 等能力相继加入。

**录制 capture 却还停在它自己 2026-05 的旧采集**，与 page-snapshot 是**两套互不相干的元素身份/采集系统**：

- 录制（`src/lib/recording/capture.ts`）：被动监听 **click / change / submit / scroll** 四类 DOM 事件，每步只产出一个很薄的 `label`（如「按钮 'Submit'」）+ 自己一套 `selectorHint`，对页面的"感知"仅此而已。
- agent（`src/lib/dom-actions/page-snapshot.ts`）：`pageSnapshotInjected()` 做完整快照，给可见可交互元素打 `data-pie-idx`，捕获 role/type/value/checked/aria/状态/可滚动区域/多 frame/shadow DOM。

错配的体感（用户确认的痛点，按优先级）：

1. **漏录了很多操作** —— 现代前端大量用 `div+onclick` / 自定义组件（下拉、开关、标签页、虚拟列表项）/ contenteditable 富文本，录制只认 `a/button/input/select/textarea` 这类原生标签，全漏。
2. **录到了但描述太弱** —— 每步只有一根 label 字符串 + CSS hint，没有把元素的丰富表征（role、accessible name、value/状态）记下来。
3. **录的内容本身没意义** —— 典型如**复选框勾选**：原生 `<input type=checkbox>` 勾选触发 `change` → 被当成 `type` 动作记成 `value="on"`（该值恒等于 "on"，与勾没勾无关），**完全没记 `checked` 状态**；回放时 LLM 看到「在某框输入 on」，毫无意义。
4. 富文本 / canvas 编辑（飞书 / Google Docs）打字 `change` 不触发，完全没录。
5. hover 才展开的菜单、拖拽等非点击交互没被捕获。

而 page-snapshot 恰恰已经会反射 `checked`（`page-snapshot.ts:189`）、用更宽的 `INTERACTIVE_SELECTOR` 识别 `[onclick]`/`[role=*]`/`[contenteditable]`/`[tabindex]`（`page-snapshot.ts:64-70`）。**结论：录制 capture 应当复用 page-snapshot 的采集判定与状态反射逻辑，而不是各养一套。**

## 决策定位（brainstorm 收窄）

- **回放体感不变**：仍是「录制 → 提炼成 skill → LLM 重新理解着回放」。本轮**不**追求确定性机械回放，只把 capture 采得更全、更厚、带状态。
- **录制行为只动 capture 侧**：`capture.ts` / `selector.ts` / `types.ts` / `serialize.ts`。另有一次**行为保持不变的去重重构**触及 `page-snapshot.ts` / `search-page.ts`（把其内联的 `INTERACTIVE_SELECTOR`/`isVisible` 副本改为镜像新的共享权威源，输出不变）。
- **完全不动**：`recording-orchestrator.ts` 生命周期（仅透传新字段）、`create_skill_from_recording` skill、回放链路、"录制只活内存不落盘"不变量、8KB promptTemplate 上限、page-snapshot 的对外输出。
- **键盘**：做最小集（只记 Enter + 显式组合键，映射现有 `press_key`）。
- **拖拽**：本轮不做（现有 agent 无 drag 回放工具；采集了也无法真正回放，留待将来连同 drag 工具一起做）。

## "复用 page-snapshot 基础设施"的精确含义

page-snapshot 并没有现成的 `describeElement` 可调；它的采集能力散在三组**可复用且当前互相漂移**的概念里，这三组在 `page-snapshot.ts` / `search-page.ts` / `capture.ts` 各有一份独立拷贝：

1. `INTERACTIVE_SELECTOR` —— 什么算"可交互元素"。page-snapshot 的版本含 `[onclick]` / `[role=*]` / `[contenteditable="true"]` / `[tabindex]:not([tabindex='-1'])` / `summary`；capture 的 ad-hoc `closest(...)` 列表缺这些 → **div/自定义组件漏录的直接原因**。
2. `isVisible()` —— 可见性判定。
3. **状态反射**（`checked` / `selected` / `value` / `open`，`page-snapshot.ts:184-197`）—— 复选框该记而没记的那块。
4. 中文 kind 映射（`ROLE_TO_CN` / `TAG_TO_CN`，现于 `selector.ts:39-57`）。

### 注入约束与既定纪律

注入函数（`pageSnapshotInjected` / `searchPageInjected` / `installCaptureListener`）经 `chrome.scripting.executeScript` 序列化函数体后注入页面，**不能 import、不能引用 outer-scope**。本仓库对此的既定纪律是**"故意内联复制 + parity 测试守护"**：

- `page-snapshot.ts:19-22` 明确："Duplication of walkDeep / strip logic ... is intentional — executeScript serializes the function body, so all helpers must be nested inside with no external references."
- `capture.ts:16-23` 已有一条 parity invariant：`buildLabelFor` 必须与 `selector.ts` 的 `describeElement` 逐字一致，有 parity 测试守。
- 描述逻辑已是**双份结构**：`selector.ts` 的 `describeElement`（纯函数、吃 meta 对象、可单测）是权威版；`capture.ts` 的 `buildLabelFor`（注入态、读 live DOM）是镜像版。

### 做法

把上述 1–4 抽成**单一权威源** `src/lib/dom-actions/_shared/interactive.ts`：

- 模块侧导出：`INTERACTIVE_SELECTOR`（string 常量）、`ROLE_TO_CN` / `TAG_TO_CN`。供 `selector.ts`、类型、单测直接 import 使用。
- 注入侧：因不能 import，仍按既定纪律**内联进** `page-snapshot.ts` / `search-page.ts` / `capture.ts` 三个注入函数。
- 新增 **parity 不变量测试**（`interactive-parity.test.ts`）：用 `fn.toString()` 断言三个注入函数都内联了权威 `INTERACTIVE_SELECTOR` 字面量（守住此次 dedup，防止再次漂移）。

**实现期修正**：原计划还打算把 `isVisible` 与状态反射 helper 一并抽进权威源。落地后发现 (a) capture 用 `closest` 触发、本就不需要 `isVisible`；(b) `page-snapshot`/`search-page` 的 `isVisible` 一致性早已被既有的 "search_page ↔ read_page idx parity" **行为测试**覆盖（idx 盖法依赖 isVisible 一致）。再抽一份多行函数体的源码 parity 既脆弱又冗余，故 **`isVisible` 维持各自内联、不进权威源**；状态反射（`checked`）在 capture 内就地读取，也不抽 helper。权威源最终只承载 `INTERACTIVE_SELECTOR` + kind 映射。

这样既统一了"哪些算可交互元素"的判定口径（用户诉求）+ kind 措辞，又不违反 self-contained 注入约束，消掉了三份 `INTERACTIVE_SELECTOR` 的漂移。

### 诚实边界（钉死写进 spec）

1. 飞书 / Google Docs 这类 **canvas 编辑器**，用户打字时 light DOM 无事件、无变更（agent 自己也得靠 CDP 键盘注入），因此录制只能靠 keydown 流**尽力**捕获"在该编辑器里输入了内容"这一事实，**不保证还原精确文本**。普通 contenteditable 富文本（评论框、CMS 编辑器等）能通过 `input`/`beforeinput` + textContent 正常采集。
2. **组合键回放不可直接执行**：capture 会记 `Cmd+B` / `Ctrl+K` 等组合键，但回放的 `press_key` 工具只收单键枚举（Enter/Tab/Escape/方向键等），无修饰键。组合键因此是**提示性上下文**（给 distill/回放 LLM 理解意图），并非可直接执行的步骤 —— 与"hover/allowedTools 在 reframe 后 moot"同属"capture-only、回放架构不变"的固有边界。

## Capture 覆盖面扩展

核心一招：`onClick` 现用的 ad-hoc `closest('a, button, input, ...')`（`capture.ts:221-223`）换成统一的 `INTERACTIVE_SELECTOR`，立刻吃掉"div/自定义组件点击漏录"的大头。其余按模态分别接：

| 模态 | 现状 | 改法 | 防噪 |
|---|---|---|---|
| **div/自定义点击** | closest 列表残缺 → 漏 | onClick 用统一 `INTERACTIVE_SELECTOR` 解析目标 | 解析不到交互祖先且无文本的纯布局点击 → 丢弃 |
| **复选框/单选** | 记成 `type value="on"` 垃圾 | 读最终 `checked`/`aria-checked`，`RecordedAction` 加 `checked?`，序列化渲成「勾选/取消勾选 X」（**工具仍是 click**，回放=点它，无新工具） | 原生 input 由 `change` 出最终态、`onClick` 跳过它 → 不双记；自定义 `role=checkbox` 在 click 后 rAF 读 `aria-checked` |
| **富文本 contenteditable** | 只听 input/textarea 的 `change` → 完全漏 | 新增 capture 态 `input`/`beforeinput` 监听，作用于 contenteditable 宿主，**500ms 防抖 + blur flush**，一段编辑出一条 `type`（取 textContent，截断+脱敏） | 防抖合并、按编辑会话去重，照搬现有 scroll 防抖范式（`capture.ts:291-315`） |
| **canvas 编辑器**（飞书/Docs） | 完全漏 | 仅尽力：检测到聚焦于读不出内容的编辑器且有持续 keydown → 记一条粗粒度「在 X 中输入了文本」标记 | **不保证还原文本**（见上"诚实边界"） |
| **键盘（最小集）** | 漏 | capture 态 `keydown`，**只记 Enter + 显式组合键**（Ctrl/Cmd/Alt + key），新增 `keypress` 动作 → 映射现有 `press_key` 工具 | 不记纯 Tab/方向键/普通字符键 |
| **hover 揭示菜单** | 漏 | **不录原始 hover**（噪声爆炸）；靠"广义 click 现在能录到 `role=menuitem`" + 把 **`hover` 加进 baseline allowedTools**，让回放期 LLM 自己 hover 父菜单揭示再点 | 完全不监听 mousemove |

## 数据模型与序列化

### `types.ts`（最小扩字段）

- `RecordedActionType` 加 `"keypress"`。
- 复选框**不**新增类型 —— 复用 `click` + 新增 `checked?: boolean`。
- `RecordedAction` / `CapturedActionPayload` 加 `checked?: boolean`。
- keypress 的键名**复用现有 `value` 字段**（如 `"Enter"` / `"Ctrl+K"`），不再新增字段。

### `serialize.ts`

- `STEP_TEMPLATES`：
  - `click` 分支按 `action.checked` 渲染 ——「勾选 X」/「取消勾选 X」/「点击 X」。
  - 新增 `keypress: (n, key) => `第 ${n} 步：按 ${key} 键。``。
- `ACTION_TO_TOOL` 加 `keypress: "press_key"`，`hover` 进 baseline allowedTools（保持 `serialize` 输出自洽）。
- **规划期已确认（重要修正）**：2026-05-05 reframe 后 `handleRecordingFinish` 只消费 `serialized.promptTemplate`，`serialized.allowedTools` 与 `parameters` **被丢弃**，且全仓无运行时点用 skill 的 `allowedTools` 硬过滤工具。因此"hover/press_key 进 allowedTools"对回放**零效果**；**回放期工具暴露的真正杠杆是 `STEP_TEMPLATES.header` 提示词文本**（现写 "click / type / scroll / open_url"）—— 需在 header 工具清单加入 `press_key`/`hover`。read-class 是否受 allowedTools 限制因此 moot。
- 8KB 上限与 `PromptTooLargeError` 不变；步骤略变长，仍受护栏。

### `selector.ts` ↔ `capture.ts`（描述措辞改动很小）

- 真正变化在 capture 的**触发口径**（换用统一 `INTERACTIVE_SELECTOR`）与**新监听器**（contenteditable input 防抖、keydown 最小集、checkbox 读 checked），不在描述措辞本身。
- `describeElement` 已支持 role-based kind；`div+onclick` 无 role 时 kind 落到「元素」、用其文本，够用。
- 中文 kind 映射随"复用"抽进 `_shared/interactive.ts`。
- 维持 `buildLabelFor` ↔ `describeElement` parity，给新元素类型（`role=checkbox` / contenteditable / `div+onclick`）补 parity fixture。

### `recording-orchestrator.ts`

基本不动，只需确保把 payload 新字段（`checked`）透传进 `actions[]`。

## 非目标（YAGNI）

- **不**为每步存整页或前后页快照（撞 8KB 上限、且回放 LLM 本就会在每步实时 snapshot；trace 的职责是说清"做什么"+ 足够消歧，不是携带页面态）。
- **不**改回放为确定性机械执行。
- **不**做拖拽采集与 drag 回放工具。
- **不**追求 canvas 编辑器精确文本还原。
- **不**升级 Skill schema 的结构化字段（沿用现有 promptTemplate）。

## 测试与不变量

- **新增 parity 不变量**：`interactive-parity.test.ts` 用 `fn.toString()` 断言 `INTERACTIVE_SELECTOR` 在 page-snapshot / search-page / capture 三处内联副本与 `_shared/interactive.ts` 权威源逐字一致（注意 esbuild 会转义引号，断言侧用 `JSON.stringify(...).slice(1,-1)` 对齐转义形态）。`isVisible` 一致性沿用既有的 "search_page ↔ read_page idx parity" 行为测试（不另写源码 parity，见上"实现期修正"）。
- `serialize` 单测：toggle 渲染（checked 真/假）、keypress 渲染、`keypress → press_key` 映射、allowedTools 含 `press_key` / `hover`。
- `capture` 单测（happy-dom 合成事件）：contenteditable 防抖合并成一条 type、checkbox 出 `checked`、`div+onclick` 解析到目标的 payload 形状。
- 既有不变量不破：录制只活内存不落盘的 build-time grep gate、`buildLabelFor`↔`describeElement` capture-parity、idempotent-install 测试全绿。
- 提交前 `pnpm test` / `pnpm typecheck` / `pnpm build` 全绿。

## 受影响文件清单

- 新增 `src/lib/dom-actions/_shared/interactive.ts`（权威源）+ 对应 parity 测试。
- 改 `src/lib/dom-actions/page-snapshot.ts` / `src/lib/dom-actions/search-page.ts`：内联副本改为镜像权威源（行为不变，仅去重）。
- 改 `src/lib/recording/capture.ts`：统一触发口径 + 新监听器（contenteditable / keydown / checkbox 状态）。
- 改 `src/lib/recording/types.ts`：`keypress` 类型 + `checked?` 字段。
- 改 `src/lib/recording/serialize.ts`：toggle / keypress 模板 + 工具映射 + baseline allowedTools。
- 改 `src/lib/recording/selector.ts`：复用共享 kind 映射 + 维持 parity。
- 可能微调 `src/background/recording-orchestrator.ts`：透传 `checked` 字段。
