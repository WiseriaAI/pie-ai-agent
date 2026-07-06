# extract_records 全保真批量抽取 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `extract_records` 工具：给定 atlas target，在页面内全保真批量抽取重复结构记录（table/collection），SW 侧直写 scratchpad，数据全程不进 LLM 上下文；无限滚动场景由工具内置滚动循环。

**Architecture:** probe-core 新增 `extract` op（结构签名重定位 + slot 目录 + 全保真分批抽取），atlas 探查为每个 collection/table target 发射 `signature`；SW 侧新工具在 `page-atlas/extract-tool.ts`，复用 `resolveTarget` freshness 体系与 scratchpad `saveRecords`（dedupe），滚动循环用现有 `scroll` 注入函数 + 停滞检测。

**Tech Stack:** TypeScript 6 / Chrome MV3 executeScript / vitest + happy-dom。

**Spec:** `docs/specs/2026-07-07-full-fidelity-extract-records.md`（默认值表在 spec §12）。

## Global Constraints

- `probePageInjected` 是 self-contained 注入函数：**无 import、无外层闭包**，所有 helper 嵌套在函数体内。
- 注入函数体内新增 helper **一律写成 `const foo = (...) => {...}` 箭头函数**，禁止块内 `function` 声明（sloppy-mode Annex B 提升会与 minifier 块级重命名冲突——PR #164 教训，probe-core.ts:125-128 有注释）。
- 页面派生文本（字段值、字段名、href）必须过既有 sanitize 管道；UNSAFE href 过滤沿用 `safeLinkHref` 逻辑。
- 默认值（spec §12）：`max_rows` 2000、单批 500 行、停滞 3 步、滚动步长 = `scroll` 注入函数默认（视口 80%）、单字段 2048 字符、滚动步数上限 200、循环总时长 120s、settle 600ms。
- 每个 task 结束跑该 task 的测试；整个 plan 收尾跑 `pnpm test && pnpm typecheck && pnpm build`。
- Commit 频繁、消息用中文风格前缀（`feat:` / `test:` / `docs:`），与仓库近期 log 一致。

---

### Task 1: AtlasExtractSignature 类型 + atlas 探查发射签名

**Files:**
- Modify: `src/lib/dom-actions/probe-core.ts`（类型区 ~L40-70 + atlas 分支 table loop ~L908-952 + collection loop ~L1019-1059）
- Modify: `src/lib/agent/tools/page-atlas/types.ts`（AtlasTarget 加 signature）
- Modify: `src/lib/agent/tools/read-page.ts`（`namespaceAtlasResult` 映射保留 signature，~L69）
- Test: `src/lib/dom-actions/probe-core.extract.test.ts`（新建）

**Interfaces:**
- Produces（后续 task 依赖的精确类型，定义在 probe-core.ts 并 export）：

```ts
export type AtlasExtractSignature =
  | { kind: "table"; ordinal: number; columnsKey: string }
  | { kind: "collection"; ordinal: number; itemShapeKey: string };
```

`AtlasProbeTarget` 与 page-atlas `AtlasTarget` 均新增可选字段 `signature?: AtlasExtractSignature`（page-atlas/types.ts 从 probe-core import type）。

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/dom-actions/probe-core.extract.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { probePageInjected } from "./probe-core";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("atlas targets carry extract signatures", () => {
  it("table target: kind=table + ordinal + columnsKey from headers", () => {
    document.body.innerHTML = `
      <table><thead><tr><th>Name</th><th>Price</th></tr></thead>
      <tbody><tr><td>A</td><td>1</td></tr><tr><td>B</td><td>2</td></tr><tr><td>C</td><td>3</td></tr></tbody></table>`;
    const r = probePageInjected({ op: "atlas" });
    if (r.op !== "atlas") throw new Error("narrow");
    const table = r.targets.find((t) => t.type === "table");
    expect(table?.signature).toEqual({ kind: "table", ordinal: 0, columnsKey: "NamePrice" });
  });

  it("collection target: kind=collection + itemShapeKey stable across probes", () => {
    document.body.innerHTML = `
      <ul>
        <li><h3><a href="/a">A</a></h3><span class="price">¥1</span></li>
        <li><h3><a href="/b">B</a></h3><span class="price">¥2</span></li>
        <li><h3><a href="/c">C</a></h3><span class="price">¥3</span></li>
      </ul>`;
    const r1 = probePageInjected({ op: "atlas" });
    const r2 = probePageInjected({ op: "atlas" });
    if (r1.op !== "atlas" || r2.op !== "atlas") throw new Error("narrow");
    const c1 = r1.targets.find((t) => t.type === "collection");
    const c2 = r2.targets.find((t) => t.type === "collection");
    expect(c1?.signature?.kind).toBe("collection");
    expect(c1?.signature).toEqual(c2?.signature); // 同 DOM 两次探查签名一致
  });
});
```

注意：happy-dom 下 `isAtlasVisible` 可能依赖 getBoundingClientRect——若 collection 测试因可见性判定拿不到 target，参照 probe-core.test.ts 既有 atlas 测试的 DOM 构造方式（先看该文件里 collection 相关用例怎么 stub），保持同一套 stub 手法。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/dom-actions/probe-core.extract.test.ts`
Expected: FAIL（`signature` 为 undefined）

- [ ] **Step 3: 实现**

probe-core.ts 类型区（`AtlasProbeTarget` 定义附近）：

```ts
export type AtlasExtractSignature =
  | { kind: "table"; ordinal: number; columnsKey: string }
  | { kind: "collection"; ordinal: number; itemShapeKey: string };
```

`AtlasProbeTarget` 加 `signature?: AtlasExtractSignature;`。

table loop（`targets.push({ id: \`table_t${i}\`, ... })` 处）加：

