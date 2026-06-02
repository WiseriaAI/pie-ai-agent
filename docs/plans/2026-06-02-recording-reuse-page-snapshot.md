# 录制 capture 复用 page-snapshot 采集基础设施 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让录制 capture 复用 page-snapshot 的元素采集判定（`INTERACTIVE_SELECTOR`/`isVisible`/状态反射/中文 kind 映射），修复 div/自定义组件点击、复选框勾选态、contenteditable 富文本漏录，并补键盘最小集；回放架构（LLM 重新理解着回放）完全不变。

**Architecture:** 抽 `src/lib/dom-actions/_shared/interactive.ts` 作单一权威源；三个 self-contained 注入函数（`page-snapshot`/`search-page`/`capture`）因不能 import 仍内联镜像，用 parity 测试守住不漂移。capture 扩触发口径 + 新监听器，新字段经 orchestrator 的 `{...payload}` 自动透传，`serialize` 渲染新步骤并在 header 提示词暴露 `press_key`/`hover`。

**Tech Stack:** TypeScript 6 · vitest + happy-dom · chrome.scripting.executeScript 注入模式 · pnpm。

---

## 背景：实施者必读的代码事实

执行前先读这几处，建立心智：

- **注入约束**：`page-snapshot.ts:13-22`、`search-page.ts:29-38`、`capture.ts:1-24` 都声明 self-contained——经 `executeScript` 序列化函数体注入页面，**禁止 import / 禁止 outer-scope 引用**。所以"复用"= 单一权威源（模块侧 import）+ 注入侧内联镜像 + parity 测试。TS `interface`/类型注解编译期擦除，可跨用；`const` 值不擦除，必须内联。
- **描述逻辑双份结构**：`selector.ts` 的 `describeElement`（纯函数，权威）↔ `capture.ts` 的 `buildLabelFor`（注入态镜像），由 `capture.integration.test.ts:123` 的 PARITY 测试逐字守。
- **现有 parity 范式**：`search-page.test.ts:155` 的 "search_page ↔ read_page idx parity" 用**行为对比**（同 DOM 盖出同 idx 映射）守 `page-snapshot`↔`search-page` 的 `INTERACTIVE_SELECTOR`/`isVisible`/`walkDeep` verbatim 拷贝。
- **orchestrator 自动透传**：`recording-orchestrator.ts:183-186` 是 `{ ...msg.payload, timestamp }`，新增 payload 字段（`checked`）自动进 `actions[]`，**本计划不改 orchestrator**。
- **死代码警告**：2026-05-05 reframe 后，`handleRecordingFinish:254` 只消费 `serialized.promptTemplate`；`serialized.allowedTools` 与 `serialized.parameters` **被丢弃**，且全仓无任何运行时点用 skill 的 `allowedTools` 硬过滤工具。**回放期能用哪些工具，取决于 `STEP_TEMPLATES.header` 提示词文本**（`serialize.ts:20-21` 现写 "click / type / scroll / open_url"）。本计划仍维护 `allowedTools` 输出以保持函数自洽 + 测试，但**新工具的真正暴露靠改 header 文本**。
- **capture 注入只在顶 frame**：`recording-orchestrator.ts:162` `allFrames: false`（既有限制，本计划不动）。
- **capture phase 时序**：capture 的监听器是 `addEventListener(..., true)` 捕获阶段，**先于**页面自身的 bubble 阶段 handler 执行。所以读"自定义组件点击后的状态"必须延迟到页面 handler 跑完之后（见 Task 7 的 `setTimeout(0)`）。

每个 Task 末尾的提交信息按仓库习惯结尾加：
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

## File Structure

- **新增** `src/lib/dom-actions/_shared/interactive.ts` — 权威源：`INTERACTIVE_SELECTOR`（单一字符串字面量）、`isVisible`、`ROLE_TO_CN`、`TAG_TO_CN`。模块侧消费方 = `selector.ts` + 测试。
- **新增** `src/lib/dom-actions/_shared/interactive.test.ts` — 模块导出冒烟测试。
- **新增** `src/lib/dom-actions/interactive-parity.test.ts` — 三注入函数内联副本含权威 `INTERACTIVE_SELECTOR` 字面量的 parity 守卫。
- **改** `src/lib/dom-actions/page-snapshot.ts` — `INTERACTIVE_SELECTOR` 改为内联权威字面量（行为不变）。
- **改** `src/lib/dom-actions/search-page.ts` — 同上。
- **改** `src/lib/recording/selector.ts` — `ROLE_TO_CN`/`TAG_TO_CN` 改为从权威源 import（行为不变）。
- **改** `src/lib/recording/types.ts` — `RecordedActionType` 加 `"keypress"`；`RecordedAction`/`CapturedActionPayload` 加 `checked?: boolean`。
- **改** `src/lib/recording/serialize.ts` — header 暴露 `press_key`/`hover`；`click` 按 `checked` 渲染勾选；`keypress` 模板 + `ACTION_TO_TOOL` 条目 + `hover` 进 baseline。
- **改** `src/lib/recording/capture.ts` — onClick 用权威 `INTERACTIVE_SELECTOR`；checkbox/radio 勾选态；contenteditable input 防抖；keydown 最小集。
- **改测试** `src/lib/recording/serialize.test.ts`、`src/lib/recording/capture.integration.test.ts`。

