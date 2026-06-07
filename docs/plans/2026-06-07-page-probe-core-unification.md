# 网页探查/定位核心统一 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把网页探查(read_page/search_page)与按-idx 定位(type/select/geometry/keyboard/editor)合并到两个 op 分派的注入核心,消除 editor 识别/stamp/语义/转义的复制漂移,闭合 shadow DOM「可读不可操作」缺口。

**Architecture:** 方案 A(运行时双核心 + 强化测试)。探查核心 `probePageInjected({op})` 合并 snapshot+search,共享一段 walk/stamp/语义/editor/转义;动作核心 `actByIdxInjected({op})` 合并 4 个 executeScript-func 定位点,共享唯一一份 shadow-aware locator;editor 的 CDP-string locator 改用同源字符串常量 `LOCATE_BY_IDX_FRAGMENT`。权威常量收进 `_shared/`,跨核心底层件用「往返行为 parity + 字面量 parity」守。

**Tech Stack:** TypeScript 6, Vite 8 + @crxjs, vitest + happy-dom, Chrome MV3 (`chrome.scripting.executeScript` self-contained 注入函数 + CDP `Runtime.evaluate`).

**Spec:** `docs/specs/2026-06-07-page-probe-core-unification.md`
**Branch:** `feat/page-probe-core-unification`(已创建)

---

## 关键约束(每个 task 都要记住)

1. **注入函数必须 self-contained**:`probePageInjected` / `actByIdxInjected` / `searchPageInjected` 等被 `executeScript` 序列化函数体,**不能 import**,所有 helper 必须嵌套在函数内、所有常量必须内联(从权威源**复制字面量**,不是 import)。权威源(`_shared/interactive.ts`)只供**模块侧消费者 + parity 测试** import。
2. **idx 一致性靠算法同源**:snapshot 与 search 是同一函数两 op,共享同一段 stamp,物理同源。
3. **搬运不是重写**:从旧文件搬逻辑时**逐字保留**已有策略(React native setter、IME-buffer 检测、execCommand、option 校验、subframe sentinel),只改"定位"与"常量来源"。
4. **每个 task 结束系统必须可工作**:`pnpm test` 绿。先建新核心 + 切换 + 验证,再删旧文件。
5. 提交前最终门禁:`pnpm test` + `pnpm typecheck` + `pnpm build`。

---

## File Structure

**新建:**
- `src/lib/dom-actions/_shared/locate.ts` — `LOCATE_BY_IDX_FRAGMENT` 字符串常量(CDP-string 类用)+ `findByIdxDeepSource` 复用
- `src/lib/dom-actions/probe-core.ts` — `probePageInjected({op})` 探查核心
- `src/lib/dom-actions/act-core.ts` — `actByIdxInjected({op})` 动作核心
- `src/lib/dom-actions/probe-core.test.ts`、`act-core.test.ts`
- `src/__tests__/cross-layer/probe-act-roundtrip.test.ts` — 往返行为 parity + shadow 闭合 + editor fixture

**扩充:**
- `src/lib/dom-actions/_shared/interactive.ts` — 加 `EDITOR_SELECTOR` / `EDITOR_ENGINE_MAP` / `WRAPPER_TAGS_LIST` / `TYPE_EDITOR_MARKERS`

**修改(tool 层薄改):**
- `src/lib/agent/tools/read-page.ts`、`search-page.ts`、`editor.ts`、`keyboard.ts`、`mouse.ts`
- `src/lib/dom-actions/geometry.ts`、`recording/capture.ts`
- `src/lib/dom-actions/interactive-parity.test.ts`、`src/__tests__/cross-layer/page-tools-locator-gap.test.ts`(更新 import)

**删除(合并后):**
- `src/lib/dom-actions/page-snapshot.ts`、`search-page.ts`、`type.ts`、`select.ts` 的注入函数;`geometry.ts` 的 `readRectByIdx`

---

## Task 1: 权威常量层扩充

把散落的 editor 选择器、引擎 map、WRAPPER 全表、type 编辑器标记收进 `_shared/interactive.ts`,作为可 import + 可被 parity 测试比对的唯一权威。

**Files:**
- Modify: `src/lib/dom-actions/_shared/interactive.ts`
- Test: `src/lib/dom-actions/_shared/interactive.test.ts`

- [ ] **Step 1: 写失败测试**

在 `interactive.test.ts` 追加:

```ts
import {
  EDITOR_SELECTOR,
  EDITOR_ENGINE_MAP,
  WRAPPER_TAGS_LIST,
  TYPE_EDITOR_MARKERS,
} from "./interactive";

describe("authoritative constants", () => {
  it("EDITOR_SELECTOR covers Monaco/CM5/CM6/TinyMCE v4+v6", () => {
    expect(EDITOR_SELECTOR).toBe(
      ".monaco-editor, .cm-editor, .CodeMirror, .tox-tinymce, .mce-tinymce",
    );
  });

  it("EDITOR_ENGINE_MAP maps each host class to an engine name", () => {
    expect(EDITOR_ENGINE_MAP).toEqual([
      [".monaco-editor", "Monaco"],
      [".cm-editor", "CodeMirror"],
      [".CodeMirror", "CodeMirror"],
      [".tox-tinymce", "TinyMCE"],
      [".mce-tinymce", "TinyMCE"],
    ]);
  });

  it("WRAPPER_TAGS_LIST matches the agent-layer master table", async () => {
    const { UNTRUSTED_WRAPPER_TAGS } = await import(
      "../../agent/untrusted-wrappers"
    );
    expect([...WRAPPER_TAGS_LIST].sort()).toEqual(
      [...UNTRUSTED_WRAPPER_TAGS].sort(),
    );
  });

  it("TYPE_EDITOR_MARKERS keeps the 9 type-diagnostic editors", () => {
    expect(TYPE_EDITOR_MARKERS.map((m) => m[1])).toEqual([
      "Slate", "ProseMirror", "Quill", "Lexical", "Monaco",
      "CodeMirror", "Feishu Docs", "Notion", "Google Docs",
    ]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/dom-actions/_shared/interactive.test.ts`
