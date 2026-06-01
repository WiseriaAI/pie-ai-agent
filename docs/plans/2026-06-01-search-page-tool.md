# `search_page` 工具实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给页面加一个 `search_page` 工具——在 live DOM 全量文本上做关键词/正则搜索(绕开 `read_page` 的 50KB 截断),每个命中回最近可交互祖先的 `data-pie-idx` 锚点 + 上下文片段。

**Architecture:** 一个 self-contained 注入函数(`searchPageInjected`)在每个 frame 里跑——内联复制 `page-snapshot.ts` 的 `data-pie-idx` stamp 逻辑(保证 idx 与 `read_page` 一致),再遍历元素的直接文本节点匹配;一个 handler(`searchPageTool`)做参数归一、前置检查、`executeScript allFrames` fanout、跨 frame 聚合 + 全局截断,输出对称 `search_pdf` 的 `<search_page>` XML。语义交给 LLM(多关键词 OR)。

**Tech Stack:** TypeScript, Chrome MV3 `chrome.scripting.executeScript`, vitest + happy-dom。

**设计依据:** `docs/specs/2026-06-01-search-page-tool.md`。

**约定:** 所有 commit 按仓库约定在 message 末尾附 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer。每个 Task 跑 `pnpm test <file>` 验证后再 commit。

---

## 执行前置(在 Task 1 之前做一次)

- [ ] **当前在 `main` 分支,先开 feature 分支**

```bash
git checkout -b feat/search-page-tool
```

---

## Task 1: 注册 `untrusted_page_match` 到 wrapper 双清单

**Files:**
- Modify: `src/lib/agent/untrusted-wrappers.ts:41-57` (`UNTRUSTED_WRAPPER_TAGS`)
- Modify: `src/lib/dom-actions/page-snapshot.ts:44-53` (`WRAPPER_TAGS_LIST`)
- Test: `src/lib/agent/untrusted-wrappers.test.ts`

**为什么先做:** handler 输出的命中片段要包在 `<untrusted_page_match>` 里,且 `escapeUntrustedWrappers` 必须能中和页面伪造的同名标签。先把 wrapper 注册好,后续 task 的转义才生效。`html-strip.ts` 不涉及(其 `stripToWhitelist` 全 src 仅被自身测试引用,且早已与 PDF/local-file wrapper 脱节)。

- [ ] **Step 1: 写失败测试** — 在 `src/lib/agent/untrusted-wrappers.test.ts` 末尾的最外层(`describe` 之外或新增 describe)追加:

```ts
describe("untrusted_page_match sanitize", () => {
  it("中和 </untrusted_page_match> 闭合标签", () => {
    expect(escapeUntrustedWrappers("</untrusted_page_match>")).toContain(
      "&lt;/untrusted_page_match&gt;",
    );
  });
  it("中和全角括号变体", () => {
    expect(escapeUntrustedWrappers("＜/untrusted_page_match＞")).toContain(
      "&lt;/untrusted_page_match&gt;",
    );
  });
});
```

> 若文件顶部没有 `escapeUntrustedWrappers` 的 import,确认它已存在(现有测试已 import 它)。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/agent/untrusted-wrappers.test.ts`
Expected: FAIL — `untrusted_page_match` 尚不在 `WRAPPER_RE` 的 tag 集合,不会被转义。

- [ ] **Step 3: 加 tag 到 `untrusted-wrappers.ts`** — 在 `UNTRUSTED_WRAPPER_TAGS` 数组里 `"untrusted_local_file",` 之前(或之后,顺序不影响)加一行:

```ts
  "untrusted_pdf_match",
  "untrusted_pdf_outline_entry",
  "untrusted_page_match",
  "untrusted_local_file",
] as const;
```

(即在已有的 `untrusted_pdf_outline_entry` 与 `untrusted_local_file` 之间插入 `"untrusted_page_match",`)

- [ ] **Step 4: 加 tag 到 `page-snapshot.ts`** — `WRAPPER_TAGS_LIST` 数组里同样位置插入:

```ts
    "untrusted_pdf_page",
    "untrusted_pdf_match",
    "untrusted_pdf_outline_entry",
    "untrusted_page_match",
    "untrusted_local_file",
  ];
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/lib/agent/untrusted-wrappers.test.ts src/lib/dom-actions/page-snapshot.test.ts`
Expected: PASS(两个文件都过——page-snapshot 的现有 wrapper 转义测试不受影响)。

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent/untrusted-wrappers.ts src/lib/dom-actions/page-snapshot.ts src/lib/agent/untrusted-wrappers.test.ts
git commit -m "feat(search-page): register untrusted_page_match in wrapper dual-list"
```

---

## Task 2: `searchPageInjected` 注入函数 + 单测

**Files:**
- Create: `src/lib/dom-actions/search-page.ts`
- Test: `src/lib/dom-actions/search-page.test.ts`

