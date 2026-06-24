# LOCATE_BY_IDX_FRAGMENT `in_subframe` 分支单测（issue #151 ②）

**日期**: 2026-06-24
**Issue**: WiseriaAI/pie-ai-agent#151 — P2 · feature（第 ② 项：`in_subframe` sentinel 回归测试）
**范围**: 只补 #151 的 **②**。①（capture shadow/editor 归一）已由 PR #218 交付；③（构建期内联）issue 明确暂缓——本 PR 不动。

## 背景与现状

`src/lib/dom-actions/_shared/locate.ts` 的 `LOCATE_BY_IDX_FRAGMENT`（CDP evaluate 字符串）含 `inSubframe(w)` 函数：当目标 `[data-pie-idx=N]` 不在顶层 document、但存在于某子 frame 的 document 时，`_locatorReason` 返回 `"in_subframe"`（区别于 `"not_found"`），让 `read_editor`/`set_editor_value` 对子 frame 编辑器降级报错（"iframe" 提示）。

`editor.test.ts` 的 `describe("LOCATE_BY_IDX_FRAGMENT shadow-aware locator")` 已测 `found`（reason=null）与 `not_found` 两分支，但 **`inSubframe` 函数（→ reason="in_subframe"）当前零覆盖**。issue #151 ② 与原 spec/triage 都判它「happy-dom 无法 fake `window.frames`，只能真机回归」。

## 关键发现：happy-dom 可单测（推翻原假设）

实测（probe）确认：用 `Object.defineProperty(window, "frames", { configurable:true, value:{length:1, 0: fakeFrame} })` + `document.implementation.createHTMLDocument()` 造一个**含目标元素的假子 frame document**，即可驱动 `inSubframe(window)` 在 happy-dom 里返回 true、`_locatorReason === "in_subframe"`。`window.frames` 在 happy-dom 里可 `defineProperty`（probe: `defineOk=true found=false reason=in_subframe`）。故无需真机，可补单测。

## 设计

在 `editor.test.ts` 的 `LOCATE_BY_IDX_FRAGMENT` describe 块内补 1（或 2）条测试：

1. **in_subframe**：顶层 document 无目标；造假 `window.frames=[{document: 含目标的 createHTMLDocument(), frames:{length:0}}]`；eval fragment → `found===false`、`reason==="in_subframe"`。测试用 `try/finally` 还原 `window.frames` 原描述符（避免污染其他测试）。
2. **（可选守护）frames 存在但不含目标**：假 frame 的 document 不含目标 → `reason==="not_found"`（确保不误判 in_subframe）。

不改任何生产代码（`locate.ts` 不动）——纯补测试，关闭覆盖缺口 + 移除「只能真机回归」的认知。

## 验收标准

- 新测试通过；`pnpm test src/lib/agent/tools/editor.test.ts` 绿；全量 `pnpm test` / `pnpm typecheck` / `pnpm build` 全绿。
- `inSubframe` 分支（reason="in_subframe"）有真实单测覆盖，且测试后 `window.frames` 还原、不污染其他用例。

## 排除

- 不改 `locate.ts` 生产代码（行为已正确，只缺测试）。
- #151 ③（方案 B 构建期内联）—— issue/triage 明确暂缓，不做。