Expected: FAIL（`EDITOR_SELECTOR` 等未导出）

- [ ] **Step 3: 实现**

先读 `src/lib/agent/untrusted-wrappers.ts` 确认 `UNTRUSTED_WRAPPER_TAGS` 的精确成员,把它逐字复制成 `WRAPPER_TAGS_LIST`(string 数组字面量,顺序与 master 一致)。然后在 `interactive.ts` 末尾追加:

```ts
// Code-editor host selector. Authoritative source; injected functions inline a
// VERBATIM copy. EDITOR_SELECTOR marks hosts that role="editor" + read_editor /
// set_editor_value can operate (Monaco / CodeMirror / TinyMCE only).
export const EDITOR_SELECTOR =
  ".monaco-editor, .cm-editor, .CodeMirror, .tox-tinymce, .mce-tinymce";

// Host-class → engine name. First match wins (order matters: .cm-editor is CM6,
// .CodeMirror is CM5). Drives inferredRole/accessibleName editor branch.
export const EDITOR_ENGINE_MAP: ReadonlyArray<readonly [string, string]> = [
  [".monaco-editor", "Monaco"],
  [".cm-editor", "CodeMirror"],
  [".CodeMirror", "CodeMirror"],
  [".tox-tinymce", "TinyMCE"],
  [".mce-tinymce", "TinyMCE"],
];

// Master untrusted-wrapper tag list. MUST equal agent-layer UNTRUSTED_WRAPPER_TAGS
// (dual-list invariant). Injected functions inline a VERBATIM copy; parity test
// guards drift.
export const WRAPPER_TAGS_LIST: readonly string[] = [
  // ⚠️ 从 src/lib/agent/untrusted-wrappers.ts 的 UNTRUSTED_WRAPPER_TAGS 逐字复制,
  // 顺序一致。包含 untrusted_editor_content / untrusted_page_match / untrusted_pdf_*
  // / untrusted_local_file / untrusted_search_result 等全部成员。
];

// type-failure diagnostic editor markers (broader than EDITOR_SELECTOR: includes
// canvas/rich editors that type can't write but should be DIAGNOSED to route the
// LLM to keyboard tools). Distinct semantics from EDITOR_SELECTOR — do NOT merge.
export const TYPE_EDITOR_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ['[data-slate-editor="true"]', "Slate"],
  [".ProseMirror", "ProseMirror"],
  [".ql-editor", "Quill"],
  ['[data-lexical-editor="true"]', "Lexical"],
  [".monaco-editor", "Monaco"],
  [".cm-editor, .CodeMirror", "CodeMirror"],
  ['.suite-editor-container, .docx-root, [class*="lark-"], [class*="docx-"]', "Feishu Docs"],
  [".notion-page-content", "Notion"],
  [".kix-documentview-content", "Google Docs"],
];
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/dom-actions/_shared/interactive.test.ts`
Expected: PASS（若 WRAPPER 列表测试失败,把数组补齐到与 master 完全一致）

- [ ] **Step 5: Commit**

```bash
git add src/lib/dom-actions/_shared/interactive.ts src/lib/dom-actions/_shared/interactive.test.ts
git commit -m "feat(probe): authoritative editor/wrapper/type-marker constants"
```

---

## Task 2: probe-core 骨架 + op:snapshot

新建探查核心,先实现 snapshot 分支(逐字搬运 `pageSnapshotInjected`),把所有共享 helper 与 stamp 提到函数顶部。

**Files:**
- Create: `src/lib/dom-actions/probe-core.ts`
- Create: `src/lib/dom-actions/probe-core.test.ts`
- Reference(搬运源): `src/lib/dom-actions/page-snapshot.ts`(全文)

- [ ] **Step 1: 写失败测试(迁移 page-snapshot 的核心断言)**

把 `src/lib/dom-actions/page-snapshot.test.ts` 的断言迁移到 `probe-core.test.ts`,入口改为 `probePageInjected({ op: "snapshot" })`。最小起步断言:

```ts
import { probePageInjected } from "./probe-core";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("probePageInjected op=snapshot", () => {
  it("returns html + interactiveElements + scrollableHints", () => {
    document.body.innerHTML = `<button>Hi</button><a href="/x">link</a>`;
    const r = probePageInjected({ op: "snapshot" });
    expect(r.op).toBe("snapshot");
    if (r.op !== "snapshot") throw new Error("narrow");
    expect(r.interactiveElements.length).toBe(2);
    expect(r.interactiveElements[0]).toMatchObject({ tag: "button", role: "button" });
    expect(r.html).toContain("data-pie-idx");
  });

  it("marks a Monaco host as a single role=editor entry", () => {
    document.body.innerHTML = `<div class="monaco-editor"><textarea class="inputarea"></textarea><div class="view-line">x</div></div>`;
    const host = document.querySelector(".monaco-editor") as HTMLElement;
    Object.defineProperty(host, "getBoundingClientRect", {
      value: () => ({ width: 400, height: 200, top: 0, left: 0, right: 400, bottom: 200 }),
      configurable: true,
    });
    const r = probePageInjected({ op: "snapshot" });
    if (r.op !== "snapshot") throw new Error("narrow");
    const editors = r.interactiveElements.filter((e) => e.role === "editor");
    expect(editors.length).toBe(1);
    expect(editors[0].name).toContain("read_editor");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/dom-actions/probe-core.test.ts`