**不在本计划**（spec 已标 best-effort / 非目标）：canvas 编辑器（飞书/Docs）精确或粗粒度文本采集、拖拽采集与 drag 回放工具、整页前后快照、确定性机械回放。canvas 的粗粒度 marker 作为后续可选项，见文末"Deferred"。

---

### Task 1: 权威源 `_shared/interactive.ts`

**Files:**
- Create: `src/lib/dom-actions/_shared/interactive.ts`
- Test: `src/lib/dom-actions/_shared/interactive.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/dom-actions/_shared/interactive.test.ts
import { describe, it, expect } from "vitest";
import {
  INTERACTIVE_SELECTOR,
  isVisible,
  ROLE_TO_CN,
  TAG_TO_CN,
} from "./interactive";

describe("_shared/interactive", () => {
  it("INTERACTIVE_SELECTOR 是单一字符串且覆盖 page-snapshot 口径", () => {
    expect(typeof INTERACTIVE_SELECTOR).toBe("string");
    for (const needle of [
      "a", "button", "input", "select", "textarea",
      '[role="button"]', '[role="checkbox"]', '[role="switch"]',
      '[contenteditable="true"]', "summary", "[onclick]",
      "[tabindex]:not([tabindex='-1'])",
    ]) {
      expect(INTERACTIVE_SELECTOR).toContain(needle);
    }
  });

  it("isVisible 对 0 尺寸元素返回 false", () => {
    document.body.innerHTML = `<button style="display:none">x</button>`;
    const el = document.querySelector("button")!;
    expect(isVisible(el)).toBe(false);
  });

  it("kind 映射含中文", () => {
    expect(ROLE_TO_CN.checkbox).toBe("复选框");
    expect(TAG_TO_CN.button).toBe("按钮");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/dom-actions/_shared/interactive.test.ts`
Expected: FAIL — 模块不存在 / 无法解析 `./interactive`。

- [ ] **Step 3: 写权威源**

> 注意 `INTERACTIVE_SELECTOR` **必须是单行单一字符串字面量**（不是 `[...].join()`），这样 Task 3 的 parity 测试能用 `fn.toString().includes(...)` 在注入函数源码里匹配同一字面量。该字符串内容与 `page-snapshot.ts:64-70` 数组 join 后的结果逐字一致。

```ts
// src/lib/dom-actions/_shared/interactive.ts
/**
 * Canonical source for "what counts as an interactive element" + visibility +
 * Chinese element-kind maps. Shared across the injected snapshot/search/capture
 * functions.
 *
 * Injected functions (pageSnapshotInjected / searchPageInjected /
 * installCaptureListener) CANNOT import this at runtime — executeScript
 * serializes their bodies. They inline a VERBATIM copy of INTERACTIVE_SELECTOR
 * (single string literal) and isVisible; interactive-parity.test.ts asserts the
 * inlined literal matches this source. Module-side consumers (selector.ts,
 * tests) import directly.
 */

// Single-string literal (NOT array.join) so source-text parity checks can match
// the exact same literal inlined into each injected function. Content equals the
// joined form of page-snapshot.ts INTERACTIVE_SELECTOR, verbatim.
export const INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [contenteditable="true"], summary, [onclick], [tabindex]:not([tabindex=\'-1\'])';

/** Mirrors page-snapshot.ts isVisible exactly. */
export function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (parseFloat(style.opacity) === 0) return false;
  const tag = el.tagName.toLowerCase();
  if ((tag === "input" || tag === "textarea") && (rect.width < 8 || rect.height < 8)) {
    return false;
  }
  if (style.position !== "fixed" && (el as HTMLElement).offsetParent === null) return false;
  return true;
}

export const ROLE_TO_CN: Record<string, string> = {
  button: "按钮",
  link: "链接",
  tab: "标签页",
  checkbox: "复选框",
  radio: "单选框",
  switch: "开关",
  menuitem: "菜单项",
  option: "下拉选项",
};

export const TAG_TO_CN: Record<string, string> = {
  a: "链接",
  button: "按钮",
  input: "输入框",
  textarea: "文本框",
  select: "下拉框",
  summary: "折叠标签",
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/dom-actions/_shared/interactive.test.ts`
Expected: PASS（3 个用例）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/dom-actions/_shared/interactive.ts src/lib/dom-actions/_shared/interactive.test.ts
git commit -m "feat(dom-actions): add canonical _shared/interactive source

INTERACTIVE_SELECTOR (single-string literal) + isVisible + zh kind maps,
to be reused by the snapshot/search/capture injected functions.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `selector.ts` 复用共享 kind 映射

**Files:**
- Modify: `src/lib/recording/selector.ts:39-57`（删除本地 `ROLE_TO_CN`/`TAG_TO_CN`，改 import）

- [ ] **Step 1: 先跑既有测试确认绿（基线）**

Run: `pnpm test src/lib/recording/selector.test.ts`
Expected: PASS（既有用例）。这是行为不变重构，作为安全网。

- [ ] **Step 2: 改 selector.ts import 共享映射**

删除 `selector.ts:39-57` 的两个本地常量定义：
```ts
const ROLE_TO_CN: Record<string, string> = { ... };  // 删除
const TAG_TO_CN: Record<string, string> = { ... };   // 删除
```
在文件顶部 import 区（`selector.ts:1-11` 注释块之后）加：
```ts
import { ROLE_TO_CN, TAG_TO_CN } from "@/lib/dom-actions/_shared/interactive";
```
`REGION_TO_CN`（`selector.ts:59-66`）**保留**在 selector.ts（录制专用，page-snapshot 无此概念）。`elementKindCn`（`selector.ts:93-101`）函数体不变，继续引用现在 import 进来的 `ROLE_TO_CN`/`TAG_TO_CN`。

