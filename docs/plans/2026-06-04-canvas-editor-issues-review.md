# 评估：Canvas/IDE 编辑器交互系列 issue（#123–#127）

> 状态：评审 + 改进计划（非实现）。对应分支 `claude/issue-review-plan-7X1WD`。
> 评审日期：2026-06-04。基于当前 main（`98bfd8e`）的代码事实，逐条评估 5 个 issue 的诉求、可行性、依赖与风险，并给出推荐的落地顺序。

## 0. TL;DR

- 5 个 issue（#123 P0 / #124 P0 / #125 P1 / #126 P1 / #127 P2）是同一簇问题：**Agent 操作 Monaco / CodeMirror 等 IDE 编辑器时"盲操作 + 无法可靠写入"**。诉求方向正确、价值真实（数据平台 SQL 编辑器是高频场景）。
- **但 issue 的技术前提有一处需要更正**：Monaco / CodeMirror **不是 Canvas 渲染**。Monaco 用绝对定位的 DOM `<div>/<span>` + 虚拟滚动渲染；CodeMirror 6 是 `contenteditable` DOM；CodeMirror 5 是 textarea + DOM。真正 Canvas 渲染的是 Google Docs（`.kix-*`）、部分飞书表格。把它们都归为"Canvas"会误导方案选型。它们真正难搞的原因是 **① 虚拟滚动（DOM 里只有可视行）+ ② 一个隐藏的 IME `<textarea>` 捕获键盘**，而不是 Canvas。
- **决定性约束（5 个 issue 都没提到）**：`chrome.scripting.executeScript({func})` 默认跑在 **isolated world**，**看不到页面 MAIN world 的 `window.monaco` / DOM 节点上的 `.CodeMirror` 属性 / `editor.getValue()/setValue()`**。全仓现在**没有任何一处**用 `world: "MAIN"`（已确认）。所以 #124/#125（读内容部分）/#126 的核心能力**共享同一个前置项：引入一条 MAIN-world 注入路径**。这是本簇最大的一块工作，也是排序的关键。
- 推荐顺序：**#123（独立、最低风险、立即缓解）→ 建 MAIN-world editor helper（#124/#125/#126 的共享底座）→ #126/#125 读+聚焦 → #124 写入 → #127 诊断兜底**。

---

## 1. 现状事实（代码锚点）

| 能力 | 现状 | 锚点 |
|---|---|---|
| `press_key` | 仅 `{key}` enum（Enter/Tab/Esc/Backspace/方向键/Home/End），**无 modifiers** | `keyboard.ts:384-458` |
| 但底层已支持 modifiers | `sendKeyPress(session, key, modifiers)` 已接收 bitmask；`MODIFIER_SHIFT=8` 已用于 soft-break；Alt=1/Ctrl=2/Meta=4/Shift=8 已注释 | `keyboard.ts:81-103, 71-75` |
| `dispatch_keyboard_input` | CDP `Input.insertText` 分段 + `Enter` 分隔；**5000 字符上限**；bidi/控制字符过滤 | `keyboard.ts:216-382, 50, 116-151` |
| `type` | isolated-world DOM 注入；input/textarea 走 native setter，contenteditable 走 execCommand；**已能 fingerprint Monaco/CM/Slate/飞书/Notion/GDocs**（仅用于诊断）；命中隐藏 IME buffer 时返回明确报错 | `type.ts:90-113, 288-320` |
| interactive index 选择器 | `a,button,input,select,textarea,[role=...],[contenteditable="true"],summary,[onclick],[tabindex]` — **不含** `.monaco-editor`/`.cm-editor` | `page-snapshot.ts:70`、`_shared/interactive.ts:17` |
| `read_page` 输出 | `<frame_map>` + `<interactive_index>` + `<untrusted_page_content>`（白名单 HTML）。**不调用任何 editor API** | `read-page.ts:122-322` |
| 注入世界 | 全部 isolated world，**无 `world:"MAIN"`** | 全仓 grep 确认 |
| 工具错误回流 | `ActionResult.error` 原样进 `tool_result`（trusted，无 untrusted 包裹）→ LLM | `loop.ts:2000-2075` |
| 诊断先例 | `read_page` 在 PDF tab 返回 `pdf_tab:` 前缀让 LLM 自纠；`type` 命中 IME buffer 且 CDP 关时提示开 CDP | `read-page.ts:161`、`loop.ts:2046-2058` |
| 循环/反思 | repeat-error 阈值=2、exact-repeat=3、oscillation；命中只升级 `<reflections>` note，不再 give-up | `loop-detection.ts`、`loop.ts:920-944` |
| 无 confirm 层 | risk.ts / sendConfirmRequest 已移除 | `__tests__/cross-layer/no-confirm-*.test.ts` |

---

## 2. 逐 issue 评估

### #123 (P0) — `press_key` 增加 modifiers（Ctrl+A/V/Z…）

**结论：✅ 强烈建议先做。最低风险、最高杠杆，且不依赖 MAIN world。**

