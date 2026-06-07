# TinyMCE 富文本编辑器支持

设计文档 · 2026-06-07 · 关联 issue [#143](https://github.com/WiseriaAI/pie-ai-agent/issues/143)

## 1. 背景与问题

WebArena mutate 任务 **464**(修改产品描述)失败,且是最危险的**静默假成功**:agent 用 `dispatch_keyboard_input` 往描述编辑器"输入"新文本并**报告保存成功**(URL 确实跳转),但实际提交的 `product/save` POST 里描述**仍是原值**。agent 误判已完成,不会自我纠正。

根因:Magento 产品描述编辑器是 **TinyMCE**(iframe 内 contenteditable 富文本)。现有编辑器 CDP 支持(#124 / #125 / #126,见 `docs/specs/2026-06-05-canvas-editor-cdp-support.md`)只覆盖 **Monaco / CodeMirror**(顶层 frame),不含 TinyMCE。键盘事件没落进 iframe 编辑体,原内容保留,而工具链没有读回校验 → 假成功。

## 2. 根因(已用活页面探针证实)

在真实 Magento(`localhost:7780`,TinyMCE **5.10.2**)产品编辑页上做非破坏性探测,结论:

1. **提交源是隐藏 `<textarea>`**(`name="short_description"`,`display:none`),不是 iframe 编辑体。
2. **写入路径(决定性)**:
   - 写 iframe body(isolated 式,≈`dispatch_keyboard_input` 的效果)→ 编辑器模型变,但 textarea **不同步**。
   - `editor.setContent(html)` → 编辑器模型变,textarea **仍不同步**。
   - **只有 `editor.save()`(单编辑器版 `tinymce.triggerSave()`)把内容刷进 textarea。** Magento 表单提交时虽会自动 triggerSave,但 464 的文本根本没进编辑器模型(agent 点的是 Content 区而非聚焦 iframe body,键盘事件落空)→ triggerSave 同步的是原内容。
3. **`getContent()` 返回规范化 HTML**(如 `<p>...</p>`、实体编码、`<br />`),严格 `after === TEXT` 校验必然误判失败。
4. **宿主在顶层 frame**:可见容器 `.tox-tinymce`(v5/6)/ `.mce-tinymce`(v4)在 top document;`window.tinymce` 是 main-world 全局。`tinymce.get(id) === editor` ✓,从容器经 `editor.getContainer()` 也能解析回 editor(探针 `resolvedByContainer: true`)。

**关键架构事实**:现有 `set_editor_value` 走 CDP `Runtime.evaluate`,**本就在页面 main world 跑**(现有分支已用 `win.monaco` / `win.CM` 这些 main-world 全局)。故 `win.tinymce` 同样可达 —— **#143 不需要 iframe 遍历、不需要新工具、不需要 #141 延期的 main-world 注入基建**,是现有 editor CDP 工具的自然延伸。

**纯文本写入机制(已往返验证,`roundtripMatch: true`)**:转义 `& < >`、换行 `\n`→`<br>` → `setContent(esc)` → `save()` → `getContent({format:"text"})` 干净回读出原始纯文本;textarea 同步成 `<p>...</p>` 提交值。

## 3. 目标与范围

### 目标
让 agent 能可靠地把内容写进 TinyMCE 编辑器并经保存生效;写入未成功时**如实报错而非假成功**。沿用现有 `read_editor` / `set_editor_value` 工具与 `role="editor"` 快照约定,agent 无需学新工具。

### 范围内
- `page-snapshot.ts`:`EDITOR_SELECTOR` + `editorEngineOf` 识别 TinyMCE 容器 → 快照把它标成 `role="editor"` 单句柄(现有 `editorHosts` / `insideEditor continue` 逻辑自动跳过 iframe/工具栏子元素)。
- `editor.ts` `adapterFragment()`:新增 TinyMCE 引擎分支,`get = getContent({format:"text"})`,`set = 转义 + setContent + save()`。
- `editor.ts` `buildSetEditorExpression`:引擎感知的容错校验(TinyMCE 文本级归一比对;Monaco/CM 保持严格)。
- 工具描述补充 TinyMCE 与"纯文本写入"语义。

### 范围外(本版不做,见 §8)
- **`search-page.ts` 不改**:它对**所有**编辑器引擎(Monaco/CM/TinyMCE)都不做 editor-host 盖戳——这是 #137 既定边界,编辑器只由 `read_page` 暴露。单给 TinyMCE 在 search-page 加分支反而破坏一致性。agent 经 `read_page` 发现编辑器,这是主路径。
- **纯文本语义之外的富文本/格式化**:`set_editor_value` 是整体替换,不碰工具栏格式按钮。
- **其他富文本编辑器**(CKEditor / Froala / iframe 内 Quill):YAGNI;适配器分支结构便于将来加兄弟分支。
- **真正在 iframe 内的代码编辑器**(CM-in-iframe):仍走现有 `in_subframe` 降级。

## 4. 设计

### 4.1 快照可达性（page-snapshot.ts）

现状(`page-snapshot.ts:76-83`):

```js
const EDITOR_SELECTOR = ".monaco-editor, .cm-editor, .CodeMirror";

function editorEngineOf(el) {
  if (el.matches?.(".monaco-editor")) return "Monaco";
  if (el.matches?.(".cm-editor")) return "CodeMirror"; // CM6
  if (el.matches?.(".CodeMirror")) return "CodeMirror"; // CM5
  return null;
}
```

改为:

```js
const EDITOR_SELECTOR = ".monaco-editor, .cm-editor, .CodeMirror, .tox-tinymce, .mce-tinymce";

function editorEngineOf(el) {
  if (el.matches?.(".monaco-editor")) return "Monaco";
  if (el.matches?.(".cm-editor")) return "CodeMirror"; // CM6
  if (el.matches?.(".CodeMirror")) return "CodeMirror"; // CM5
  if (el.matches?.(".tox-tinymce")) return "TinyMCE";   // v5 / v6
  if (el.matches?.(".mce-tinymce")) return "TinyMCE";   // v4
  return null;
}
```

**自动生效**:`inferredRole`(`page-snapshot.ts:244`)对任何 `editorEngineOf` 命中返回 `"editor"`;`accessibleName`(L265)返回 `"TinyMCE editor — use read_editor / set_editor_value (idx N)"`;`editorHosts`(L400)把容器纳入并经 `insideEditor continue`(L415)跳过其后代。无需改动这三处。

### 4.2 写入/读取适配器（editor.ts adapterFragment）

在 CM6 分支之后、`adapterFragment()` 闭合之前新增:

```js
if (!ed && win.tinymce && win.tinymce.editors) {
  const host = el.closest(".tox-tinymce, .mce-tinymce") || el;
  const t = win.tinymce.editors.find(function (e) {
    const c = e.getContainer && e.getContainer();
    return c && (c === host || c.contains(el) || el.contains(c));
  });
  if (t) ed = {
    engine: "tinymce",
    looseText: true,
    get: function () { return t.getContent({ format: "text" }); },
    set: function (txt) {
      const esc = txt
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/\n/g, "<br>");
      t.setContent(esc);   // 纯文本语义:转义后按 HTML 写入
      t.save();            // 同步隐藏 textarea(提交源)—— 消除假成功的关键
    },
  };
}
```

- `host`:被盖戳的元素就是 `.tox-tinymce` 容器(EDITOR_SELECTOR 命中的就是它),`el.closest(...)` 兜底拿容器,再经 `getContainer()` 在 `win.tinymce.editors` 里匹配回 editor。
- `looseText: true`:仅 TinyMCE 携带,供 §4.3 校验分流。

### 4.3 引擎感知的容错校验（buildSetEditorExpression）

现状(`editor.ts:152-153`):

```js
ed.set(TEXT);
const after = String(ed.get());
return { ok: true, engine: ed.engine, verified: after === TEXT };
```

改为:

```js
ed.set(TEXT);
const after = String(ed.get());
const verified = ed.looseText
  ? after.replace(/\s+/g, " ").trim() === TEXT.replace(/\s+/g, " ").trim()
  : after === TEXT;
return { ok: true, engine: ed.engine, verified: verified };
```

- TinyMCE:`get()` 返回 `format:text` 纯文本,与输入 `TEXT` 做空白归一(`\s+→空格` + trim)后比对,容忍 `<p>` 包裹与 TinyMCE 的空白规范化。
- Monaco/CM:`looseText` 为 undefined → 走严格 `after === TEXT`,代码编辑器逐字符精确不变。
- read-back 不匹配仍回 `verified:false` → `set_editor_value` 返回失败 → **根治 464 假成功**。

### 4.4 工具描述（buildEditorTools）

- `set_editor_value` 描述补:支持 TinyMCE 富文本编辑器;对 TinyMCE 按**纯文本**写入(传什么文本就显示什么,特殊字符自动转义),写入后读回校验。
- `read_editor` 描述补:TinyMCE 返回纯文本内容。
- `read_editor` 对 TinyMCE 经 `get()` 返回纯文本,照旧包 `<untrusted_editor_content engine="tinymce">`(无需改 handler,适配器已统一)。

## 5. 数据流（agent 视角）

1. `read_page` → TinyMCE 容器以 `role="editor"` engine=TinyMCE 出现在 `<interactive_index>`,带 frameId + pieIdx。
2. agent `set_editor_value(idx, "1 customer(s) love it!")` → CDP main-world eval 定位容器 → 解析 `tinymce` editor → 转义 + `setContent` + `save()` → `getContent({format:text})` 读回 → 归一比对通过 → `verified:true`。
3. 若内容没落进去(读回不匹配)→ `verified:false` → 工具返回失败,agent 自我纠正(不再假成功)。
4. agent 点保存 → Magento 提交时 textarea 已含新内容 → POST 携带新描述 → 任务成功。

## 6. 边界与不变量

- **单句柄**:`.tox-tinymce` 标为 editor host,iframe/工具栏子元素经 `insideEditor continue` 不再单独盖戳(同 Monaco)。
- **解析失败**:`win.tinymce` 缺失或匹配不到 editor → `ed` 仍为 null → `no_engine` 错误(如实降级,不假成功)。
- **idx-parity**:editor-host 盖戳本就只在 page-snapshot、不在 search-page(#137 既存,Monaco/CM 同此);TinyMCE 加入同一 read_page-only 处理,不新增也不收窄该边界。parity 行为测试 fixture 不含编辑器,不受影响。
- **CDP 同意门**:沿用现有 `requireCdpInput`,无新增授权面。
- **安全**:`getContent` 在页面 JS 上下文返回 → 仍 UNTRUSTED,经 `<untrusted_editor_content>` 包裹,永不进 system role(现有不变量)。

## 7. 测试（TDD）

1. **快照识别 TinyMCE**:fixture = `<div class="tox-tinymce">...</div>`(可见);断言它拿到 `data-pie-idx`、`role="editor"`、accessibleName 含 "TinyMCE editor"。v4 `.mce-tinymce` 同测。
2. **单句柄**:TinyMCE 容器内放一个可见 `<button>`(模拟工具栏)→ 断言容器被盖、内部 button 未单独盖(`insideEditor` 跳过)。
3. **set 表达式构造**:`buildSetEditorExpression(idx, "a < b")` 的输出串包含 TinyMCE 分支(`getContent`、`setContent`、`.save()`)、转义逻辑、`looseText` 容错比对分支。
4. **read 表达式构造**:`buildReadEditorExpression(idx)` 输出含 `getContent({ format: "text" })`。
5. **容错校验逻辑**(纯函数级,抽出归一比较或对表达式求值):`<p>x</p>` 文本 `x` vs 输入 `x` 判等;含换行/特殊字符的输入归一后判等;Monaco 分支仍严格(`a` ≠ `a `)。
6. **不回归 Monaco/CM**:现有 editor.test.ts 全绿,Monaco/CM 的 set 仍严格校验。

> 注:adapter 在 CDP 页面上下文里求值,单测无法起真实 TinyMCE。测试策略 = 对 `build*Expression` 的**输出字符串**断言关键片段(现有 editor.test.ts 已是此模式),真实驱动靠手动真机回归(Magento 464 场景)。

## 8. 延期项（文档化，本版不做）

- **search_page 暴露编辑器**:需把整套 `editorHosts` / `insideEditor` 逻辑镜像进 `dom-actions/search-page.ts`,覆盖所有引擎,单独评估(非 TinyMCE 专属)。
- **其他富文本引擎**(CKEditor / Froala / iframe-Quill):适配器留兄弟分支位,按需添加。
- **富文本格式化交互**:加粗/列表/链接等结构化编辑,超出"整体替换纯文本"范畴。

## 9. 风险

- **TinyMCE 版本差异**:v4(`.mce-tinymce`)与 v5/6(`.tox-tinymce`)容器类不同,均已纳入选择器;`getContent`/`setContent`/`save` API 在 v4–v6 稳定一致。
- **`win.tinymce.editors` 解析不到**:多编辑器/嵌套场景经 `getContainer()` 容器匹配兜底;匹配不到则 `no_engine` 如实降级。
- **归一比对过松**:空白归一可能放过"内容大体对但细节差"的情况,但 read-back 仍能抓住"内容根本没进去"(464 的真问题);代码编辑器不受影响(严格分支)。
- **手动验证依赖**:adapter 真实行为需 Magento 真机回归(464 场景)兜底,单测只覆盖表达式构造。