Expected: FAIL（`probePageInjected` 不存在）

- [ ] **Step 3: 实现 probe-core 骨架 + snapshot 分支**

新建 `probe-core.ts`。结构如下(self-contained 注入函数):

```ts
import type { InteractiveElementSummary } from "./interactive-summary";

export interface ScrollableHint {
  region: string;
  pieIdx: number | null;
  visibleCount: number;
  estimatedTotal: number;
}

export interface SearchMatch {
  pieIdx: number | null;
  tag: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  type?: string;
  contenteditable?: boolean;
  matched: string;
  snippet: string;
}

export type ProbeParams =
  | { op: "snapshot" }
  | {
      op: "search";
      queries: string[];
      regex: boolean;
      mode: "all" | "interactive" | "text";
      maxResults: number;
      searchBy: "text" | "role" | "tag" | "attribute";
    };

export type ProbeResult =
  | { op: "snapshot"; html: string; interactiveElements: InteractiveElementSummary[]; scrollableHints: ScrollableHint[] }
  | { op: "search"; matches: SearchMatch[]; total: number; timedOut: boolean; invalidRegex: string | null; invalidAttribute: string | null };

export function probePageInjected(params: ProbeParams): ProbeResult {
  // ── 内联权威常量(VERBATIM copy of _shared/interactive.ts) ──
  const INTERACTIVE_SELECTOR =
    'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [contenteditable="true"], summary, [onclick], [tabindex]:not([tabindex=\'-1\'])';
  const EDITOR_SELECTOR =
    ".monaco-editor, .cm-editor, .CodeMirror, .tox-tinymce, .mce-tinymce";
  const WRAPPER_TAGS_LIST = [ /* VERBATIM copy of _shared WRAPPER_TAGS_LIST */ ];

  // ── 共享 helper(从 page-snapshot.ts 逐字搬:walkDeep / isVisible /
  //    isRescuableControl / visibleLabelFor / sanitizeText / escapeWrapperMarkup /
  //    normalizeSpace / directText / descendantText / textById / labelFor /
  //    nearestSection / cssEscape / CONTROL_CHAR_RE / SUMMARY_* ) ──
  function editorEngineOf(el: Element): string | null {
    if (el.matches?.(".monaco-editor")) return "Monaco";
    if (el.matches?.(".cm-editor")) return "CodeMirror";
    if (el.matches?.(".CodeMirror")) return "CodeMirror";
    if (el.matches?.(".tox-tinymce")) return "TinyMCE";
    if (el.matches?.(".mce-tinymce")) return "TinyMCE";
    return null;
  }
  function inferredRole(el: Element): string { /* 搬 page-snapshot.ts:245-264(含 editorEngineOf 分支) */ }
  function accessibleName(el: Element): string { /* 搬 page-snapshot.ts:266-281(含 editor 引导提示) */ }
  // ... 其余共享 helper 逐字搬 ...

  // ── 共享:stamp live DOM(editorHosts / insideEditor / rescue) ──
  // 逐字搬 page-snapshot.ts Step C(line 392-432),产出 liveBodyElements + data-pie-idx。
  // 注意:此处 stamp 必须在 snapshot 的 clone 之后(Step A/A1/B 之后)对 LIVE DOM 进行,
  // 与现状一致。

  if (params.op === "snapshot") {
    // 逐字搬 page-snapshot.ts 的 Step A → Step E,返回:
    // return { op: "snapshot", html, interactiveElements, scrollableHints };
  }
  // search 分支在 Task 3 实现:
  return { op: "search", matches: [], total: 0, timedOut: false, invalidRegex: null, invalidAttribute: null };
}
```

