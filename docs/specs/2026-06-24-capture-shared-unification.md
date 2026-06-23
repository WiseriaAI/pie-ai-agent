# Recording capture 归一：shadow DOM 穿透 + editor 识别（issue #151 ①）

**日期**: 2026-06-24
**Issue**: WiseriaAI/pie-ai-agent#151 — P2 · feature（page-probe-core-unification 的 follow-up）
**范围**: 只做 issue 的 **①**（capture shadow DOM 穿透 + editor 识别，复用 `_shared/` 权威常量）。②③ 见末尾「明确排除」。

## 现状（勘察结论）

`src/lib/recording/capture.ts` 的 `installCaptureListener` 是 **self-contained 注入函数**（`recording-orchestrator.ts:163` 用 `func: installCaptureListener` 经 `executeScript` 序列化注入）——**不能 runtime import**（只能 `import type`）。因此归一方式只能是 **inline 逐字复制权威常量 + parity 测试**（一如现有 `WRAPPER_TAGS_LIST` / `INTERACTIVE_SELECTOR` 的做法，`interactive-parity.test.ts` 已守 `installCaptureListener`）。

已归一的部分（**不重做**）：
- `INTERACTIVE_SELECTOR` 已 inline 逐字复制（capture.ts:248）+ parity 守护（interactive-parity.test.ts:40-47）。
- `WRAPPER_TAGS_LIST` 18 项已 inline 完整（capture.ts:73-92）。
- `selector.ts describeElement` 已复用 `_shared/interactive.ts` 的 `ROLE_TO_CN`/`TAG_TO_CN`；与 capture `buildLabelFor` 已维持字符级 parity（capture.ts 头注 + parity 测试）。

真正缺口（capture.ts 头注第 12-14 行自陈「不处理 shadow DOM 内部元素 v1 不在范围」）：
1. **shadow DOM 穿透缺失**：`onClick`/`onChange` 用 `e.target`，对 shadow 组件会被**事件重定向**到 shadow host，拿不到内部真实元素；`target.closest(INTERACTIVE_SELECTOR)` 也不跨 shadow 边界。→ 录到的是宿主、label 错。
2. **editor 识别缺失**：无 `EDITOR_SELECTOR` 判断，点 Monaco/CodeMirror/TinyMCE 时录到的是虚拟化内部 div，label 退化成 unstable 的 `${region} 第 N 个元素`。

## 设计

全部改动在 `capture.ts`（+ parity 测试 + 集成测试），均 self-contained、无 runtime import。

### (a) shadow DOM 穿透 —— 用 `e.composedPath()`

注入上下文原生可用 `Event.prototype.composedPath()`（无需 import），它天然穿透 shadow 边界，返回 `[最内层真实目标, …祖先(跨 shadow)…, host, …, document, window]`。

新增内联 helper：
```ts
function realTargetOf(e: Event): HTMLElement | null {
  const path = e.composedPath?.() ?? [];
  const first = path[0];
  if (first instanceof HTMLElement) return first;            // shadow-pierced 真实目标
  return (e.target as HTMLElement) ?? null;                  // 老环境兜底
}
function closestInPath(e: Event, el: HTMLElement, selector: string): HTMLElement | null {
  const path = e.composedPath?.() ?? [];
  for (const n of path) {                                     // path 已是 target→…→document 的祖先链(跨 shadow)
    if (n instanceof HTMLElement && n.matches?.(selector)) return n;
  }
  return el.closest(selector) as HTMLElement | null;          // composedPath 不可用时兜底
}
```
**只 patch composed 事件的 handler**（这是关键修正）：`composedPath()` 只对**逃逸 shadow 边界的 composed 事件**有意义。
- `click`（composed）→ `onClick`：把 `const target = e.target` 改为 `realTargetOf(e)`，`target.closest(INTERACTIVE_SELECTOR)` 改为 `closestInPath(e, target, INTERACTIVE_SELECTOR)`。
- `input`（composed）→ `onInput`：把 `e.target` 改为 `realTargetOf(e)`、`t.closest('[contenteditable="true"]')` 改为 `closestInPath(...)`。
- **`change` / `submit`（non-composed）→ 不 patch**：实测确认（happy-dom + DOM 规范）non-composed 事件**根本不逃逸 shadow 边界**——shadow 内 input 的 change 事件压根不会触达 document 上的 capture listener，给它加 `realTargetOf` 是死功（handler 不会被调）。捕获 shadow 封装内的 form change 是另一个独立限制，不在本切片。`onChange` 头加注释说明。
- `onKeydown` 不解析元素（只记按键组合），无可穿透目标，不动。

其余逻辑（label/region/checkbox/fromPopup）不变。

### (b) editor 识别 —— inline `EDITOR_SELECTOR` + `EDITOR_ENGINE_MAP`

逐字复制权威常量（来自 `_shared/interactive.ts:58-73`）：
```ts
const EDITOR_SELECTOR = ".monaco-editor, .cm-editor, .CodeMirror, .tox-tinymce, .mce-tinymce";
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
  for (const [cls, engine] of EDITOR_ENGINE_MAP) if (host.matches(cls)) return engine;
  return "editor";
}
```
在 `buildLabelFor` 开头加分支：若 `editorEngineOf(el)` 命中，直接返回 `{ label: "${engine} 编辑器", unstable: false }`（无 selectorHint）。这样 Monaco/CM/TinyMCE 录成稳定的 editor 标签，而非内部虚拟化 div 的 unstable nth。（editor 宿主一般不在 shadow 内，`closest(EDITOR_SELECTOR)` 足够。）

### (c) parity 守护

`interactive-parity.test.ts` 扩展：把现有「probePageInjected inlines EDITOR_SELECTOR / EDITOR_ENGINE_MAP」的守护对 `installCaptureListener` 也加一份（同 `fn.toString()` + JSON-escape 技法），防 capture 的 inline 副本与权威源漂移。

### (d) 文档

更新 `capture.ts` 头注：删「不处理 shadow DOM 内部元素 v1 不在范围」限制，改注「shadow DOM 经 composedPath 穿透；editor 宿主经 EDITOR_SELECTOR 识别（inline + parity）」。

## 测试（capture.integration.test.ts 追加）

- **shadow**：在 open shadow root 里放 `<button>Inner</button>`，对内部 button 派发 `composed:true` 的 click → 捕获的 label 反映内部 button（含其文本），而非宿主。
- **editor**：点击 `.monaco-editor` 内的元素 → 捕获 label 为 `Monaco 编辑器`、`unstable` 不置位（守护：不再是 `第 N 个元素`）。
- **不退化**：普通 light-DOM button 点击的 label 与原行为一致。

## 验收标准

- 上述测试通过；`interactive-parity` 扩展守护通过；`pnpm test` / `pnpm typecheck` / `pnpm build` 全绿。
- capture 内联的 EDITOR_SELECTOR / EDITOR_ENGINE_MAP 与 `_shared/interactive.ts` 逐字一致（parity 守护）。

## 明确排除（YAGNI / 环境限制）

- **describeElement / buildLabelFor 的深度语义合并到统一权威层**（issue 第二条）：二者已字符级 parity（现有测试守护），抽共享语义层是更大重构、用户价值低、属 issue 所述「方案 B」升级点——本切片不做，留后续。
- **② `in_subframe` sentinel 真机回归测试**：happy-dom 无法 fake `window.frames`，本就是 `it.skip` + 真机回归注释，非 happy-dom 可测——保持现状。
- **③ 方案 B（构建期 vite transform 内联）**：issue 与 triage 均判「复制面未继续扩大、暂缓」——不做。
