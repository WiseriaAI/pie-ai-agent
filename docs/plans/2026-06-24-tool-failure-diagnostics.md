# Tool-Failure Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `type`/`click` 命中编辑器渲染面 / canvas 时返回可路由的诊断提示，而非笼统失败。

**Architecture:** 改动全部落在 `src/lib/dom-actions/act-core.ts` 一个文件、两处失败/成功返回点；遵循仓库「错误字符串内嵌引导」约定（参照 `read-page.ts` 的 `pdf_tab:` 前缀），不新增类型/字段、不动 loop.ts / prompt.ts（审计见 spec：那些已实现）。

**Tech Stack:** TypeScript、vitest + happy-dom。注入函数须 self-contained（`actByIdxInjected` 经 `executeScript` 注入，不能引外部闭包）。

## Global Constraints

- 注入函数自包含：复用**已在 type op 块内定义**的 `detectEditor`（act-core.ts:139），不 import 外部常量。
- 不退化既有行为：普通非编辑器 `<div>` 的 `type` 仍返回原 generic「not typeable」消息；普通元素 `click` observation 不变。
- 提交前：`pnpm test src/lib/dom-actions/act-core.test.ts`、`pnpm typecheck`、`pnpm build` 全绿。

---

### Task 1: type 命中编辑器/canvas 渲染面时给出工具路由提示

**Files:**
- Modify: `src/lib/dom-actions/act-core.ts:192-196`（type 的 `!isInputOrTextarea && !isContentEditable` 早返回分支）
- Test: `src/lib/dom-actions/act-core.test.ts`（`describe("actByIdxInjected op=type")` 内追加）

**Interfaces:**
- Consumes: `detectEditor(el: Element): string | null`（已定义于 act-core.ts:139，与本分支同作用域）；`tag`（已于 act-core.ts:186 计算，值为 `el.tagName.toLowerCase()`）。
- Produces: 无新导出；仅改 `ActResult.error` 文案。

- [ ] **Step 1: 写失败测试（编辑器 div + canvas，并守护不退化）**

在 `act-core.test.ts` 的 `describe("actByIdxInjected op=type")` 块内追加：

```typescript
it("routes a type aimed at a Monaco editor surface (non-typeable div) to the editor tools", async () => {
  document.body.innerHTML = `
    <div class="monaco-editor">
      <div class="view-line" data-pie-idx="20">const x = 1;</div>
    </div>`;
  const r = await actByIdxInjected({ op: "type", idx: 20, text: "y", clear: false });
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("narrow");
  expect(r.error).toContain("Monaco");
  expect(r.error).toMatch(/read_editor|dispatch_keyboard_input/);
});

it("routes a type aimed at a bare <canvas> to screenshot + keyboard tools", async () => {
  document.body.innerHTML = `<canvas data-pie-idx="21"></canvas>`;
  const r = await actByIdxInjected({ op: "type", idx: 21, text: "y", clear: false });
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("narrow");
  expect(r.error).toMatch(/canvas/i);
  expect(r.error).toMatch(/dispatch_keyboard_input|screenshot|vision/);
});

it("keeps the generic not-typeable message for a plain non-editor element", async () => {
  document.body.innerHTML = `<p data-pie-idx="22">just text</p>`;
  const r = await actByIdxInjected({ op: "type", idx: 22, text: "y", clear: false });
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("narrow");
  expect(r.error).toMatch(/not typeable/i);
  expect(r.error).not.toMatch(/dispatch_keyboard_input/);
});
```

- [ ] **Step 2: 跑测试确认前两条 FAIL**

Run: `pnpm test src/lib/dom-actions/act-core.test.ts`
Expected: 前两条新测试 FAIL（当前只返回 generic「not typeable」，不含 Monaco/canvas 引导）；第三条 PASS（守护）。

- [ ] **Step 3: 实现——把单一 message 拆为三态**

在 `act-core.ts` 把行 192-196 的分支替换为：