- **可行性：高。** 底座已就位——`sendKeyPress` 已接收 modifiers bitmask，CDP 位定义已注释。改动面：
  1. schema 增 `modifiers: string[]`（enum `ctrl/shift/alt/meta`）→ reduce 成 bitmask 传给 `sendKeyPress`。
  2. **`KEY_MAP` 需补字母键**（`A/C/V/X/Z` 等），现在只有控制键 —— `Ctrl+A` 的 `A` 当前不在表里。这是真正要新增的部分。
- **⚠️ 重要纠偏：`Ctrl+V` 粘贴在 CDP `Input.dispatchKeyEvent` 下不会注入任意文本** —— 它只发按键事件，不会把"我们想要的文本"放进剪贴板。`Ctrl+V` 只在剪贴板里恰好有目标内容时才有意义。所以 issue 里"全选/粘贴"的真实可达路径是 **`Ctrl+A`（全选）→ `dispatch_keyboard_input`（覆盖输入）**，而不是 `Ctrl+A → Ctrl+V`。文档/工具描述应讲清这点，否则 LLM 会反复尝试无效的 `Ctrl+V`。
- **价值**：单做 #123 就能解锁"全选→覆盖"这条替换已有内容的基本路径，**无需任何 MAIN-world 工作**，是对 #124 之外的即时缓解。
- 分类仍为 `write`（`tool-names.ts`），无需改。

### #124 (P0) — 新增 `set_editor_value`，直接 `editor.setValue()`

**结论：✅ 价值最高但工作量最大。依赖 MAIN-world 路径；建议在共享底座 + #125 的定位手柄就绪后做。**

- **可行性：中。** 一步写入大段 SQL 是这簇 issue 的核心痛点，`setValue()` 是唯一可靠路径（绕开 IME、5000 上限、逐字符中间态）。但：
  - **必须 `world:"MAIN"`**：`monaco.editor.getEditors()` / `node.CodeMirror` / `view.dispatch` 都在页面 world。这是全仓首次引入 MAIN-world 注入，需要新约定（注入函数仍须 self-contained；但现在跑在页面信任域内）。
  - **多实例定位**：页面可能有多个编辑器。单做 #124 只能"设第一个/唯一一个"；多实例场景需要 #125 给出 pie_idx 定位手柄 →  **#124 概念上依赖 #125**（issue 的 P0>P1 优先级与依赖方向相反，需注意）。
  - **必须复用 `validateText`**：`setValue` 绕开了 `dispatch_keyboard_input` 的 bidi/控制字符过滤，安全门禁要在新工具里重新套上。
  - 各编辑器 setter 不同：Monaco `editor.setValue()` / CM6 `view.dispatch({changes})` / CM5 `cm.setValue()` / ACE `editor.setValue()` —— helper 要按 fingerprint 分发（fingerprint 逻辑可从 `type.ts:90-113` 抽出复用）。
- **注册成本**：`KNOWN_KEYBOARD_TOOL_NAMES`（或新分组）+ `TOOL_CLASSES`（`write`）+ build-time exhaustive check + redaction（含大段文本，需进 `redactArgsForPanel`）。

### #125 (P1) — 识别 Monaco/CM 为可交互元素（聚焦 + 读内容）

**结论：✅ 建议拆成两半，落地路径不同。**

- **125a 注册可交互 + 点击聚焦**：**isolated world 即可，低成本。** `.monaco-editor`/`.cm-editor`/`.CodeMirror` 是普通 DOM class，isolated world 能选中。把这些 host 加进 `INTERACTIVE_SELECTOR`（注意三处 verbatim 副本 + parity test）即可拿到 pie_idx、可被 `click` 聚焦。**给 #124 提供定位手柄的就是这一步。**
- **125b 读内容**：**需要 MAIN world**（`getValue()`），与 #126 完全重叠 —— 同一个 helper。
- ⚠️ 注意：把编辑器 host 塞进 interactive index 可能让其内部 `[contenteditable]` 行也被各自 stamp，导致 index 噪音/重复。需要在 stamp 时对"已识别编辑器宿主"做去重/收敛（只暴露宿主一个 idx，不展开内部虚拟行）。

### #126 (P1) — `read_page` 返回编辑器当前内容

**结论：✅ 与 #125b/#124 共享 MAIN-world helper，是"可观测性"的关键。**

- **可行性：中-高。** 虚拟滚动意味着 DOM 抓取**只能看到可视行**，所以 `getValue()` 是拿全文的**唯一**手段 —— 这条 issue 不能用"扩大 HTML 白名单"绕过。
- **安全：返回内容是页面数据，必须 `untrusted_*` 包裹。** 新增 wrapper tag（如 `untrusted_editor_content`），按双清单不变量同时登记到 `untrusted-wrappers.ts:UNTRUSTED_WRAPPER_TAGS` 和 `page-snapshot.ts:WRAPPER_TAGS_LIST`。
- 体积：大文件 getValue 可能很大，需纳入 `max_bytes`/截断逻辑（标 `truncated`）。

### #127 (P2) — 工具失败时返回更有用的诊断

