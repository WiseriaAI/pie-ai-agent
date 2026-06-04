# 编辑器交互方案：近期走 isolated-world，MAIN-world helper 暂缓（触发条件门控）

> 状态：**S2 / MAIN-world editor helper = 暂缓（DEFERRED，trigger-gated，仿 SP-4 #70）**。
> 分支 `claude/editor-main-world-helper`。关联：`docs/plans/2026-06-04-canvas-editor-issues-review.md`。
> 本文是对前一版"直接建 MAIN-world 底座"方案的**修订**：评审认为对当前 issue 描述的场景属过设计，改为先走 isolated-world 的便宜路线，MAIN world 记成待触发待办。原 MAIN-world 设计完整保留在**附录 A**（触发后可直接捡起）。

## 0. TL;DR（决策）

- **不引入 MAIN world**。编辑器簇 issue（#124/#125/#126）描述的主线场景，用现有 isolated-world + CDP 键盘**基本已覆盖或可低成本覆盖**。
- 关键事实（已核实代码，见 §1）：`read_page` 的快照白名单保留 `span/div/code/pre`，只删 `script/style/noscript/template`——所以 **Monaco/CodeMirror 的"可见行"文本本来就会被抓进 `<untrusted_page_content>`**。issue 说"完全读不到编辑器内容"这一前提不准确，真正缺的只是**屏幕外被虚拟化的行**。
- 近期只做 isolated-world 的几步小改（§3），MAIN world 设触发条件（§4）+ 留一条**实测 TODO**（§5，后续另行跟进）。

## 1. 关键事实（代码锚点，已核实）

| 事实 | 锚点 |
|---|---|
| 快照标签白名单含 `span/div/code/pre`；只删 `script/style/noscript/template` → **可见编辑器文本会被序列化进快照** | `page-snapshot.ts:34-43` |
| `dispatch_keyboard_input` 走 CDP `Input.insertText`（isTrusted，**绕开 IME**）；IME 问题是 DOM `type` 工具才有 | `keyboard.ts:343-354`、`type.ts:288-320` |
| `MAX_TEXT_LENGTH=5000` 是**自设常量**，非 CDP 硬限——可按需调高 | `keyboard.ts:50` |
| `window.monaco`/`node.CodeMirror`/`getValue/setValue` 在 MAIN world，isolated 注入看不到（这是 MAIN world 唯一独占价值） | 全仓无 `world:"MAIN"` |
| `.monaco-editor`/`.cm-editor`/`.CodeMirror` 等指纹已存在（仅诊断用） | `type.ts:90-113` |

## 2. 不引入 MAIN world 的代价（如实，且有界）

只丢两样，且都不是 issue 描述的量级：

1. **一次性读全文（屏幕外虚拟化行）**——可见视口已能读；丢的是不滚动就拿整篇。兜底：滚动分页 + #125a 让编辑器进快照。对"看模板/确认刚输入的内容"（光标在视口内），可见区通常够。
2. **一次性可靠写 >5000 字符**——#124 自举例子是"数百字符"，远未到 5000；它担心的 IME 已被 `dispatch_keyboard_input` 解决。真嫌 5000 小，调高常量即可。

→ MAIN world 真正独占的只剩"**对大部分在屏幕外的大文档做整篇读 / 整篇一步写**"，是边角场景，不是主线。

## 3. 近期方案（isolated-world，本分支后续实现）

| 步骤 | 内容 | world | 成本 |
|---|---|---|---|
| #123 ✅ | `press_key` + modifiers → `mod+A` 全选后 `dispatch_keyboard_input` 覆盖 | CDP | 已完成（另一 PR） |
| **#125a** | 把 `.monaco-editor`/`.cm-editor`/`.CodeMirror`/`.ace_editor` 加进 `INTERACTIVE_SELECTOR`（三处 verbatim 副本 + parity test 同步），编辑器宿主拿 pie_idx 可被 `click` 聚焦；stamp 时对宿主**去重收敛**（只暴露宿主一个 idx，不展开内部虚拟行） | isolated | 低 |
| **轻量 #126** | 确保 read_page 把**可见编辑器文本清晰露出**（如给已识别编辑器区域加可识别标注），其余靠滚动；**前置 §5 实测**确认可见行当前是否真被抓到 | isolated | 低-中 |
| **#127** | `type`/`click` 命中已指纹的编辑器却失败时，错误信息引导走"`press_key(mod+A)` + `dispatch_keyboard_input`"路径 | — | 低 |
| 可选 | 视实测结果，按需调高 `dispatch_keyboard_input` 的 5000 上限 | CDP | 极低 |

## 4. MAIN world 触发条件（满足再考虑动工，附录 A 是现成设计）

- [ ] 出现一类**高频**任务，内容大到"可见区 + 滚动"读不全，或必须一步写入 >5000 且无法分段；
- [ ] 且 #123 + `dispatch_keyboard_input` 这条路在该任务上被证明**反复失败 / 太慢**；
- [ ] 评估 MAIN-world 新攻击面（"执行即不可信"，见附录 A §4）的代价 vs 收益；
- [ ] 若决定做：直接采用附录 A 的设计（execInTabMainWorld + 适配器 + untrusted 包裹 + 新 invariant）。

## 5. TODO（后续另行跟进）

> 这些不在本 PR 范围内，留作待办，由后续单独跟进。