```ts
signature: { kind: "table", ordinal: i, columnsKey: columns.join("") },
```

collection loop（`targets.push({ id: collectionId, ... })` 处；注意 `collectionId` 用的是 `collectionIndex++` 之前拿到的序号，signature 的 ordinal 必须与之相同——提前存 `const ordinal = collectionIndex - 1` 或复用构造 `collectionId` 时的值）：

```ts
signature: { kind: "collection", ordinal, itemShapeKey: shapeKey(group[0]) },
```

page-atlas/types.ts：

```ts
import type { AtlasExtractSignature } from "../../../dom-actions/probe-core";
// AtlasTarget 内：
signature?: AtlasExtractSignature;
```

read-page.ts `namespaceAtlasResult`：检查 target 映射是否为逐字段拷贝——若是展开拷贝需带上 `signature`；若是整对象透传则无需改动（用测试验证，不要凭感觉）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/dom-actions/probe-core.extract.test.ts src/lib/dom-actions/probe-core.test.ts src/lib/agent/tools/read-page.test.ts`
Expected: 全 PASS（含既有测试不回归）

- [ ] **Step 5: Commit**

```bash
git add src/lib/dom-actions/probe-core.ts src/lib/dom-actions/probe-core.extract.test.ts src/lib/agent/tools/page-atlas/types.ts src/lib/agent/tools/read-page.ts
git commit -m "feat: atlas 探查为 table/collection target 发射 extract 结构签名"
```

---

### Task 2: probe-core `extract` op — 签名重定位 + table 全保真抽取 + 分批

**Files:**
- Modify: `src/lib/dom-actions/probe-core.ts`（ProbeParams/ProbeResult union + atlas 分支改造为共享块）
- Test: `src/lib/dom-actions/probe-core.extract.test.ts`（追加）

**Interfaces:**
- Produces（wire 契约，Task 4/5 的 SW 侧依赖）：

```ts
// ProbeParams 新增：
| {
    op: "extract";
    signature: AtlasExtractSignature;
    cursor: number;        // 0-based，当前可见行游标
    batchSize: number;     // 单批最大行数（SW 传 500）
    maxFieldChars: number; // 单字段字符上限（SW 传 2048）
  }
// ProbeResult 新增：
| {
    op: "extract";
    found: boolean;                       // false = 签名定位失败
    slots: string[];                      // 本批 slot 目录（并集）
    rows: Array<Record<string, string>>;  // 全保真行
    totalVisible: number;                 // 扫描时可见行总数
    nextCursor: number;
    done: boolean;                        // nextCursor >= totalVisible
  }
