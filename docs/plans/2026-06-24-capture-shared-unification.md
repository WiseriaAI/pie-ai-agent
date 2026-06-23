# Recording capture 归一 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 recording capture 补 shadow DOM 穿透（`composedPath`）+ editor 识别（inline `EDITOR_SELECTOR`/`EDITOR_ENGINE_MAP` + parity），复用 `_shared/` 权威常量（issue #151 ①）。

**Architecture:** 全部改动在 `src/lib/recording/capture.ts`（self-contained 注入函数，**不能 runtime import**，归一=inline 逐字复制 + parity 测试）。shadow 穿透用注入上下文原生 `Event.prototype.composedPath()`（无需 import）。editor 识别集中在 `buildLabelFor`，自动惠及所有调用点。

**Tech Stack:** TypeScript、vitest + happy-dom。

## Global Constraints

- `capture.ts` 是 `executeScript` 序列化注入的 self-contained 函数：**无 runtime import / 无闭包 / 无 outer-scope 引用**。新常量一律 inline 逐字复制权威源 + 在 `interactive-parity.test.ts` 加 parity 守护。
- 逐字复制源（`src/lib/dom-actions/_shared/interactive.ts`）：
  - `EDITOR_SELECTOR = ".monaco-editor, .cm-editor, .CodeMirror, .tox-tinymce, .mce-tinymce"`
  - `EDITOR_ENGINE_MAP = [[".monaco-editor","Monaco"],[".cm-editor","CodeMirror"],[".CodeMirror","CodeMirror"],[".tox-tinymce","TinyMCE"],[".mce-tinymce","TinyMCE"]]`
- 不退化既有行为：普通 light-DOM 元素的 label/region/checkbox/fromPopup 逻辑不变。
- happy-dom 事实（已实测）：不重定向 `e.target`，但 `composedPath()` 可用且跨 shadow；`closest()` 不跨 shadow 边界——这正是 shadow 测试 RED 的着力点。
- 提交前：`pnpm test`、`pnpm typecheck`、`pnpm build` 全绿。

---

### Task 1: shadow DOM 穿透（composedPath）

**Files:**
- Modify: `src/lib/recording/capture.ts`（加 `realTargetOf`/`closestInPath` helper；`onClick` 改用之）
- Test: `src/lib/recording/capture.integration.test.ts`

**Interfaces:**
- Produces（capture 内联 helper，非导出）：`realTargetOf(e: Event): HTMLElement | null`、`closestInPath(e: Event, el: HTMLElement, selector: string): HTMLElement | null`。

- [ ] **Step 1: 写失败测试**

在 `capture.integration.test.ts` 追加（注意：点击的是嵌在自定义元素 shadow root 里的内层元素，外层 `<button>` 在 light DOM）：

```typescript
  it("pierces shadow DOM to capture the interactive ancestor across the boundary", () => {
    document.body.innerHTML = `<main><button id="b">Save</button></main>`;
    const btn = document.getElementById("b")!;
    const icon = document.createElement("span");
    btn.appendChild(icon);
    const sr = icon.attachShadow({ mode: "open" });
    sr.innerHTML = `<i id="glyph">x</i>`;
    uninstall = installCaptureListener();
    const glyph = sr.getElementById("glyph") as HTMLElement;
    glyph.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));

    expect(captured).toHaveLength(1);
    expect(captured[0]!.payload.type).toBe("click");
    // old code: glyph.closest(INTERACTIVE_SELECTOR) can't cross the shadow
    // boundary → interactive=null → captures the glyph itself (label "元素 'x'"),
    // NOT the button. New code finds the <button> via composedPath.
    expect(captured[0]!.payload.label).toContain("Save");
    uninstall();
  });
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `pnpm test src/lib/recording/capture.integration.test.ts`
Expected: 新测试 FAIL（`captured` 长度为 0——旧码丢弃了该点击）。

- [ ] **Step 3: 实现 helper + 改 onClick**

在 `installCaptureListener` 内、`onClick` 之前加两个 inline helper：

```typescript
  // Shadow-piercing event target resolution. composedPath() crosses shadow
  // boundaries (the page-context Event API; no import needed). Falls back to
  // e.target on engines without composedPath.
  function realTargetOf(e: Event): HTMLElement | null {
    const path = (e.composedPath?.() ?? []) as EventTarget[];
    const first = path[0];
    if (first instanceof HTMLElement) return first;
    const t = e.target;
    return t instanceof HTMLElement ? t : null;
  }
  function closestInPath(e: Event, el: HTMLElement, selector: string): HTMLElement | null {
    const path = (e.composedPath?.() ?? []) as EventTarget[];
    for (const n of path) {
      if (n instanceof HTMLElement && n.matches?.(selector)) return n;
    }
    return el.closest(selector) as HTMLElement | null;
  }
```

`onClick` 开头：把
```typescript
    const target = e.target as HTMLElement | null;
    if (!target?.tagName) return;
```
改为
```typescript
    const target = realTargetOf(e);
    if (!target?.tagName) return;
```
并把
```typescript
    const interactive = target.closest(INTERACTIVE_SELECTOR) as HTMLElement | null;
```
改为
```typescript
    const interactive = closestInPath(e, target, INTERACTIVE_SELECTOR);
```
（`INTERACTIVE_SELECTOR` 常量声明保持原位、原文不动。其余 onClick 逻辑不变。）

- [ ] **Step 4: 跑测试确认 PASS**

Run: `pnpm test src/lib/recording/capture.integration.test.ts`
Expected: PASS（含既有用例不退化）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/recording/capture.ts src/lib/recording/capture.integration.test.ts
git commit -m "feat(recording): pierce shadow DOM in capture via composedPath (#151)"
```

