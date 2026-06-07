# TinyMCE 富文本编辑器支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent 能可靠地把内容写进 TinyMCE 富文本编辑器并经保存生效,写入未成功时如实报错而非静默假成功(WebArena 任务 464)。

**Architecture:** 扩展现有编辑器 CDP 基础设施(#124-126)。`read_page` 经 `EDITOR_SELECTOR` 把 TinyMCE 容器标成 `role="editor"` 单句柄;`set_editor_value` / `read_editor` 走 CDP `Runtime.evaluate`(本就在页面 main world),其 `adapterFragment` 新增 TinyMCE 引擎分支(`getContent`/`setContent`+`save()`);写入校验改为引擎感知容错(TinyMCE 文本归一,Monaco/CM 保持严格)。不动 `search-page.ts`、无新工具、无 main-world 新基建。

**Tech Stack:** TypeScript, vitest + happy-dom, Chrome CDP `Runtime.evaluate`, TinyMCE 4/5/6 公共 API(`tinymce.editors` / `editor.getContainer/getContent/setContent/save`)。

**Spec:** `docs/specs/2026-06-07-tinymce-rich-text-editor-support.md`

---

## File Structure

- **`src/lib/dom-actions/page-snapshot.ts`**(Modify):`EDITOR_SELECTOR`(L76)加 TinyMCE 容器类;`editorEngineOf`(L78-83)加 TinyMCE 分支。其余识别链(`inferredRole` L244 / `accessibleName` L265 / `editorHosts` L400 / `insideEditor` L415)自动生效,不改。
- **`src/lib/agent/tools/editor.ts`**(Modify):`adapterFragment()`(L69-130)加 TinyMCE 引擎分支;`buildSetEditorExpression()`(L143-155)校验改引擎感知容错;两个工具的 `description` 补 TinyMCE 说明。
- **`src/lib/dom-actions/page-snapshot.editor.test.ts`**(Modify):加 TinyMCE 识别用例。
- **`src/lib/agent/tools/editor.test.ts`**(Modify):加 TinyMCE 适配器/校验用例(`new Function` 真实求值生成的表达式 + fake `window.tinymce`/`window.monaco`)。

不改 `search-page.ts`(spec §3 范围外:它对所有编辑器引擎都不盖戳,#137 既定边界)。

---

## Task 1: 快照识别 TinyMCE 容器为 role="editor"

**Files:**
- Modify: `src/lib/dom-actions/page-snapshot.ts:76` 和 `:78-83`
- Test: `src/lib/dom-actions/page-snapshot.editor.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/lib/dom-actions/page-snapshot.editor.test.ts` 的 `describe("read_page editor detection", ...)` 块内、最后一个 `it` 之后追加:

```ts
  it("registers a TinyMCE v5/6 host (.tox-tinymce) as a role=editor element", () => {
    document.body.innerHTML = `
      <div class="tox tox-tinymce">
        <div class="tox-editor-container">
          <button class="tox-tbtn">Bold</button>
          <iframe class="tox-edit-area__iframe"></iframe>
        </div>
      </div>`;
    const host = document.querySelector(".tox-tinymce") as HTMLElement;
    makeVisible(host);

    const snap = pageSnapshotInjected();
    const editor = snap.interactiveElements.find((el) => el.role === "editor");

    expect(editor).toBeDefined();
    expect(editor!.name).toContain("TinyMCE");
    expect(editor!.name).toContain("set_editor_value");
    expect(host.getAttribute("data-pie-idx")).toBe(String(editor!.pieIdx));
  });

  it("suppresses the toolbar button inside the TinyMCE host (single handle)", () => {
    document.body.innerHTML = `
      <div class="tox tox-tinymce">
        <button class="tox-tbtn">Bold</button>
      </div>`;
    const host = document.querySelector(".tox-tinymce") as HTMLElement;
    const btn = document.querySelector(".tox-tbtn") as HTMLElement;
    makeVisible(host);
    makeVisible(btn);

    const snap = pageSnapshotInjected();
    expect(snap.interactiveElements.filter((e) => e.role === "editor")).toHaveLength(1);
    expect(btn.hasAttribute("data-pie-idx")).toBe(false);
  });

  it("registers a TinyMCE v4 host (.mce-tinymce) as a role=editor element", () => {
    document.body.innerHTML = `<div class="mce-tinymce mce-container"></div>`;
    const host = document.querySelector(".mce-tinymce") as HTMLElement;
    makeVisible(host);

    const snap = pageSnapshotInjected();
    const editor = snap.interactiveElements.find((el) => el.role === "editor");
    expect(editor).toBeDefined();
    expect(editor!.name).toContain("TinyMCE");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/dom-actions/page-snapshot.editor.test.ts`
Expected: 3 个新用例 FAIL(`editor` 为 undefined,因为 `.tox-tinymce` 未被识别)。

- [ ] **Step 3: 改 EDITOR_SELECTOR 与 editorEngineOf**

`src/lib/dom-actions/page-snapshot.ts` L76,把:

```ts
  const EDITOR_SELECTOR = ".monaco-editor, .cm-editor, .CodeMirror";
```

改为:

```ts
  const EDITOR_SELECTOR = ".monaco-editor, .cm-editor, .CodeMirror, .tox-tinymce, .mce-tinymce";
```

L78-83 的 `editorEngineOf`,把:

```ts
  function editorEngineOf(el: Element): string | null {
    if (el.matches?.(".monaco-editor")) return "Monaco";
    if (el.matches?.(".cm-editor")) return "CodeMirror"; // CM6
    if (el.matches?.(".CodeMirror")) return "CodeMirror"; // CM5
    return null;
  }
```

改为:

```ts
  function editorEngineOf(el: Element): string | null {
    if (el.matches?.(".monaco-editor")) return "Monaco";
    if (el.matches?.(".cm-editor")) return "CodeMirror"; // CM6
    if (el.matches?.(".CodeMirror")) return "CodeMirror"; // CM5
    if (el.matches?.(".tox-tinymce")) return "TinyMCE";   // v5 / v6
    if (el.matches?.(".mce-tinymce")) return "TinyMCE";   // v4
    return null;
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/dom-actions/page-snapshot.editor.test.ts`
Expected: PASS(原有 Monaco/CM 用例 + 3 个新 TinyMCE 用例全绿)。

- [ ] **Step 5: 提交**

```bash
git add src/lib/dom-actions/page-snapshot.ts src/lib/dom-actions/page-snapshot.editor.test.ts
git commit -m "feat(snapshot): surface TinyMCE hosts as role=editor (#143)"
```

---

## Task 2: editor.ts 适配器 + 引擎感知容错校验

**Files:**
- Modify: `src/lib/agent/tools/editor.ts`(`adapterFragment` L69-130;`buildSetEditorExpression` L143-155)
- Test: `src/lib/agent/tools/editor.test.ts`

- [ ] **Step 1: 写失败测试(求值 helper + fakes + 用例)**

在 `src/lib/agent/tools/editor.test.ts` 文件**末尾**追加。先加求值 helper 与 fake 安装器,再加用例:

```ts
// ── 真实求值生成的 CDP 表达式(happy-dom + fake 编辑器全局)──
// build*Expression 产出 `(function(){...})()` 串;在 happy-dom 里求值即可端到端
// 验证 adapter 解析 + 写入 + 引擎感知校验,而无需真实 CDP / 真实 TinyMCE。
function evalExpr(expr: string): { ok: boolean; engine?: string; verified?: boolean; reason?: string; value?: string } {
  return new Function("return " + expr)();
}

interface TinyFake {
  capturedHtml: string;
  saveCalled: boolean;
  getContentText: () => string; // 测试可覆写以模拟"内容没落进去"
}

function installTinyMce(host: Element): TinyFake {
  const state: TinyFake = {
    capturedHtml: "",
    saveCalled: false,
    getContentText: function () {
      // 默认:setContent 的 html 经 happy-dom 解析回文本(模拟真实 round-trip)
      const d = document.createElement("div");
      d.innerHTML = state.capturedHtml;
      return d.textContent ?? "";
    },
  };
  const editor = {
    getContainer: () => host,
    setContent: (html: string) => { state.capturedHtml = html; },
    getContent: (opts?: { format?: string }) =>
      opts && opts.format === "text" ? state.getContentText() : state.capturedHtml,
    save: () => { state.saveCalled = true; },
  };
  (window as unknown as { tinymce: unknown }).tinymce = { editors: [editor] };
  return state;
}

function installMonaco(host: Element, getValueReturns: string): void {
  const editor = {
    getContainerDomNode: () => host,
    getValue: () => getValueReturns,
    setValue: (_t: string) => {},
  };
  (window as unknown as { monaco: unknown }).monaco = {
    editor: { getEditors: () => [editor] },
  };
}

describe("set_editor_value TinyMCE adapter (eval-in-happy-dom)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.querySelectorAll("[data-pie-idx]").forEach((el) => el.removeAttribute("data-pie-idx"));
    delete (window as unknown as { tinymce?: unknown }).tinymce;
    delete (window as unknown as { monaco?: unknown }).monaco;
  });

  it("writes via setContent, calls save(), and verifies on round-trip", () => {
    document.body.innerHTML = `<div class="tox-tinymce" data-pie-idx="3"></div>`;
    const host = document.querySelector(".tox-tinymce")!;
    const fake = installTinyMce(host);

    const out = evalExpr(buildSetEditorExpression(3, "a < b & c"));

    expect(out.ok).toBe(true);
    expect(out.engine).toBe("tinymce");
    expect(out.verified).toBe(true);
    expect(fake.saveCalled).toBe(true);               // textarea 同步发生
    expect(fake.capturedHtml).toContain("a &lt; b &amp; c"); // 纯文本语义:转义后写入
  });

  it("reports verified=false when content did not land (anti false-success)", () => {
    document.body.innerHTML = `<div class="tox-tinymce" data-pie-idx="3"></div>`;
    const host = document.querySelector(".tox-tinymce")!;
    const fake = installTinyMce(host);
    fake.getContentText = () => "ORIGINAL UNCHANGED"; // 模拟写入被忽略 / 回滚

    const out = evalExpr(buildSetEditorExpression(3, "1 customer(s) love it!"));

    expect(out.ok).toBe(true);
    expect(out.engine).toBe("tinymce");
    expect(out.verified).toBe(false);                 // 根治 464 假成功
  });

  it("TinyMCE verify is whitespace-tolerant; Monaco verify stays strict", () => {
    // TinyMCE: getContent 文本带尾空格 → 归一后判等 → verified true
    document.body.innerHTML = `<div class="tox-tinymce" data-pie-idx="1"></div>`;
    const tinyHost = document.querySelector(".tox-tinymce")!;
    const fake = installTinyMce(tinyHost);
    fake.getContentText = () => "hello ";
    const tinyOut = evalExpr(buildSetEditorExpression(1, "hello"));
    expect(tinyOut.engine).toBe("tinymce");
    expect(tinyOut.verified).toBe(true);

    // Monaco: getValue 带尾空格 → 严格比对 → verified false
    document.body.innerHTML = `<div class="monaco-editor" data-pie-idx="2"></div>`;
    const monacoHost = document.querySelector(".monaco-editor")!;
    installMonaco(monacoHost, "hello ");
    const monacoOut = evalExpr(buildSetEditorExpression(2, "hello"));
    expect(monacoOut.engine).toBe("monaco");
    expect(monacoOut.verified).toBe(false);
  });
});

describe("buildReadEditorExpression TinyMCE", () => {
  it("reads TinyMCE as plain text via getContent format:text", () => {
    const expr = buildReadEditorExpression(4);
    expect(expr).toContain('getContent({ format: "text" })');
  });
});
```

> 注:`evalExpr` 用 `new Function`(非 `eval`)避免 lint;生成的表达式引用 `document`/`window` 全局,在 happy-dom 下可解析。`installTinyMce` 的 editor 经 `getContainer()` 返回被盖戳的容器,adapter 据此匹配。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/agent/tools/editor.test.ts`
Expected: 新 `describe` 全 FAIL(`out.engine` 为 `undefined`/`reason:"no_engine"`,因 adapter 无 TinyMCE 分支;`buildReadEditorExpression` 不含 `format: "text"`)。

- [ ] **Step 3: adapterFragment 加 TinyMCE 分支**

`src/lib/agent/tools/editor.ts` 的 `adapterFragment()` 里,在 CM6 分支的 `} catch (e) {}`(约 L127)之后、`}` 闭合 `if (el) {`(约 L128)之前,插入:

```js
      if (!ed && win.tinymce && win.tinymce.editors) try {
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
              .replace(/\\n/g, "<br>");
            t.setContent(esc);
            t.save();
          },
        };
      } catch (e) {}
