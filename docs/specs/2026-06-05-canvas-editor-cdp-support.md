# 设计：CDP 编辑器读写支持（Monaco / CodeMirror）

- 日期：2026-06-05
- 关联 issue：#124（P0 写）、#125（P1 可交互+读）、#126（P1 读全文）
- 关联前序：PR #129（否决 `chrome.scripting world:'MAIN'` 底座，定调 isolated-world + 触发门控）

## 1. 背景与问题

Monaco / CodeMirror 这类代码编辑器对 Agent 是「半盲」状态：

- **读不全**：编辑器是 **DOM 渲染 + 虚拟化**（`.view-line` / `.cm-line` 是真实 DOM，但只渲染视口内的行）。`read_page` 的 isolated 快照能抓到**视口内**文本，但滚出视口的行不在 DOM 里 → 长文档读不全。
- **不可辨识**：即便抓到可见区文本，Agent 也分不清哪段是编辑器内容、拿不到一个 index 去定位它。`.monaco-editor` 容器不匹配 `INTERACTIVE_SELECTOR`，不进 interactive index。
- **写易错**：`type` 工具对 Monaco/CM 不灵（hidden IME buffer）；`dispatch_keyboard_input` 是逐字符模拟，慢、对大段文本要分段、有 5000 字符上限。

> 澄清一个 issue 措辞误解：Monaco/CM **不是 canvas 渲染**，是虚拟化 DOM。这正是 `getValue()` 能救场的原因——内容存在编辑器的 JS model 对象里。真·canvas 编辑器（Google Docs canvas 模式等）是另一类，见 §7。

技术路线已在前期讨论中比较并定案：

| 路线 | 能否读全屏外 | 新底座成本 | 结论 |
|---|---|---|---|
| `chrome.scripting world:'MAIN'` | ✅ | 高（新注入面，PR #129 已否） | ❌ |
| **CDP `Runtime.evaluate`（main context）** | ✅ 一步 `getValue/setValue` | **零**（复用现有 `cdp-session`，keyboard 已用） | ✅ **采用** |
| isolated 滚动分页 | ⚠️ 逼近但不可靠（多轮、Monaco 行序乱、到底判定脆） | 零 | ❌ |

参照：Playwright/Selenium 处理虚拟化编辑器的业界标准做法就是「调编辑器 model API」（`page.evaluate(() => monaco.editor.getEditors()[0].getValue())`），而非读 DOM 或模拟键盘。本方案用现有 CDP 实现等价能力。与 Playwright 的关键差异：本项目跑在**不可信网页**上，CDP 取回的内容必须裹 untrusted（Playwright 是可信测试目标，无此需求）。

## 2. 目标 / 非目标

**目标**

1. `read_page` 检测 Monaco/CM 编辑器，登记为可交互元素（进 interactive index，可点击聚焦），并在 `name` 标注引擎+用法。【#125 + #126 可辨识】
2. 新增 read-class 工具 `read_editor(elementIndex)`，经 CDP 取编辑器**全文**。【#126 全文】
3. 新增 write-class 工具 `set_editor_value(elementIndex, text)`，经 CDP 一步写入并回读校验。【#124】
4. 覆盖 Monaco + CodeMirror 5/6，按 model 能力探测。
5. 覆盖主 frame + same-origin iframe 内的编辑器。

**非目标（本次明确不做，走降级）**

- 真·canvas 编辑器（Google Docs canvas 等，无标准 model API）→ 截图+vision（读）/ keyboard（写）。
- cross-origin OOPIF 内的编辑器（需 `Target.setAutoAttach` 子 target 管理）→ keyboard/vision 降级。
- 不替换 `dispatch_keyboard_input`；它继续作为 canvas / OOPIF / 探测失败时的写入降级。

## 3. 架构总览

一座桥（复用现有 CDP `cdp-session`）+ 三个出口：

| 出口 | 解决 | world | 授权 |
|---|---|---|---|
| `read_page` 编辑器检测+登记 | #125 + #126（可辨识） | isolated（现有） | 零授权 |
| `read_editor(elementIndex)` | #126（全文） | CDP main-context | 需 CDP consent |
| `set_editor_value(elementIndex, text)` | #124 | CDP main-context | 需 CDP consent |

read/write 两个 CDP 工具共享一段 **editor-bridge** 探测逻辑（在 main context 执行：从 `data-pie-idx` 元素发现所属编辑器实例并调 `getValue/setValue`）。