**关键点:** 注入函数必须 **self-contained**(`executeScript` 只序列化函数体,所有 helper 内联,无外部 import)。stamp 逻辑(`walkDeep` / `isVisible` / `INTERACTIVE_SELECTOR` / 清除+盖 idx)**逐字复制**自 `page-snapshot.ts` 以保证 idx 一致(Task 3 加回归护栏)。interface 的类型注解仅编译期,运行时擦除,不破坏 self-contained(`page-snapshot.ts` 的 `PageSnapshotResult` 同模式)。

- [ ] **Step 1: 写失败测试** — 创建 `src/lib/dom-actions/search-page.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { searchPageInjected, type SearchPageParams } from "./search-page";

function run(overrides: Partial<SearchPageParams>) {
  const params: SearchPageParams = {
    queries: [],
    regex: false,
    mode: "all",
    maxResults: 10,
    ...overrides,
  };
  return searchPageInjected(params);
}

describe("searchPageInjected", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document
      .querySelectorAll("[data-pie-idx]")
      .forEach((el) => el.removeAttribute("data-pie-idx"));
  });

  it("子串命中,返回 matched + snippet + tag", () => {
    document.body.innerHTML = `<p>our refund policy is generous</p>`;
    const r = run({ queries: ["refund"] });
    expect(r.total).toBe(1);
    expect(r.matches[0].matched).toBe("refund");
    expect(r.matches[0].snippet).toContain("refund");
    expect(r.matches[0].tag).toBe("p");
  });

  it("大小写不敏感", () => {
    document.body.innerHTML = `<p>REFUND here</p>`;
    const r = run({ queries: ["refund"] });
    expect(r.total).toBe(1);
  });

  it("多 query OR — 命中任一即算", () => {
    document.body.innerHTML = `<p>about price</p><div>refund desk</div>`;
    const r = run({ queries: ["refund", "price"] });
    expect(r.total).toBe(2);
  });

  it("命中在可交互元素 → pie_idx 非空 + 等于 read_page 的盖号", () => {
    document.body.innerHTML = `<button>refund</button>`;
    const r = run({ queries: ["refund"] });
    expect(r.matches[0].pieIdx).toBe(0);
  });

  it("命中在普通文本 → pie_idx 为 null", () => {
    document.body.innerHTML = `<p>refund</p>`;
    const r = run({ queries: ["refund"] });
    expect(r.matches[0].pieIdx).toBeNull();
  });

  it("文本在不可交互子元素里 → 锚到最近可交互祖先", () => {
    document.body.innerHTML = `<button><span>refund</span></button>`;
    const r = run({ queries: ["refund"] });
    // span 命中,但向上锚到 button(idx 0)
    expect(r.matches[0].pieIdx).toBe(0);
  });

  it("同元素多次出现 → 只产出一条", () => {
    document.body.innerHTML = `<p>refund refund refund</p>`;
    const r = run({ queries: ["refund"] });
    expect(r.total).toBe(1);
    expect(r.matches.length).toBe(1);
  });

  it("穿透 open shadow root 搜索 + 锚 idx", () => {
    document.body.innerHTML = `<div id="host"></div>`;
    const shadow = document
      .getElementById("host")!
      .attachShadow({ mode: "open" });
    shadow.innerHTML = `<button>shadow-refund</button>`;
    const r = run({ queries: ["shadow-refund"] });
    expect(r.total).toBe(1);
    expect(r.matches[0].pieIdx).not.toBeNull();
  });

  it("snippet 长文本两端加省略号", () => {
    const long = "x".repeat(200) + "refund" + "y".repeat(200);
    document.body.innerHTML = `<p>${long}</p>`;
    const r = run({ queries: ["refund"] });
    expect(r.matches[0].snippet.startsWith("…")).toBe(true);
    expect(r.matches[0].snippet.endsWith("…")).toBe(true);
    expect(r.matches[0].snippet).toContain("refund");
  });

  it("mode=interactive 只回 pie_idx 非空命中", () => {
    document.body.innerHTML = `<button>refund btn</button><p>refund text</p>`;
    const r = run({ queries: ["refund"], mode: "interactive" });
    expect(r.matches.every((m) => m.pieIdx !== null)).toBe(true);
    expect(r.matches.length).toBe(1);
  });

  it("mode=text 只回 pie_idx 为空命中", () => {
    document.body.innerHTML = `<button>refund btn</button><p>refund text</p>`;
    const r = run({ queries: ["refund"], mode: "text" });
    expect(r.matches.every((m) => m.pieIdx === null)).toBe(true);
    expect(r.matches.length).toBe(1);
  });

  it("maxResults 截断 matches 但 total 报全量", () => {
    document.body.innerHTML = `<p>refund a</p><p>refund b</p><p>refund c</p>`;
    const r = run({ queries: ["refund"], maxResults: 1 });
    expect(r.total).toBe(3);
    expect(r.matches.length).toBe(1);
  });

  it("regex 命中,matched 是实际匹配文本", () => {
    document.body.innerHTML = `<p>refund</p>`;
    const r = run({ queries: ["ref.nd"], regex: true });
    expect(r.total).toBe(1);
    expect(r.matches[0].matched).toBe("refund");
  });

  it("regex 大小写不敏感(gi)", () => {
    document.body.innerHTML = `<p>REFUND</p>`;
    const r = run({ queries: ["ref.nd"], regex: true });
    expect(r.total).toBe(1);
  });

  it("无效 regex 返回 invalidRegex,不抛", () => {
    document.body.innerHTML = `<p>refund</p>`;
    const r = run({ queries: ["("], regex: true });
    expect(r.invalidRegex).toBeTruthy();
    expect(r.matches.length).toBe(0);
  });

  it("能匹配空串的 regex(a*) 不死循环", () => {
    document.body.innerHTML = `<p>bbb</p>`;
    const r = run({ queries: ["a*"], regex: true });
    // 不挂即可;每元素只取首个匹配
    expect(r.invalidRegex).toBeNull();
  });

  it("无命中返回空 + total 0", () => {
    document.body.innerHTML = `<p>nothing here</p>`;
    const r = run({ queries: ["refund"] });
    expect(r.total).toBe(0);
    expect(r.matches.length).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/dom-actions/search-page.test.ts`
