# 实现方案（S2）：MAIN-world 编辑器 helper —— #124/#125/#126 的共享底座

> 状态：实现方案（待评审后开工）。分支 `claude/editor-main-world-helper`（基于 main）。
> 关联：`docs/plans/2026-06-04-canvas-editor-issues-review.md` 的 **S2**。这是整簇编辑器 issue 的"总开关"——`set_editor_value`（#124）、读编辑器内容（#125b/#126）都建在它上面。
> 与 #123 关系：正交。#123 走 CDP 键盘（isolated 无关），S2 走 `world:"MAIN"` 注入。两者可独立合入。

## 0. 为什么需要它（一句话）

`window.monaco` / `node.CodeMirror` / `editor.getValue()/setValue()` 都活在页面 **MAIN world**，而全仓现有注入（`execInTab` / `read_page`）全在 **isolated world**，**看不到这些对象**。要可靠读/写 Monaco/CodeMirror，必须引入一条 MAIN-world 注入路径 + 一层编辑器适配器。本方案只交付这条底座 + 适配器 + 一个最小读取工具用于打通端到端；写入工具（#124）作为紧随其后的薄封装。

## 1. 关键事实（代码锚点，已核实）

| 事实 | 锚点 |
|---|---|
| 现有注入 helper `execInTab` 不带 `world`（= isolated） | `tools.ts:54-82` |
| `read_page` 用 `executeScript({allFrames:true, func})`，无 world | `read-page.ts:177-180` |
| `scripting` 权限已具备；MV3 动态注入支持 `world:"MAIN"`，**无需新 manifest 权限** | `manifest.json:7` |
| `data-pie-idx` 是 **DOM 属性**，跨 world 可见（world 隔离的只是 JS 对象/全局，不隔离 DOM 属性） | `page-snapshot.ts:355` |
| untrusted 包裹双清单不变量：`UNTRUSTED_WRAPPER_TAGS`（escape 正则）+ `WRAPPER_TAGS_LIST`（页面 HTML 里同名标签会被剥离，防伪造） | `untrusted-wrappers.ts:41`、`page-snapshot.ts:47` |
| 工具输出包裹先例（PDF）：`<untrusted_pdf_page>${escapeUntrustedWrappers(text)}</...>` | `pdf.ts:67` |
| 已有编辑器指纹（仅诊断用，可复用选择器） | `type.ts:90-113` |

## 2. 架构总览

```
LLM tool call (read_editor / set_editor_value)
        │  args: { frameId, elementIndex(pie_idx), [text] }
        ▼
SW tool handler ──► execInTabMainWorld(tabId, editorFn, args, frameId)
        │                    │  chrome.scripting.executeScript({ target, func, world:"MAIN", args })
        ▼                    ▼
   结果回 SW          页面 MAIN world 执行自包含 editorFn：
        │              1. el = querySelector([data-pie-idx])   ← 跨 world 可见
        │              2. adapter = detectAdapter(el)          ← monaco/cm5/cm6/ace
        │              3. getValue() / setValue(text)
        │              4. 返回 { ok, editorKind, value? } (结构化可克隆)
        ▼
读：escapeUntrustedWrappers → <untrusted_editor_content> 进 observation
写：复用 validateText 门禁 → 成功/失败 observation（脱敏 text）
```

## 3. 交付物拆解

### 3.1 MAIN-world 注入 helper（新）

在 `tools.ts` 新增与 `execInTab` 并列的 `execInTabMainWorld`，唯一差别是 `world: "MAIN"`：

```ts
async function execInTabMainWorld<T extends unknown[], R>(
  tabId: number, func: (...args: T) => R | Promise<R>, args: T, frameId?: number,
): Promise<R | { __injectError: string }> {
  const target = frameId !== undefined ? { tabId, frameIds: [frameId] } : { tabId };
  try {
    const results = await chrome.scripting.executeScript({ target, func, args, world: "MAIN" });
    return (results[0]?.result as R) ?? { __injectError: "Execution failed" };
  } catch (err) { /* 同 execInTab 的 frame-gone 处理 */ }
}
```

- **约束不变**：注入函数仍须 self-contained（executeScript 序列化函数体，无闭包/import）。
- **返回值须结构化可克隆**（string/number/plain object）——editor 实例本身不能跨边界返回，只返回提取出的字符串。
- MAIN world 函数**拿不到 `chrome.*`**——本 helper 不需要（只用 DOM + window 上的 editor 全局）。