```

> 注意 `\\n`:adapterFragment 是 JS **模板字符串**字面量(返回 string),故源码里写 `\\n` 才能在生成的表达式里得到 `\n`。

- [ ] **Step 4: buildSetEditorExpression 改引擎感知容错校验**

`src/lib/agent/tools/editor.ts` 的 `buildSetEditorExpression`(L143-155),把:

```ts
    ed.set(TEXT);
    const after = String(ed.get());
    return { ok: true, engine: ed.engine, verified: after === TEXT };
```

改为:

```ts
    ed.set(TEXT);
    const after = String(ed.get());
    const verified = ed.looseText
      ? after.replace(/\\s+/g, " ").trim() === TEXT.replace(/\\s+/g, " ").trim()
      : after === TEXT;
    return { ok: true, engine: ed.engine, verified: verified };
```

> 同样注意 `\\s`:模板字面量里写 `\\s+` 才能生成 `\s+`。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/lib/agent/tools/editor.test.ts`
Expected: PASS(原有 Monaco/CM 用例 + 新 TinyMCE 用例全绿)。

- [ ] **Step 6: 提交**

```bash
git add src/lib/agent/tools/editor.ts src/lib/agent/tools/editor.test.ts
git commit -m "feat(editor): TinyMCE adapter + engine-aware tolerant verify (#143)"
```