- [ ] **Step 3: 跑测试确认仍通过**

Run: `pnpm test src/lib/recording/selector.test.ts && pnpm test src/lib/recording/capture.integration.test.ts`
Expected: PASS——describeElement 输出逐字不变，capture↔selector parity 测试仍绿。

- [ ] **Step 4: typecheck**

Run: `pnpm typecheck`
Expected: 0 errors。

- [ ] **Step 5: 提交**

```bash
git add src/lib/recording/selector.ts
git commit -m "refactor(recording): selector imports shared zh kind maps

Behavior-preserving; describeElement output unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: page-snapshot / search-page 内联权威 selector + 三方 parity 守卫

**Files:**
- Modify: `src/lib/dom-actions/page-snapshot.ts:64-70`
- Modify: `src/lib/dom-actions/search-page.ts:47-53`
- Create: `src/lib/dom-actions/interactive-parity.test.ts`

- [ ] **Step 1: 写失败的 parity 测试**

```ts
// src/lib/dom-actions/interactive-parity.test.ts
/**
 * Guards that the three self-contained injected functions inline the SAME
 * INTERACTIVE_SELECTOR string literal as the canonical _shared source. They
 * cannot import it (executeScript serializes their bodies), so drift is caught
 * here via source-text inspection of Function.prototype.toString().
 */
import { describe, it, expect } from "vitest";
import { INTERACTIVE_SELECTOR } from "./_shared/interactive";
import { pageSnapshotInjected } from "./page-snapshot";
import { searchPageInjected } from "./search-page";
import { installCaptureListener } from "@/lib/recording/capture";