### 3.2 编辑器适配器（新，注入函数内的自包含逻辑）

一个纯函数 `editorAdapterFn(pieIdx, op, text?)`，在 MAIN world 执行，按指纹分发：

| 编辑器 | 定位 instance | getValue | setValue | 可靠度 |
|---|---|---|---|---|
| **Monaco** | `window.monaco?.editor.getEditors()` 中 `e.getContainerDomNode()` 含 el | `e.getValue()` | `e.setValue(text)` | 高（需页面暴露 `window.monaco`） |
| **CodeMirror 5** | `el.closest('.CodeMirror').CodeMirror` | `.getValue()` | `.setValue(text)` | 高（CM5 官方在 DOM 节点挂实例） |
| **CodeMirror 6** | `el.closest('.cm-editor')` → 经 `EditorView.findFromDOM` 或页面挂载点探测 | `view.state.doc.toString()` | `view.dispatch({changes:{from:0,to:len,insert:text}})` | 中（CM6 无官方 DOM→view，需探测） |
| **ACE** | `el.closest('.ace_editor')` → `win.ace?.edit(node)` 或 `node.env.editor` | `.getValue()` | `.setValue(text, -1)` | 中 |

- 指纹选择器复用 `type.ts:90-113` 的清单（抽成共享常量，但因 self-contained 需在注入函数内 inline 一份副本——同 INTERACTIVE_SELECTOR 的 verbatim 副本约定）。
- **找不到 instance 时返回结构化失败**（`{ ok:false, reason:"editor instance unreachable" }`），让上层把错误转成"建议改用 press_key(mod+A)+dispatch_keyboard_input"的诊断（呼应 #127）。

### 3.3 读取打通：`read_editor` 工具（新，最小端到端）

- 参数 `{ frameId, elementIndex }`（pie_idx 来自 #125a 让编辑器宿主进 interactive_index——见 §5 依赖）。
- handler：`execInTabMainWorld(tabId, editorAdapterFn, [pieIdx, "get"], frameId)` → 取 `value`。
- **输出 untrusted 包裹**：新增 wrapper tag `untrusted_editor_content`，按双清单不变量**两处都登记**：
  1. `untrusted-wrappers.ts` 的 `UNTRUSTED_WRAPPER_TAGS`
  2. `page-snapshot.ts` 的 `WRAPPER_TAGS_LIST`
  发射：`` `<untrusted_editor_content kind="${kind}" pie_idx="${idx}"${truncated?' truncated="true"':''}>\n${escapeUntrustedWrappers(value)}\n</untrusted_editor_content>` ``
- **体积控制**：getValue 可能很大 → 加 `max_bytes`（默认沿用 read_page 策略），超限截断并标 `truncated`。
- 分类：`read`（`tool-names.ts` TOOL_CLASSES + build-time exhaustive check）。

### 3.4 写入：`set_editor_value`（#124，本方案给接口预留，建议同 PR 或紧随）

- 参数 `{ frameId, elementIndex, text }`。
- **复用 `validateText`**（bidi/控制字符门禁）——但 **5000 上限要替换成更高的 `max_bytes`**（#124 的全部价值就是突破 5000）。建议：抽 `validateText` 为可配置 cap 的版本，`dispatch_keyboard_input` 传 5000、`set_editor_value` 传更高值（如 100KB）。
- handler：`execInTabMainWorld(tabId, editorAdapterFn, [pieIdx, "set", text], frameId)`。
- 分类：`write`；**脱敏**：含大段 `text` → 进 `redactArgsForPanel`（现仅认 keyboard tool 的 `text`，需把 set_editor_value 纳入脱敏判定，或泛化"凡有 text 字段即脱敏长度")。

## 4. 安全模型（MAIN world 是新攻击面，需单独记录）

注入函数体**硬编码**（非 LLM 输入）；LLM 只提供 pie_idx（number）和 setValue 的 text。逐项：

