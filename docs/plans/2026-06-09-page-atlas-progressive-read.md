# Page Atlas Progressive Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Page Atlas V1 so the agent first discovers page action/data targets, then reads or extracts only a selected target.

**Architecture:** Add an `atlas` branch to the existing `probePageInjected` page-world probe, so structural discovery happens inside the page where DOM APIs are available. The background tool layer assembles frame-aware atlas state, stores it in session memory, renders a compact XML-like observation, and exposes target-gated read/extract tools. Existing `read_page(mode="interactive"|"content"|"full"|"auto")` remains compatible.

**Tech Stack:** TypeScript, Chrome Extension MV3 `chrome.scripting.executeScript`, Vitest, happy-dom, existing agent tool registry.

---

## File Structure

- Create: `src/lib/agent/tools/page-atlas/types.ts`
  - Shared TypeScript types for atlas state, targets, controls, records, and extraction schema.
- Create: `src/lib/agent/tools/page-atlas/state.ts`
  - In-memory atlas store keyed by `atlas_id`; validates tab, origin, target existence, target type, TTL, and light page fingerprint.
- Create: `src/lib/agent/tools/page-atlas/render.ts`
  - XML-like observation rendering for `<page_atlas>`, `next_actions`, records, and fail-closed errors.
- Create: `src/lib/agent/tools/page-atlas/target-tools.ts`
  - Tool definitions for `find_target`, `read_collection`, `read_table`, `read_target`, and `extract_records`.
- Create: `src/lib/agent/tools/page-atlas/index.ts`
  - Public exports and factory helpers.
- Modify: `src/lib/dom-actions/probe-core.ts`
  - Add `op: "atlas"` and page-world DOM heuristics for controls, forms, collections, tables, detail regions, and page fingerprint.
- Modify: `src/lib/agent/tools/read-page.ts`
  - Add `mode: "atlas"`, call the atlas probe, assemble/store atlas, and render Page Atlas observation.
- Modify: `src/lib/agent/tools.ts`
  - Register Page Atlas target tools and remove public `searchPageTool` from `BUILT_IN_TOOLS`.
- Modify: `src/lib/agent/tool-names.ts`
  - Add Page Atlas target tools to the registry and remove `search_page` from publicly known page snapshot tools.
- Modify: `src/lib/agent/prompt.ts`
  - Replace old `read_page` / `search_page` guidance with Page Atlas flow guidance.
- Modify tests:
  - `src/lib/dom-actions/probe-core.test.ts`
  - `src/lib/agent/tools/read-page.test.ts`
  - `src/lib/agent/tools/page-atlas/state.test.ts`
  - `src/lib/agent/tools/page-atlas/target-tools.test.ts`
  - `src/lib/agent/tool-names.test.ts`
  - `src/lib/agent/prompt.test.ts`
  - `src/lib/agent/tools/search-page.test.ts`
  - `src/lib/agent/tools/mouse.test.ts`

## Task 1: Atlas Types And Store

**Files:**
- Create: `src/lib/agent/tools/page-atlas/types.ts`
- Create: `src/lib/agent/tools/page-atlas/state.ts`
- Create: `src/lib/agent/tools/page-atlas/state.test.ts`
- Create: `src/lib/agent/tools/page-atlas/index.ts`

- [ ] **Step 1: Write failing store tests**

Create `src/lib/agent/tools/page-atlas/state.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createPageAtlasStore } from "./state";
import type { PageAtlasState } from "./types";

function atlas(overrides: Partial<PageAtlasState> = {}): PageAtlasState {
  return {
    atlasId: "atlas_test",
    tabId: 7,
    url: "https://example.com/products",
    origin: "https://example.com",
    title: "Products",
    createdAt: Date.now(),
    fingerprint: {
      url: "https://example.com/products",
      title: "Products",
      bodyTextLengthBucket: 1000,
      interactiveCountBucket: 10,
      topSectionCount: 3,
    },
    targets: [
      {
        id: "collection_c1",
        type: "collection",
        label: "Product results",
        frameId: 0,
        confidence: "high",
        summary: "Repeated product cards",
        records: [
          {
            id: "collection_c1.record_0",
            fields: { title: "Pie Basic", price: "$9" },
            text: "Pie Basic $9",
            evidence: "Pie Basic $9",
          },
        ],
        fieldGuesses: [
          { name: "title", confidence: "high" },
          { name: "price", confidence: "high" },
        ],
        visibleCount: 1,
      },
      {
        id: "table_t1",
        type: "table",
        label: "Orders",
        frameId: 0,
        confidence: "high",
        summary: "Order table",
        columns: ["Order ID", "Status"],
        records: [
          {
            id: "table_t1.row_0",
            fields: { order_id: "A-1", status: "Paid" },
            text: "A-1 Paid",
            evidence: "A-1 Paid",
          },
        ],
        visibleCount: 1,
      },
    ],
    controls: [],
    forms: [],
    controlGroups: [],
    navigation: [],
    ...overrides,
  };
}

describe("PageAtlasStore", () => {
  it("stores and retrieves a fresh atlas target", () => {
    const store = createPageAtlasStore({ ttlMs: 120_000 });
    store.save(atlas());

    const result = store.resolveTarget({
      atlasId: "atlas_test",
      targetId: "collection_c1",
      tabId: 7,
      currentUrl: "https://example.com/products",
      allowedTypes: ["collection"],
      now: Date.now(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.target.label).toBe("Product results");
  });

  it("fails closed when the target type is not allowed", () => {
    const store = createPageAtlasStore({ ttlMs: 120_000 });
    store.save(atlas());

    const result = store.resolveTarget({
      atlasId: "atlas_test",
      targetId: "table_t1",
      tabId: 7,
      currentUrl: "https://example.com/products",
      allowedTypes: ["collection"],
      now: Date.now(),
    });

    expect(result).toEqual({
      ok: false,
      reason: "unsupported_target_type",
      message: "target table_t1 is type table; expected collection",
    });
  });

  it("expires stale atlas snapshots", () => {
    vi.setSystemTime(new Date("2026-06-09T00:00:00Z"));
    const store = createPageAtlasStore({ ttlMs: 60_000 });
    store.save(atlas({ createdAt: Date.now() - 120_000 }));

    const result = store.resolveTarget({
      atlasId: "atlas_test",
      targetId: "collection_c1",
      tabId: 7,
      currentUrl: "https://example.com/products",
      allowedTypes: ["collection"],
      now: Date.now(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("atlas_expired");
    vi.useRealTimers();
  });

  it("fails closed on cross-origin drift", () => {
    const store = createPageAtlasStore({ ttlMs: 120_000 });
    store.save(atlas());

    const result = store.resolveTarget({
      atlasId: "atlas_test",
      targetId: "collection_c1",
      tabId: 7,
      currentUrl: "https://evil.example/products",
      allowedTypes: ["collection"],
      now: Date.now(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("origin_changed");
  });
});
```