Expected: FAIL — `Failed to resolve import "./search-page"`(文件不存在)。

- [ ] **Step 3: 实现注入函数** — 创建 `src/lib/dom-actions/search-page.ts`:

```ts
export interface SearchMatch {
  /** Nearest interactive ancestor's data-pie-idx, or null for plain text. */
  pieIdx: number | null;
  /** Lowercased tag name of the element directly containing the matched text. */
  tag: string;
  /** The matched term (substring mode) or the matched text (regex mode). */
  matched: string;
  /** ~80 chars of context around the hit, ellipsised at cut edges. */
  snippet: string;
}

export interface SearchPageResult {
  matches: SearchMatch[];
  /** Total hit elements found (before maxResults truncation). */
  total: number;
  /** True if the time-budget guard tripped mid-walk. */
  timedOut: boolean;
  /** Non-null = a regex term failed to compile; matches will be empty. */
  invalidRegex: string | null;
}

export interface SearchPageParams {
  queries: string[];
  regex: boolean;
  mode: "all" | "interactive" | "text";
  maxResults: number;
}

/**
 * Self-contained injected function. Runs via chrome.scripting.executeScript.
 * NO imports, NO outer-scope closures — all helpers nested inside. Interface
 * type annotations are erased at compile time, so referencing them here does
 * NOT break self-containment (same pattern as page-snapshot.ts).
 *
 * The stamp logic (walkDeep / isVisible / INTERACTIVE_SELECTOR / clear+stamp)
 * is copied VERBATIM from page-snapshot.ts Step C so that data-pie-idx matches
 * read_page exactly. A cross-layer test (search-page idx-parity) guards drift.
 */
export function searchPageInjected(params: SearchPageParams): SearchPageResult {
  const { queries, regex, mode, maxResults } = params;

  const SNIPPET_CONTEXT = 80;
  const TIME_BUDGET_MS = 1500;
  const MATCHED_MAX_LEN = 80;
  const MATCH_SCAN_LIMIT = 50_000;

  const INTERACTIVE_SELECTOR = [
    "a", "button", "input", "select", "textarea",
    '[role="button"]', '[role="link"]', '[role="tab"]',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
    '[role="menuitem"]', '[contenteditable="true"]',
    "summary", "[onclick]", "[tabindex]:not([tabindex='-1'])",
  ].join(", ");

  // ── walkDeep — copied verbatim from page-snapshot.ts ──
  function* walkDeep(root: Node): IterableIterator<Element> {
    if (root instanceof Element) yield root;
    const doc = (root as Element).ownerDocument ?? document;
    const tw = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const shadowRoots: ShadowRoot[] = [];
    if (root instanceof Element && root.shadowRoot && root.shadowRoot.mode === "open") {
      shadowRoots.push(root.shadowRoot);
    }
    let node: Element | null;
    while ((node = tw.nextNode() as Element | null)) {
      yield node;
      if (node.shadowRoot && node.shadowRoot.mode === "open") {
        shadowRoots.push(node.shadowRoot);
      }
    }
    for (const sr of shadowRoots) {
      yield* walkDeep(sr);
    }
  }

  // ── isVisible — copied verbatim from page-snapshot.ts ──
  function isVisible(el: Element): boolean {
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

  // ── stamp data-pie-idx (copied from page-snapshot.ts Step C) ──
  const liveBodyElements = [...walkDeep(document.body)];
  for (const el of liveBodyElements) {
    if (el.hasAttribute("data-pie-idx")) el.removeAttribute("data-pie-idx");
  }
  let stampIdx = 0;
  for (const el of liveBodyElements) {
    if (el.matches?.(INTERACTIVE_SELECTOR) && isVisible(el)) {
      el.setAttribute("data-pie-idx", String(stampIdx++));
    }
  }

  // ── find nearest ancestor (incl. self) with data-pie-idx, crossing shadow ──
  function findPieIdx(start: Element): number | null {
    let node: Node | null = start;
    while (node) {
      if (node instanceof Element && node.hasAttribute("data-pie-idx")) {
        return Number(node.getAttribute("data-pie-idx"));
      }
      if (node instanceof ShadowRoot) {
        node = node.host;
      } else {
        node = node.parentNode;
      }
    }
    return null;
  }

  // ── compile regexes (gi) if needed ──
  let regexes: RegExp[] = [];
  if (regex) {
    try {
      regexes = queries.map((q) => new RegExp(q, "gi"));
    } catch (e) {
      return {
        matches: [],
        total: 0,
        timedOut: false,
        invalidRegex: e instanceof Error ? e.message : String(e),
      };
    }
  }

  function buildSnippet(text: string, offset: number, matchLen: number): string {
    const start = Math.max(0, offset - SNIPPET_CONTEXT);
    const end = Math.min(text.length, offset + matchLen + SNIPPET_CONTEXT);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < text.length ? "…" : "";
    return prefix + text.slice(start, end) + suffix;
  }

  // First hit within `scan`; returns {offset, matched} or null. Only the FIRST
  // match per element — no while-loop over the node, so empty-match regexes
  // (e.g. a*) cannot infinite-loop.
  function firstMatch(scan: string): { offset: number; matched: string } | null {
    let best: { offset: number; matched: string } | null = null;
    if (regex) {
      for (const re of regexes) {
        re.lastIndex = 0;
        const m = re.exec(scan);
        if (m && (best === null || m.index < best.offset)) {
          best = { offset: m.index, matched: m[0].slice(0, MATCHED_MAX_LEN) };
        }
      }
    } else {
      const lower = scan.toLowerCase();
      for (const q of queries) {
        if (!q) continue;
        const idx = lower.indexOf(q.toLowerCase());
        if (idx !== -1 && (best === null || idx < best.offset)) {
          best = { offset: idx, matched: scan.slice(idx, idx + q.length) };
        }
      }
    }
    return best;
  }

  const startTime = performance.now();
  const matches: SearchMatch[] = [];
  let total = 0;
  let timedOut = false;

  for (const el of liveBodyElements) {
    if (performance.now() - startTime > TIME_BUDGET_MS) {
      timedOut = true;
      break;
    }
    // direct Text children only → attribute the hit to the closest element
    let direct = "";
    for (const child of el.childNodes) {
      if (child.nodeType === 3) direct += child.nodeValue ?? "";
    }
    const text = direct.trim();
    if (!text) continue;

    const hit = firstMatch(text.slice(0, MATCH_SCAN_LIMIT));
    if (!hit) continue;

    const pieIdx = findPieIdx(el);
    if (mode === "interactive" && pieIdx === null) continue;
    if (mode === "text" && pieIdx !== null) continue;

    total++;
    if (matches.length < maxResults) {
      matches.push({
        pieIdx,
        tag: el.tagName.toLowerCase(),
        matched: hit.matched,
        snippet: buildSnippet(text, hit.offset, hit.matched.length),
      });
    }
  }

  return { matches, total, timedOut, invalidRegex: null };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/dom-actions/search-page.test.ts`