```
read_page (isolated, allFrames)
  └─ 检测 .monaco-editor/.cm-editor/.CodeMirror → 打 data-pie-idx → 进 interactive index (role=editor)
        │  (Agent 拿到 idx)
        ▼
read_editor(idx) / set_editor_value(idx, text)
  └─ acquireSession → consent gate → Runtime.enable → 收集 main-world contexts
        └─ 逐 context 试探 document.querySelector('[data-pie-idx=idx]')
              └─ 命中 context 执行 editor-bridge: 发现实例 → getValue() / setValue()
                    └─ read: 裹 untrusted_editor_content 返回
                       write: 回读 getValue() 校验
```

## 4. 组件

### 4.1 read_page 编辑器检测与登记（isolated，零授权）

文件：`src/lib/dom-actions/page-snapshot.ts`（+ `src/lib/agent/tools/read-page.ts` 的 index 渲染）

- 在 Step C（交互标注）阶段，把编辑器容器纳入 `data-pie-idx`：选择器补 `.monaco-editor`、`.cm-editor`（CM6）、`.CodeMirror`（CM5）。
- 在 `interactive-summary` / `renderInteractiveIndex` 中，编辑器元素 `role="editor"`，`name` 形如 `Monaco editor — use read_editor / set_editor_value (idx N)`，引导 Agent 用对工具、别用 `type`。
- 引擎判定（class 名即可，isolated 可见）：`.monaco-editor`→Monaco，`.cm-editor`→CodeMirror6，`.CodeMirror`→CodeMirror5。
- 可见区文本仍照旧进 `untrusted_page_content`（本来就在），不重复抓、不改既有行为。
- 这一步**完全不碰 CDP**，无授权要求，独立可交付（即便 read_editor/set_editor_value 未就绪也有价值）。

### 4.2 read_editor 工具（CDP getValue，#126 全文）

文件：新增 `src/lib/agent/tools/editor.ts`（工厂 `buildEditorTools(deps)`）

- read-class。参数：`{ elementIndex: number }`（frame 由逐 context 探测自动定位，见 §4.4，**不需** frameId 入参）。
- 流程：`requireCdpInput`（consent gate，复用）→ `acquireSession(tabId)` → 经 editor-bridge 执行 → 返回 `getValue()` 文本，**裹 `untrusted_editor_content`**。
- 失败：探测不到实例 → 明确错误（§7 降级）。

### 4.3 set_editor_value 工具（CDP setValue，#124）

文件：同 `src/lib/agent/tools/editor.ts`

- write-class。参数：`{ elementIndex: number, text: string }`。
- 流程同上，执行 `editor.setValue(text)` 后**回读 `getValue()` 校验**；不一致返回错误（区分「页面拦截/受控组件回滚」与「写入成功」）。
- `text` 不设逐字符上限（一步 setValue），但保留合理上限防滥用（具体值实现期定，远大于 keyboard 的 5000）。

### 4.4 editor-bridge：实例发现 + 逐 context 定位（main context）

**逐 context 定位（绕开 frameId 映射）**

- CDP `Runtime.enable` 后接收 `Runtime.executionContextCreated` 事件，收集所有 main-world context（含 same-origin iframe 的 context，同进程可见）。
- **现采现用、不跨调用缓存**：对每个 context 跑 `document.querySelector('[data-pie-idx="N"]')`，命中（非 null）的 context 即目标 frame 的 context。
- 由于 `data-pie-idx` 是 DOM attribute、各 frame document 独立，只有目标元素所在 frame 命中 → **无需 webNavigation↔CDP↔contextId 三层映射**。
- `data-pie-idx` 由 read_page 的 isolated 注入所打，main-world CDP 脚本经共享 DOM 可读到。

**实例发现（per-engine，在命中 context 内执行）**

- **CodeMirror 5**：`el.closest('.CodeMirror').CodeMirror` —— 官方 expando，可靠。
- **Monaco**：`monaco.editor.getEditors().find(e => e.getContainerDomNode().contains(el))` —— 全局注册表，可靠。
- **CodeMirror 6**：⚠️ **本方案最大实现期不确定点**。CM6 **没有标准全局实例注册表**，DOM 上也无官方 expando。候选：`EditorView.findFromDOM(dom)`（需页面把 `EditorView` 暴露到全局，不保证）。实现期必须先验证 CM6 的可靠发现路径；若无通用解，CM6 退化为「检测+登记」但 read/set 返回明确降级错误（仍优于现状）。见 §8 风险。

**共享 deps（复用 keyboard 工厂模式）**

```ts
interface EditorToolDeps {           // 形态对齐 KeyboardToolDeps
  acquireSession: (tabId: number) => Promise<CdpSession>;
  pinnedOrigin: string;
  requestConsent: (sessionId: string) => Promise<boolean>;
  sessionId: string;
}
```

`loop.ts` 中与 `getKeyboardTools` 并列绑定 `getEditorTools(deps)`；`tools.ts` 暴露 `getEditorTools`。

## 5. 安全不变量