- [ ] **Step 2: Run the tests and confirm failure**

Run:

```bash
pnpm test src/lib/agent/tools/page-atlas/state.test.ts
```

Expected: FAIL because `./state` and `./types` do not exist.

- [ ] **Step 3: Add atlas types**

Create `src/lib/agent/tools/page-atlas/types.ts`:

```ts
export type AtlasTargetType = "collection" | "table" | "detail_region" | "region";
export type AtlasConfidence = "high" | "medium" | "low";

export interface AtlasFieldGuess {
  name: string;
  confidence: AtlasConfidence;
}

export interface AtlasRecord {
  id: string;
  fields: Record<string, string>;
  text: string;
  evidence: string;
}

export interface AtlasTarget {
  id: string;
  type: AtlasTargetType;
  label: string;
  frameId: number;
  confidence: AtlasConfidence;
  summary: string;
  fieldGuesses?: AtlasFieldGuess[];
  columns?: string[];
  records?: AtlasRecord[];
  visibleCount?: number;
  estimatedTotal?: number;
  cursor?: string;
}

export interface AtlasControl {
  id: string;
  frameId: number;
  pieIdx: number;
  type: string;
  label: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
}

export interface AtlasForm {
  id: string;
  label: string;
  frameId: number;
  fields: string[];
  submitControlId?: string;
}

export interface AtlasControlGroup {
  id: string;
  label: string;
  frameId: number;
  controls: string[];
}

export interface AtlasNavigation {
  id: string;
  type: "pagination" | "tabs" | "breadcrumbs" | "links";
  label: string;
  frameId: number;
  controls: string[];
}

export interface AtlasFingerprint {
  url: string;
  title: string;
  bodyTextLengthBucket: number;
  interactiveCountBucket: number;
  topSectionCount: number;
}

export interface PageAtlasState {
  atlasId: string;
  tabId: number;
  url: string;
  origin: string | null;
  title: string;
  createdAt: number;
  fingerprint: AtlasFingerprint;
  targets: AtlasTarget[];
  controls: AtlasControl[];
  forms: AtlasForm[];
  controlGroups: AtlasControlGroup[];
  navigation: AtlasNavigation[];
}

export interface ResolveTargetArgs {
  atlasId: string;
  targetId: string;
  tabId: number;
  currentUrl: string;
  allowedTypes: AtlasTargetType[];
  now: number;
}

export type ResolveTargetResult =
  | { ok: true; atlas: PageAtlasState; target: AtlasTarget }
  | { ok: false; reason: string; message: string };
```

- [ ] **Step 4: Add the in-memory store**

Create `src/lib/agent/tools/page-atlas/state.ts`:

```ts
import type {
  AtlasTarget,
  AtlasTargetType,
  PageAtlasState,
  ResolveTargetArgs,
  ResolveTargetResult,
} from "./types";

const DEFAULT_TTL_MS = 120_000;

export interface PageAtlasStore {
  save(atlas: PageAtlasState): void;
  get(atlasId: string): PageAtlasState | undefined;
  clear(): void;
  resolveTarget(args: ResolveTargetArgs): ResolveTargetResult;
}

export function parseOrigin(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

function typeList(types: AtlasTargetType[]): string {
  return types.join(" or ");
}

function findTarget(atlas: PageAtlasState, targetId: string): AtlasTarget | undefined {
  return atlas.targets.find((target) => target.id === targetId);
}

export function createPageAtlasStore(config: { ttlMs?: number } = {}): PageAtlasStore {
  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
  const byId = new Map<string, PageAtlasState>();

  return {
    save(atlas) {
      byId.set(atlas.atlasId, atlas);
    },

    get(atlasId) {
      return byId.get(atlasId);
    },

    clear() {
      byId.clear();
    },

    resolveTarget(args) {
      const atlas = byId.get(args.atlasId);
      if (!atlas) {
        return {
          ok: false,
          reason: "atlas_not_found",
          message: "Call read_page({mode:\"atlas\"}) first, then use a target_id from that atlas.",
        };
      }
      if (atlas.tabId !== args.tabId) {
        return {
          ok: false,
          reason: "tab_mismatch",
          message: `atlas ${args.atlasId} belongs to tab ${atlas.tabId}, not tab ${args.tabId}`,
        };
      }
      if (args.now - atlas.createdAt > ttlMs) {
        return {
          ok: false,
          reason: "atlas_expired",
          message: "The page atlas is stale. Call read_page({mode:\"atlas\"}) again.",
        };
      }
      const currentOrigin = parseOrigin(args.currentUrl);
      if (atlas.origin !== currentOrigin) {
        return {
          ok: false,
          reason: "origin_changed",
          message: "The page origin changed since the atlas was created. Call read_page({mode:\"atlas\"}) again.",
        };
      }
      const target = findTarget(atlas, args.targetId);
      if (!target) {
        return {
          ok: false,
          reason: "target_not_found",
          message: `target ${args.targetId} does not exist in atlas ${args.atlasId}. Call read_page({mode:\"atlas\"}) again.`,
        };
      }
      if (!args.allowedTypes.includes(target.type)) {
        return {
          ok: false,
          reason: "unsupported_target_type",
          message: `target ${target.id} is type ${target.type}; expected ${typeList(args.allowedTypes)}`,
        };
      }
      return { ok: true, atlas, target };
    },
  };
}