---

## Task 3: 工具描述补 TinyMCE 说明

**Files:**
- Modify: `src/lib/agent/tools/editor.ts`(`buildEditorTools` 内 `read_editor` / `set_editor_value` 的 `description`)
- Test: `src/lib/agent/tools/editor.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/lib/agent/tools/editor.test.ts` 末尾追加:

```ts
describe("editor tool descriptions mention TinyMCE", () => {
  const tools = buildEditorTools({
    acquireSession: async () => ({}) as never,
    requestConsent: async () => true,
    sessionId: "s1",
  });
  it("set_editor_value description covers TinyMCE rich-text + plain-text write", () => {
    const t = tools.find((x) => x.name === "set_editor_value")!;
    expect(t.description).toContain("TinyMCE");
  });
  it("read_editor description covers TinyMCE", () => {
    const t = tools.find((x) => x.name === "read_editor")!;
    expect(t.description).toContain("TinyMCE");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/agent/tools/editor.test.ts`
Expected: 2 个新用例 FAIL(description 不含 "TinyMCE")。

- [ ] **Step 3: 改两个工具描述**

`src/lib/agent/tools/editor.ts` 的 `read_editor` 工具 `description`(约 L204-205),在末尾(`...read those via screenshot + vision.` 之前或之后)追加一句,使其包含 TinyMCE。改为:

