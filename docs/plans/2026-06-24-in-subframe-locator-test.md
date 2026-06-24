# in_subframe locator 单测 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** 给 `LOCATE_BY_IDX_FRAGMENT` 的 `inSubframe` 分支（`reason="in_subframe"`）补单测（issue #151 ②），用 happy-dom 伪造 `window.frames`。

**Architecture:** 纯测试新增，零生产代码改动。在 `editor.test.ts` 现有 `LOCATE_BY_IDX_FRAGMENT shadow-aware locator` describe 块内追加 2 条测试。

**Tech Stack:** vitest + happy-dom。

## Global Constraints

- **不改任何生产代码**（`src/lib/dom-actions/_shared/locate.ts` 不动）。
- 测试必须在 `try/finally` 里还原 `window.frames` 原属性描述符，避免污染同文件其它用例（fragment 经 `new Function` 在全局 window 上 eval）。
- 测试代码已 probe 验证可在 happy-dom 跑出 `reason="in_subframe"`。
- 提交前：`pnpm test`、`pnpm typecheck`、`pnpm build` 全绿。

---

### Task 1: 补 in_subframe + frames-without-target 两条测试

**Files:**
- Test: `src/lib/agent/tools/editor.test.ts`

- [ ] **Step 1: 在 `LOCATE_BY_IDX_FRAGMENT shadow-aware locator` describe 块内（"reports not_found for a missing idx (top frame)" 测试之后、describe 闭合 `});` 之前）追加：**

```typescript
  it("reports in_subframe when the element lives in a same-origin child frame", () => {
    document.body.innerHTML = `<div>no target in the top frame</div>`;
    // Build a fake same-origin child frame whose document DOES contain the target.
    const frameDoc = document.implementation.createHTMLDocument("");
    frameDoc.body.innerHTML = `<button data-pie-idx="7">in frame</button>`;
    const fakeFrame = { document: frameDoc, frames: { length: 0 } };
    const orig = Object.getOwnPropertyDescriptor(window, "frames");
    Object.defineProperty(window, "frames", {
      configurable: true,
      value: { length: 1, 0: fakeFrame },
    });
    try {
      const fn = new Function(
        `${LOCATE_BY_IDX_FRAGMENT.replace(/\$\{idx\}/g, "7")} return { found: !!el, reason: _locatorReason };`,
      );
      const out = fn();
      expect(out.found).toBe(false);
      expect(out.reason).toBe("in_subframe");
    } finally {
      if (orig) Object.defineProperty(window, "frames", orig);
      else delete (window as unknown as { frames?: unknown }).frames;
    }
  });

  it("reports not_found when child frames exist but none holds the target", () => {
    document.body.innerHTML = `<div>no target in the top frame</div>`;
    const frameDoc = document.implementation.createHTMLDocument("");
    frameDoc.body.innerHTML = `<button data-pie-idx="999">unrelated</button>`;
    const fakeFrame = { document: frameDoc, frames: { length: 0 } };
    const orig = Object.getOwnPropertyDescriptor(window, "frames");
    Object.defineProperty(window, "frames", {
      configurable: true,
      value: { length: 1, 0: fakeFrame },
    });
    try {
      const fn = new Function(
        `${LOCATE_BY_IDX_FRAGMENT.replace(/\$\{idx\}/g, "7")} return { found: !!el, reason: _locatorReason };`,
      );
      const out = fn();
      expect(out.found).toBe(false);
      expect(out.reason).toBe("not_found");
    } finally {
      if (orig) Object.defineProperty(window, "frames", orig);
      else delete (window as unknown as { frames?: unknown }).frames;
    }
  });
```

- [ ] **Step 2: 跑测试确认通过**

Run: `pnpm test src/lib/agent/tools/editor.test.ts`
Expected: PASS（生产代码 `inSubframe` 已正确，这是补覆盖的回归测试，应直接绿；含既有 found/not_found 测试不变）。

- [ ] **Step 3: 全量验证**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 全绿（纯测试新增，无生产改动）。

- [ ] **Step 4: 提交**

```bash
git add src/lib/agent/tools/editor.test.ts docs/specs/2026-06-24-in-subframe-locator-test.md docs/plans/2026-06-24-in-subframe-locator-test.md
git commit -m "test(locate): cover LOCATE_BY_IDX_FRAGMENT in_subframe branch via faked window.frames (#151)"
```