export const pageAtlasStore = createPageAtlasStore();
```

- [ ] **Step 5: Add page atlas exports**

Create `src/lib/agent/tools/page-atlas/index.ts`:

```ts
export * from "./types";
export * from "./state";
```

- [ ] **Step 6: Run the store tests**

Run:

```bash
pnpm test src/lib/agent/tools/page-atlas/state.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/lib/agent/tools/page-atlas
git commit -m "feat(page-atlas): add atlas state store"
```

## Task 2: Page-World Atlas Probe

**Files:**
- Modify: `src/lib/dom-actions/probe-core.ts`
- Modify: `src/lib/dom-actions/probe-core.test.ts`

- [ ] **Step 1: Add failing probe tests**

Append these tests to `src/lib/dom-actions/probe-core.test.ts`:

```ts
it("atlas op detects forms, collections, and tables", () => {
  document.body.innerHTML = `
    <main>
      <form aria-label="Product search">
        <label for="q">Keyword</label>
        <input id="q" name="q" />
        <button>Search</button>
      </form>
      <section aria-label="Products">
        <article class="card"><a href="/a">Alpha</a><span>$9</span></article>
        <article class="card"><a href="/b">Beta</a><span>$19</span></article>
        <article class="card"><a href="/c">Gamma</a><span>$29</span></article>
      </section>
      <table>
        <thead><tr><th>Order ID</th><th>Status</th></tr></thead>
        <tbody><tr><td>A-1</td><td>Paid</td></tr></tbody>
      </table>
    </main>
  `;

  const result = probePageInjected({ op: "atlas" });

  expect(result.op).toBe("atlas");
  if (result.op !== "atlas") return;
  expect(result.controls.some((control) => control.label === "Keyword")).toBe(true);
  expect(result.forms[0]).toMatchObject({ label: "Product search" });
  expect(result.targets.some((target) => target.type === "collection")).toBe(true);
  expect(result.targets.some((target) => target.type === "table")).toBe(true);
  expect(result.fingerprint.interactiveCountBucket).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the probe test and confirm failure**

Run:

```bash
pnpm test src/lib/dom-actions/probe-core.test.ts -- --runInBand
```

Expected: FAIL because `ProbeParams` does not accept `op: "atlas"`.

- [ ] **Step 3: Extend probe result types**

In `src/lib/dom-actions/probe-core.ts`, add these interfaces near `SearchMatch`:

```ts
export interface AtlasProbeControl {
  id: string;
  pieIdx: number;
  type: string;
  label: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
}

export interface AtlasProbeForm {
  id: string;
  label: string;
  fields: string[];
  submitControlId?: string;
}

export interface AtlasProbeTarget {
  id: string;
  type: "collection" | "table" | "detail_region" | "region";
  label: string;
  confidence: "high" | "medium" | "low";
  summary: string;
  fieldGuesses?: Array<{ name: string; confidence: "high" | "medium" | "low" }>;
  columns?: string[];
  records?: Array<{ id: string; fields: Record<string, string>; text: string; evidence: string }>;
  visibleCount?: number;
  estimatedTotal?: number;
}

export interface AtlasProbeFingerprint {
  url: string;
  title: string;
  bodyTextLengthBucket: number;
  interactiveCountBucket: number;
  topSectionCount: number;
}
```

Update `ProbeParams`:

```ts
export type ProbeParams =
  | { op: "snapshot" }
  | { op: "atlas" }
  | {
      op: "search";
      queries: string[];
      regex: boolean;
      mode: "all" | "interactive" | "text";
      maxResults: number;
      searchBy: "text" | "role" | "tag" | "attribute";
    };
```

Update `ProbeResult`:

```ts
export type ProbeResult =
  | {
      op: "snapshot";
      html: string;
      interactiveElements: InteractiveElementSummary[];
      scrollableHints: ScrollableHint[];
    }
  | {
      op: "atlas";
      controls: AtlasProbeControl[];
      forms: AtlasProbeForm[];
      targets: AtlasProbeTarget[];
      fingerprint: AtlasProbeFingerprint;
    }
  | {
      op: "search";
      matches: SearchMatch[];
      total: number;
      timedOut: boolean;
      invalidRegex: string | null;
      invalidAttribute: string | null;
    };
```

- [ ] **Step 4: Add the atlas branch in `probePageInjected`**

Inside `probePageInjected`, before the current `if (params.op === "snapshot")` branch returns, add a sibling branch:

```ts
  if (params.op === "atlas") {
    const liveBodyElements = [...walkDeep(document.body)];
    const liveToCloneMap = new Map<Element, Element>();
    for (const el of liveBodyElements) liveToCloneMap.set(el, el);
    stampLiveDom(liveBodyElements, liveToCloneMap);

    const controls: AtlasProbeControl[] = [];
    for (const el of liveBodyElements) {
      if (!el.hasAttribute("data-pie-idx")) continue;
      const pieIdx = Number(el.getAttribute("data-pie-idx"));
      const tag = el.tagName.toLowerCase();
      controls.push({
        id: `ctrl_${pieIdx}`,
        pieIdx,
        type: inferredRole(el) || tag,
        label: accessibleName(el) || labelFor(el) || tag,
        value: el instanceof HTMLInputElement && el.type !== "password" ? el.value : undefined,
        disabled: el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement
          ? el.disabled
          : undefined,
        checked: el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") ? el.checked : undefined,
      });
    }

    const forms: AtlasProbeForm[] = [];
    let formIndex = 0;
    for (const form of liveBodyElements) {
      if (form.tagName.toLowerCase() !== "form") continue;
      const fieldIds: string[] = [];
      let submitControlId: string | undefined;
      for (const child of [...walkDeep(form)]) {
        if (!child.hasAttribute("data-pie-idx")) continue;
        const id = `ctrl_${child.getAttribute("data-pie-idx")}`;
        const tag = child.tagName.toLowerCase();
        if (tag === "input" || tag === "select" || tag === "textarea") fieldIds.push(id);
        if (tag === "button" || (child instanceof HTMLInputElement && child.type === "submit")) submitControlId = id;
      }
      forms.push({
        id: `form_f${formIndex + 1}`,
        label: accessibleName(form) || nearestSection(form) || `Form ${formIndex + 1}`,
        fields: fieldIds,
        submitControlId,
      });
      formIndex++;
    }

    const targets: AtlasProbeTarget[] = [];
    let collectionIndex = 0;
    for (const container of liveBodyElements) {
      const children = Array.from(container.children).filter((child) => isVisible(child));
      if (children.length < 3) continue;
      const signatureCounts = new Map<string, Element[]>();
      for (const child of children) {
        const signature = `${child.tagName.toLowerCase()}.${Array.from(child.classList).slice(0, 2).join(".")}`;
        const group = signatureCounts.get(signature) ?? [];
        group.push(child);
        signatureCounts.set(signature, group);
      }
      for (const group of signatureCounts.values()) {
        if (group.length < 3) continue;
        const records = group.slice(0, 20).map((item, index) => {
          const text = normalizeSpace(item.textContent ?? "").slice(0, 500);
          const link = item.querySelector("a");
          return {
            id: `collection_c${collectionIndex + 1}.record_${index}`,
            fields: {
              title: normalizeSpace(link?.textContent ?? text).slice(0, 160),
              link: link?.getAttribute("href") ?? "",
            },
            text,
            evidence: text.slice(0, 240),
          };
        });
        targets.push({
          id: `collection_c${collectionIndex + 1}`,
          type: "collection",
          label: nearestSection(container) || "Repeated records",
          confidence: "medium",
          summary: `${group.length} repeated visible items`,
          fieldGuesses: [
            { name: "title", confidence: "medium" },
            { name: "link", confidence: "medium" },
          ],
          records,
          visibleCount: group.length,
        });
        collectionIndex++;
        break;
      }
    }

    let tableIndex = 0;
    for (const table of liveBodyElements) {
      if (table.tagName.toLowerCase() !== "table") continue;
      const headers = Array.from(table.querySelectorAll("th"))
        .map((th) => normalizeSpace(th.textContent ?? ""))
        .filter((text) => text.length > 0);
      const rows = Array.from(table.querySelectorAll("tbody tr, tr")).slice(0, 25);
      const records = rows.map((row, index) => {
        const cells = Array.from(row.querySelectorAll("td, th")).map((cell) => normalizeSpace(cell.textContent ?? ""));
        const fields: Record<string, string> = {};
        for (let i = 0; i < cells.length; i++) {
          const key = headers[i] ? headers[i].toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") : `column_${i + 1}`;
          fields[key || `column_${i + 1}`] = cells[i];
        }
        const text = cells.join(" ");
        return { id: `table_t${tableIndex + 1}.row_${index}`, fields, text, evidence: text.slice(0, 240) };
      });
      targets.push({
        id: `table_t${tableIndex + 1}`,
        type: "table",
        label: nearestSection(table) || "Table",
        confidence: "high",
        summary: `${records.length} visible rows`,
        columns: headers,
        records,
        visibleCount: records.length,
      });
      tableIndex++;
    }

    const bodyTextLength = normalizeSpace(document.body.textContent ?? "").length;
    const topSectionCount = document.querySelectorAll("main, section, article, nav, aside, header, footer").length;
    return {
      op: "atlas",
      controls,
      forms,
      targets,
      fingerprint: {
        url: location.href,
        title: document.title,
        bodyTextLengthBucket: Math.round(bodyTextLength / 500) * 500,
        interactiveCountBucket: Math.round(controls.length / 10) * 10,
        topSectionCount,
      },
    };
  }
```

- [ ] **Step 5: Run the probe tests**

Run:

```bash
pnpm test src/lib/dom-actions/probe-core.test.ts -- --runInBand
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/lib/dom-actions/probe-core.ts src/lib/dom-actions/probe-core.test.ts
git commit -m "feat(page-atlas): add atlas page probe"
```

## Task 3: `read_page(mode="atlas")`

**Files:**
- Modify: `src/lib/agent/tools/read-page.ts`
- Create: `src/lib/agent/tools/page-atlas/render.ts`
- Modify: `src/lib/agent/tools/read-page.test.ts`

- [ ] **Step 1: Add failing `read_page` atlas tests**

Append to `src/lib/agent/tools/read-page.test.ts`:

```ts
it("mode=atlas returns compact page_atlas and stores target ids", async () => {
  vi.stubGlobal("chrome", {
    tabs: { get: vi.fn(async () => ({ id: 7, url: "https://example.com/products", title: "Products" })) },
    scripting: {
      executeScript: vi.fn(async () => [
        {
          frameId: 0,
          result: {
            op: "atlas",
            controls: [{ id: "ctrl_1", pieIdx: 1, type: "button", label: "Search" }],
            forms: [],
            targets: [
              {
                id: "collection_c1",
                type: "collection",
                label: "Products",
                confidence: "medium",
                summary: "3 repeated visible items",
                records: [{ id: "collection_c1.record_0", fields: { title: "Alpha" }, text: "Alpha", evidence: "Alpha" }],
                visibleCount: 1,
              },
            ],
            fingerprint: {
              url: "https://example.com/products",
              title: "Products",
              bodyTextLengthBucket: 500,
              interactiveCountBucket: 10,
              topSectionCount: 1,
            },
          },
        },
      ]),
    },
    webNavigation: { getAllFrames: vi.fn(async () => [{ frameId: 0, parentFrameId: -1, url: "https://example.com/products" }]) },
  });

  const result = await readPageTool.handler({ tabId: 7, mode: "atlas" }, {} as never);

  expect(result.success).toBe(true);
  expect(result.observation).toContain("<page_atlas");
  expect(result.observation).toContain("collection_c1");
  expect(result.observation).toContain("extract_records");
  expect(result.observation).not.toContain("<untrusted_page_content");
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm test src/lib/agent/tools/read-page.test.ts -- --runInBand
```

Expected: FAIL because `mode="atlas"` normalizes to `auto`.

- [ ] **Step 3: Add renderer**

Create `src/lib/agent/tools/page-atlas/render.ts`:

```ts
import { escapeWrapperAttribute, escapeUntrustedWrappers } from "../../untrusted-wrappers";
import type { AtlasTarget, PageAtlasState } from "./types";

function attr(name: string, value: string | number | boolean): string {
  return `${name}="${escapeWrapperAttribute(String(value))}"`;
}

function renderFieldGuesses(target: AtlasTarget): string {
  const guesses = target.fieldGuesses ?? [];
  return guesses.map((guess) => `      <field_guess ${attr("name", guess.name)} ${attr("confidence", guess.confidence)} />`).join("\n");
}

function renderNextActions(target: AtlasTarget): string {
  if (target.type === "collection") {
    return [
      "      <next_actions>",
      `        read_collection(target_id="${target.id}", range="0..${target.visibleCount ?? 20}")`,
      `        extract_records(target_id="${target.id}", schema={title:string, link:string})`,
      "      </next_actions>",
    ].join("\n");
  }
  if (target.type === "table") {
    return [
      "      <next_actions>",
      `        read_table(target_id="${target.id}", range="0..${target.visibleCount ?? 25}")`,
      `        extract_records(target_id="${target.id}", schema={})`,
      "      </next_actions>",
    ].join("\n");
  }
  return [
    "      <next_actions>",
    `        read_target(target_id="${target.id}", mode="text")`,
    "      </next_actions>",
  ].join("\n");
}

function renderTarget(target: AtlasTarget): string {
  const attrs = [
    attr("id", target.id),
    attr("type", target.type),
    attr("label", target.label),
    attr("frame_id", target.frameId),
    attr("confidence", target.confidence),
  ];
  if (target.visibleCount !== undefined) attrs.push(attr("visible_count", target.visibleCount));
  if (target.estimatedTotal !== undefined) attrs.push(attr("estimated_total", target.estimatedTotal));
  const children = [
    `      <summary>${escapeUntrustedWrappers(target.summary)}</summary>`,
    renderFieldGuesses(target),
    target.columns ? `      <columns>${escapeUntrustedWrappers(target.columns.join(", "))}</columns>` : "",
    renderNextActions(target),
  ].filter((part) => part.length > 0);
  return `    <data_surface ${attrs.join(" ")}>\n${children.join("\n")}\n    </data_surface>`;
}

export function renderPageAtlas(atlas: PageAtlasState): string {
  const attrs = [
    attr("atlas_id", atlas.atlasId),
    attr("tab_id", atlas.tabId),
    attr("url", atlas.url),
    attr("title", atlas.title),
  ];
  const controls = atlas.controls.map((control) => (
    `    <control ${attr("id", control.id)} ${attr("frame_id", control.frameId)} ${attr("pie_idx", control.pieIdx)} ${attr("type", control.type)} ${attr("label", control.label)} />`
  ));
  const forms = atlas.forms.map((form) => (
    `    <form ${attr("id", form.id)} ${attr("frame_id", form.frameId)} ${attr("label", form.label)} ${attr("fields", form.fields.join(","))}${form.submitControlId ? " " + attr("submit", form.submitControlId) : ""} />`
  ));
  return [
    `<page_atlas ${attrs.join(" ")}>`,
    "  <action_surfaces>",
    ...forms,
    ...controls,
    "  </action_surfaces>",
    "  <data_surfaces>",
    ...atlas.targets.map(renderTarget),
    "  </data_surfaces>",
    "</page_atlas>",
  ].join("\n");
}

export function renderAtlasError(message: string): string {
  return `<page_atlas_error>${escapeUntrustedWrappers(message)}</page_atlas_error>`;
}
```

- [ ] **Step 4: Wire `read_page(mode="atlas")`**

In `src/lib/agent/tools/read-page.ts`, extend mode support:

```ts
const MODE_BUDGETS = {
  atlas: { maxBytes: 80_000 },
  auto: { maxBytes: 500_000 },
  interactive: { maxBytes: 200_000 },
  content: { maxBytes: 300_000 },
  full: { maxBytes: 500_000 },
} as const;
```

Update `normalizeMode`:

```ts
function normalizeMode(mode: unknown): ReadPageMode {
  return mode === "atlas" || mode === "interactive" || mode === "content" || mode === "full" ? mode : "auto";
}
```

Add imports:

```ts
import { pageAtlasStore, parseOrigin, type PageAtlasState } from "./page-atlas";
import { renderPageAtlas } from "./page-atlas/render";
```

After tab validation and before snapshot execution, add the atlas branch:

```ts
    if (mode === "atlas") {
      const results = await chrome.scripting.executeScript({
        target: { tabId: a.tabId, allFrames: true },
        func: probePageInjected,
        args: [{ op: "atlas" }],
      }) as chrome.scripting.InjectionResult<ProbeResult>[];
      const frames = await chrome.webNavigation.getAllFrames({ tabId: a.tabId });
      if (!frames) return { success: false, error: "Tab unavailable" };
      const topUrl = frames.find((f) => f.frameId === 0)?.url ?? tab.url ?? "";
      const atlasId = `atlas_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const atlas: PageAtlasState = {
        atlasId,
        tabId: a.tabId,
        url: topUrl,
        origin: parseOrigin(topUrl),
        title: tab.title ?? "",
        createdAt: Date.now(),
        fingerprint: results.find((r) => r.result?.op === "atlas")?.result?.op === "atlas"
          ? results.find((r) => r.result?.op === "atlas")!.result!.fingerprint
          : { url: topUrl, title: tab.title ?? "", bodyTextLengthBucket: 0, interactiveCountBucket: 0, topSectionCount: 0 },
        targets: [],
        controls: [],
        forms: [],
        controlGroups: [],
        navigation: [],
      };
      for (const r of results) {
        const data = r.result?.op === "atlas" ? r.result : undefined;
        if (!data) continue;
        const frameId = r.frameId ?? 0;
        atlas.controls.push(...data.controls.map((control) => ({ ...control, frameId })));
        atlas.forms.push(...data.forms.map((form) => ({ ...form, frameId })));
        atlas.targets.push(...data.targets.map((target) => ({ ...target, frameId })));
      }
      pageAtlasStore.save(atlas);
      return { success: true, observation: renderPageAtlas(atlas) };
    }
```

- [ ] **Step 5: Run `read_page` tests**

Run:

```bash
pnpm test src/lib/agent/tools/read-page.test.ts -- --runInBand
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/lib/agent/tools/read-page.ts src/lib/agent/tools/read-page.test.ts src/lib/agent/tools/page-atlas/render.ts
git commit -m "feat(page-atlas): render read_page atlas mode"
```

## Task 4: Target Tools

**Files:**
- Create: `src/lib/agent/tools/page-atlas/target-tools.ts`
- Create: `src/lib/agent/tools/page-atlas/target-tools.test.ts`
- Modify: `src/lib/agent/tools/page-atlas/index.ts`

- [ ] **Step 1: Write failing target tool tests**

Create `src/lib/agent/tools/page-atlas/target-tools.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createPageAtlasTargetTools } from "./target-tools";
import { createPageAtlasStore } from "./state";
import type { PageAtlasState } from "./types";