```ts
      description:
        "Read the FULL content of a code editor (Monaco / CodeMirror) or a TinyMCE rich-text editor by its data-pie-idx from read_page's <interactive_index> (role=\"editor\"). Returns the entire document via the editor's model API — including lines scrolled off-screen that read_page cannot see. TinyMCE returns plain text. Use this instead of read_page when you need the complete editor text. For canvas editors (e.g. Google Docs) it returns an error; read those via screenshot + vision.",
```

`set_editor_value` 工具 `description`(约 L233-234),改为:

```ts
      description:
        "Replace the ENTIRE content of a code editor (Monaco / CodeMirror) or a TinyMCE rich-text editor by its data-pie-idx from read_page (role=\"editor\"). Writes via the editor's model API in one shot — no per-character typing, no IME issues, no length truncation. TinyMCE input is treated as PLAIN TEXT (special characters are escaped; what you pass is what appears) and committed to the underlying form field. Reads back to verify. For canvas editors (e.g. Google Docs) it errors; write those via dispatch_keyboard_input after clicking to focus.",
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/agent/tools/editor.test.ts`
Expected: PASS(全部用例绿)。

- [ ] **Step 5: 提交**

```bash
git add src/lib/agent/tools/editor.ts src/lib/agent/tools/editor.test.ts
git commit -m "docs(editor): tool descriptions cover TinyMCE rich-text (#143)"
```

---

## Task 4: 全量门禁

**Files:** 无新增,仅验证。

- [ ] **Step 1: 跑全量测试**

Run: `pnpm test`
Expected: 全绿(无回归)。

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 0 错。

- [ ] **Step 3: build**

Run: `pnpm build`
Expected: 成功(build-time invariants 不 throw)。

- [ ] **Step 4: 若有偶发失败按需修复后重跑,确认三项全绿即完成**

---

## Self-Review(规划者已核对)

**Spec 覆盖:**
- §4.1 快照可达性 → Task 1 ✓
- §4.2 写入/读取适配器 → Task 2 Step 3 ✓
- §4.3 引擎感知容错校验 → Task 2 Step 4 ✓
- §4.4 工具描述 + read_editor 纯文本 → Task 3 + Task 2(read 表达式 `format:text`)✓
- §7 测试 1-6 → Task 1(快照/单句柄)、Task 2(set 构造/read 构造/容错校验/不回归 Monaco)✓
- §3 范围外 search-page 不改 → 计划无 search-page 任务 ✓

**占位符扫描:** 无 TBD/TODO;所有 step 含完整代码/命令/预期输出。

**类型/命名一致性:** `looseText` 标志在 Task 2 适配器(set)与校验(buildSetEditorExpression)两处一致;`engine: "tinymce"` 字符串一致;`getContent({ format: "text" })` 在适配器与 read 测试一致;fake 的 `getContainer`/`getContent`/`setContent`/`save` 与适配器调用一致。

**已知约束:** adapter 真实行为(真实 TinyMCE round-trip)靠 Magento 464 真机回归兜底;单测经 `new Function` 求值 + fake 全局覆盖解析/写入/校验/引擎分流逻辑。