- CDP 在 page main context 执行 = **信任页面 JS**（页面可 hook/伪造 `getValue`）。`read_editor` 返回内容**必须**裹 `untrusted_editor_content`，**绝不**进 system role；走 `untrusted-wrappers.ts` 唯一 escape 入口。
- **新 wrapper 双清单登记**（dual-list invariant）：`untrusted_editor_content` 同时加入 `untrusted-wrappers.ts` 的 `UNTRUSTED_WRAPPER_TAGS` 与 `page-snapshot.ts` 的 `WRAPPER_TAGS_LIST`；由 parity 测试守护。
- CDP consent：复用现有 `requireCdpInput` gate；未授权时触发现有 sidepanel consent 流程，不另设计。
- origin 重检：复用 keyboard 的 per-CDP-call origin/active-tab 重检（`pinnedOrigin`）。
- ownerToken / per-session 锁：经 `acquireSession`（任务级 `acquireSessionForTask`）继承现有 R7 跨 session 隔离，无新增。

## 6. Tool 注册与分类

- `tool-names.ts`：加 `read_editor`、`set_editor_value` 到 `KNOWN_BUILT_IN_TOOL_NAMES`（或新建 `KNOWN_EDITOR_TOOL_NAMES`）；`TOOL_CLASSES` 声明 `read_editor: "read"`、`set_editor_value: "write"`（build-time 不变量要求每个 known tool 必须分类）。
- `tools.ts`：`getEditorTools(deps)` → `buildEditorTools(deps)`，在 loop 注册。
- prompt：在工具目录/指引中说明三者关系（read_page 发现 → read_editor 读全文 → set_editor_value 写），并明确 canvas/OOPIF 降级到 keyboard/vision。

## 7. 错误处理与降级（fail-closed）

| 情形 | 行为 |
|---|---|
| 探测不到 model 入口（真 canvas / 未知编辑器 / CM6 无法发现实例） | 返回明确错误：读→「无法提取，请截图后用 vision」；写→「请 click 聚焦后用 dispatch_keyboard_input」 |
| cross-origin OOPIF 内编辑器（逐 context 看不到其 context） | 同上降级；read_page 仍登记该编辑器（isolated allFrames 可见），Agent 可 click 聚焦 + keyboard/vision |
| CDP 未授权 | 现有 consent 流程提示用户授权 |
| setValue 后回读不一致 | 返回错误（页面拦截/受控回滚），不谎报成功 |
| elementIndex 失效（DOM 已变） | 逐 context 全 miss → 明确错误，提示重新 read_page |

## 8. 风险与未决

- **CM6 实例发现（高）**：无标准注册表，是最大不确定点。实现期第一步即验证；无通用解则 CM6 read/set 降级（检测+登记仍保留）。
- **逐 context 探测的 context 数量**：极端页面 iframe 很多时逐个 querySelector 有开销；实测若成问题再加 frame 提示优化。但 context 通常个位数，预期可忽略。
- **context 生命周期**：现采现用、不缓存，规避导航/reload 导致 context 失效；`Runtime.enable` 在调用内开启即可。
- **CDP `Runtime.evaluate` 大字符串**：`returnByValue` 对大文档的序列化上限实现期验证（一般数百 KB 无虞）。

## 9. 测试策略

- **isolated 检测**（happy-dom）：造 `.monaco-editor` / `.cm-editor` / `.CodeMirror` DOM，验证进 interactive index、role/name 正确、打了 data-pie-idx；可见文本仍进 page_content。
- **editor-bridge 实例发现**（per-engine 单测）：mock `window.monaco` / CM5 `.CodeMirror` expando / CM6 候选路径，验证从 data-pie-idx 元素发现实例。
- **工具层**（mock `session.send`）：验证 Runtime.enable+逐 context 探测调用序、命中 context 选择、`untrusted_editor_content` 包裹、写后回读校验、consent gate 短路、canvas/OOPIF/失效 idx 的降级错误文案。
- **不变量**：wrapper 双清单 parity 测试（仿 `interactive-parity` 模式）。
- 提交前：`pnpm test`、`pnpm typecheck`、`pnpm build`。

## 10. Issue 映射与交付顺序

| issue | 由哪个组件解决 | 可独立交付 |
|---|---|---|
| #125（可交互+读可辨识） | §4.1 read_page 检测+登记 | ✅ 零授权，先交付 |
| #126（读全文） | §4.1 标注 + §4.2 read_editor | read_editor 依赖 §4.4 bridge |
| #124（写，P0） | §4.3 set_editor_value | 依赖 §4.4 bridge |

建议顺序：§4.1（isolated，零授权，独立见效）→ §4.4 bridge（Monaco/CM5 先，CM6 验证）→ §4.2 read_editor → §4.3 set_editor_value。