1. **getValue 返回内容是页面可控数据** → **必须 untrusted 包裹 + escapeUntrustedWrappers**（防内容里塞伪造 `<untrusted_*>`/指令）。这是硬要求。
2. **页面可污染 `window.monaco`/getter 窃取我们 setValue 的 text** → 这是 MAIN world 固有风险。但：编辑器本就属于页面，我们写入的是"用户要求写进该编辑器的内容"，并未新增超出页面已有视野的外泄通道。判定：可接受，但在威胁模型文档里写明。
3. **指纹/instance 探测被页面伪造**（假 `.monaco-editor` + 恶意 `getEditors`）→ 最坏是返回垃圾字符串，已被 untrusted 包裹兜住；不会获得额外权限。
4. **不引入新 manifest 权限**，攻击面增量仅限"在已授权 host 的页面 MAIN world 跑一段硬编码读/写函数"。
5. 复用 isolated 路径的不变量：写入是 write-class → 受 loop 的 R7 跨 session 锁 + advisory origin 漂移 notice 约束（与 type/click 一致；MAIN world executeScript 不走 CDP 黄条，故不需要 keyboard 那套 per-call origin 重检）。

→ 交付物含一份 `docs/solutions/` mini 威胁模型（仿 SP-2/SP-3 风格）。

## 5. 依赖与排序

- **依赖 #125a（编辑器宿主进 interactive_index）拿到 pie_idx 定位手柄**：把 `.monaco-editor`/`.cm-editor`/`.CodeMirror`/`.ace_editor` 加进 `INTERACTIVE_SELECTOR`（三处 verbatim 副本 + parity test 同步），并在 stamp 时对编辑器宿主**去重收敛**（只暴露宿主一个 idx，不展开内部虚拟行）。#125a 是 isolated-world 改动、低成本，建议与本方案同批或前置。
- 落地顺序建议：**§3.1 helper + §3.2 适配器 + §5 的 #125a → §3.3 read_editor 打通端到端 → §3.4 set_editor_value（#124）→ #126 把 read_editor 能力并进 read_page 输出（或保持独立工具，见开放问题）→ #127 失败诊断指向新工具**。

## 6. 已知限制（须在工具描述/文档诚实写明）

- **必须页面暴露编辑器实例**：Monaco 若被打包成不挂 `window.monaco`，则无 DOM→instance 路径，getValue/setValue 不可达 → 适配器返回失败，回退到 CDP 键盘（press_key mod+A + dispatch_keyboard_input）。
- **真 Canvas 编辑器（Google Docs `.kix-*` 等）无公开 getValue/setValue** → 明确**排除**在本方案外，继续走 CDP 键盘。
- CM6/ACE 的 DOM→instance 探测较脆，MVP 可先稳 **Monaco + CM5**，CM6/ACE 标"best-effort"。

## 7. 测试策略

- **适配器单测**（happy-dom 里 mock 各编辑器全局）：
  - Monaco：mock `window.monaco.editor.getEditors()` 返回含 `getContainerDomNode/getValue/setValue` 的桩 → get 返回值正确、set 调用 setValue。
  - CM5：DOM 节点挂 `.CodeMirror` 桩 → get/set 正确。
  - 找不到 instance → 结构化失败。
- **包裹测试**：`read_editor` 输出含 `<untrusted_editor_content>`，且内容里的 `</untrusted_editor_content>` 被 `escapeUntrustedWrappers` 转义（仿 `untrusted-wrappers.test.ts`）。
- **双清单 parity**：断言 `untrusted_editor_content` 同时存在于 `UNTRUSTED_WRAPPER_TAGS` 与 `WRAPPER_TAGS_LIST`（若仓内已有 dual-list parity 测试则自动覆盖；否则补一条）。
- **validateText cap**：set_editor_value 超 max_bytes 拒绝、bidi/控制字符拒绝、正常大文本（>5000）通过。
- **脱敏**：set_editor_value 的 text 不进 panel（`redactArgsForPanel` 覆盖）。
- 三门禁：`pnpm test` / `pnpm typecheck` / `pnpm build`。

## 8. 开放问题（建议开工前对齐）

1. **MAIN-world 注入是否批准引入**为新架构能力？（总开关；CLAUDE.md "Injected functions 必须 self-contained" 不变，但新增"isolated vs MAIN world"维度，需补一条 Architecture Invariant。）
2. **读编辑器内容**做成独立 `read_editor` 工具，还是并进 `read_page` 默认输出？建议**先独立**（避免每次 snapshot 都付 getValue 成本 + MAIN world 注入开销），#126 在 read_page 里只放一个"检测到编辑器，调 read_editor"的提示。
3. `set_editor_value` 的 `max_bytes` 上限取值（建议 100KB 起，配截断）。
4. CM6/ACE 是否纳入 MVP，还是首版只保 Monaco + CM5。
5. `validateText` 抽参化 vs 复制一份——倾向抽成 `validateText(text, {maxLength})`，两调用方各传 cap。