```typescript
if (!isInputOrTextarea && !isContentEditable) {
  if (tag === "canvas") {
    return {
      ok: false,
      error: `Element [${index}] is a <canvas> — canvas surfaces have no DOM text, so 'type' can't work. Read it via screenshot + vision, and write via dispatch_keyboard_input after clicking to focus.`,
    };
  }
  const surfaceEditor = detectEditor(el);
  if (surfaceEditor) {
    return {
      ok: false,
      error: `Element [${index}] is a <${tag}> inside a ${surfaceEditor} editor surface, which is not directly typeable. For code editors (Monaco / CodeMirror) use read_editor / set_editor_value; otherwise use dispatch_keyboard_input — do not use 'type' here.`,
    };
  }
  return {
    ok: false,
    error: `Element [${index}] is a <${tag}> which is not typeable (expected input, textarea, or contenteditable).`,
  };
}
```

- [ ] **Step 4: 跑测试确认三条全 PASS**

Run: `pnpm test src/lib/dom-actions/act-core.test.ts`
Expected: PASS（含既有 Monaco IME buffer 测试不受影响——那条 type 的是 `<textarea>`，走 input 分支，不进本早返回）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/dom-actions/act-core.ts src/lib/dom-actions/act-core.test.ts
git commit -m "feat(dom-actions): route type-on-editor/canvas surfaces to the right tool (#127)"
```

---

### Task 2: 合成点击 canvas 时附 advisory 注记

**Files:**
- Modify: `src/lib/dom-actions/act-core.ts:491-492`（合成 click 成功返回）
- Test: `src/lib/dom-actions/act-core.test.ts`（`describe("actByIdxInjected op=click")` 内追加）

**Interfaces:**
- Consumes: `el`（已解析的目标元素）。
- Produces: 无新导出；click 成功 observation 文案在 canvas 时追加注记，其余不变（仍 `ok: true`）。

- [ ] **Step 1: 写测试（canvas 附注 + 普通元素不变）**

在 `act-core.test.ts` 的 `describe("actByIdxInjected op=click")` 块内追加：

```typescript
it("appends a canvas advisory when clicking a <canvas> element", async () => {
  document.body.innerHTML = `<canvas data-pie-idx="30"></canvas>`;
  const r = await actByIdxInjected({ op: "click", idx: 30 });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("narrow");
  if (r.op !== "click") throw new Error("narrow op");
  expect(r.observation).toContain("Clicked element [30]");
  expect(r.observation).toMatch(/canvas/i);
});

it("does not append the canvas advisory for a normal element", async () => {
  document.body.innerHTML = `<button data-pie-idx="31">Go</button>`;
  const r = await actByIdxInjected({ op: "click", idx: 31 });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("narrow");
  if (r.op !== "click") throw new Error("narrow op");
  expect(r.observation).not.toMatch(/canvas/i);
});
```

- [ ] **Step 2: 跑测试确认第一条 FAIL**

Run: `pnpm test src/lib/dom-actions/act-core.test.ts`
Expected: 第一条 FAIL（当前 observation 只有「Clicked element [30]」无 canvas 注记）；第二条 PASS（守护）。

- [ ] **Step 3: 实现——canvas 时追加注记**

把 `act-core.ts` 行 491-492 的：

```typescript
    (el as HTMLElement).click();
    return { ok: true, op: "click", observation: `Clicked element [${params.idx}]` };
```

替换为：

```typescript
    (el as HTMLElement).click();
    const canvasNote =
      el.tagName === "CANVAS"
        ? ` (Note: this is a <canvas> — its content isn't standard DOM; if nothing happened, read it via screenshot + vision and interact via the keyboard tools.)`
        : "";
    return { ok: true, op: "click", observation: `Clicked element [${params.idx}]${canvasNote}` };
```

- [ ] **Step 4: 跑测试确认两条全 PASS**

Run: `pnpm test src/lib/dom-actions/act-core.test.ts`
Expected: PASS（既有 click 测试 observation 仍含「Clicked element [3]」，不受影响）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/dom-actions/act-core.ts src/lib/dom-actions/act-core.test.ts
git commit -m "feat(dom-actions): flag canvas clicks with a vision/keyboard advisory (#127)"
```

---

### Task 3: 全量验证

- [ ] **Step 1: 跑全量测试 + typecheck + build**

```bash
pnpm test && pnpm typecheck && pnpm build
```
Expected: 全绿（注入函数仍 self-contained，build 不变量不 throw）。

- [ ] **Step 2: 若全绿，无需额外提交（前两 task 已各自提交）**