**结论：✅ 独立、低风险、高 ROI。建议放在最后（让提示指向已存在的新工具），或先做但先指向现有工具。**

- **可行性：高，先例充分**（`pdf_tab:` 自纠、IME-buffer 提示、CDP tip）。错误是纯字符串，无 schema 改动。
- 具体增强：`type`/`click` 命中已 fingerprint 的编辑器（`type.ts:90-113` 已有检测）却失败时，把报错从泛化的 "Element not found / IME buffer" 升级为 **"该区域是 Monaco/CodeMirror 编辑器，请改用 `set_editor_value`（写）或 `press_key`+modifiers / `dispatch_keyboard_input`（键入）"**。
- **issue 里"失败 2 次后主动降级/求助"已被部分覆盖**：loop-detection 的 repeat-error 阈值就是 2，命中即注入 `<reflections>` 自纠 note（`loop.ts:920-944`）。所以 #127 的 Agent 侧诉求不必新造机制，重点是**让 tool 错误字符串携带可执行的下一步**。
- ⚠️ 顺序耦合：提示文案要指向真实存在的工具。若 #127 先于 #123/#124 落地，文案应先指向 `dispatch_keyboard_input`；待新工具就位再更新。

---

## 3. 关键风险与纠偏（必须在动工前对齐）

1. **术语纠偏**：把"Canvas 编辑器"改称"复杂/虚拟化编辑器（Monaco/CodeMirror）"。真正 Canvas 的（Google Docs kix）**没有公开 getValue/setValue**，本簇方案对其无效，只能继续走 CDP 键盘 —— 范围上要明确排除，避免承诺做不到的事。
2. **MAIN-world 是新攻击面**：注入函数体是硬编码的（非 LLM 输入），主要风险是 (a) 页面可污染 `window.monaco` 来窃取我们 `setValue` 写入的文本，(b) `getValue` 返回的是页面可控内容 → **必须 untrusted 包裹**。建议为这条路径单写一份 mini 威胁模型 + guard（取 helper 前快照校验 editor 实例类型）。
3. **依赖方向 vs 优先级标注冲突**：issue 标 #124=P0、#125=P1，但 #124（多实例写入）实际依赖 #125a（定位手柄）与 MAIN-world 底座。落地顺序应按依赖走，不按标注的字面优先级。
4. **`Ctrl+V` 误区**：见 #123，CDP 不注入剪贴板，"粘贴"不是真实可达路径，工具描述要讲清。
5. **三处选择器 verbatim 副本**：改 `INTERACTIVE_SELECTOR` 必须同步 `page-snapshot.ts` / `search-page.ts` / `_shared/interactive.ts` 三份，否则 parity test 会 fail（这是 build-time 不变量，属预期门禁）。

---

## 4. 推荐落地顺序（按依赖与风险/收益比）

| 阶段 | 内容 | 依赖 | 风险 | 备注 |
|---|---|---|---|---|
| **S1** | #123 `press_key` + modifiers（含补字母键、`Ctrl+A` 路径、`Ctrl+V` 误区文案） | 无 | 低 | 立即缓解"替换已有内容"；纯 CDP，不碰 MAIN world |
| **S2** | **MAIN-world editor helper**（fingerprint 分发 + `getValue`/`setValue`，self-contained，guard + untrusted 约定） | 引入 `world:"MAIN"` 注入路径 | 中（新攻击面，需 mini 威胁模型） | #124/#125b/#126 的共享底座，一次建好 |
| **S3** | #125a 编辑器宿主进 interactive index + 点击聚焦（isolated world，三处选择器同步 + index 去重） | 无（与 S2 解耦） | 低 | 给 #124 提供 pie_idx 定位手柄 |
| **S4** | #126 + #125b：`read_page` 经 helper 返回 `untrusted_editor_content`（双清单登记 + `max_bytes` 截断） | S2 | 中 | 解决"盲操作"可观测性 |
| **S5** | #124 `set_editor_value`：经 helper + pie_idx 定位 + 复用 `validateText` + redaction | S2 + S3 | 中 | 解决大段 SQL 一步写入 |
| **S6** | #127 诊断兜底：`type`/`click` 命中编辑器失败时指向 S1/S5 的新工具 | S1, S5（文案指向） | 低 | 收尾，闭环自纠 |

S1 可独立先发并立即给用户价值；S2 是节流闸；S3 与 S2 可并行。

---

## 5. 待决问题（建议先和维护者对齐再开工）

1. **MAIN-world 注入**是否接受作为新架构能力引入？（这是本簇能否做成 #124/#126 的总开关。）
2. 范围是否明确**排除真 Canvas 编辑器（Google Docs kix 等）**，只覆盖 Monaco/CodeMirror/ACE 这类有 JS API 的？
3. 编辑器内容读取要不要纳入 `read_page` 默认输出，还是做成独立 `read_editor` 工具（避免每次 snapshot 都付 getValue 成本）？
4. `set_editor_value` 的 5000/大小上限策略：是否沿用 `dispatch_keyboard_input` 的 5000，还是因为 setValue 一步到位而放宽（但要配 `max_bytes`）？