- [ ] **实测 read_page 对真实 Monaco/CodeMirror 页面的输出**（~10 分钟）：确认"可见行文本"当前**是否真被抓进 `<untrusted_page_content>`**。
  - 若**抓到** → issue #126 的"完全读不到"前提推翻，轻量 #126 只需把编辑器区域标注清楚即可；
  - 若**没抓到**（理论上 span 该保留，但可能被某段 strip 逻辑/虚拟化时机漏掉）→ 这是一个该修的 **isolated-world bug**，优先级高于、且独立于 MAIN world。
- [ ] 基于实测结论，决定轻量 #126 的具体形态，并确认是否需要调高 `dispatch_keyboard_input` 上限。
- [ ] （仅当 §4 触发条件满足时）重启附录 A 的 MAIN-world 底座。

---

# 附录 A：MAIN-world editor helper 设计（暂缓，触发后捡起）

> 以下为前一版完整设计，保留以便触发条件满足时直接采用。**当前不实现。**

## A.1 为什么需要它

`window.monaco`/`node.CodeMirror`/`editor.getValue()/setValue()` 都活在页面 MAIN world，isolated 注入看不到。要"整篇读 / 整篇一步写"必须引入 MAIN-world 注入路径 + 编辑器适配器。

## A.2 架构

```
LLM tool call (read_editor / set_editor_value)
        │  args: { frameId, elementIndex(pie_idx), [text] }
        ▼
SW handler ──► execInTabMainWorld(tabId, editorFn, args, frameId)
        │            chrome.scripting.executeScript({ target, func, world:"MAIN", args })
        ▼
   页面 MAIN world 自包含 editorFn：
     1. el = querySelector([data-pie-idx])   ← DOM 属性跨 world 可见
     2. adapter = detectAdapter(el)          ← monaco/cm5/cm6/ace
     3. getValue() / setValue(text)
     4. 返回 { ok, editorKind, value? }（结构化可克隆）
        ▼
读：escapeUntrustedWrappers → <untrusted_editor_content>
写：复用 validateText（抬高 cap）→ 成功/失败（脱敏 text）
```

## A.3 交付物

- **`execInTabMainWorld`**：与 `execInTab`（`tools.ts:54`）并列，唯一差别 `world:"MAIN"`；返回值须结构化可克隆；注入函数仍须 self-contained；MAIN world 拿不到 `chrome.*`（本 helper 不需要）。**无需新 manifest 权限**。
- **编辑器适配器**（注入函数内自包含）：Monaco（`monaco.editor.getEditors()` 匹配 `getContainerDomNode`）、CM5（`el.closest('.CodeMirror').CodeMirror`）= 高可靠；CM6（`EditorView.findFromDOM`/探测）、ACE（`ace.edit`/`env.editor`）= best-effort。找不到 instance → 结构化失败 → 回退 CDP 键盘。
- **`read_editor` 工具**：输出包进新 wrapper `untrusted_editor_content`，按双清单不变量**两处都登记**（`untrusted-wrappers.ts:UNTRUSTED_WRAPPER_TAGS` + `page-snapshot.ts:WRAPPER_TAGS_LIST`），发射仿 PDF 先例（`pdf.ts:67`）；加 `max_bytes` 截断。分类 `read`。
- **`set_editor_value`（#124）**：薄写入封装，复用 `validateText`（把 5000 抽成可配置 cap，set 用更高值如 100KB）；分类 `write`；大段 `text` 进 `redactArgsForPanel`。

## A.4 安全模型（MAIN world 是"执行即不可信"的新攻击面）

注入函数体硬编码（非 LLM），LLM 只供 pie_idx + setValue 的 text：
1. **丢失 intrinsics 隔离**：MAIN world 跑在页面敌对 JS 上下文，页面可 monkeypatch 任何内建/getter → **MAIN world 里不得放任何安全逻辑**（校验/消毒/origin 检查全留 SW 侧）。
2. **getValue 返回是页面可控数据** → **必须 untrusted 包裹 + escapeUntrustedWrappers**（硬要求）。
3. 信任边界**精确落在 executeScript 返回点**：返回前全不可信。
4. 不增 manifest 权限；涨的是**信任足迹**非权限足迹。
5. **新增 Architecture Invariant**：注入函数除"self-contained"外，须显式声明 world 归属；MAIN-world 函数执行即不可信、返回值页面可控、内部无安全逻辑。**严禁退化成通用 `eval_in_page`**（会成 prompt-injection 放大器）；窄锁在 editor get/set。
6. 与 SP-2（#68）沙箱方向相反：SP-2 是"把不可信代码关进沙箱远离权力"，MAIN world 是"可信代码走进不可信地盘够 API"——概念上保持隔离。

## A.5 已知限制

- 必须页面暴露编辑器实例（Monaco 未挂 `window.monaco` → 不可达 → 回退 CDP 键盘）。
- 真 Canvas 编辑器（Google Docs `.kix-*`）无公开 API → **排除**，继续 CDP 键盘。
- 耦合第三方编辑器内部 → best-effort + 优雅降级，**绝不 load-bearing**。

## A.6 测试 / 开放问题

- 适配器单测（mock 各编辑器全局）、untrusted 包裹转义测试、双清单 parity、validateText cap、脱敏；三门禁。
- 开放问题：MAIN-world 是否批准引入（总开关）；read_editor 独立 vs 并进 read_page（倾向独立）；max_bytes 取值；CM6/ACE 是否进 MVP；validateText 抽参化。