function seed(store: ReturnType<typeof createPageAtlasStore>) {
  const atlas: PageAtlasState = {
    atlasId: "atlas_test",
    tabId: 7,
    url: "https://example.com/products",
    origin: "https://example.com",
    title: "Products",
    createdAt: Date.now(),
    fingerprint: { url: "https://example.com/products", title: "Products", bodyTextLengthBucket: 500, interactiveCountBucket: 10, topSectionCount: 1 },
    controls: [],
    forms: [],
    controlGroups: [],
    navigation: [],
    targets: [
      {
        id: "collection_c1",
        type: "collection",
        label: "Product results",
        frameId: 0,
        confidence: "high",
        summary: "Product cards",
        fieldGuesses: [{ name: "title", confidence: "high" }, { name: "price", confidence: "high" }],
        records: [
          { id: "collection_c1.record_0", fields: { title: "Alpha", price: "$9" }, text: "Alpha $9", evidence: "Alpha $9" },
          { id: "collection_c1.record_1", fields: { title: "Beta", price: "$19" }, text: "Beta $19", evidence: "Beta $19" },
        ],
        visibleCount: 2,
      },
      {
        id: "detail_d1",
        type: "detail_region",
        label: "Product detail",
        frameId: 0,
        confidence: "medium",
        summary: "Single product details",
        records: [
          { id: "detail_d1.record_0", fields: { title: "Alpha", sku: "SKU-1" }, text: "Alpha SKU-1", evidence: "Alpha SKU-1" },
        ],
        visibleCount: 1,
      },
    ],
  };
  store.save(atlas);
}