describe("INTERACTIVE_SELECTOR parity across injected functions", () => {
  for (const [name, fn] of [
    ["pageSnapshotInjected", pageSnapshotInjected],
    ["searchPageInjected", searchPageInjected],
    ["installCaptureListener", installCaptureListener],
  ] as const) {
    it(`${name} inlines the canonical INTERACTIVE_SELECTOR literal`, () => {
      expect(fn.toString()).toContain(INTERACTIVE_SELECTOR);
    });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/dom-actions/interactive-parity.test.ts`
Expected: FAIL——三个注入函数当前用的是 `[...].join(", ")` 数组形式或 ad-hoc 列表，源码里不含该单一字面量。

- [ ] **Step 3: page-snapshot.ts 改为内联权威字面量**

把 `page-snapshot.ts:64-70`：
```ts
  const INTERACTIVE_SELECTOR = [
    "a", "button", "input", "select", "textarea",
    '[role="button"]', '[role="link"]', '[role="tab"]',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
    '[role="menuitem"]', '[contenteditable="true"]',
    "summary", "[onclick]", "[tabindex]:not([tabindex='-1'])",
  ].join(", ");
```
替换为（与 `_shared/interactive.ts` 逐字一致的单行字面量；保留行内注释指向权威源）：
```ts
  // VERBATIM copy of _shared/interactive.ts INTERACTIVE_SELECTOR (single string
  // literal). interactive-parity.test.ts guards this against drift.
  const INTERACTIVE_SELECTOR =
    'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [contenteditable="true"], summary, [onclick], [tabindex]:not([tabindex=\'-1\'])';
```

- [ ] **Step 4: search-page.ts 同样替换**

把 `search-page.ts:47-53` 的数组 join 形式替换为与 Step 3 完全相同的单行字面量 + 同一注释。

- [ ] **Step 5: 跑 parity + 既有行为测试**

Run: `pnpm test src/lib/dom-actions/interactive-parity.test.ts src/lib/dom-actions/search-page.test.ts`
Expected: PASS——parity 测试（page-snapshot + search-page 两项）通过；`search-page.test.ts:155` 的 idx 行为 parity 仍绿（字符串逻辑等价）。`installCaptureListener` 那项**仍 FAIL**（capture 还没改，留待 Task 6 转绿）——本步只验证 snapshot/search 两项；执行 Task 6 后整套转绿。

> 实施提示：若希望 Task 3 提交时全套绿，可把 Task 6 的 onClick selector 改动一并纳入本次；本计划为保持单一职责，分开提交，并在此显式标注 capture 项暂红，Task 6 收口。

- [ ] **Step 6: typecheck + 提交**

Run: `pnpm typecheck`（Expected: 0 errors）
```bash
git add src/lib/dom-actions/page-snapshot.ts src/lib/dom-actions/search-page.ts src/lib/dom-actions/interactive-parity.test.ts
git commit -m "refactor(dom-actions): inline canonical INTERACTIVE_SELECTOR + parity guard

page-snapshot/search-page now inline the _shared literal verbatim; new
interactive-parity.test.ts catches drift. capture covered in a later task.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 数据模型扩字段（`types.ts`）

**Files:**
- Modify: `src/lib/recording/types.ts:7-13`（类型 union）、`:20-43`（RecordedAction）、`:69-79`（CapturedActionPayload）

- [ ] **Step 1: 改类型 union 加 `keypress`**

`types.ts:7-13`：
```ts
export type RecordedActionType =
  | "click"
  | "type"
  | "select"
  | "scroll"
  | "navigate"
  | "submit"
  | "keypress";
```

- [ ] **Step 2: RecordedAction 加 `checked?`**

在 `RecordedAction`（`types.ts:20-43`）`unstable?` 字段之后、`timestamp` 之前插入：
```ts
  /** checkbox/radio/switch 勾选后的最终状态。仅 type==="click" 且目标是可勾选
   *  元素时出现；serialize 据此渲染「勾选/取消勾选」。 */
  checked?: boolean;
```

- [ ] **Step 3: CapturedActionPayload 加 `checked?`**

在 `CapturedActionPayload`（`types.ts:69-79`）`unstable?` 之后插入同一字段：
```ts
  checked?: boolean;
```

> keypress 的键名复用既有 `value` 字段（如 `"Enter"`/`"Ctrl+K"`），不新增字段。

- [ ] **Step 4: typecheck**

Run: `pnpm typecheck`
Expected: FAIL——`serialize.ts:35` 的 `ACTION_TO_TOOL: Record<RecordedAction["type"], string | null>` 现在缺 `keypress` 键。这是预期的，Task 5 补上。

> 本 Task 是纯类型扩展，单独跑 typecheck 会因 ACTION_TO_TOOL 缺键而红——这正是驱动 Task 5 的信号。可与 Task 5 连续执行后再整体 typecheck；为保持 commit 粒度，此处先提交类型变更（编译红由下一 Task 立即修复）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/recording/types.ts
git commit -m "feat(recording): add keypress action type + checked field

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 序列化新步骤（`serialize.ts`）

**Files:**
- Modify: `src/lib/recording/serialize.ts:19-42`（templates + tool map）、`:79-103`（switch 渲染）
- Test: `src/lib/recording/serialize.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `serialize.test.ts` 的 `describe("serialize", ...)` 内（复用文件顶部已有的 `action(partial)` helper）：
```ts
  it("renders checkbox check/uncheck instead of a generic click", () => {
    const checked = serialize([action({ type: "click", label: "复选框 '同意条款'", checked: true })]);
    expect(checked.promptTemplate).toContain("第 1 步：勾选复选框 '同意条款'");
    const unchecked = serialize([action({ type: "click", label: "复选框 '订阅'", checked: false })]);
    expect(unchecked.promptTemplate).toContain("第 1 步：取消勾选复选框 '订阅'");
  });

  it("renders a keypress step and maps it to press_key", () => {
    const r = serialize([action({ type: "keypress", label: "", value: "Enter" })]);
    expect(r.promptTemplate).toContain("第 1 步：按 Enter 键");
    expect(r.allowedTools).toContain("press_key");
  });

  it("header advertises press_key and hover to the replay LLM", () => {
    const r = serialize([action({ type: "click", label: "按钮 'X'" })]);
    expect(r.promptTemplate).toContain("press_key");
    expect(r.promptTemplate).toContain("hover");
  });

  it("hover is in baseline allowedTools", () => {
    expect(serialize([]).allowedTools).toContain("hover");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/recording/serialize.test.ts`
Expected: FAIL——checkbox 渲成"点击"、无 keypress 模板、header 不含 press_key/hover、baseline 无 hover。

- [ ] **Step 3: 改 header 提示词暴露新工具**

`serialize.ts:20-21` `header` 改为：
```ts
  header:
    "你是回放一段用户已演示过的网页操作流程。请按以下步骤逐步执行，每步先 snapshot 页面，再用 click / type / scroll / open_url / press_key / hover 工具操作匹配到的元素（按 Enter 或快捷键用 press_key；菜单需悬停展开时用 hover）。完成后调用 done；遇到无法继续的情况调用 fail。\n\n",
```

- [ ] **Step 4: 加 keypress 模板**

在 `STEP_TEMPLATES`（`serialize.ts:19-33`）的 `navigate` 之后加一行：
```ts
  keypress: (n: number, key: string) => `第 ${n} 步：按 ${key} 键。`,
```

- [ ] **Step 5: ACTION_TO_TOOL 补 keypress + baseline 加 hover**

`serialize.ts:35-42` 的 `ACTION_TO_TOOL` 加键（修复 Task 4 引入的 typecheck 红）：
```ts
  keypress: "press_key",
```
`serialize.ts:61` baseline tools 集合加 `hover`：
```ts
  const tools = new Set<string>(["scroll", "hover", "done", "fail"]);
```
以及空 actions 分支 `serialize.ts:67`：
```ts
      allowedTools: ["done", "fail", "hover", "scroll"],
```
> 注意空分支数组最终会被使用方按 sorted 比较——已有空用例 `serialize.test.ts:22` 断言 `["done", "fail", "scroll"]`，需同步更新为 `["done", "fail", "hover", "scroll"]`（字母序）。在 Step 1 已新增 baseline-hover 用例，但旧的空用例也要改：把 `serialize.test.ts` 中 `expect(r.allowedTools).toEqual(["done", "fail", "scroll"])` 改为 `["done", "fail", "hover", "scroll"]`。

- [ ] **Step 6: click 分支按 checked 渲染**

`serialize.ts:80-86` 的 switch，把 `case "click"` 改为：
```ts
      case "click":
        line =
          action.checked === undefined
            ? STEP_TEMPLATES.click(stepN, safeLabel)
            : action.checked
              ? `第 ${stepN} 步：勾选${safeLabel}。`
              : `第 ${stepN} 步：取消勾选${safeLabel}。`;
        break;
```
并在 switch 内 `case "navigate"` 之后加 keypress 分支：
```ts
      case "keypress":
        line = STEP_TEMPLATES.keypress(stepN, escapeUntrustedWrappers(action.value ?? ""));
        break;
```

- [ ] **Step 7: 跑测试确认通过 + typecheck**

Run: `pnpm test src/lib/recording/serialize.test.ts && pnpm typecheck`
Expected: PASS + 0 errors（Task 4 的 union 现已被 ACTION_TO_TOOL/switch 完整覆盖）。

- [ ] **Step 8: 提交**

```bash
git add src/lib/recording/serialize.ts src/lib/recording/serialize.test.ts
git commit -m "feat(recording): serialize checkbox toggle + keypress, advertise press_key/hover

Header tool list (the only consumed replay-capability lever post-reframe)
now lists press_key/hover; checkbox clicks render 勾选/取消勾选.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: capture onClick 用权威 INTERACTIVE_SELECTOR（div/自定义点击）

**Files:**
- Modify: `src/lib/recording/capture.ts:218-234`（onClick）
- Test: `src/lib/recording/capture.integration.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `capture.integration.test.ts` 的 describe 内：
```ts
  it("captures a div[onclick] custom control as a click", () => {
    document.body.innerHTML = `<main><div onclick="void 0" data-testid="card">Open card</div></main>`;
    uninstall = installCaptureListener();
    (document.querySelector("[data-testid='card']") as HTMLElement).click();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.payload.type).toBe("click");
    expect(captured[0]!.payload.label).toContain("Open card");
    uninstall();
  });

  it("captures a role=button div as a click", () => {
    document.body.innerHTML = `<main><div role="button" aria-label="Play">▶</div></main>`;
    uninstall = installCaptureListener();
    (document.querySelector('[role="button"]') as HTMLElement).click();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.payload.label).toContain("Play");
    uninstall();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/recording/capture.integration.test.ts`
Expected: FAIL——当前 `onClick` 的 closest 列表（`capture.ts:221-223`）不含 `[onclick]`/`[role="button"]` div 之外的项……实际上 `[role="button"]` 在旧列表里有，但 `[onclick]`/`[contenteditable]`/`[tabindex]` 没有；div[onclick] 用例会 FAIL（closest 匹配不到、fallback 到 target 本身——本步要让它走统一 selector）。

- [ ] **Step 3: onClick 改用内联权威 selector**

把 `capture.ts:221-223` 的 ad-hoc closest 列表替换为内联权威字面量（与 `_shared/interactive.ts` 逐字一致，受 Task 3 的 parity 测试守）：
```ts
  const onClick = (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (!target?.tagName) return;
    // VERBATIM copy of _shared/interactive.ts INTERACTIVE_SELECTOR.
    // interactive-parity.test.ts guards this literal against drift.
    const INTERACTIVE_SELECTOR =
      'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [contenteditable="true"], summary, [onclick], [tabindex]:not([tabindex=\'-1\'])';
    const interactive = target.closest(INTERACTIVE_SELECTOR) as HTMLElement | null;
    // 解析不到交互祖先且 target 自身无文本 → 纯布局点击，丢弃防噪。
    if (!interactive && !(target.innerText?.trim())) return;
    const el = interactive ?? target;
    const { label, selectorHint, unstable } = buildLabelFor(el);
    send({
      type: "click",
      label,
      ...(selectorHint ? { selectorHint } : {}),
      url: location.href,
      region: getRegion(el),
      ...(unstable ? { unstable } : {}),
    });
  };
```

- [ ] **Step 4: 跑测试确认通过（含 Task 3 capture parity 项转绿）**

Run: `pnpm test src/lib/recording/capture.integration.test.ts src/lib/dom-actions/interactive-parity.test.ts`
Expected: PASS——新 div 用例过；`interactive-parity.test.ts` 的 `installCaptureListener` 项现在转绿（三项全绿）。

- [ ] **Step 5: typecheck + 提交**

Run: `pnpm typecheck`（Expected: 0 errors）
```bash
git add src/lib/recording/capture.ts src/lib/recording/capture.integration.test.ts
git commit -m "feat(recording): capture onClick uses canonical INTERACTIVE_SELECTOR

div[onclick] / role=* custom controls now recorded; layout-only clicks dropped.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 复选框/单选勾选态

**Files:**
- Modify: `src/lib/recording/capture.ts`（onClick 加自定义可勾选元素延迟读态；onChange 改原生 checkbox/radio 分支）
- Test: `src/lib/recording/capture.integration.test.ts`

实现要点：
- **原生 `<input type=checkbox|radio>`**：`change` 在状态翻转后触发，可同步读 `el.checked`。让 `onChange` 对这类元素发 `type:"click"` + `checked`（而非旧的 `type:"type" value="on"`），并让 `onClick` **跳过**原生 checkbox/radio 避免双记。
- **自定义 `[role=checkbox|radio|switch]`**：状态由页面 bubble-phase handler 翻转，capture-phase 同步读会读到旧值 → 用 `setTimeout(0)` 延迟到页面 handler 之后读 `aria-checked`。

- [ ] **Step 1: 写失败测试（用 fake timers 驱动延迟读态）**

```ts
  it("records native checkbox toggle as click with checked state", () => {
    document.body.innerHTML = `<main><label>同意<input type="checkbox" name="agree"></label></main>`;
    uninstall = installCaptureListener();
    const cb = document.querySelector("input") as HTMLInputElement;
    cb.checked = true;
    cb.dispatchEvent(new Event("change", { bubbles: true }));

    const clicks = captured.filter((c) => c.payload.type === "click");
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.payload.checked).toBe(true);
    // 不再产生 type "on" 垃圾动作
    expect(captured.some((c) => c.payload.type === "type")).toBe(false);
    uninstall();
  });

  it("records custom role=checkbox toggle via deferred aria-checked read", () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<main><div role="checkbox" aria-checked="false" aria-label="夜间模式">●</div></main>`;
    const box = document.querySelector('[role="checkbox"]') as HTMLElement;
    // 页面自身的 bubble-phase handler：点击后翻转 aria-checked
    box.addEventListener("click", () => box.setAttribute("aria-checked", "true"));
    uninstall = installCaptureListener();

    box.click();
    vi.advanceTimersByTime(0); // 跑完 setTimeout(0) 的延迟读态

    const clicks = captured.filter((c) => c.payload.type === "click");
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.payload.checked).toBe(true);
    expect(clicks[0]!.payload.label).toContain("夜间模式");
    vi.useRealTimers();
    uninstall();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/recording/capture.integration.test.ts`
Expected: FAIL——原生 checkbox 现产出 `type "on"`；自定义 role=checkbox 无 `checked`。

- [ ] **Step 3: onClick 跳过原生 checkbox/radio + 自定义可勾选元素延迟读态**

在 Task 6 改好的 `onClick` 里，`const el = interactive ?? target;` 之后插入分流逻辑：
```ts
    const el = interactive ?? target;

    // 原生 checkbox/radio 交给 onChange（它能同步拿到翻转后的 checked），
    // onClick 跳过以免双记。
    const tagLower = el.tagName.toLowerCase();
    const inputType = (el as HTMLInputElement).type?.toLowerCase?.();
    if (tagLower === "input" && (inputType === "checkbox" || inputType === "radio")) {
      return;
    }

    // 自定义可勾选元素（role=checkbox/radio/switch）：状态由页面 bubble handler
    // 翻转，capture-phase 此刻读到的是旧值，延迟到下一 tick 再读 aria-checked。
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (role === "checkbox" || role === "radio" || role === "switch") {
      const { label, selectorHint, unstable } = buildLabelFor(el);
      const region = getRegion(el);
      setTimeout(() => {
        const ariaChecked = el.getAttribute("aria-checked");
        send({
          type: "click",
          label,
          ...(selectorHint ? { selectorHint } : {}),
          checked: ariaChecked === "true",
          url: location.href,
          region,
          ...(unstable ? { unstable } : {}),
        });
      }, 0);
      return;
    }
```
（其后保留 Task 6 写好的普通 click `send(...)`。）

- [ ] **Step 4: onChange 原生 checkbox/radio 分支**

`capture.ts:236-269` 的 `onChange`，在 `if (tag === "input" || tag === "textarea")` 分支**之前**加 checkbox/radio 拦截：
```ts
  const onChange = (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const tag = target.tagName.toLowerCase();
    const inputEl = target as HTMLInputElement;
    const { label, selectorHint, unstable } = buildLabelFor(target);

    // 原生 checkbox/radio：记成 click + 最终 checked 态（onClick 已跳过它们）。
    const inputType = inputEl.type?.toLowerCase?.();
    if (tag === "input" && (inputType === "checkbox" || inputType === "radio")) {
      send({
        type: "click",
        label,
        ...(selectorHint ? { selectorHint } : {}),
        checked: inputEl.checked,
        url: location.href,
        region: getRegion(target),
        ...(unstable ? { unstable } : {}),
      });
      return;
    }

    if (tag === "select") {
      // ...（原逻辑不变）
```
（保留 `select` 与 `input/textarea` 原有分支。）

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/lib/recording/capture.integration.test.ts`
Expected: PASS（两个新用例 + 既有用例全绿）。

- [ ] **Step 6: typecheck + 提交**

Run: `pnpm typecheck`（Expected: 0 errors）
```bash
git add src/lib/recording/capture.ts src/lib/recording/capture.integration.test.ts
git commit -m "fix(recording): record checkbox/radio toggle state, not value=on

Native: onChange emits click+checked; custom role=checkbox: deferred
aria-checked read. onClick skips native checkbox/radio to avoid double-record.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: contenteditable 富文本输入（防抖）

**Files:**
- Modify: `src/lib/recording/capture.ts`（加 `onInput` 监听 + 注册/注销）
- Test: `src/lib/recording/capture.integration.test.ts`

实现要点：监听 capture-phase `input`，仅当 target（或其 closest `[contenteditable]`）是 contenteditable 宿主时处理；500ms 防抖 + 一段编辑出一条 `type` 动作（值取宿主 `innerText`，经 `sanitizeText` 截断；走 `detectSensitiveInline` 脱敏，与现有 input/textarea 分支一致）。`<input>`/`<textarea>` 的 `input` 事件**不**在此处理（它们仍由现有 `change` 分支覆盖，避免逐键爆量）。

- [ ] **Step 1: 写失败测试（fake timers）**

```ts
  it("coalesces contenteditable typing into one type action after debounce", () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<main><div contenteditable="true" aria-label="评论">x</div></main>`;
    const ed = document.querySelector('[contenteditable="true"]') as HTMLElement;
    uninstall = installCaptureListener();

    ed.textContent = "你好";
    ed.dispatchEvent(new InputEvent("input", { bubbles: true }));
    ed.textContent = "你好世界";
    ed.dispatchEvent(new InputEvent("input", { bubbles: true }));
    vi.advanceTimersByTime(500);

    const types = captured.filter((c) => c.payload.type === "type");
    expect(types).toHaveLength(1);
    expect(types[0]!.payload.value).toBe("你好世界");
    expect(types[0]!.payload.label).toContain("评论");
    vi.useRealTimers();
    uninstall();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/recording/capture.integration.test.ts`
Expected: FAIL——当前无 `input` 监听，contenteditable 打字一条都不产出。

- [ ] **Step 3: 加 onInput 监听器**

在 `capture.ts` 的 scroll 监听器定义之后、`document.addEventListener("click", ...)` 注册区之前，加：
```ts
  // contenteditable 富文本输入 —— 防抖合并一段编辑为一条 type。input/textarea
  // 的 input 事件不在此处理（逐键爆量），它们仍由 onChange（blur 时）覆盖。
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  let editTarget: HTMLElement | null = null;
  const flushEdit = () => {
    if (!editTarget) return;
    const host = editTarget;
    editTarget = null;
    editTimer = null;
    const sens = detectSensitiveInline(host);
    const raw = host.innerText ?? host.textContent ?? "";
    const value = sens.redacted ? sens.placeholderName! : sanitizeText(raw, 200);
    const { label, selectorHint, unstable } = buildLabelFor(host);
    send({
      type: "type",
      label,
      ...(selectorHint ? { selectorHint } : {}),
      value,
      ...(sens.redacted ? { redacted: true, placeholderName: sens.placeholderName } : {}),
      url: location.href,
      region: getRegion(host),
      ...(unstable ? { unstable } : {}),
    });
  };
  const onInput = (e: Event) => {
    const t = e.target as HTMLElement | null;
    const host = t?.closest?.('[contenteditable="true"]') as HTMLElement | null;
    if (!host) return; // 非 contenteditable（如 input/textarea）忽略，交给 onChange
    editTarget = host;
    if (editTimer !== null) clearTimeout(editTimer);
    editTimer = setTimeout(flushEdit, 500);
  };
```

- [ ] **Step 4: 注册 + 注销 + blur flush**

在注册区（`capture.ts:317-323`）加：
```ts
  document.addEventListener("input", onInput, true);
  document.addEventListener("blur", flushEdit, true); // 失焦立即落一条，避免漏尾
```
在返回的 uninstall 闭包（`capture.ts:325-332`）里加：
```ts
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("blur", flushEdit, true);
    if (editTimer !== null) clearTimeout(editTimer);
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/lib/recording/capture.integration.test.ts`
Expected: PASS。

> 若 happy-dom 下 `blur` 的 capture-phase flush 导致测试里多产出一条，断言用 `.filter(type==="type")` 已隔离；如仍有重复，确认测试未显式触发 blur（本用例只 advance timer，不 blur）。

- [ ] **Step 6: typecheck + 提交**

Run: `pnpm typecheck`（Expected: 0 errors）
```bash
git add src/lib/recording/capture.ts src/lib/recording/capture.integration.test.ts
git commit -m "feat(recording): capture contenteditable rich-text typing (debounced)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: 键盘最小集（Enter + 组合键）

**Files:**
- Modify: `src/lib/recording/capture.ts`（加 `onKeydown` + 注册/注销）
- Test: `src/lib/recording/capture.integration.test.ts`

实现要点：capture-phase `keydown`，仅记两类——(1) `key === "Enter"`（无 IME 组合态 `isComposing`）；(2) 带修饰键的组合（`ctrlKey||metaKey||altKey` 且主键是可见单字符或功能键）。其余（纯字符、Tab、方向键、单独 Shift 等）一律忽略。产出 `type:"keypress"`，`value` = 规范化键名。

- [ ] **Step 1: 写失败测试**

```ts
  it("captures Enter as a keypress", () => {
    document.body.innerHTML = `<main><input type="search" name="q"></main>`;
    uninstall = installCaptureListener();
    const input = document.querySelector("input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    const keys = captured.filter((c) => c.payload.type === "keypress");
    expect(keys).toHaveLength(1);
    expect(keys[0]!.payload.value).toBe("Enter");
    uninstall();
  });

  it("captures a modifier combo, ignores plain character keys", () => {
    document.body.innerHTML = `<main><div contenteditable="true">x</div></main>`;
    uninstall = installCaptureListener();
    const ed = document.querySelector("div")!;
    ed.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })); // 忽略
    ed.dispatchEvent(new KeyboardEvent("keydown", { key: "b", metaKey: true, bubbles: true })); // 记

    const keys = captured.filter((c) => c.payload.type === "keypress");
    expect(keys).toHaveLength(1);
    expect(keys[0]!.payload.value).toBe("Cmd+B");
    uninstall();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/recording/capture.integration.test.ts`
Expected: FAIL——无 keydown 监听。

- [ ] **Step 3: 加 onKeydown**

在 `onInput` 定义之后加：
```ts
  // 键盘最小集：只记 Enter + 显式修饰组合键；纯字符/Tab/方向键/单独修饰键忽略。
  const onKeydown = (e: KeyboardEvent) => {
    if (e.isComposing) return; // IME 组合中，交给 contenteditable input 路径
    const k = e.key;
    const hasMod = e.ctrlKey || e.metaKey || e.altKey;
    const isPlainChar = k.length === 1 && !hasMod;
    if (isPlainChar) return;
    if (k === "Shift" || k === "Control" || k === "Meta" || k === "Alt") return;
    if (!hasMod && k !== "Enter") return; // 无修饰时只放行 Enter

    const parts: string[] = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.metaKey) parts.push("Cmd");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    parts.push(k.length === 1 ? k.toUpperCase() : k);
    send({
      type: "keypress",
      label: "",
      value: parts.join("+"),
      url: location.href,
      region: "other",
    });
  };
```

- [ ] **Step 4: 注册 + 注销**

注册区加：
```ts
  document.addEventListener("keydown", onKeydown, true);
```
uninstall 闭包加：
```ts
    document.removeEventListener("keydown", onKeydown, true);
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/lib/recording/capture.integration.test.ts`
Expected: PASS。

- [ ] **Step 6: typecheck + 提交**

Run: `pnpm typecheck`（Expected: 0 errors）
```bash
git add src/lib/recording/capture.ts src/lib/recording/capture.integration.test.ts
git commit -m "feat(recording): capture Enter + modifier-combo keypresses

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: parity fixtures 补强 + 全量验证

**Files:**
- Modify: `src/lib/recording/capture.integration.test.ts:123`（PARITY 用例补新元素类型 fixture）

- [ ] **Step 1: 给 buildLabelFor↔describeElement parity 补 fixture**

阅读 `capture.integration.test.ts:123-180` 现有 PARITY 用例结构（它遍历一组 DOM 元素，分别用注入态 `buildLabelFor` 与 `describeElement(meta)` 比对 label）。在其元素集合里追加三类新形态，确保两侧措辞仍逐字一致：
```ts
      // div[onclick] 无 role → kind 落到「元素」，用文本
      `<div onclick="void 0">Open card</div>`,
      // role=checkbox 自定义元素
      `<div role="checkbox" aria-label="夜间模式">●</div>`,
      // contenteditable 富文本宿主
      `<div contenteditable="true" aria-label="评论">draft</div>`,
```
> 具体插入方式按该用例既有的 fixture 数组/循环写法对齐（保持它构造 `ElementMetaForDescribe` 的同款字段提取），目标是新增元素在两条路径下 label 相等。

- [ ] **Step 2: 跑录制全套测试**

Run: `pnpm test src/lib/recording/ src/lib/dom-actions/`
Expected: PASS——capture 集成、selector、serialize、orchestrator、interactive、parity、search-page 全绿。

- [ ] **Step 3: 全量门禁**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 全绿；build-time invariants（含"录制状态不落盘" grep gate）通过。

- [ ] **Step 4: 提交**

```bash
git add src/lib/recording/capture.integration.test.ts
git commit -m "test(recording): extend capture↔selector parity fixtures for new kinds

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review（计划 vs spec 覆盖核对）

- **痛点①漏录 div/自定义点击** → Task 6（onClick 用权威 INTERACTIVE_SELECTOR）。✓
- **痛点②描述太弱** → Task 6/7/8 用 `buildLabelFor`（role/aria/text）+ checked 状态；Task 1/2 统一 kind 映射。✓
- **痛点③复选框 value=on 没意义** → Task 7（checked 态，原生 + 自定义）。✓
- **痛点④富文本 contenteditable 漏录** → Task 8。✓
- **键盘最小集** → Task 9。✓
- **复用 page-snapshot 基础设施（INTERACTIVE_SELECTOR/isVisible/kind 映射 + 三方 parity）** → Task 1/2/3。✓
- **hover 靠广义 click + 回放期 hover** → Task 6（录到 menuitem 点击）+ Task 5（header 暴露 hover）。✓
- **数据/序列化（keypress 类型、checked 字段、toggle/keypress 模板）** → Task 4/5。✓
- **header 提示词是回放工具暴露的真正杠杆**（修正 spec 中"hover 进 allowedTools"的表述：allowedTools 输出在 reframe 后被丢弃）→ Task 5 Step 3 改 header。✓
- **既有不变量不破**（不落盘 grep gate / capture-parity / idempotent install / idx-parity）→ Task 3/10 全量门禁守。✓
- **canvas 精确文本** → 非目标（spec 已钉死）；canvas 粗粒度 marker → 见下 Deferred。

类型一致性核对：`checked?: boolean`、`RecordedActionType` 含 `"keypress"`、`ACTION_TO_TOOL.keypress="press_key"`、`STEP_TEMPLATES.keypress(n,key)` 在 Task 4/5 一致；`INTERACTIVE_SELECTOR` 单一字面量在 Task 1/3/6 三处逐字相同（由 parity 测试机器守）。无悬空引用。

## Deferred（本计划外，spec 标记 best-effort/非目标）

- **canvas 编辑器（飞书/Google Docs）粗粒度输入 marker**：light DOM 无事件、无变更，需靠 keydown 流尽力探测"在不可读编辑器中持续输入"并落一条无文本 marker。Task 9 的 keydown 仅记 Enter/组合键，不覆盖普通字符；要落 marker 需额外的"聚焦元素不可读 + 持续字符 keydown"启发式，价值低且模糊，留待后续单独评估。
- **拖拽采集 + drag 回放工具**：现无 drag 工具，越过 capture-only 边界，整体推迟。