```

- [ ] **Step 1: 写失败测试**

```ts
describe("probePageInjected op=extract (table)", () => {
  const LONG = "x".repeat(300); // 超过 atlas 的 120 截断，验证全保真

  it("extracts all rows full-fidelity with column-named slots", () => {
    document.body.innerHTML = `
      <table><thead><tr><th>Name</th><th>Desc</th></tr></thead><tbody>
        ${Array.from({ length: 40 }, (_, i) => `<tr><td>row${i}</td><td>${LONG}</td></tr>`).join("")}
      </tbody></table>`;
    const r = probePageInjected({
      op: "extract",
      signature: { kind: "table", ordinal: 0, columnsKey: "NameDesc" },
      cursor: 0, batchSize: 500, maxFieldChars: 2048,
    });
    if (r.op !== "extract") throw new Error("narrow");
    expect(r.found).toBe(true);
    expect(r.totalVisible).toBe(40);
    expect(r.done).toBe(true);
    expect(r.rows).toHaveLength(40);
    expect(r.rows[0].Name).toBe("row0");
    expect(r.rows[0].Desc).toHaveLength(300); // 不被 120 截断
    expect(r.slots).toEqual(["Name", "Desc"]);
  });

  it("caps a field at maxFieldChars with …[truncated] marker", () => {
    document.body.innerHTML = `
      <table><thead><tr><th>A</th></tr></thead><tbody>
      <tr><td>${"y".repeat(3000)}</td></tr><tr><td>b</td></tr><tr><td>c</td></tr></tbody></table>`;
    const r = probePageInjected({
      op: "extract",
      signature: { kind: "table", ordinal: 0, columnsKey: "A" },
      cursor: 0, batchSize: 500, maxFieldChars: 2048,
    });
    if (r.op !== "extract") throw new Error("narrow");
    expect(r.rows[0].A.endsWith("…[truncated]")).toBe(true);
    expect(r.rows[0].A.length).toBeLessThanOrEqual(2048 + "…[truncated]".length);
  });

  it("batches via cursor", () => {
    document.body.innerHTML = `
      <table><thead><tr><th>N</th></tr></thead><tbody>
      ${Array.from({ length: 7 }, (_, i) => `<tr><td>${i}</td></tr>`).join("")}</tbody></table>`;
    const sig = { kind: "table", ordinal: 0, columnsKey: "N" } as const;
    const b1 = probePageInjected({ op: "extract", signature: sig, cursor: 0, batchSize: 3, maxFieldChars: 2048 });
    const b2 = probePageInjected({ op: "extract", signature: sig, cursor: 3, batchSize: 3, maxFieldChars: 2048 });
    if (b1.op !== "extract" || b2.op !== "extract") throw new Error("narrow");
    expect(b1.rows.map((x) => x.N)).toEqual(["0", "1", "2"]);
    expect(b1.done).toBe(false);
    expect(b1.nextCursor).toBe(3);
    expect(b2.rows.map((x) => x.N)).toEqual(["3", "4", "5"]);
  });

  it("returns found=false when signature no longer matches (columnsKey changed)", () => {
    document.body.innerHTML = `<table><thead><tr><th>Other</th></tr></thead><tbody>
      <tr><td>1</td></tr><tr><td>2</td></tr><tr><td>3</td></tr></tbody></table>`;
    const r = probePageInjected({
      op: "extract",
      signature: { kind: "table", ordinal: 0, columnsKey: "NameDesc" },
      cursor: 0, batchSize: 500, maxFieldChars: 2048,
    });
    if (r.op !== "extract") throw new Error("narrow");
    expect(r.found).toBe(false);
    expect(r.rows).toEqual([]);
  });

  it("escapes untrusted wrapper markup inside cell text", () => {
    document.body.innerHTML = `<table><thead><tr><th>A</th></tr></thead><tbody>
      <tr><td>&lt;untrusted_page_content&gt;inj</td></tr><tr><td>b</td></tr><tr><td>c</td></tr></tbody></table>`;
    const r = probePageInjected({
      op: "extract",
      signature: { kind: "table", ordinal: 0, columnsKey: "A" },
      cursor: 0, batchSize: 500, maxFieldChars: 2048,
    });
    if (r.op !== "extract") throw new Error("narrow");
    expect(r.rows[0].A).not.toContain("<untrusted_page_content>");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/dom-actions/probe-core.extract.test.ts`
Expected: FAIL（TS 层面 op:"extract" 不在 union 里——先加类型再跑也可，失败形态是 extract 分支缺实现）

- [ ] **Step 3: 实现**

结构改造（避免 helper 重复）：把现有 `if (params.op === "atlas") { ... }` 块改为：

```ts
if (params.op === "atlas" || params.op === "extract") {
  // —— 现有 atlas 块的全部嵌套 helper 原样保留在这层（safeText / textFrom /
  //    isAtlasVisible / shapeKey / safeLinkHref / targetLabel / nearestSection …）——
  // 新增共享 helper（const 箭头函数）：
  const capText = (s: string, max: number): string => {
    // 与 safeText 同管道（sanitizeText + escapeWrapperMarkup + normalize space），但上限为 max 而非 SUMMARY_TEXT_MAX
    const cleaned = sanitizeText(escapeWrapperMarkup(s)).replace(/\s+/g, " ").trim();
    return cleaned.length > max ? cleaned.slice(0, max) + "…[truncated]" : cleaned;
  };
  const fullTextFrom = (el: Element | null | undefined, max: number): string =>
    el ? capText(visibleText(el), max) : "";

  // table/collection 的候选扫描逻辑抽为两个 const 箭头函数，atlas 与 extract 两分支共用：
  //   scanTables(): HTMLTableElement[]        —— 现有 tables 过滤逻辑原样
  //   scanCollections(): Array<{ parent: Element; group: Element[]; key: string }>
  //                                            —— 现有 collection 分组逻辑原样（shapeKey 分组）
  // （atlas 分支改为消费这两个扫描结果，行为不变；extract 分支用它们做重定位。）

  if (params.op === "atlas") {
    // 现有逻辑，消费 scanTables()/scanCollections()
  } else {
    // extract 分支（本 task 只实现 table；collection 在 Task 3）
    const empty = (found: boolean) => ({
      op: "extract" as const, found, slots: [] as string[],
      rows: [] as Array<Record<string, string>>, totalVisible: 0, nextCursor: params.cursor, done: true,
    });
    if (params.signature.kind === "table") {
      const tables = scanTables();
      const keyOf = (t: HTMLTableElement): string => {/* 复用 atlas 的列头推导逻辑 */ return columnsOf(t).join("");};
      // 定位：优先 ordinal 位签名匹配，否则第一个 columnsKey 匹配者，否则 found=false
      const byOrdinal = tables[params.signature.ordinal];
      const table = byOrdinal && keyOf(byOrdinal) === params.signature.columnsKey
        ? byOrdinal
        : tables.find((t) => keyOf(t) === params.signature.columnsKey);
      if (!table) return empty(false);
      // 行来源与可见性过滤：与 atlas table 分支同一逻辑（thead/首行 th 剔除 + isAtlasVisible）
      const visibleRows = visibleRowsOf(table);
      // 列名去重：重名列加 _2/_3 后缀
      const slots = dedupeNames(columnsOf(table));
      const batch = visibleRows.slice(params.cursor, params.cursor + params.batchSize);
      const rows = batch.map((row) => {
        const rec: Record<string, string> = {};
        Array.from(row.cells).forEach((cell, idx) => {
          const key = slots[idx] ?? `Column ${idx + 1}`;
          rec[key] = fullTextFrom(cell, params.maxFieldChars);
        });
        return rec;
      });
      const nextCursor = params.cursor + batch.length;
      return { op: "extract", found: true, slots, rows, totalVisible: visibleRows.length, nextCursor, done: nextCursor >= visibleRows.length };
    }
    // collection 分支：Task 3
    return empty(false);
  }
}
```

实现要点（非伪码部分照写）：
- `columnsOf` / `visibleRowsOf` / `dedupeNames` 是新抽的 const 箭头 helper，内容 = 现有 atlas table 分支里对应片段**原样搬移**（atlas 分支改为调用它们，保证两分支同一套推导——这是签名匹配正确性的根基）。
- `dedupeNames`: `["A","A","B"] → ["A","A_2","B"]`。
- 整个 extract 分支不 stamp DOM、不写任何属性（只读）。

- [ ] **Step 4: 跑测试确认通过（含 atlas 无回归）**

Run: `pnpm vitest run src/lib/dom-actions/`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/dom-actions/probe-core.ts src/lib/dom-actions/probe-core.extract.test.ts
git commit -m "feat: probe-core extract op — 签名重定位 + table 全保真分批抽取"
```

---

### Task 3: extract op collection 路径 — slot 目录 + 语义命名

**Files:**
- Modify: `src/lib/dom-actions/probe-core.ts`（extract 分支 collection 路径）
- Test: `src/lib/dom-actions/probe-core.extract.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 的 extract 分支骨架、`scanCollections()`、`capText`。
- Produces: collection 行抽取契约——slot 命名规则见下（Task 4 的 observation 覆盖率直接消费这些 slot 名）。

- [ ] **Step 1: 写失败测试**

```ts
describe("probePageInjected op=extract (collection)", () => {
  const html = (n: number) => `
    <ul>${Array.from({ length: n }, (_, i) => `
      <li>
        <h3><a href="/p/${i}">Item ${i}</a></h3>
        <span class="price">¥${i}00</span>
        <span class="css-1x2y3z">${i} reviews</span>
        <img src="/img/${i}.jpg">
      </li>`).join("")}
    </ul>`;

  const sigOf = () => {
    const a = probePageInjected({ op: "atlas" });
    if (a.op !== "atlas") throw new Error("narrow");
    const c = a.targets.find((t) => t.type === "collection");
    if (!c?.signature) throw new Error("no collection signature");
    return c.signature;
  };

  it("round-trips: atlas signature relocates and extracts all items with semantic slots", () => {
    document.body.innerHTML = html(30);
    const r = probePageInjected({ op: "extract", signature: sigOf(), cursor: 0, batchSize: 500, maxFieldChars: 2048 });
    if (r.op !== "extract") throw new Error("narrow");
    expect(r.found).toBe(true);
    expect(r.rows).toHaveLength(30);          // 不受 atlas 20 条预览 cap 限制
    expect(r.rows[3].title).toBe("Item 3");
    expect(r.rows[3].link).toBe("/p/3");
    expect(r.rows[3].price).toBe("¥300");     // class 词干命名
    expect(r.rows[3].img).toBe("/img/3.jpg");
    // hash-like class（css-1x2y3z）不作字段名 → 位置兜底
    expect(Object.keys(r.rows[3])).toContain("text_0");
  });

  it("ragged items: missing field is absent, others unaffected", () => {
    document.body.innerHTML = `
      <ul>
        <li><h3><a href="/a">A</a></h3><span class="price">¥1</span></li>
        <li><h3><a href="/b">B</a></h3></li>
        <li><h3><a href="/c">C</a></h3><span class="price">¥3</span></li>
      </ul>`;
    const r = probePageInjected({ op: "extract", signature: sigOf(), cursor: 0, batchSize: 500, maxFieldChars: 2048 });
    if (r.op !== "extract") throw new Error("narrow");
    expect(r.rows[1].price).toBeUndefined();
    expect(r.rows[0].price).toBe("¥1");
    expect(r.slots).toContain("price");       // slot 目录是并集
  });

  it("filters unsafe hrefs", () => {
    document.body.innerHTML = `
      <ul>
        <li><h3><a href="javascript:alert(1)">A</a></h3></li>
        <li><h3><a href="/b">B</a></h3></li>
        <li><h3><a href="/c">C</a></h3></li>
      </ul>`;
    const r = probePageInjected({ op: "extract", signature: sigOf(), cursor: 0, batchSize: 500, maxFieldChars: 2048 });
    if (r.op !== "extract") throw new Error("narrow");
    expect(r.rows[0].link).toBeUndefined();
    expect(r.rows[1].link).toBe("/b");
  });

  it("same-name collision within an item gets _2 suffix", () => {
    document.body.innerHTML = `
      <ul>
        <li><span class="tag">x</span><span class="tag">y</span><b>t</b></li>
        <li><span class="tag">x2</span><span class="tag">y2</span><b>t2</b></li>
        <li><span class="tag">x3</span><span class="tag">y3</span><b>t3</b></li>
      </ul>`;
    const r = probePageInjected({ op: "extract", signature: sigOf(), cursor: 0, batchSize: 500, maxFieldChars: 2048 });
    if (r.op !== "extract") throw new Error("narrow");
    expect(r.rows[0].tag).toBe("x");
    expect(r.rows[0].tag_2).toBe("y");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/dom-actions/probe-core.extract.test.ts`
Expected: collection 用例 FAIL（Task 2 的占位返回 found=false）

- [ ] **Step 3: 实现**

extract 分支 collection 路径（全部 const 箭头 helper）：

```ts
// 定位：scanCollections() 返回候选组；优先 ordinal 位且 itemShapeKey 匹配，
// 否则第一个 shapeKey(group[0]) === signature.itemShapeKey 的组；无 → found=false。
const groups = scanCollections();
const sig = params.signature; // kind === "collection"
const byOrdinal = groups[sig.ordinal];
const matched = byOrdinal && shapeKey(byOrdinal.group[0]) === sig.itemShapeKey
  ? byOrdinal
  : groups.find((g) => shapeKey(g.group[0]) === sig.itemShapeKey);
if (!matched) return empty(false);

// slot 命名（spec §6：语义证据优先，class 词干仅 tiebreaker，位置兜底）：
const slotNameFor = (el: Element, fallbackIndex: number): string => {
  const itemprop = el.getAttribute("itemprop");
  if (itemprop && /^[A-Za-z][\w-]{0,24}$/.test(itemprop)) return itemprop.toLowerCase();
  const tag = el.tagName.toLowerCase();
  if (tag === "time") return "time";
  const cls = typeof el.className === "string" ? el.className : "";
  const stem = cls.split(/\s+/).find((c) => /^[a-z][a-z-]{2,24}$/i.test(c) && !/\d/.test(c) && !/^(css|sc|jsx)-/i.test(c));
  if (stem) return stem.toLowerCase().replace(/-/g, "_");
  return `text_${fallbackIndex}`;
};

// 单条目抽取：
const extractItem = (item: Element): Record<string, string> => {
  const rec: Record<string, string> = {};
  const put = (name: string, value: string) => {
    if (!value) return;
    let key = name; let n = 2;
    while (key in rec) key = `${name}_${n++}`;
    rec[key] = value;
  };
  const heading = item.querySelector("h1,h2,h3,h4,h5,h6");
  const link = item.querySelector("a[href]") as HTMLAnchorElement | null;
  if (heading) put("title", fullTextFrom(heading, params.maxFieldChars));
  else if (link) put("title", fullTextFrom(link, params.maxFieldChars));
  if (link) { const href = safeLinkHref(link); if (href) put("link", href); }
  const img = item.querySelector("img[src]") as HTMLImageElement | null;
  if (img) put("img", capText(img.getAttribute("src") ?? "", params.maxFieldChars));
  // 其余文本叶子：有直接文本的元素（跳过 title 来源 heading 的内部，避免重复）
  let textIdx = 0;
  for (const el of Array.from(item.querySelectorAll("*"))) {
    if (heading && (el === heading || heading.contains(el))) continue;
    const direct = directText(el); // 现有 helper：仅直接子文本节点，normalize 后
    if (!direct) continue;
    put(slotNameFor(el, textIdx++), capText(direct, params.maxFieldChars));
  }
  return rec;
};

const items = matched.group.filter((el) => isAtlasVisible(el));
const batch = items.slice(params.cursor, params.cursor + params.batchSize);
const rows = batch.map(extractItem);
const slotSet = new Set<string>();
for (const row of rows) for (const k of Object.keys(row)) slotSet.add(k);
const nextCursor = params.cursor + batch.length;
return {
  op: "extract", found: true, slots: Array.from(slotSet), rows,
  totalVisible: items.length, nextCursor, done: nextCursor >= items.length,
};
```

已知天花板（写进代码注释）：`text_N` 位置兜底在条目参差时会漂移（有真实语义证据的 slot 不受影响）；覆盖率统计会暴露这类字段，v1 接受，SQL 清洗兜底。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/dom-actions/`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/dom-actions/probe-core.ts src/lib/dom-actions/probe-core.extract.test.ts
git commit -m "feat: probe-core extract op collection 路径 — slot 语义命名 + 参差容忍"
```

---

### Task 4: SW 工具 `extract_records`（单次路径，scroll=false）

**Files:**
- Modify: `src/lib/agent/tools/page-atlas/target-tools.ts`（`resolveTarget` 与 `pageStateGetter` 加 `export`，零逻辑改动）
- Create: `src/lib/agent/tools/page-atlas/extract-tool.ts`
- Test: `src/lib/agent/tools/page-atlas/extract-tool.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 `AtlasExtractSignature`（经 `AtlasTarget.signature`）、Task 2/3 extract op 契约、`ScratchpadToolDeps["saveRecords"]`（`(collection, records, {dedupeKey, fields}) => Promise<SaveResult|{error}>`，`SaveResult = {added, skipped, total}`）。
- Produces:

```ts
export interface ExtractRecordsDeps {
  saveRecords: (
    collection: string,
    records: Array<Record<string, unknown>>,
    opts: { dedupeKey?: string; fields?: string[] },
  ) => Promise<{ added: number; skipped: number; total: number } | { error: string }>;
  store?: PageAtlasStore;                  // 默认 pageAtlasStore
  getPageState?: GetPageState;             // 测试注入
  exec?: (tabId: number, frameId: number, params: ProbeParams) => Promise<ProbeResult | undefined>;
  scrollPage?: (tabId: number, frameId: number) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  now?: () => number;                      // 默认 Date.now
}
export function createExtractRecordsTool(deps: ExtractRecordsDeps): Tool
```

工具 schema（name `extract_records`）：

```ts
parameters: {
  type: "object",
  properties: {
    atlas_id: { type: "string" },
    target_id: { type: "string", description: "A collection or table target from read_page({mode:\"atlas\"})." },
    collection: { type: "string", description: 'Scratchpad collection to write into, e.g. "products".' },
    dedupeKey: { type: "string", description: "Field that identifies a row (e.g. \"link\"). Omit to auto-dedupe by full-row content hash." },
    scroll: { type: "boolean", description: "Auto-scroll and keep extracting until no new items (infinite lists). Default false." },
    max_rows: { type: "integer", minimum: 1, description: "Stop after this many stored rows. Default 2000." },
  },
  required: ["atlas_id", "target_id", "collection"],
  additionalProperties: false,
}
```

description（写实的 USE WHEN / DO NOT USE WHEN，与家族一致）：

```
Bulk-extract every record of a collection/table target straight into a scratchpad collection — full fidelity, without the data passing through your context. Returns counts + field coverage + a 2-row sample for verification. Pass scroll:true for infinite/virtualized lists.

USE WHEN:
- You are collecting many rows (products, listings, table rows) from a repeated structure the atlas already identified.
- The list is long or virtualized — scroll:true drives the scroll-extract loop for you.

**DO NOT USE WHEN:**
- You need a handful of rows to reason about in context — use read_struct.
- No suitable atlas target exists (page too unstructured) — read the page and save rows manually with save_scratchpad.
```

- [ ] **Step 1: 写失败测试**

测试用 fake deps（不碰 chrome.*）。构造辅助：

```ts
// extract-tool.test.ts 核心 fixture
import { describe, it, expect } from "vitest";
import { createExtractRecordsTool } from "./extract-tool";
import { createPageAtlasStore } from "./state";
import type { ProbeParams, ProbeResult } from "../../../dom-actions/probe-core";

const FP = { url: "https://x.test/", title: "t", bodyTextLengthBucket: 0, interactiveCountBucket: 0, topSectionCount: 1 };

function storeWithTarget(overrides: Partial<import("./types").AtlasTarget> = {}) {
  const store = createPageAtlasStore();
  store.save({
    atlasId: "atlas_1", tabId: 7, url: "https://x.test/", origin: "https://x.test",
    createdAt: Date.now(), fingerprint: FP,
    targets: [{
      id: "collection_c0", type: "collection", label: "Products", frameId: 0,
      confidence: "medium", summary: "3 repeated li items",
      signature: { kind: "collection", ordinal: 0, itemShapeKey: "li|a:0|a" },
      ...overrides,
    }],
    controls: [], forms: [], navigations: [],
  } as never); // 按 PageAtlasState 实际必填字段补齐——以 state.ts 类型为准，禁 as never 蒙混：先读类型再写 fixture
  return store;
}

// scripted exec：按调用序返回 ProbeResult
function scriptedExec(script: Array<Extract<ProbeResult, { op: "extract" }>>) {
  const calls: ProbeParams[] = [];
  let i = 0;
  return {
    calls,
    exec: async (_tab: number, _frame: number, p: ProbeParams) => {
      calls.push(p);
      return script[Math.min(i++, script.length - 1)];
    },
  };
}
const batch = (rows: Array<Record<string, string>>, over: Partial<Extract<ProbeResult, { op: "extract" }>> = {}) => ({
  op: "extract" as const, found: true, slots: Object.keys(rows[0] ?? {}),
  rows, totalVisible: rows.length, nextCursor: rows.length, done: true, ...over,
});
```

用例：

```ts
it("saves extracted rows via saveRecords and reports counts + coverage + sample", async () => {
  const saved: unknown[] = [];
  const { exec } = scriptedExec([batch([
    { title: "A", link: "/a", price: "¥1" },
    { title: "B", link: "/b" },
  ])]);
  const tool = createExtractRecordsTool({
    saveRecords: async (col, recs) => { saved.push([col, recs]); return { added: recs.length, skipped: 0, total: recs.length }; },
    store: storeWithTarget(),
    getPageState: async () => ({ url: "https://x.test/", fingerprint: FP }),
    exec,
  });
  const r = await tool.handler(
    { atlas_id: "atlas_1", target_id: "collection_c0", collection: "products" },
    { tabId: 7 } as never,
  );
  expect(r.success).toBe(true);
  expect(r.observation).toContain("added 2");
  expect(r.observation).toMatch(/title 100%/);
  expect(r.observation).toMatch(/price 50%/);
  expect(r.observation).toContain("<untrusted_scratchpad_preview>");
  expect(saved).toHaveLength(1);
});

it("injects _hash dedupe when dedupeKey omitted; passes user dedupeKey through", async () => { /* 断言 saveRecords 收到 opts.dedupeKey === "_hash" 且每行有 _hash；传 dedupeKey:"link" 时透传且不注入 _hash */ });

it("pulls multiple cursor batches until done", async () => { /* scripted: done:false nextCursor:500 → done:true；断言 exec 收到 cursor 0 和 500 两次调用，rows 合并保存 */ });

it("fails with target_stale guidance when extract returns found=false", async () => { /* found:false → success:false, error 含 read_page({mode:"atlas"}) */ });

it("fails when target has no signature", async () => { /* storeWithTarget({signature: undefined}) → success:false 提示重新 read_page */ });

it("caps stored rows at max_rows", async () => { /* batch 10 行 + max_rows 5 → saveRecords 只收 5 行，observation 注明 reached max_rows */ });
```

（测试代码在 plan 里以骨架给出的，实现 task 时写完整断言——fixture 与首个用例已给全，其余同构。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/agent/tools/page-atlas/extract-tool.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 extract-tool.ts**

要点（完整骨架）：

```ts
const BATCH_SIZE = 500;
const MAX_FIELD_CHARS = 2048;
const DEFAULT_MAX_ROWS = 2000;
const MAX_BATCH_PULLS = 100; // 单 pass 分批拉取护栏

const djb2 = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
};

// 单 pass：拉完当前可见全部批次
async function extractVisible(exec, tabId, frameId, signature):
  Promise<{ ok: true; rows: Array<Record<string, string>>; slots: string[] } | { ok: false }> {
  const rows: Array<Record<string, string>> = [];
  const slots = new Set<string>();
  let cursor = 0;
  for (let pull = 0; pull < MAX_BATCH_PULLS; pull++) {
    const r = await exec(tabId, frameId, { op: "extract", signature, cursor, batchSize: BATCH_SIZE, maxFieldChars: MAX_FIELD_CHARS });
    if (!r || r.op !== "extract" || !r.found) return { ok: false };
    rows.push(...r.rows);
    r.slots.forEach((s) => slots.add(s));
    if (r.done) break;
    cursor = r.nextCursor;
  }
  return { ok: true, rows, slots: Array.from(slots) };
}
```

handler 单次路径：validate args → `resolveTarget(store, getPageState, ctx, atlas_id, target_id, ["collection", "table"])`（本 task 已 export）→ signature 缺失即 fail → `frameId = resolved.target.frameId`（spec §6：执行 frame 取 atlas target 记录值，不引入新 frame 逻辑）→ `extractVisible` → `!ok` 则 fail `target_stale: the page structure changed — re-run read_page({mode:"atlas"})` → 行数截到 max_rows → 无 dedupeKey 时逐行注入 `_hash: djb2(JSON.stringify(row))` 且 dedupeKey="_hash" → `saveRecords` → observation。

observation 构造（覆盖率按抽到的行算，样本取前 2 行、`escapeUntrustedWrappers(JSON.stringify(...))` 包 `<untrusted_scratchpad_preview>`）：

```ts
const coverageLine = slots
  .map((s) => `${s} ${Math.round((rows.filter((r) => r[s]).length / rows.length) * 100)}%`)
  .join(" · ");
const observation =
  `Extracted from "${target.label}" into "${collection}": added ${res.added}, skipped ${res.skipped} (duplicates), total ${res.total}.\n` +
  (capped ? `Stopped: reached max_rows (${maxRows}).\n` : "") +
  `Fields (coverage): ${coverageLine}\n` +
  `Sample: <untrusted_scratchpad_preview>${sampleJson}</untrusted_scratchpad_preview>`;
```

默认 `exec` / `scrollPage`（本 task 只用 exec；scrollPage 给 Task 5 备好）：

```ts
const defaultExec = async (tabId: number, frameId: number, params: ProbeParams) => {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] }, func: probePageInjected, args: [params],
  }) as chrome.scripting.InjectionResult<ProbeResult>[];
  return results[0]?.result;
};
const defaultScrollPage = async (tabId: number, frameId: number) => {
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: scroll, args: ["down"] });
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/agent/tools/page-atlas/`
Expected: 全 PASS（含 target-tools 既有测试）

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/tools/page-atlas/target-tools.ts src/lib/agent/tools/page-atlas/extract-tool.ts src/lib/agent/tools/page-atlas/extract-tool.test.ts
git commit -m "feat: extract_records 工具单次路径 — atlas target 直写 scratchpad + 覆盖率回显"
```

---

### Task 5: 滚动循环（scroll=true）

**Files:**
- Modify: `src/lib/agent/tools/page-atlas/extract-tool.ts`
- Test: `src/lib/agent/tools/page-atlas/extract-tool.test.ts`（追加）

**Interfaces:**
- Consumes: Task 4 全部；`deps.scrollPage` / `deps.sleep` / `deps.signal` / `deps.now`。
- Produces: 停止原因字符串枚举（observation 消费）：`no new items after 3 scrolls` / `reached max_rows (N)` / `reached max scroll steps (200)` / `time limit reached (120s)` / `aborted by user` / `container lost (page structure changed mid-scroll)`。

- [ ] **Step 1: 写失败测试**

```ts
// 常量：STALL_LIMIT=3, MAX_SCROLL_STEPS=200, MAX_DURATION_MS=120_000, SETTLE_MS=600
it("scroll loop: accumulates until 3 stalled passes, reports screens + stop reason", async () => {
  // scripted exec：pass1 抽到 r1-r10，pass2 抽到 r8-r15（重叠，dedupe 后 added>0），
  // pass3/4/5 与 pass2 相同（added=0 三次）→ 停
  // fake saveRecords 维护 seen Set 按 dedupeKey 模拟 added/skipped
  // 断言：observation 含 "Scrolled 4 screens"、"no new items after 3 scrolls"、
  //        scrollPage 被调 4 次、sleep(600) 每次滚动后被调
});
it("scroll loop: stops at max_rows", async () => { /* max_rows:12，两 pass 各 10 行不重叠 → 第二 pass 截到 2 行，stop reason reached max_rows */ });
it("scroll loop: aborts via signal, keeps saved rows", async () => {
  // AbortController，第二个 pass 前 abort → observation 含 aborted by user + 已存计数（success:true，部分结果）
});
it("scroll loop: container lost mid-scroll returns partial with reason", async () => {
  // pass1 ok，pass2 found:false → success:true，observation 含 container lost + pass1 的计数
});
it("scroll loop: time limit", async () => { /* deps.now 造假前进 121s → time limit reached */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/agent/tools/page-atlas/extract-tool.test.ts`
Expected: 新用例 FAIL

- [ ] **Step 3: 实现滚动循环**

```ts
// handler 内 scroll=true 路径：
const start = now();
let screens = 0, stall = 0, stopReason = "";
let totals = { added: 0, skipped: 0, total: 0 };
const coverage = new Map<string, number>(); let rowCount = 0; let sample: Record<string, string>[] = [];

for (;;) {
  if (signal?.aborted) { stopReason = "aborted by user"; break; }
  const pass = await extractVisible(exec, tabId, frameId, signature);
  if (!pass.ok) {
    if (screens === 0) return fail('target_stale: ... re-run read_page({mode:"atlas"})');
    stopReason = "container lost (page structure changed mid-scroll)"; break;
  }
  const room = maxRows - totals.total;
  const rows = pass.rows.slice(0, Math.max(room, 0));
  const res = await save(rows); // 注入 _hash（如需）+ saveRecords + 覆盖率/样本累积
  totals = accumulate(totals, res);
  if (totals.total >= maxRows) { stopReason = `reached max_rows (${maxRows})`; break; }
  stall = res.added === 0 ? stall + 1 : 0;
  if (stall >= STALL_LIMIT) { stopReason = `no new items after ${STALL_LIMIT} scrolls`; break; }
  if (screens >= MAX_SCROLL_STEPS) { stopReason = `reached max scroll steps (${MAX_SCROLL_STEPS})`; break; }
  if (now() - start >= MAX_DURATION_MS) { stopReason = "time limit reached (120s)"; break; }
  await scrollPage(tabId, frameId); screens++;
  await sleep(SETTLE_MS);
}
// observation 第二行：`Scrolled ${screens} screens; stopped: ${stopReason}.`
```

注意：**每个 pass 落盘后才检查停止条件**——abort/超时/container_lost 都不丢已存数据（success:true + 部分结果 + 原因，除非第一 pass 就定位失败）。`totals.total` 用 saveRecords 返回的 total（集合累计）而不是本次 added 累加，跨 pass 语义才对。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/agent/tools/page-atlas/`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/tools/page-atlas/extract-tool.ts src/lib/agent/tools/page-atlas/extract-tool.test.ts
git commit -m "feat: extract_records 内置滚动循环 — 停滞检测/限界/abort 不丢数据"
```

---

### Task 6: 注册 + 分类 + 披露 + loop.ts 接线

**Files:**
- Modify: `src/lib/agent/tool-names.ts`（名字注册 + read/write class + disclosure group）
- Modify: `src/lib/agent/loop.ts`（~L1866 scratchpadTools 旁构建 + fullToolList 加入）
- Test: 既有 `tool-names` 相关测试文件（找 `KNOWN_BUILT_IN_TOOL_NAMES` 的测试所在处追加断言）

**Interfaces:**
- Consumes: Task 4/5 的 `createExtractRecordsTool`。
- Produces: 工具名 `"extract_records"` 进入 KNOWN 名册；class=`write`；disclosure group 与 `read_struct` 同组（`core`）。

- [ ] **Step 1: 写失败测试**

在 tool-names 测试处追加：

```ts
it("extract_records is a known write-class core tool", () => {
  expect(KNOWN_BUILT_IN_TOOL_NAMES).toContain("extract_records");
  expect(TOOL_RW_CLASS.extract_records).toBe("write");   // 常量名以 tool-names.ts 实际导出为准
  expect(TOOL_GROUPS.extract_records).toBe("core");      // 同上
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/agent/tool-names.test.ts`（以实际测试文件名为准）
Expected: FAIL

- [ ] **Step 3: 实现**

tool-names.ts：
- 名字加进 scratchpad/atlas 家族对应的名册数组（跟 `read_struct` 注册的同一条链路，保证进 `KNOWN_BUILT_IN_TOOL_NAMES`）。
- class 表加 `extract_records: "write"`，带注释：

```ts
//   extract_records — write：它长时间占用并滚动目标 tab 且写 scratchpad IDB；
//     与 query_scratchpad 不同（后者无 tab 参数、classing read 是刻意的），
//     extract_records 正是跨 session tab 锁想保护的对象。
```

- disclosure group 表加 `extract_records: "core"`（与 find_target/read_struct/read_target 同组）。

loop.ts（scratchpadTools 构建处之后）：

```ts
const extractRecordsTool = createExtractRecordsTool({
  saveRecords: (collection, records, opts) => svcSaveRecords(sessionId, collection, records, opts),
  signal, // runAgentLoop 的 internalController.signal（L1187 已在作用域）
});
```

`fullToolList` 中加在 `...scratchpadTools` 之后。import 补齐。

- [ ] **Step 4: 跑测试确认通过（build invariant 一起验）**

Run: `pnpm vitest run src/lib/agent/ && pnpm typecheck && pnpm build`
Expected: 全 PASS；build 无 R-iframe-1 / tool-class throw

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/tool-names.ts src/lib/agent/loop.ts <对应测试文件>
git commit -m "feat: 注册 extract_records（write-class/core 披露组）并接线 agent loop"
```

---

### Task 7: skill playbook + 工具描述互指 + 全量 gates

**Files:**
- Modify: `src/lib/skills/builtin.ts`（`extract_structured_data` 的 Collect 段）
- Modify: `src/lib/agent/tools/scratchpad.ts`（`save_scratchpad` description）
- Modify: `src/lib/agent/tools/page-atlas/target-tools.ts`（`read_struct` description）
- Test: `src/lib/skills/builtin.test.ts`（若有内容断言则同步）

- [ ] **Step 1: builtin.ts Collect 段重写**

```markdown
## Collect
1. Choose a collection name and a dedupeKey that uniquely identifies a row
   (e.g. "url"), so re-visiting a page never double-counts.
2. read_page({mode:"atlas"}) to find the collection/table target holding
   the data.
3. **Preferred: extract_records(atlas_id, target_id, collection, dedupeKey)**
   — bulk-extracts every row straight into the scratchpad without the data
   passing through your context. For infinite/virtualized lists pass
   scroll:true and it drives the scroll loop for you. Verify the returned
   field coverage + sample; clean up names later with query_scratchpad.
4. Fallback (no suitable target — page too unstructured): read the page and
   save_scratchpad the rows you read, page by page.
5. Paginated lists: navigate to the next page (click next / open_url),
   re-run read_page({mode:"atlas"}) + extract_records with the SAME
   collection and dedupeKey; duplicates are skipped automatically.
6. update_scratchpad_notes to record progress and the next step.
   Check <scratchpad_overview> each turn for counts and position.
```

- [ ] **Step 2: 描述互指**

`save_scratchpad` description 的 USE WHEN 前加一行：

```
If the rows are visible as an atlas collection/table target, prefer extract_records — it stores them without transcription.
```

`read_struct` 的 DO NOT USE WHEN 加：

```
- You are bulk-collecting rows into the scratchpad — use extract_records (full fidelity, no context cost).
```

- [ ] **Step 3: 跑全量 gates**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 全 PASS、0 错、build 成功

- [ ] **Step 4: Commit**

```bash
git add src/lib/skills/builtin.ts src/lib/agent/tools/scratchpad.ts src/lib/agent/tools/page-atlas/target-tools.ts
git commit -m "feat: extract playbook 首选 extract_records + 工具描述互指"
```

---

## 真机回归清单（合并前人工执行）

1. 静态大表格页（如维基百科长表）：atlas → extract_records → 覆盖率/样本合理 → query_scratchpad 清洗 → output_file 导出 CSV。
2. 电商搜索结果页（卡片 collection）：字段含 price 类语义命名；hash-class 页面退化为 text_N 但数据完整。
3. 无限滚动页（Twitter/微博/瀑布流）：scroll:true 跑到停滞收敛；中途点 abort → 已抽数据在 scratchpad。
4. 分页列表跨 3 页：同 collection + dedupeKey，无重复计数。
5. SPA 切页后用旧 atlas_id → target_stale 报错引导重读。