function tool(name: string, tools: ReturnType<typeof createPageAtlasTargetTools>) {
  const t = tools.find((candidate) => candidate.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
}

describe("Page Atlas target tools", () => {
  it("find_target searches atlas targets", async () => {
    const store = createPageAtlasStore();
    seed(store);
    const tools = createPageAtlasTargetTools({ store, getTabUrl: async () => "https://example.com/products" });

    const result = await tool("find_target", tools).handler({ atlas_id: "atlas_test", query: "price" }, { tabId: 7 } as never);

    expect(result.success).toBe(true);
    expect(result.observation).toContain("collection_c1");
  });

  it("read_collection returns records from a selected target", async () => {
    const store = createPageAtlasStore();
    seed(store);
    const tools = createPageAtlasTargetTools({ store, getTabUrl: async () => "https://example.com/products" });

    const result = await tool("read_collection", tools).handler({ atlas_id: "atlas_test", target_id: "collection_c1", range: "0..1" }, { tabId: 7 } as never);

    expect(result.success).toBe(true);
    expect(result.observation).toContain("Alpha");
    expect(result.observation).not.toContain("Beta");
  });

  it("extract_records requires atlas and target", async () => {
    const store = createPageAtlasStore();
    const tools = createPageAtlasTargetTools({ store, getTabUrl: async () => "https://example.com/products" });

    const result = await tool("extract_records", tools).handler({ schema: { title: "string" } }, { tabId: 7 } as never);

    expect(result.success).toBe(false);
    expect(result.error).toContain("read_page");
  });

  it("read_target returns text for detail targets", async () => {
    const store = createPageAtlasStore();
    seed(store);
    const tools = createPageAtlasTargetTools({ store, getTabUrl: async () => "https://example.com/products" });

    const result = await tool("read_target", tools).handler({ atlas_id: "atlas_test", target_id: "detail_d1" }, { tabId: 7 } as never);

    expect(result.success).toBe(true);
    expect(result.observation).toContain("Alpha SKU-1");
  });
});
```

- [ ] **Step 2: Run failing target tool tests**

Run:

```bash
pnpm test src/lib/agent/tools/page-atlas/target-tools.test.ts
```

Expected: FAIL because `target-tools.ts` does not exist.

- [ ] **Step 3: Implement target tools**

Create `src/lib/agent/tools/page-atlas/target-tools.ts`:

```ts
import type { ActionResult } from "../../../dom-actions/types";
import type { Tool, ToolHandlerContext } from "../../types";
import { escapeUntrustedWrappers } from "../../untrusted-wrappers";
import type { AtlasRecord, AtlasTarget, AtlasTargetType } from "./types";
import { pageAtlasStore, type PageAtlasStore } from "./state";

interface Deps {
  store?: PageAtlasStore;
  getTabUrl?: (tabId: number) => Promise<string>;
}

function parseRange(input: unknown, fallbackLength: number): [number, number] {
  if (typeof input !== "string") return [0, fallbackLength];
  const match = input.match(/^(\d+)\.\.(\d+)$/);
  if (!match) return [0, fallbackLength];
  const start = Math.max(0, Number(match[1]));
  const end = Math.max(start, Number(match[2]));
  return [start, end];
}

function renderRecords(name: string, target: AtlasTarget, records: AtlasRecord[]): string {
  const body = records.map((record) => (
    `  <record id="${record.id}">${escapeUntrustedWrappers(JSON.stringify(record.fields))}\n` +
    `    <evidence>${escapeUntrustedWrappers(record.evidence)}</evidence>\n` +
    "  </record>"
  ));
  return `<${name} target_id="${target.id}" type="${target.type}" count="${records.length}">\n${body.join("\n")}\n</${name}>`;
}

async function resolve(
  deps: Required<Deps>,
  ctx: ToolHandlerContext,
  atlasId: unknown,
  targetId: unknown,
  allowedTypes: AtlasTargetType[],
): Promise<{ ok: true; target: AtlasTarget } | { ok: false; error: string }> {
  if (typeof atlasId !== "string" || typeof targetId !== "string") {
    return {
      ok: false,
      error: "target tools require atlas_id and target_id from read_page({mode:\"atlas\"}).",
    };
  }
  const currentUrl = await deps.getTabUrl(ctx.tabId);
  const result = deps.store.resolveTarget({
    atlasId,
    targetId,
    tabId: ctx.tabId,
    currentUrl,
    allowedTypes,
    now: Date.now(),
  });
  if (!result.ok) return { ok: false, error: result.message };
  return { ok: true, target: result.target };
}

export function createPageAtlasTargetTools(deps: Deps = {}): Tool[] {
  const resolvedDeps: Required<Deps> = {
    store: deps.store ?? pageAtlasStore,
    getTabUrl: deps.getTabUrl ?? (async (tabId) => {
      const tab = await chrome.tabs.get(tabId);
      return tab.url ?? "";
    }),
  };

  const findTarget: Tool = {
    name: "find_target",
    description: "Find a collection/table/detail target inside a previously returned page atlas. Requires atlas_id from read_page({mode:\"atlas\"}); does not search raw page text.",
    parameters: {
      type: "object",
      properties: {
        atlas_id: { type: "string" },
        query: { type: "string" },
        kind: { type: "string", enum: ["data", "action", "any"] },
      },
      required: ["atlas_id", "query"],
      additionalProperties: false,
    },
    handler: async (args: unknown): Promise<ActionResult> => {
      const a = args as { atlas_id?: string; query?: string };
      if (typeof a.atlas_id !== "string" || typeof a.query !== "string") {
        return { success: false, error: "find_target requires atlas_id and query." };
      }
      const atlas = resolvedDeps.store.get(a.atlas_id);
      if (!atlas) return { success: false, error: "atlas_not_found: call read_page({mode:\"atlas\"}) first." };
      const q = a.query.toLowerCase();
      const candidates = atlas.targets
        .filter((target) => `${target.label} ${target.summary} ${(target.fieldGuesses ?? []).map((f) => f.name).join(" ")}`.toLowerCase().includes(q))
        .slice(0, 8);
      const rows = candidates.map((target) => `  <candidate target_id="${target.id}" type="${target.type}" confidence="${target.confidence}">${escapeUntrustedWrappers(target.label)}</candidate>`);
      return { success: true, observation: `<find_target atlas_id="${a.atlas_id}" count="${candidates.length}">\n${rows.join("\n")}\n</find_target>` };
    },
  };

  const readCollection: Tool = {
    name: "read_collection",
    description: "Read records from a collection target selected from read_page({mode:\"atlas\"}). Requires atlas_id and target_id.",
    parameters: {
      type: "object",
      properties: {
        atlas_id: { type: "string" },
        target_id: { type: "string" },
        range: { type: "string", description: "Record range like 0..10." },
      },
      required: ["atlas_id", "target_id"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx): Promise<ActionResult> => {
      const a = args as { atlas_id?: string; target_id?: string; range?: string };
      const resolved = await resolve(resolvedDeps, ctx, a.atlas_id, a.target_id, ["collection"]);
      if (!resolved.ok) return { success: false, error: resolved.error };
      const records = resolved.target.records ?? [];
      const [start, end] = parseRange(a.range, records.length);
      return { success: true, observation: renderRecords("read_collection", resolved.target, records.slice(start, end)) };
    },
  };

  const readTable: Tool = {
    name: "read_table",
    description: "Read rows from a table target selected from read_page({mode:\"atlas\"}). Requires atlas_id and target_id.",
    parameters: {
      type: "object",
      properties: {
        atlas_id: { type: "string" },
        target_id: { type: "string" },
        range: { type: "string", description: "Row range like 0..25." },
      },
      required: ["atlas_id", "target_id"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx): Promise<ActionResult> => {
      const a = args as { atlas_id?: string; target_id?: string; range?: string };
      const resolved = await resolve(resolvedDeps, ctx, a.atlas_id, a.target_id, ["table"]);
      if (!resolved.ok) return { success: false, error: resolved.error };
      const records = resolved.target.records ?? [];
      const [start, end] = parseRange(a.range, records.length);
      return { success: true, observation: renderRecords("read_table", resolved.target, records.slice(start, end)) };
    },
  };

  const readTarget: Tool = {
    name: "read_target",
    description: "Read text/evidence from a detail_region or fallback region target selected from read_page({mode:\"atlas\"}). Requires atlas_id and target_id.",
    parameters: {
      type: "object",
      properties: {
        atlas_id: { type: "string" },
        target_id: { type: "string" },
        mode: { type: "string", enum: ["summary", "text"] },
      },
      required: ["atlas_id", "target_id"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx): Promise<ActionResult> => {
      const a = args as { atlas_id?: string; target_id?: string; mode?: "summary" | "text" };
      const resolved = await resolve(resolvedDeps, ctx, a.atlas_id, a.target_id, ["detail_region", "region"]);
      if (!resolved.ok) return { success: false, error: resolved.error };
      const records = resolved.target.records ?? [];
      if (a.mode === "summary") {
        return { success: true, observation: `<read_target target_id="${resolved.target.id}" mode="summary">${escapeUntrustedWrappers(resolved.target.summary)}</read_target>` };
      }
      return { success: true, observation: renderRecords("read_target", resolved.target, records) };
    },
  };

  const extractRecords: Tool = {
    name: "extract_records",
    description: "Extract structured JSON records from a selected atlas target. Requires atlas_id, target_id, and an explicit schema object.",
    parameters: {
      type: "object",
      properties: {
        atlas_id: { type: "string" },
        target_id: { type: "string" },
        schema: { type: "object", additionalProperties: { type: "string" } },
        range: { type: "string" },
      },
      required: ["atlas_id", "target_id", "schema"],
      additionalProperties: false,
    },
    handler: async (args: unknown, ctx): Promise<ActionResult> => {
      const a = args as { atlas_id?: string; target_id?: string; schema?: Record<string, string>; range?: string };
      if (typeof a.atlas_id !== "string" || typeof a.target_id !== "string" || !a.schema || typeof a.schema !== "object") {
        return { success: false, error: "extract_records requires atlas_id, target_id, and schema from read_page({mode:\"atlas\"})." };
      }
      const resolved = await resolve(resolvedDeps, ctx, a.atlas_id, a.target_id, ["collection", "table", "detail_region"]);
      if (!resolved.ok) return { success: false, error: resolved.error };
      const records = resolved.target.records ?? [];
      const [start, end] = parseRange(a.range, records.length);
      const schemaKeys = Object.keys(a.schema);
      const extracted = records.slice(start, end).map((record) => {
        const out: Record<string, string> = {};
        for (const key of schemaKeys) out[key] = record.fields[key] ?? "";
        return { ...out, _evidence: record.evidence };
      });
      return { success: true, observation: `<extract_records target_id="${resolved.target.id}">${escapeUntrustedWrappers(JSON.stringify(extracted))}</extract_records>` };
    },
  };

  return [findTarget, readCollection, readTable, readTarget, extractRecords];
}
```

- [ ] **Step 4: Export target tools**

Update `src/lib/agent/tools/page-atlas/index.ts`:

```ts
export * from "./types";
export * from "./state";
export * from "./target-tools";
```

- [ ] **Step 5: Run target tool tests**

Run:

```bash
pnpm test src/lib/agent/tools/page-atlas/target-tools.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/lib/agent/tools/page-atlas
git commit -m "feat(page-atlas): add target-gated tools"
```

## Task 5: Tool Registry And Prompt Disclosure

**Files:**
- Modify: `src/lib/agent/tools.ts`
- Modify: `src/lib/agent/tool-names.ts`
- Modify: `src/lib/agent/prompt.ts`
- Modify: `src/lib/agent/tool-names.test.ts`
- Modify: `src/lib/agent/prompt.test.ts`
- Modify: `src/lib/agent/tools/search-page.test.ts`
- Modify: `src/lib/agent/tools/mouse.test.ts`

- [ ] **Step 1: Update registry tests first**

In `src/lib/agent/tool-names.test.ts`, add:

```ts
it("registers Page Atlas target tools as read tools", () => {
  expect(KNOWN_BUILT_IN_TOOL_NAMES).toContain("find_target");
  expect(KNOWN_BUILT_IN_TOOL_NAMES).toContain("read_collection");
  expect(KNOWN_BUILT_IN_TOOL_NAMES).toContain("read_table");
  expect(KNOWN_BUILT_IN_TOOL_NAMES).toContain("read_target");
  expect(KNOWN_BUILT_IN_TOOL_NAMES).toContain("extract_records");
  expect(TOOL_CLASSES.find_target).toBe("read");
  expect(TOOL_CLASSES.read_collection).toBe("read");
  expect(TOOL_CLASSES.read_table).toBe("read");
  expect(TOOL_CLASSES.read_target).toBe("read");
  expect(TOOL_CLASSES.extract_records).toBe("read");
});

it("does not expose search_page as a known built-in tool in Page Atlas V1", () => {
  expect(KNOWN_BUILT_IN_TOOL_NAMES).not.toContain("search_page");
});
```

- [ ] **Step 2: Run registry tests and confirm failure**

Run:

```bash
pnpm test src/lib/agent/tool-names.test.ts
```

Expected: FAIL because Page Atlas tools are not registered and `search_page` is still known.

- [ ] **Step 3: Register Page Atlas tools and de-expose `search_page`**

In `src/lib/agent/tool-names.ts`, replace `PAGE_SNAPSHOT_TOOL_NAMES` with:

```ts
export const PAGE_SNAPSHOT_TOOL_NAMES = [
  "read_page",
] as const;

export const PAGE_ATLAS_TOOL_NAMES = [
  "find_target",
  "read_collection",
  "read_table",
  "read_target",
  "extract_records",
] as const;
```

Add `...PAGE_ATLAS_TOOL_NAMES` to `KNOWN_BUILT_IN_TOOL_NAMES` after `...PAGE_SNAPSHOT_TOOL_NAMES`.

In `TOOL_CLASSES`, remove `search_page: "read"` and add:

```ts
  find_target: "read",
  read_collection: "read",
  read_table: "read",
  read_target: "read",
  extract_records: "read",
```

In `src/lib/agent/tools.ts`, add:

```ts
import { createPageAtlasTargetTools } from "./tools/page-atlas";
```

Remove `searchPageTool` from `BUILT_IN_TOOLS`, and add:

```ts
  ...createPageAtlasTargetTools(),
```

immediately after `readPageTool`.

- [ ] **Step 4: Update prompt guidance**

In `src/lib/agent/prompt.ts`, replace search-page guidance with this Page Atlas guidance:

```ts
const PAGE_ATLAS_GUIDANCE = `
Page reading uses a progressive Page Atlas flow:
- Start with \`read_page({tabId, mode:"atlas"})\` for page tasks involving operation or structured extraction.
- The atlas returns action surfaces (forms, controls, navigation) and data surfaces (collections, tables, detail regions).
- To extract data, first choose a \`target_id\` from the atlas or call \`find_target({atlas_id, query})\`.
- Then call \`read_collection\`, \`read_table\`, \`read_target\`, or \`extract_records\` with the \`atlas_id\` and \`target_id\`.
- \`extract_records\` is target-level only. Never call it without a target from the current atlas.
- Use \`read_page({tabId, mode:"interactive"})\` before click/type/select when you need fresh element indices.
`;
```

Then include `PAGE_ATLAS_GUIDANCE` in the existing static prompt section where `read_page` modes are described.

- [ ] **Step 5: Update prompt and tool wording tests**

In `src/lib/agent/prompt.test.ts`, replace assertions that require `search_page` with assertions for `mode:"atlas"` and `extract_records`.

In `src/lib/agent/tools/search-page.test.ts`, remove assertions that `search_page` is in `BUILT_IN_TOOLS`; keep pure `searchPageTool` unit tests if they import the tool directly.

In `src/lib/agent/tools/mouse.test.ts`, update description expectations from:

```ts
"read_page <interactive_index> or search_page result"
```

to:

```ts
"read_page <interactive_index>"
```

Also update descriptions in `src/lib/agent/tools.ts` and `src/lib/agent/tools/mouse.ts` so click/type/select/hover no longer mention `search_page`.

- [ ] **Step 6: Run registry and prompt tests**

Run:

```bash
pnpm test src/lib/agent/tool-names.test.ts src/lib/agent/prompt.test.ts src/lib/agent/tools/search-page.test.ts src/lib/agent/tools/mouse.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/lib/agent/tools.ts src/lib/agent/tool-names.ts src/lib/agent/prompt.ts src/lib/agent/tool-names.test.ts src/lib/agent/prompt.test.ts src/lib/agent/tools/search-page.test.ts src/lib/agent/tools/mouse.test.ts src/lib/agent/tools/mouse.ts
git commit -m "feat(page-atlas): expose target tools and retire search_page"
```

## Task 6: End-To-End Verification And Spec Trace

**Files:**
- Modify: `docs/specs/2026-06-09-page-atlas-progressive-read-design.md`

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm test src/lib/dom-actions/probe-core.test.ts src/lib/agent/tools/read-page.test.ts src/lib/agent/tools/page-atlas/state.test.ts src/lib/agent/tools/page-atlas/target-tools.test.ts src/lib/agent/tool-names.test.ts src/lib/agent/prompt.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Run full test suite**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 4: Run production build**

Run:

```bash
pnpm build
```

Expected: PASS and Vite writes `dist/`.

- [ ] **Step 5: Add implementation trace to spec**

Append to `docs/specs/2026-06-09-page-atlas-progressive-read-design.md`:

```md
## 16. Implementation Trace

- `read_page(mode="atlas")` implemented in `src/lib/agent/tools/read-page.ts`.
- Page-world atlas heuristics implemented in `src/lib/dom-actions/probe-core.ts` under `op: "atlas"`.
- Atlas state and target validation implemented in `src/lib/agent/tools/page-atlas/state.ts`.
- Target-gated tools implemented in `src/lib/agent/tools/page-atlas/target-tools.ts`.
- Public tool disclosure updated in `src/lib/agent/tools.ts`, `src/lib/agent/tool-names.ts`, and `src/lib/agent/prompt.ts`.
- `search_page` remains importable for unit coverage but is no longer exposed through `BUILT_IN_TOOLS` or prompt guidance in V1.
- `read_more` is deferred until atlas probes produce stable cursors for scrollable and virtualized collections.
```

- [ ] **Step 6: Commit**

Run:

```bash
git add docs/specs/2026-06-09-page-atlas-progressive-read-design.md
git commit -m "docs(page-atlas): add implementation trace"
```

## Self-Review

**Spec coverage:**  
This plan covers Page Atlas as the default discovery mode, action/data surfaces, target-gated reading/extraction, fail-closed `atlas_id` / `target_id` validation, `search_page` de-exposure, and V1 testing. It explicitly defers `read_more` until cursor generation exists and does not implement V2 semantic search, matching the spec's non-goals and route.

**Placeholder scan:**  
No task uses unresolved placeholder instructions. Code snippets provide concrete names, paths, commands, expected failures, and expected passes.

**Type consistency:**  
The plan consistently uses `atlas_id` / `target_id` in tool JSON schemas, `atlasId` / `targetId` in TypeScript, target types `collection | table | detail_region | region`, and the tool names `find_target`, `read_collection`, `read_table`, `read_target`, `extract_records`.