Expected: PASS(全部用例)。

> 若 `mode=interactive`/`text` 用例失败,检查 `findPieIdx` 的 shadow 跨界分支;若 shadow 用例失败,确认 `walkDeep` 与 page-snapshot.ts 逐字一致。

- [ ] **Step 5: Commit**

```bash
git add src/lib/dom-actions/search-page.ts src/lib/dom-actions/search-page.test.ts
git commit -m "feat(search-page): searchPageInjected — text search + pie_idx anchoring + regex guards"
```

---

## Task 3: 跨层 `data-pie-idx` 一致性回归测试

**Files:**
- Test: `src/lib/dom-actions/search-page.test.ts`(追加)

**为什么:** spec 标的关键不变量——`searchPageInjected` 与 `pageSnapshotInjected` 在同一页面上盖出的 `data-pie-idx` 必须一致(两者用复制的同一算法)。这条护栏防止未来改一处忘改另一处导致 LLM 拿错 idx 点错元素。

- [ ] **Step 1: 写测试** — 在 `search-page.test.ts` 顶部 import 加 `pageSnapshotInjected`,并追加一个 describe:

```ts
import { pageSnapshotInjected } from "./page-snapshot";

describe("search_page ↔ read_page idx parity (cross-layer regression)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document
      .querySelectorAll("[data-pie-idx]")
      .forEach((el) => el.removeAttribute("data-pie-idx"));
  });

  it("两个注入函数盖出的 idx→element 映射相同", () => {
    document.body.innerHTML = `
      <h1>Title</h1>
      <button id="b0">A</button>
      <a id="a1" href="/x">B</a>
      <input id="i2" type="text">
      <p>plain text refund</p>
      <div id="host"></div>
    `;
    const shadow = document
      .getElementById("host")!
      .attachShadow({ mode: "open" });
    shadow.innerHTML = `<button id="sb">S</button>`;

    // read_page stamps first
    pageSnapshotInjected();
    const fromRead = new Map<string, string | null>();
    for (const id of ["b0", "a1", "i2"]) {
      fromRead.set(id, document.getElementById(id)!.getAttribute("data-pie-idx"));
    }
    fromRead.set("sb", shadow.getElementById("sb")!.getAttribute("data-pie-idx"));

    // search_page re-stamps (clears + restamps with the copied algorithm)
    searchPageInjected({ queries: ["refund"], regex: false, mode: "all", maxResults: 10 });
    for (const id of ["b0", "a1", "i2"]) {
      expect(document.getElementById(id)!.getAttribute("data-pie-idx")).toBe(
        fromRead.get(id),
      );
    }
    expect(shadow.getElementById("sb")!.getAttribute("data-pie-idx")).toBe(
      fromRead.get("sb"),
    );
  });
});
```