实现要点(搬运 `pageSnapshotInjected` 时):
- Step A clone / A1 shadow 注入 / B IDL reflect(含 #143 隐藏 textarea isVisible 守卫,line 364-370 逐字保留)/ C0 iframe stamp / C stamp / D 4-pass strip / E scrollable —— **全部逐字搬**。
- `interactiveSummary`(line 283-311,含 rescue label control 派生)逐字搬。
- 末尾 `return { op: "snapshot", html, interactiveElements, scrollableHints };`(比原版多 `op` 字段)。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/dom-actions/probe-core.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/dom-actions/probe-core.ts src/lib/dom-actions/probe-core.test.ts
git commit -m "feat(probe): probePageInjected core + op=snapshot (ported from page-snapshot)"
```

---

## Task 3: probe-core op:search(共享 helper + editor 行为修复)

实现 search 分支,**复用** Task 2 已建的共享 helper 与 stamp;这自动给 search 带来 editor 识别(行为修复)。

**Files:**
- Modify: `src/lib/dom-actions/probe-core.ts`
- Modify: `src/lib/dom-actions/probe-core.test.ts`
- Reference(搬运源): `src/lib/dom-actions/search-page.ts`(匹配逻辑)

- [ ] **Step 1: 写失败测试(迁移 search-page 断言 + editor 修复断言)**

迁移 `src/lib/dom-actions/search-page.test.ts` 的断言到 `probe-core.test.ts`(入口 `probePageInjected({op:"search", ...})`)。新增 editor 行为修复断言:

```ts
describe("probePageInjected op=search", () => {
  it("substring text match returns pieIdx + snippet", () => {
    document.body.innerHTML = `<p>hello world</p><a href="/x">find me</a>`;
    const r = probePageInjected({ op: "search", queries: ["find"], regex: false, mode: "all", maxResults: 10, searchBy: "text" });
    if (r.op !== "search") throw new Error("narrow");
    expect(r.total).toBe(1);
    expect(r.matches[0].pieIdx).not.toBeNull();
  });

  it("search_by=role 'editor' now hits a Monaco host (regression fix)", () => {
    document.body.innerHTML = `<div class="monaco-editor"><div class="view-line">code</div></div>`;
    const host = document.querySelector(".monaco-editor") as HTMLElement;
    Object.defineProperty(host, "getBoundingClientRect", {
      value: () => ({ width: 400, height: 200, top: 0, left: 0, right: 400, bottom: 200 }),
      configurable: true,
    });
    const r = probePageInjected({ op: "search", queries: ["editor"], regex: false, mode: "all", maxResults: 10, searchBy: "role" });
    if (r.op !== "search") throw new Error("narrow");
    expect(r.total).toBeGreaterThanOrEqual(1);
    expect(r.matches[0].role).toBe("editor");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/dom-actions/probe-core.test.ts -t "op=search"`
Expected: FAIL（search 分支返回空）

- [ ] **Step 3: 实现 search 分支**

在 `probe-core.ts` 把 `if (params.op === "snapshot")` 之后改为 `if (params.op === "search")` 分支,搬运 `searchPageInjected` 的匹配逻辑(line 359-518),但:
- **删除** search-page.ts 自带的 stamp 复制块(line 150-166)—— 改用 Task 2 共享 stamp 的结果。
- **删除** search-page.ts 自带的 helper 复制(walkDeep/isVisible/inferredRole/accessibleName/...)—— 改用共享 helper。
- 保留 search 特有:`findPieIdx`(穿 shadow 找祖先 idx,line 169-182)、`firstMatch`、`buildSnippet`、`buildElementMatch`、`modeAllowsElement`、`parseAttributeQuery`、`attrValue`、searchBy 分支、text 匹配循环。
- 共享 helper 现已带 editor 分支,`inferredRole`/`accessibleName` 对 editor 宿主自动产出 `role="editor"` + 引导 —— search 的 editor 修复**自动获得**,无需额外代码。
- 返回 `{ op: "search", matches, total, timedOut, invalidRegex, invalidAttribute }`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/dom-actions/probe-core.test.ts`
Expected: PASS（snapshot + search 全绿）

- [ ] **Step 5: Commit**

```bash
git add src/lib/dom-actions/probe-core.ts src/lib/dom-actions/probe-core.test.ts
git commit -m "feat(probe): op=search sharing stamp/semantics (editor recognition fix)"
```

---

## Task 4: 切换 read_page / search_page tool 层 + 删旧探查注入

**Files:**
- Modify: `src/lib/agent/tools/read-page.ts`
- Modify: `src/lib/agent/tools/search-page.ts`
- Delete: `src/lib/dom-actions/page-snapshot.ts`、`src/lib/dom-actions/search-page.ts`
- Modify(import 修正): `src/lib/dom-actions/interactive-parity.test.ts`、`src/__tests__/cross-layer/page-tools-locator-gap.test.ts`、以及任何 import `pageSnapshotInjected`/`searchPageInjected`/`PageSnapshotResult`/`SearchPageResult` 的文件

- [ ] **Step 1: 切换 read-page.ts**

`read-page.ts`:
- import 改为 `import { probePageInjected, type ProbeResult } from "../../dom-actions/probe-core";`
- `executeScript` 调用:`func: pageSnapshotInjected` → `func: probePageInjected`,加 `args: [{ op: "snapshot" }]`。
- 结果类型从 `PageSnapshotResult` 改为窄化:`const data = inj?.result; if (!data || data.op !== "snapshot") {...}`,后续用 `data.interactiveElements` 等。

- [ ] **Step 2: 切换 search-page.ts**

`search-page.ts`:
- import 改为 `probePageInjected`。
- `func: searchPageInjected` → `func: probePageInjected`,`args: [{ op: "search", queries, regex, mode, maxResults, searchBy }]`。
- 读结果时窄化 `r.result?.op === "search"`。`invalidRegex`/`invalidAttribute`/`matches`/`total`/`timedOut` 字段位置不变。

- [ ] **Step 3: 修 import 引用,删旧文件**

```bash
grep -rln "pageSnapshotInjected\|searchPageInjected\|page-snapshot\|dom-actions/search-page" src --include="*.ts"
```
- `interactive-parity.test.ts`:把 `pageSnapshotInjected`/`searchPageInjected` 两个入口改为 `probePageInjected`(同一函数,断言它 inline 了 selector 字面量;`installCaptureListener` 保留)。
- `page-tools-locator-gap.test.ts`:`pageSnapshotInjected()` → `probePageInjected({op:"snapshot"})`,`searchPageInjected({...})` → `probePageInjected({op:"search", ...})`,并窄化 `op`。
- `PageSnapshotResult` 类型引用 → `ProbeResult` 的 snapshot 分支(或导出一个 `SnapshotResult` 便捷别名)。
- 删除 `src/lib/dom-actions/page-snapshot.ts`、`search-page.ts` 及其 `.test.ts`(断言已迁移到 probe-core.test.ts)。

- [ ] **Step 4: 全量回归**

Run: `pnpm test && pnpm typecheck`
Expected: PASS(read-page/search-page tool 测试 + 跨层测试全绿)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(probe): route read_page/search_page through probePageInjected; drop old inject fns"
```

---

## Task 5: act-core shadow-aware locator + op:rect

新建动作核心,先落 shadow-aware locator 与最简单的 `rect` op(geometry),用往返测试守 shadow 闭合。

**Files:**
- Create: `src/lib/dom-actions/act-core.ts`
- Create: `src/lib/dom-actions/act-core.test.ts`

- [ ] **Step 1: 写失败测试(shadow 内 idx 可定位)**

```ts
import { probePageInjected } from "./probe-core";
import { actByIdxInjected } from "./act-core";

beforeEach(() => { document.body.innerHTML = ""; });

it("locates a stamped element inside an open shadow root (op=rect)", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const sr = host.attachShadow({ mode: "open" });
  sr.innerHTML = `<button>deep</button>`;
  const btn = sr.querySelector("button") as HTMLElement;
  Object.defineProperty(btn, "getBoundingClientRect", {
    value: () => ({ x: 10, y: 20, width: 30, height: 40, top: 20, left: 10, right: 40, bottom: 60 }),
    configurable: true,
  });
  // probe stamps shadow-internal interactive elements
  probePageInjected({ op: "snapshot" });
  const idx = Number(btn.getAttribute("data-pie-idx"));
  expect(Number.isFinite(idx)).toBe(true);
  const r = actByIdxInjected({ op: "rect", idx });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("narrow");
  expect(r.rect).toMatchObject({ w: 30, h: 40 });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/dom-actions/act-core.test.ts`
Expected: FAIL（`actByIdxInjected` 不存在）

- [ ] **Step 3: 实现 act-core 骨架 + shadow locator + rect**

```ts
import type { ActionResult } from "./types";

export type ActParams =
  | { op: "rect"; idx: number }
  | { op: "focusClick"; idx: number }
  | { op: "type"; idx: number; text: string; clear: boolean }
  | { op: "select"; idx: number; value: string };

export type ActResult =
  | { ok: true; rect: { x: number; y: number; w: number; h: number } }
  | ({ ok: true } & ActionResult)
  | { ok: false; error: string };

export async function actByIdxInjected(params: ActParams): Promise<ActResult> {
  // ── shadow-aware locator(唯一一份;CDP-string 版见 _shared/locate.ts,逻辑同源) ──
  function findByIdxDeep(idx: number): Element | null {
    const sel = `[data-pie-idx="${idx}"]`;
    function search(root: Document | ShadowRoot): Element | null {
      const direct = root.querySelector(sel);
      if (direct) return direct;
      const all = root.querySelectorAll("*");
      for (const el of all) {
        const sr = (el as Element).shadowRoot;
        if (sr && sr.mode === "open") {
          const found = search(sr);
          if (found) return found;
        }
      }
      return null;
    }
    return search(document);
  }

  const el = findByIdxDeep(params.idx);
  if (!el) {
    return { ok: false, error: `Element not found at index ${params.idx}. The page may have changed; try snapshotting again.` };
  }

  if (params.op === "rect") {
    (el as unknown as { scrollIntoViewIfNeeded?: (a: unknown) => void }).scrollIntoViewIfNeeded?.({ block: "center" });
    const r = (el as HTMLElement).getBoundingClientRect();
    return { ok: true, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
  }
  // type / select / focusClick 在后续 task 实现
  return { ok: false, error: "unimplemented op" };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/dom-actions/act-core.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/dom-actions/act-core.ts src/lib/dom-actions/act-core.test.ts
git commit -m "feat(act): actByIdxInjected core + shadow-aware locator + op=rect"
```

---

## Task 6: act-core op:type(逐字搬 typeByIndex 全策略)

**Files:**
- Modify: `src/lib/dom-actions/act-core.ts`
- Modify: `src/lib/dom-actions/act-core.test.ts`
- Reference(搬运源): `src/lib/dom-actions/type.ts`(全文)

- [ ] **Step 1: 写失败测试(迁移 type.test 核心 + IME-buffer 诊断)**

迁移 `type.test.ts` 的断言到 `act-core.test.ts`,入口 `await actByIdxInjected({op:"type", idx, text, clear})`。必须覆盖:input 写入、contenteditable 写入、Monaco `.inputarea`(input 嵌在 `.monaco-editor` 内)被诊断为 IME-buffer 并返回引导 keyboard 的错误。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/dom-actions/act-core.test.ts -t "type"`
Expected: FAIL

- [ ] **Step 3: 实现 type 分支**

在 `findByIdxDeep` 之后、`if (params.op === "rect")` 同级加 `if (params.op === "type")`。**逐字搬** `typeByIndex` 的 line 31-351,但:
- 删除其开头的 `document.querySelector('[data-pie-idx]')` 定位(line 135-141),改用已定位的 `el`。
- `detectEditor`(line 90-113)的 markers 数组从权威 `TYPE_EDITOR_MARKERS` **复制字面量**内联(self-contained)。
- 其余(`isSensitive`/`getFieldName`/`setNativeValue`/focus/input 策略/contenteditable 策略/80ms post-check/`looksLikeIMEBuffer`/返回文案)**逐字保留**。
- 返回值包成 `{ ok: true, ...ActionResult }` 或 `{ ok: false, error }`,与 act-core 的 `ActResult` 一致。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/dom-actions/act-core.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/dom-actions/act-core.ts src/lib/dom-actions/act-core.test.ts
git commit -m "feat(act): op=type ported verbatim from typeByIndex (markers from authority)"
```

---

## Task 7: act-core op:select + op:focusClick

**Files:**
- Modify: `src/lib/dom-actions/act-core.ts`、`act-core.test.ts`
- Reference: `src/lib/dom-actions/select.ts`、`src/lib/agent/tools/keyboard.ts:28-41`

- [ ] **Step 1: 写失败测试**

迁移 `select.test.ts` 断言(入口 `actByIdxInjected({op:"select", idx, value})`);新增 focusClick 测试:

```ts
it("focusClick clicks the located element", async () => {
  document.body.innerHTML = `<button>go</button>`;
  probePageInjected({ op: "snapshot" });
  const btn = document.querySelector("button") as HTMLElement;
  const idx = Number(btn.getAttribute("data-pie-idx"));
  let clicked = false;
  btn.addEventListener("click", () => { clicked = true; });
  const r = await actByIdxInjected({ op: "focusClick", idx });
  expect(r.ok).toBe(true);
  expect(clicked).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/dom-actions/act-core.test.ts -t "select|focusClick"`
Expected: FAIL

- [ ] **Step 3: 实现**

- `if (params.op === "select")`:逐字搬 `selectByIndex` line 20-56(去掉自带定位 line 11),用已定位 `el`;非 `<select>` / option 不存在的错误文案保留。
- `if (params.op === "focusClick")`:`(el as HTMLElement).click(); return { ok: true, success: true, observation: \`Focus-clicked element [${params.idx}]\` };`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/dom-actions/act-core.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/dom-actions/act-core.ts src/lib/dom-actions/act-core.test.ts
git commit -m "feat(act): op=select + op=focusClick"
```

---

## Task 8: 切换动作 tool 层 + 删旧动作注入

**Files:**
- Modify: `src/lib/dom-actions/geometry.ts`、`src/lib/agent/tools/keyboard.ts`、`src/lib/agent/tools/mouse.ts`、以及 type/select 的调用方
- Delete: `src/lib/dom-actions/type.ts`、`src/lib/dom-actions/select.ts` 的注入函数(若文件仅含该函数则删文件)、`geometry.ts` 的 `readRectByIdx`

- [ ] **Step 1: 定位 type/select 调用方**

```bash
grep -rln "typeByIndex\|selectByIndex\|readRectByIdx\|focusClickByIndex" src --include="*.ts" | grep -v test
```
通常在 `src/lib/agent/tools/mouse.ts`(click→geometry)、type/select 各自的 tool wrapper、`keyboard.ts`。

- [ ] **Step 2: 切换 executeScript 调用**

每处 `func: typeByIndex, args:[idx,text,clear]` → `func: actByIdxInjected, args:[{op:"type", idx, text, clear}]`,结果读 `res.ok`/`res.error`/`res.observation`。`selectByIndex` → `{op:"select", idx, value}`。`keyboard.ts` 的 `focusClickByIndex` → `{op:"focusClick", idx}`。`geometry.ts` 的 `elementToPagePoint` 内 `func: readRectByIdx, args:[idx]` → `func: actByIdxInjected, args:[{op:"rect", idx}]`,把 `injection[0].result` 从 `{x,y,w,h}|null` 改读 `result.ok ? result.rect : null`。

注意:`actByIdxInjected` 是 `async`,`executeScript` 已支持注入 async func(返回 Promise 会被 await),无需改调用形态。

- [ ] **Step 3: 删旧文件 + 修 import**

删 `type.ts`/`select.ts` 注入函数、`geometry.ts` 的 `readRectByIdx`;`keyboard.ts` 内联的 `focusClickByIndex` 删除。修正所有 import。

- [ ] **Step 4: 全量回归**

Run: `pnpm test && pnpm typecheck`
Expected: PASS(type/select/mouse/keyboard tool 测试 + geometry 测试全绿)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(act): route type/select/rect/focusClick through actByIdxInjected; drop old inject fns"
```

---

## Task 9: editor CDP locator 改用共享 fragment

**Files:**
- Create: `src/lib/dom-actions/_shared/locate.ts`
- Modify: `src/lib/agent/tools/editor.ts`
- Modify: `src/lib/agent/tools/editor.test.ts`

- [ ] **Step 1: 写失败测试(fragment 穿 shadow + 保留 subframe sentinel)**

在 `editor.test.ts` 加(沿用现有 `new Function` 求值表达式模式):

```ts
import { LOCATE_BY_IDX_FRAGMENT } from "../../dom-actions/_shared/locate";

it("LOCATE_BY_IDX_FRAGMENT resolves el across open shadow root", () => {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const sr = host.attachShadow({ mode: "open" });
  sr.innerHTML = `<div data-pie-idx="7" class="cm-editor"></div>`;
  // fragment 定义 const SEL/el/win/_locatorReason —— 包一层求值
  const fn = new Function(`${LOCATE_BY_IDX_FRAGMENT.replace("${idx}", "7")} return { found: !!el, reason: _locatorReason };`);
  const out = fn();
  expect(out.found).toBe(true);
  expect(out.reason).toBeNull();
});

it("fragment reports not_found for a missing idx (top frame)", () => {
  document.body.innerHTML = `<div>nothing</div>`;
  const fn = new Function(`${LOCATE_BY_IDX_FRAGMENT.replace("${idx}", "99")} return { found: !!el, reason: _locatorReason };`);
  const out = fn();
  expect(out.found).toBe(false);
  expect(out.reason).toBe("not_found");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/agent/tools/editor.test.ts -t "fragment"`
Expected: FAIL

- [ ] **Step 3: 实现 locate.ts + 切 editor.ts**

`_shared/locate.ts`:把 `editor.ts` 现有 `locatorFragment`(line 46-64)抽出为导出常量,但把 `document.querySelector(SEL)` 升级为穿 shadow 的查找,**保留** subframe 检测(`inSubframe` 走 `w.frames`)与 `_locatorReason` sentinel:

```ts
// CDP-evaluate-string locator. Shadow-aware (mirrors act-core findByIdxDeep);
// keeps subframe detection so callers can return in_subframe vs not_found.
// `${idx}` is substituted by the caller (buildReadEditorExpression etc.).
export const LOCATE_BY_IDX_FRAGMENT = `
    const SEL = '[data-pie-idx="\${idx}"]';
    function _deep(root) {
      const d = root.querySelector(SEL);
      if (d) return d;
      const all = root.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) {
        const sr = all[i].shadowRoot;
        if (sr && sr.mode === 'open') { const f = _deep(sr); if (f) return f; }
      }
      return null;
    }
    const el = _deep(document);
    const win = window;
    function inSubframe(w) {
      const fs = w.frames;
      for (let i = 0; i < fs.length; i++) {
        try {
          if (_deep(fs[i].document)) return true;
          if (inSubframe(fs[i])) return true;
        } catch (e) {}
      }
      return false;
    }
    const _locatorReason = el ? null : (inSubframe(window) ? "in_subframe" : "not_found");
  `;
```

`editor.ts`:删除内联 `locatorFragment` 函数,改 `import { LOCATE_BY_IDX_FRAGMENT } from "../../dom-actions/_shared/locate";`,`buildReadEditorExpression`/`buildSetEditorExpression` 里 `${locatorFragment(idx)}` → `${LOCATE_BY_IDX_FRAGMENT.replace(/\$\{idx\}/g, String(idx))}`。`adapterFragment` 与 `reasonToError` 不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/agent/tools/editor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/dom-actions/_shared/locate.ts src/lib/agent/tools/editor.ts src/lib/agent/tools/editor.test.ts
git commit -m "refactor(editor): shared shadow-aware LOCATE_BY_IDX_FRAGMENT (keeps subframe sentinel)"
```

---

## Task 10: WRAPPER 转义统一 + capture 顺手补 + 安全测试

**Files:**
- Modify: `src/lib/recording/capture.ts`
- Modify: `src/lib/recording/capture.test.ts`(或新增)
- Verify: `probe-core.ts` 的 `WRAPPER_TAGS_LIST` 内联已等于权威全表(Task 2 已做,这里加测试钉死)

- [ ] **Step 1: 写失败测试(capture label 过滤全表 wrapper)**

在 `capture.test.ts` 加:模拟点击一个 `aria-label` 含 `<untrusted_editor_content>` 的元素,断言发出的 payload.label 含 `[filtered]` 而非原始标签。

```ts
it("capture filters the full wrapper-tag table out of labels", () => {
  // ... install listener, dispatch click on element with
  //     aria-label="x <untrusted_editor_content> y", capture sent payload ...
  expect(sent.label).toContain("[filtered]");
  expect(sent.label).not.toContain("untrusted_editor_content");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/recording/capture.test.ts -t "wrapper"`
Expected: FAIL（capture 当前 `WRAPPER_TAGS_RE` 只 6 项,不含 editor_content）

- [ ] **Step 3: 实现**

`capture.ts` 把 `WRAPPER_TAGS_RE`(line 70-71)替换为从权威全表生成的正则(self-contained:内联 `WRAPPER_TAGS_LIST` 字面量副本,与 `_shared` 一致):

```ts
const WRAPPER_TAGS_LIST = [ /* VERBATIM copy of _shared WRAPPER_TAGS_LIST */ ];
const WRAPPER_TAGS_RE = new RegExp(`</?(?:${WRAPPER_TAGS_LIST.join("|")})[^>]*>`, "gi");
```
不动 capture 其余逻辑(shadow/editor 识别仍属后续 issue)。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/recording/capture.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/recording/capture.ts src/lib/recording/capture.test.ts
git commit -m "fix(recording): capture escapes the full untrusted-wrapper table (security)"
```

---

## Task 11: 强化 parity 测试(字面量 + 往返行为 + editor/shadow 综合)

**Files:**
- Modify: `src/lib/dom-actions/interactive-parity.test.ts`
- Create: `src/__tests__/cross-layer/probe-act-roundtrip.test.ts`

- [ ] **Step 1: 扩展字面量 parity**

`interactive-parity.test.ts` 增加对 `EDITOR_SELECTOR`、`WRAPPER_TAGS_LIST` join 形式的 `toContain` 断言,覆盖 `probePageInjected`、`actByIdxInjected`、`installCaptureListener` 的 `toString()`,以及 `LOCATE_BY_IDX_FRAGMENT` 字符串(断言它与 act-core `findByIdxDeep` 的 shadow 遍历同形:都含 `shadowRoot` + `mode === 'open'` 递归)。

```ts
import { EDITOR_SELECTOR, WRAPPER_TAGS_LIST } from "./_shared/interactive";
import { actByIdxInjected } from "./act-core";
import { LOCATE_BY_IDX_FRAGMENT } from "./_shared/locate";

it("probe-core inlines EDITOR_SELECTOR verbatim", () => {
  expect(probePageInjected.toString()).toContain(JSON.stringify(EDITOR_SELECTOR).slice(1, -1));
});
it("probe-core inlines the full WRAPPER_TAGS_LIST", () => {
  for (const tag of WRAPPER_TAGS_LIST) expect(probePageInjected.toString()).toContain(tag);
});
it("act-core + fragment both do open-shadow recursion", () => {
  expect(actByIdxInjected.toString()).toMatch(/shadowRoot/);
  expect(LOCATE_BY_IDX_FRAGMENT).toMatch(/shadowRoot/);
  expect(LOCATE_BY_IDX_FRAGMENT).toContain("mode");
});
```

- [ ] **Step 2: 跑确认失败,补到通过**

Run: `pnpm test src/lib/dom-actions/interactive-parity.test.ts`
Expected: 先 FAIL（断言新增）→ 调整后 PASS

- [ ] **Step 3: 写往返行为 parity(最有价值)**

`probe-act-roundtrip.test.ts`:对一组 fixture(普通按钮、shadow 内按钮、Monaco 宿主、CM6 宿主、TinyMCE 宿主),`probePageInjected({op:"snapshot"})` 后,**每个** stamp 出的 `data-pie-idx`,用 `actByIdxInjected({op:"rect", idx})` 都能定位成功(`r.ok===true`)。再对 editor 宿主断言:snapshot 的 role=editor entry 的 idx == `search({searchBy:"role", query:"editor"})` 命中的 idx(同一 idx)。

```ts
it("every stamped idx is locatable by act-core (incl. shadow + editors)", () => {
  // build fixture with shadow + monaco/cm6/tinymce hosts (mock getBoundingClientRect)
  const snap = probePageInjected({ op: "snapshot" });
  if (snap.op !== "snapshot") throw new Error("narrow");
  for (const e of snap.interactiveElements) {
    const r = actByIdxInjected({ op: "rect", idx: e.pieIdx });
    // actByIdxInjected is async — await inside an async it()
    return expect(r).resolves.toMatchObject({ ok: true });
  }
});
```
(注:实际写成 `for...of` + `await`,断言每个 idx `ok===true`。)

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/__tests__/cross-layer/probe-act-roundtrip.test.ts`
Expected: PASS（happy-dom 不支持的项标注 `it.skip` + `// 真机回归`,沿用 editor.test.ts 注释惯例）

- [ ] **Step 5: Commit**

```bash
git add src/lib/dom-actions/interactive-parity.test.ts src/__tests__/cross-layer/probe-act-roundtrip.test.ts
git commit -m "test(probe): literal + round-trip parity (editor recognition + shadow locate)"
```

---

## Task 12: 全量验证 + 后续 issue

**Files:** 无代码改动

- [ ] **Step 1: 全量门禁**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 全 PASS。`grep -rn "pageSnapshotInjected\|searchPageInjected\|typeByIndex\|selectByIndex\|readRectByIdx\|focusClickByIndex" src --include="*.ts"` 应只剩历史注释,无活引用。

- [ ] **Step 2: 真机回归清单(人工)**

在 `chrome://extensions` load `dist/`,验证:① 普通页 read_page/search_page/click/type;② Monaco(如 VS Code web)/CM6(如 CodeMirror demo)/TinyMCE 页面 read_page 报 role=editor + read_editor/set_editor_value 往返 + search role=editor 命中;③ 一个 shadow-DOM 组件页(如带 web component 的站点)click/type shadow 内元素成功。记录结果。

- [ ] **Step 3: 创建后续 issue**

```bash
gh auth switch --user WiseriaAI
gh issue create --title "capture/selector 探查能力归一" --body "见 docs/specs/2026-06-07-page-probe-core-unification.md §10:为 installCaptureListener 补 shadow 穿透 + editor 识别(EDITOR_SELECTOR/TYPE_EDITOR_MARKERS),将 recording/selector.ts describeElement 与 capture buildLabelFor 归一到 _shared 权威层;评估升级方案 B(构建期内联)。"
```

- [ ] **Step 4: Commit(若有真机修)+ 收尾**

```bash
git add -A && git commit -m "chore(probe): real-device regression notes" || echo "no changes"
```

---

## Self-Review 结果

- **Spec 覆盖**:§4 架构→Task 1/2/3/5-9;§5 行为变更→Task 3(editor)/Task 5(shadow);§6 转义→Task 1/2/10;§7 留口子→Task 1(常量集中)/probe-act op union;§8 测试→Task 11;§9 回归→Task 4/8 的全量 + Task 12 真机。无遗漏。
- **类型一致**:`probePageInjected(ProbeParams):ProbeResult` discriminated by `op`;`actByIdxInjected(ActParams):Promise<ActResult>` discriminated by `op`;`LOCATE_BY_IDX_FRAGMENT` 用 `${idx}` 占位 + `.replace`。跨 task 命名统一。
- **搬运边界**:Task 2/3/6/7 明确"逐字搬 + 仅改定位与常量来源",避免重写既有策略。