---

### Task 2: editor 识别 + parity 守护

**Files:**
- Modify: `src/lib/recording/capture.ts`（inline `EDITOR_SELECTOR`/`EDITOR_ENGINE_MAP`/`editorEngineOf`；`buildLabelFor` 加 editor 分支）
- Modify: `src/lib/dom-actions/interactive-parity.test.ts`（守护 capture 的 inline 副本）
- Test: `src/lib/recording/capture.integration.test.ts`

**Interfaces:**
- Produces（capture 内联）：`editorEngineOf(el: Element): string | null`（命中 EDITOR_SELECTOR 返回引擎名，否则 null）。

- [ ] **Step 1: 写失败测试（capture.integration.test.ts + parity）**

capture.integration.test.ts 追加：

```typescript
  it("labels a click inside a Monaco editor as the editor engine (stable, not nth)", () => {
    document.body.innerHTML = `<main><div class="monaco-editor"><div class="view-line">const x = 1;</div></div></main>`;
    uninstall = installCaptureListener();
    const line = document.querySelector(".view-line") as HTMLElement;
    line.click();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.payload.label).toBe("Monaco 编辑器");
    expect(captured[0]!.payload.unstable).toBeFalsy();
    uninstall();
  });
```

interactive-parity.test.ts 追加（紧跟现有 `EDITOR_SELECTOR parity in probePageInjected` 块之后）：

```typescript
// ── capture: EDITOR_SELECTOR + EDITOR_ENGINE_MAP parity ──────────────────────
describe("EDITOR_SELECTOR / EDITOR_ENGINE_MAP parity in installCaptureListener", () => {
  const escapedEditorSelector = JSON.stringify(EDITOR_SELECTOR).slice(1, -1);
  it("installCaptureListener inlines the canonical EDITOR_SELECTOR literal", () => {
    expect(installCaptureListener.toString()).toContain(escapedEditorSelector);
  });
  for (const [selector, engine] of EDITOR_ENGINE_MAP) {
    const escapedSelector = JSON.stringify(selector).slice(1, -1);
    it(`installCaptureListener inlines editor host class ${JSON.stringify(selector)}`, () => {
      expect(installCaptureListener.toString()).toContain(escapedSelector);
    });
    it(`installCaptureListener inlines engine name "${engine}"`, () => {
      expect(installCaptureListener.toString()).toContain(engine);
    });
  }
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `pnpm test src/lib/recording/capture.integration.test.ts src/lib/dom-actions/interactive-parity.test.ts`
Expected: FAIL（editor label 测试得到 nth 标签而非「Monaco 编辑器」；parity 测试因 capture 未 inline EDITOR 常量而 FAIL）。

- [ ] **Step 3: 实现 editor 识别**

在 `installCaptureListener` 内、`buildLabelFor` 之前加：

```typescript
  // VERBATIM copy of EDITOR_SELECTOR / EDITOR_ENGINE_MAP from
  // src/lib/dom-actions/_shared/interactive.ts. Cannot import at runtime
  // (executeScript serializes function bodies). interactive-parity.test.ts
  // guards these literals against drift.
  const EDITOR_SELECTOR =
    ".monaco-editor, .cm-editor, .CodeMirror, .tox-tinymce, .mce-tinymce";
  const EDITOR_ENGINE_MAP: Array<[string, string]> = [
    [".monaco-editor", "Monaco"],
    [".cm-editor", "CodeMirror"],
    [".CodeMirror", "CodeMirror"],
    [".tox-tinymce", "TinyMCE"],
    [".mce-tinymce", "TinyMCE"],
  ];
  function editorEngineOf(el: Element): string | null {
    const host = el.closest(EDITOR_SELECTOR);
    if (!host) return null;
    for (const [cls, engine] of EDITOR_ENGINE_MAP) {
      if (host.matches(cls)) return engine;
    }
    return "editor";
  }
```

在 `buildLabelFor` 函数体最前面（`const aria = ...` 之前）加 editor 分支：

```typescript
    const editorEngine = editorEngineOf(el);
    if (editorEngine) {
      return { label: `${editorEngine} 编辑器`, unstable: false };
    }
```

- [ ] **Step 4: 跑测试确认 PASS**

Run: `pnpm test src/lib/recording/capture.integration.test.ts src/lib/dom-actions/interactive-parity.test.ts`
Expected: PASS（含新 parity 守护）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/recording/capture.ts src/lib/dom-actions/interactive-parity.test.ts src/lib/recording/capture.integration.test.ts
git commit -m "feat(recording): recognize Monaco/CodeMirror/TinyMCE editors in capture (#151)"
```

---

### Task 3: 文档更新 + 全量验证

**Files:**
- Modify: `src/lib/recording/capture.ts`（头注限制说明）

- [ ] **Step 1: 更新 capture.ts 头注**

把头注「已知限制」里的这条：
```
 *   - 不处理 shadow DOM 内部元素（v1 不在范围）
```
改为：
```
 *   - shadow DOM：经 composedPath() 穿透取真实目标 + 跨边界找交互祖先
 *   - editor 宿主（Monaco/CodeMirror/TinyMCE）经 EDITOR_SELECTOR 识别（inline + parity）
```

- [ ] **Step 2: 提交文档**

```bash
git add src/lib/recording/capture.ts
git commit -m "docs(recording): update capture header — shadow + editor now handled (#151)"
```

- [ ] **Step 3: 全量验证**

```bash
pnpm test && pnpm typecheck && pnpm build
```
Expected: 全绿。