- [ ] **Step 2: 跑测试确认通过**(Task 2 的复制若正确,此处直接 PASS)

Run: `pnpm test src/lib/dom-actions/search-page.test.ts`
Expected: PASS。若 FAIL — 说明 `searchPageInjected` 的 stamp 段与 `page-snapshot.ts` Step C 有偏差,逐字比对 `walkDeep`/`isVisible`/`INTERACTIVE_SELECTOR`/stamp 循环。

- [ ] **Step 3: Commit**

```bash
git add src/lib/dom-actions/search-page.test.ts
git commit -m "test(search-page): cross-layer data-pie-idx parity with read_page"
```

---

## Task 4: `searchPageTool` handler + 单测

**Files:**
- Create: `src/lib/agent/tools/search-page.ts`
- Test: `src/lib/agent/tools/search-page.test.ts`

- [ ] **Step 1: 写失败测试** — 创建 `src/lib/agent/tools/search-page.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { searchPageTool } from "./search-page";

function frameResult(frameId: number, matches: any[], total: number, extra?: Partial<any>) {
  return {
    frameId,
    result: { matches, total, timedOut: false, invalidRegex: null, ...extra },
  };
}

describe("search_page tool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function stubChrome(opts: {
    tab?: any;
    inject?: any[];
    injectThrows?: boolean;
  }) {
    const tab = opts.tab ?? { id: 7, url: "https://example.com/", discarded: false };
    vi.stubGlobal("chrome", {
      tabs: { get: vi.fn().mockResolvedValue(tab) },
      scripting: {
        executeScript: opts.injectThrows
          ? vi.fn().mockRejectedValue(new Error("boom"))
          : vi.fn().mockResolvedValue(opts.inject ?? []),
      },
    });
  }

  it("成功 — observation 含 search_page + untrusted_page_match + frame_id + pie_idx", async () => {
    stubChrome({
      inject: [
        frameResult(0, [{ pieIdx: 3, tag: "button", matched: "refund", snippet: "…refund…" }], 1),
      ],
    });
    const r = await searchPageTool.handler(
      { tabId: 7, query: "refund" },
      {} as any,
    );
    expect(r.success).toBe(true);
    expect(r.observation).toContain("<search_page");
    expect(r.observation).toContain('total_matches="1"');
    expect(r.observation).toContain('mode="all"');
    expect(r.observation).toContain('<untrusted_page_match frame_id="0" pie_idx="3"');
    expect(r.observation).toContain('tag="button"');
    expect(r.observation).toContain('matched="refund"');
  });

  it("纯文本命中 pie_idx 输出空串", async () => {
    stubChrome({
      inject: [frameResult(0, [{ pieIdx: null, tag: "p", matched: "x", snippet: "x" }], 1)],
    });
    const r = await searchPageTool.handler({ tabId: 7, query: "x" }, {} as any);
    expect(r.observation).toContain('pie_idx=""');
  });

  it("无命中 → no matches", async () => {
    stubChrome({ inject: [frameResult(0, [], 0)] });
    const r = await searchPageTool.handler({ tabId: 7, query: "zzz" }, {} as any);
    expect(r.success).toBe(true);
    expect(r.observation).toContain('total_matches="0"');
    expect(r.observation).toContain("no matches");
  });

  it("空 query → empty_query 错误", async () => {
    stubChrome({ inject: [] });
    const r = await searchPageTool.handler({ tabId: 7, query: "   " }, {} as any);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/empty_query/);
  });

  it("数组 query 被接受", async () => {
    stubChrome({
      inject: [frameResult(0, [{ pieIdx: null, tag: "p", matched: "a", snippet: "a" }], 1)],
    });
    const r = await searchPageTool.handler(
      { tabId: 7, query: ["a", "b"] },
      {} as any,
    );
    expect(r.success).toBe(true);
    // executeScript 收到归一化后的 queries
    const call = (chrome.scripting.executeScript as any).mock.calls[0][0];
    expect(call.args[0].queries).toEqual(["a", "b"]);
  });

  it("非数字 tabId → 错误", async () => {
    stubChrome({ inject: [] });
    const r = await searchPageTool.handler({ query: "x" } as any, {} as any);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/tabId/);
  });

  it("PDF tab → pdf_tab 错误", async () => {
    stubChrome({ tab: { id: 7, url: "https://x.com/file.pdf", discarded: false } });
    // isPdfTab 走 url 后缀/类型判定;用 .pdf 后缀触发
    const r = await searchPageTool.handler({ tabId: 7, query: "x" }, {} as any);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/pdf_tab|PDF/i);
  });

  it("restricted scheme → 错误", async () => {
    stubChrome({ tab: { id: 7, url: "chrome://settings/", discarded: false } });
    const r = await searchPageTool.handler({ tabId: 7, query: "x" }, {} as any);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/restricted/i);
  });

  it("跨 frame 聚合 — total 求和 + frame_id 标注", async () => {
    stubChrome({
      inject: [
        frameResult(0, [{ pieIdx: 1, tag: "a", matched: "x", snippet: "x" }], 1),
        frameResult(3, [{ pieIdx: 2, tag: "button", matched: "x", snippet: "x" }], 1),
      ],
    });
    const r = await searchPageTool.handler(
      { tabId: 7, query: "x", max_results: 50 },
      {} as any,
    );
    expect(r.observation).toContain('total_matches="2"');
    expect(r.observation).toContain('frame_id="0"');
    expect(r.observation).toContain('frame_id="3"');
  });

  it("跨 frame 合并超 max_results → 全局截断 + truncated", async () => {
    stubChrome({
      inject: [
        frameResult(0, [{ pieIdx: 0, tag: "p", matched: "x", snippet: "x" }], 1),
        frameResult(3, [{ pieIdx: 1, tag: "p", matched: "x", snippet: "x" }], 1),
      ],
    });
    const r = await searchPageTool.handler(
      { tabId: 7, query: "x", max_results: 1 },
      {} as any,
    );
    expect(r.observation).toContain('total_matches="2"');
    expect(r.observation).toContain('truncated="true"');
    // 只渲染 1 条
    expect((r.observation!.match(/<untrusted_page_match/g) ?? []).length).toBe(1);
  });

  it("invalidRegex → invalid_regex 错误", async () => {
    stubChrome({
      inject: [frameResult(0, [], 0, { invalidRegex: "Unterminated group" })],
    });
    const r = await searchPageTool.handler(
      { tabId: 7, query: "(", regex: true },
      {} as any,
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/invalid_regex/);
  });

  it("timedOut 透传到 observation", async () => {
    stubChrome({
      inject: [frameResult(0, [{ pieIdx: 0, tag: "p", matched: "x", snippet: "x" }], 1, { timedOut: true })],
    });
    const r = await searchPageTool.handler({ tabId: 7, query: "x" }, {} as any);
    expect(r.observation).toContain('timed_out="true"');
  });

  it("命中片段里的 wrapper 字面被转义", async () => {
    stubChrome({
      inject: [
        frameResult(0, [
          { pieIdx: null, tag: "p", matched: "x", snippet: "x </untrusted_page_match> y" },
        ], 1),
      ],
    });
    const r = await searchPageTool.handler({ tabId: 7, query: "x" }, {} as any);
    expect(r.observation).toContain("&lt;/untrusted_page_match&gt;");
  });

  it("executeScript 抛错 → success false", async () => {
    stubChrome({ injectThrows: true });
    const r = await searchPageTool.handler({ tabId: 7, query: "x" }, {} as any);
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/agent/tools/search-page.test.ts`
Expected: FAIL — `Failed to resolve import "./search-page"`。

- [ ] **Step 3: 实现 handler** — 创建 `src/lib/agent/tools/search-page.ts`:

```ts
import type { Tool, ToolHandlerContext } from "../types";
import type { ActionResult } from "../../dom-actions/types";
import { searchPageInjected, type SearchPageResult } from "../../dom-actions/search-page";
import { escapeWrapperAttribute, escapeUntrustedWrappers } from "../untrusted-wrappers";
import { isRestrictedSchemeForGrouping } from "./tabs";
import { isPdfTab } from "@/lib/pdf/detect";

const DEFAULT_MAX = 10;

interface SearchPageArgs {
  tabId?: number;
  query?: string | string[];
  max_results?: number;
  mode?: "all" | "interactive" | "text";
  regex?: boolean;
}

export const searchPageTool: Tool = {
  name: "search_page",
  description:
    "Search the given tab's visible text for one or more terms and return matches with the " +
    "nearest interactive element index (data-pie-idx) plus a surrounding snippet — across all " +
    "frames, without read_page's 50KB truncation. Pass an array of terms to OR-search (expand an " +
    "abstract intent into synonyms in one call). Each match's pie_idx is non-empty when the hit " +
    "is in a clickable element (use it directly with click/type) or empty for plain text. " +
    "Note: matching is per-element direct text, so a phrase split across inline tags (e.g. <a>) " +
    "may need shorter keywords. For PDF tabs use search_pdf instead.",
  parameters: {
    type: "object",
    properties: {
      tabId: { type: "integer", description: "Tab id to search." },
      query: {
        description: "One term (string) or several terms (array, OR-matched). Case-insensitive.",
        anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
      },
      max_results: {
        type: "integer",
        description: "Default 10. Capped at 50.",
        default: DEFAULT_MAX,
        minimum: 1,
        maximum: 50,
      },
      mode: {
        type: "string",
        enum: ["all", "interactive", "text"],
        description:
          "all (default) = all text; interactive = only text inside clickable elements; " +
          "text = only non-interactive body text.",
      },
      regex: {
        type: "boolean",
        description: "Default false (literal substring). true = each term is a regex (flags gi).",
      },
    },
    required: ["tabId", "query"],
    additionalProperties: false,
  },
  handler: async (args: unknown, _ctx: ToolHandlerContext): Promise<ActionResult> => {
    const a = (args ?? {}) as SearchPageArgs;
    if (typeof a.tabId !== "number") {
      return { success: false, error: "search_page requires a numeric tabId" };
    }
    const rawQueries = Array.isArray(a.query)
      ? a.query
      : typeof a.query === "string"
        ? [a.query]
        : [];
    const queries = rawQueries
      .map((q) => (typeof q === "string" ? q.trim() : ""))
      .filter((q) => q.length > 0);
    if (queries.length === 0) {
      return { success: false, error: "empty_query: provide at least one non-empty search term" };
    }
    const rawMax =
      typeof a.max_results === "number" && Number.isFinite(a.max_results)
        ? a.max_results
        : DEFAULT_MAX;
    const maxResults = Math.min(50, Math.max(1, Math.floor(rawMax)));
    const mode: "all" | "interactive" | "text" =
      a.mode === "interactive" || a.mode === "text" ? a.mode : "all";
    const regex = a.regex === true;

    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(a.tabId);
    } catch {
      return { success: false, error: "Tab not found" };
    }
    if (isPdfTab(tab)) {
      return { success: false, error: "pdf_tab: This tab is a PDF. Use search_pdf instead." };
    }
    if (!tab.url || isRestrictedSchemeForGrouping(tab.url)) {
      return { success: false, error: "restrictedUrl: cannot read restricted-scheme tabs" };
    }
    if (tab.discarded) {
      return { success: false, error: "discardedTabRequiresActivation" };
    }

    let results: chrome.scripting.InjectionResult<SearchPageResult>[];
    try {
      results = (await chrome.scripting.executeScript({
        target: { tabId: a.tabId, allFrames: true },
        func: searchPageInjected,
        args: [{ queries, regex, mode, maxResults }],
      })) as chrome.scripting.InjectionResult<SearchPageResult>[];
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : "executeScript failed" };
    }

    // Invalid regex surfaces identically on every frame — report the first.
    for (const r of results) {
      if (r.result?.invalidRegex) {
        return { success: false, error: `invalid_regex: ${r.result.invalidRegex}` };
      }
    }

    const sorted = [...results].sort((x, y) => (x.frameId ?? 0) - (y.frameId ?? 0));
    const rows: { frameId: number; m: SearchMatchRow }[] = [];
    let total = 0;
    let timedOut = false;
    for (const r of sorted) {
      const data = r.result;
      if (!data) continue;
      total += data.total;
      if (data.timedOut) timedOut = true;
      for (const m of data.matches) {
        rows.push({ frameId: r.frameId ?? 0, m });
      }
    }

    if (total === 0) {
      return {
        success: true,
        observation: `<search_page total_matches="0" mode="${mode}">no matches</search_page>`,
      };
    }

    const shown = rows.slice(0, maxResults);
    const truncated = total > shown.length;

    const lines = shown.map((row) => {
      const idxAttr = row.m.pieIdx === null ? "" : String(row.m.pieIdx);
      return (
        `  <untrusted_page_match frame_id="${row.frameId}" pie_idx="${idxAttr}" ` +
        `tag="${escapeWrapperAttribute(row.m.tag)}" matched="${escapeWrapperAttribute(row.m.matched)}">` +
        `${escapeUntrustedWrappers(row.m.snippet)}</untrusted_page_match>`
      );
    });

    const headerAttrs = [`total_matches="${total}"`, `mode="${mode}"`];
    if (truncated) headerAttrs.push(`truncated="true"`);
    if (timedOut) headerAttrs.push(`timed_out="true"`);

    const observation =
      `<search_page ${headerAttrs.join(" ")}>\n` + `${lines.join("\n")}\n` + `</search_page>`;
    return { success: true, observation };
  },
};

type SearchMatchRow = SearchPageResult["matches"][number];
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/agent/tools/search-page.test.ts`
Expected: PASS(全部)。

> PDF tab 用例若失败:检查 `@/lib/pdf/detect` 的 `isPdfTab` 判定条件,必要时把测试 tab 的 url 换成更明确的 PDF 形态(参考 `src/lib/pdf/detect.ts` 的实现)。

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/tools/search-page.ts src/lib/agent/tools/search-page.test.ts
git commit -m "feat(search-page): searchPageTool handler — fanout, aggregate, truncate, escape"
```

---

## Task 5: 注册 `search_page` 到 registry

**Files:**
- Modify: `src/lib/agent/tool-names.ts:71-73` (`PAGE_SNAPSHOT_TOOL_NAMES`) + `:180-181` (`TOOL_CLASSES`)
- Modify: `src/lib/agent/tools.ts:13` (import) + `:293` (`BUILT_IN_TOOLS`)
- Test: `src/lib/agent/tools/search-page.test.ts`(追加 registry describe)

- [ ] **Step 1: 写失败测试** — 在 `src/lib/agent/tools/search-page.test.ts` 追加:

```ts
import { BUILT_IN_TOOLS } from "../tools";
import { getToolClass } from "../tool-names";

describe("search_page registry", () => {
  it("在 BUILT_IN_TOOLS 中", () => {
    expect(BUILT_IN_TOOLS.find((t) => t.name === "search_page")).toBeTruthy();
  });
  it("分类为 read", () => {
    expect(getToolClass("search_page")).toBe("read");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/agent/tools/search-page.test.ts`
Expected: FAIL — `search_page` 不在 `BUILT_IN_TOOLS`;`getToolClass` 返回默认 `"read"` 可能误过,但 `BUILT_IN_TOOLS` 用例必失败。

- [ ] **Step 3: 加进 `PAGE_SNAPSHOT_TOOL_NAMES`** — `src/lib/agent/tool-names.ts`,把:

```ts
export const PAGE_SNAPSHOT_TOOL_NAMES = [
  "read_page",
] as const;
```

改为:

```ts
export const PAGE_SNAPSHOT_TOOL_NAMES = [
  "read_page",
  "search_page",
] as const;
```

- [ ] **Step 4: 加进 `TOOL_CLASSES`** — 同文件,在 `read_page: "read",` 行之后加:

```ts
  // Page snapshot tool — reads page DOM structure, no tab/page state mutation
  read_page: "read",
  search_page: "read",
```

(即在已有的 `read_page: "read",` 下面插入 `search_page: "read",`)

> 注:`search_page` 一旦进入 `PAGE_SNAPSHOT_TOOL_NAMES`(→ `KNOWN_BUILT_IN_TOOL_NAMES`),若没加 `TOOL_CLASSES` 条目,模块加载即 throw([M3-U4] 检查)。两步必须同改。

- [ ] **Step 5: 注册进 `BUILT_IN_TOOLS`** — `src/lib/agent/tools.ts`:

import 段(`readPageTool` import 附近)加:

```ts
import { readPageTool } from "./tools/read-page";
import { searchPageTool } from "./tools/search-page";
```

`BUILT_IN_TOOLS` 数组里 `readPageTool,` 之后加 `searchPageTool,`:

```ts
  readPageTool,
  searchPageTool,
  ...PDF_TOOLS,
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm test src/lib/agent/tools/search-page.test.ts`
Expected: PASS(registry 两条 + 之前全部)。

- [ ] **Step 7: Commit**

```bash
git add src/lib/agent/tool-names.ts src/lib/agent/tools.ts src/lib/agent/tools/search-page.test.ts
git commit -m "feat(search-page): register search_page in tool registry (read-class)"
```

---

## Task 6: 全量验证 + 收尾

**Files:** 无新增(验证 + 可选文档)

- [ ] **Step 1: 跑全量测试**

Run: `pnpm test`
Expected: 全绿。重点确认未破坏 `read-page.test.ts`、`page-snapshot.test.ts`、`untrusted-wrappers.test.ts`、`tools` registry 相关测试。

- [ ] **Step 2: 生产构建(验证 build-time invariant + 注入函数可打包)**

Run: `pnpm build`
Expected: 构建成功。`tool-names.ts`/`tools.ts` 的 build-time throw 未触发(说明 `search_page` read/write 分类完整)。

- [ ] **Step 3:(若可用)类型检查**

Run: `pnpm typecheck`(若该 script 存在 — 见 repo memory:PR #97 接回了 typecheck 门禁)
Expected: 0 错。若 `pnpm typecheck` 不存在则跳过(以 `pnpm test` + `pnpm build` 为准,见 CLAUDE.md)。

- [ ] **Step 4: 人工冒烟(可选,推荐)**

`pnpm dev` → 加载 `dist/` → 在一个长页面(如长 GitHub issue / 文档)让 agent 调 `search_page`,确认:
- 关键词命中回 `pie_idx` 能直接 `click`
- 大页面不再因 50KB 截断丢目标
- `mode=interactive` / 多关键词 / `regex=true` 各跑一次

- [ ] **Step 5: 确认无遗漏后,本计划完成。** 后续按 `finishing-a-development-branch` 决定合并/PR(本计划不含合并动作)。

---

## Self-Review 备注(plan 作者已核对)

- **Spec 覆盖:** Tool 契约(Task 4 参数/输出)、抓取+idx 锚定(Task 2)、搜索算法含 regex/守卫(Task 2)、边界 PDF/restricted(Task 4)、untrusted 双清单(Task 1)、tool 分类(Task 5)、跨层 idx 一致性(Task 3)、测试策略(Task 2/3/4/5)——逐条有对应 task。
- **类型一致:** `SearchPageParams`/`SearchMatch`/`SearchPageResult`(Task 2 定义)在 handler(Task 4)以 `import type { SearchPageResult }` + `SearchMatchRow` 派生引用;注入函数签名 `searchPageInjected(params: SearchPageParams)` 与 handler 的 `args: [{ queries, regex, mode, maxResults }]` 字段一一对应。
- **无占位符:** 所有 step 含真实代码/命令/预期输出。
- **已知局限已在 spec + tool description 注明:** 只搜元素直接文本(跨 inline 短语可能漏)、不搜 input value/属性文本。
