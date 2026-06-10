# iframe Click 分路径支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 click 在 iframe 内报 `frame mapping failed` 的回归——子 frame 改走 frame 内合成点击（无需跨 frame 几何），顶层保持 CDP 真实点击；hover 顶层限定；删除 chrome↔CDP frame 映射启发式；snapshot 补采 aria-haspopup/aria-expanded。

**Spec:** `docs/specs/2026-06-10-iframe-click-split-path.md`（背景、否决的备选方案、错误模型详见 spec）

**Architecture:** `click(frameId>0)` 经 `chrome.scripting.executeScript({frameIds:[frameId]})` 在目标 frame 内执行 act-core 新增的 `click` op（完整 pointer/mouse 事件序列 + 原生 `el.click()`），不 attach CDP、不弹授权；`frameId===0` 路径零变化。`geometry.ts` 因此只服务顶层，整套 `resolveChromeToCdpFrameId` URL 启发式删除。

**Tech Stack:** Chrome MV3 / TypeScript / vitest + happy-dom。命令均在 `pie-ai-agent/` 下运行。

**Branch:** 从 main 切 `fix/iframe-click-subframe`（配合 superpowers:using-git-worktrees 隔离；subagent 注意 cwd 须显式 cd 到 worktree 绝对路径）。

**项目级注意：**
- act-core / probe-core 的注入函数必须 self-contained（函数体内不得引用外部模块符号；类型 import 仅限 type-level）。
- R-iframe-1：click/hover 的 schema `required: ["frameId","elementIndex"]` 不可动（`tools.ts` 末尾 IIFE 构建期断言会拦）。
- 提交前 `pnpm test`、`pnpm typecheck`、`pnpm build` 三连。

---

### Task 1: act-core 新增 `click` op

**Files:**
- Modify: `src/lib/dom-actions/act-core.ts`（ActParams/ActResult union + op 实现，约 L11-22 与 focusClick 块之后）
- Test: `src/lib/dom-actions/act-core.test.ts`（文件末尾追加 describe）

- [ ] **Step 1: 写失败测试**

在 `act-core.test.ts` 末尾追加（沿用文件内现有 happy-dom 风格——直接设 `document.body.innerHTML`）：

```ts
describe("actByIdxInjected op=click", () => {
  it("dispatches the full event sequence ending with native click", async () => {
    document.body.innerHTML = `<button data-pie-idx="3">Go</button>`;
    const el = document.querySelector("button")!;
    const seen: string[] = [];
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      el.addEventListener(t, () => seen.push(t));
    }
    const result = await actByIdxInjected({ op: "click", idx: 3 });
    expect(result).toEqual({ ok: true, op: "click", observation: "Clicked element [3]" });
    expect(seen).toEqual(["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
  });

  it("focuses a focusable element before clicking", async () => {
    document.body.innerHTML = `<input data-pie-idx="5" type="checkbox" />`;
    const el = document.querySelector("input")!;
    await actByIdxInjected({ op: "click", idx: 5 });
    expect(document.activeElement).toBe(el);
    expect(el.checked).toBe(true); // native click() toggles the checkbox
  });

  it("locates elements inside open shadow roots", async () => {
    document.body.innerHTML = `<div id="host"></div>`;
    const host = document.getElementById("host")!;
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = `<button data-pie-idx="9">Inner</button>`;
    let clicked = false;
    sr.querySelector("button")!.addEventListener("click", () => { clicked = true; });
    const result = await actByIdxInjected({ op: "click", idx: 9 });
    expect(result.ok).toBe(true);
    expect(clicked).toBe(true);
  });

  it("returns ok:false for a missing idx", async () => {
    document.body.innerHTML = `<div></div>`;
    const result = await actByIdxInjected({ op: "click", idx: 404 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not found");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/dom-actions/act-core.test.ts`
Expected: FAIL —— TS 报 `op: "click"` 不在 ActParams union（或运行期落入 ok:false 路径）。

- [ ] **Step 3: 实现**

`act-core.ts` 三处修改：

(a) 顶部注释 `All four ops implemented: rect, type, select, focusClick.` 改为 `All five ops implemented: rect, type, select, focusClick, click.`

(b) union 扩展：

```ts
export type ActParams =
  | { op: "rect"; idx: number }
  | { op: "focusClick"; idx: number }
  | { op: "click"; idx: number }
  | { op: "type"; idx: number; text: string; clear: boolean }
  | { op: "select"; idx: number; value: string };

export type ActResult =
  | { ok: true; op: "rect"; rect: { x: number; y: number; w: number; h: number } }
  | { ok: true; op: "type"; observation: string }
  | { ok: true; op: "select"; observation: string }
  | { ok: true; op: "focusClick"; observation: string }
  | { ok: true; op: "click"; observation: string }
  | { ok: false; error: string };
```

(c) 在 `if (params.op === "focusClick") {...}` 块之后插入：

```ts
  if (params.op === "click") {
    // Synthetic in-frame click — used for subframe elements where real CDP
    // mouse input is unavailable (cross-frame geometry was the broken link;
    // OOPIF frames are invisible to the root CDP session's frame tree).
    // Full pointer/mouse sequence approximates a user click for standard
    // handlers; isTrusted stays false by nature of synthetic events.
    (el as unknown as { scrollIntoViewIfNeeded?: (a: unknown) => void }).scrollIntoViewIfNeeded?.({
      block: "center",
    });
    const r = (el as HTMLElement).getBoundingClientRect();
    const init: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: r.x + r.width / 2,
      clientY: r.y + r.height / 2,
      button: 0,
    };
    // happy-dom / older runtimes may lack PointerEvent — MouseEvent carries
    // the same type string and listeners on "pointer*" still fire.
    const PointerCtor: typeof MouseEvent =
      typeof PointerEvent !== "undefined" ? PointerEvent : MouseEvent;
    el.dispatchEvent(new PointerCtor("pointerover", init));
    el.dispatchEvent(new MouseEvent("mouseover", init));
    el.dispatchEvent(new PointerCtor("pointerdown", init));
    el.dispatchEvent(new MouseEvent("mousedown", init));
    (el as HTMLElement).focus?.();
    el.dispatchEvent(new PointerCtor("pointerup", init));
    el.dispatchEvent(new MouseEvent("mouseup", init));
    (el as HTMLElement).click();
    return { ok: true, op: "click", observation: `Clicked element [${params.idx}]` };
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/dom-actions/act-core.test.ts`
Expected: PASS（含原有 rect/type/select/focusClick 用例）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/dom-actions/act-core.ts src/lib/dom-actions/act-core.test.ts
git commit -m "feat(act-core): add synthetic click op for subframe clicks"
```

---

### Task 2: 抽取 `execActInTab` 到共享模块（纯重构）

mouse.ts 的子 frame 路径需要调 `execActInTab`，但它目前是 `tools.ts` 的私有函数，而 `tools.ts` import 了 `tools/mouse.ts`——直接反向 import 会成环。把它移到 dom-actions 层。

**Files:**
- Create: `src/lib/dom-actions/exec-act.ts`
- Modify: `src/lib/agent/tools.ts`（删除本地 `execActInTab` L97-127，改 import）

- [ ] **Step 1: 创建共享模块**

`src/lib/dom-actions/exec-act.ts`（函数体从 `tools.ts` L97-127 原样搬移）：

```ts
import { actByIdxInjected, type ActParams, type ActResult } from "./act-core";

/**
 * Run actByIdxInjected in the target tab/frame. Returns the op-tagged
 * ActResult; maps frame-navigated/removed executeScript failures to a
 * re-snapshot hint. Shared by tools.ts (type/select) and tools/mouse.ts
 * (subframe synthetic click).
 */
export async function execActInTab(
  tabId: number,
  params: ActParams,
  frameId?: number,
): Promise<ActResult> {
  const target: chrome.scripting.InjectionTarget = frameId !== undefined
    ? { tabId, frameIds: [frameId] }
    : { tabId };
  try {
    const results = await chrome.scripting.executeScript({
      target,
      func: actByIdxInjected,
      args: [params],
    });
    return (
      (results[0]?.result as ActResult | undefined) ?? {
        ok: false,
        error: "Execution failed",
      }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (frameId !== undefined && /Frame with ID .* not found|No frame with id/i.test(msg)) {
      return {
        ok: false,
        error: `Frame ${frameId} unreachable or removed. Re-snapshot.`,
      };
    }
    throw err;
  }
}
```

`tools.ts`：删除本地 `execActInTab` 定义，在文件顶部按现有 import 风格加 `import { execActInTab } from "@/lib/dom-actions/exec-act";`（若 tools.ts 对 dom-actions 用相对路径则保持一致）。若删除后 `actByIdxInjected` / `ActParams` 在 tools.ts 已无其他使用处，连带清理其 import。

- [ ] **Step 2: 全量测试 + typecheck 验证无行为变化**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿（纯搬移，零行为变化）。

- [ ] **Step 3: Commit**

```bash
git add src/lib/dom-actions/exec-act.ts src/lib/agent/tools.ts
git commit -m "refactor(dom-actions): extract execActInTab to shared module"
```

---

### Task 3: mouse.ts click 分路径 + hover 顶层限定

**Files:**
- Modify: `src/lib/agent/tools/mouse.ts`（buildClickTool / buildHoverTool handler 开头分流）
- Test: `src/lib/agent/tools/mouse.test.ts`

- [ ] **Step 1: 写失败测试**

`mouse.test.ts` 追加两个 describe（`ToolHandlerContext` 构造沿用文件内现有 handler 调用的写法；若现有用例用 `{ tabId: 7 } as ToolHandlerContext` 即照搬）。同时**删除**两个已不可达的旧用例：`hover` describe 下的 `"returns frame-gone error from geometry"` 与 `"returns cdp-frame-id-unresolved error from geometry"`（分路径后 geometry 只处理顶层，这两个 error kind 在 Task 4 删除）。

```ts
describe("click tool — subframe synthetic path", () => {
  it("frameId>0 clicks in-frame without CDP attach or consent", async () => {
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockResolvedValue([
      { result: { ok: true, op: "click", observation: "Clicked element [4]" } },
    ]);
    const acquireSession = vi.fn();
    const requestConsent = vi.fn();
    const tool = buildClickTool({ acquireSession, sessionId: "S1", requestConsent });
    const result = await tool.handler({ frameId: 5, elementIndex: 4 }, ctx());
    expect(result.success).toBe(true);
    expect(result.observation).toContain("synthetic events");
    expect(result.observation).toContain("frame 5");
    expect(acquireSession).not.toHaveBeenCalled();
    expect(requestConsent).not.toHaveBeenCalled();
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7, frameIds: [5] } }),
    );
  });

  it("frameId>0 with vanished frame returns unreachable error", async () => {
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("No frame with id 21114 in tab 7"),
    );
    const tool = buildClickTool(deps());
    const result = await tool.handler({ frameId: 21114, elementIndex: 49 }, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toBe("Frame 21114 unreachable or removed. Re-snapshot.");
  });

  it("frameId>0 element-not-found passes act-core error through", async () => {
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockResolvedValue([
      { result: { ok: false, error: "Element not found at index 4. The page may have changed; try snapshotting again." } },
    ]);
    const tool = buildClickTool(deps());
    const result = await tool.handler({ frameId: 5, elementIndex: 4 }, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Element not found at index 4");
  });
});

describe("hover tool — subframe gate", () => {
  it("frameId>0 returns top-frame-only error without CDP attach or consent", async () => {
    const acquireSession = vi.fn();
    const requestConsent = vi.fn();
    const tool = buildHoverTool({ acquireSession, sessionId: "S1", requestConsent });
    const result = await tool.handler({ frameId: 3, elementIndex: 1 }, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toContain("top frame");
    expect(acquireSession).not.toHaveBeenCalled();
    expect(requestConsent).not.toHaveBeenCalled();
  });
});
```

注意：subframe 用例**不要**调 `setCdpInputEnabled`——验证的就是该路径完全不碰 CDP gate。若文件内没有现成 `ctx()` / `deps()` helper，按现有用例的内联写法展开。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/agent/tools/mouse.test.ts`
Expected: 新用例 FAIL（当前 frameId>0 仍走 CDP 路径，会撞 consent gate / geometry mock）。

- [ ] **Step 3: 实现分流**

`mouse.ts`：

(a) 顶部加 import：`import { execActInTab } from "@/lib/dom-actions/exec-act";`

(b) `buildClickTool` handler 内、`const a = args as {...}` 之后、`requireCdpInput` 之前插入：

```ts
      if (a.frameId !== 0) {
        // Subframe path — in-frame synthetic click. No CDP: the chrome↔CDP
        // frame mapping was the broken link (OOPIF frames invisible to the
        // root session). executeScript reaches exactly the frames read_page
        // can snapshot, so anything the agent can see it can click.
        return withActionSettle(ctx.tabId, async () => {
          const result = await execActInTab(
            ctx.tabId,
            { op: "click", idx: a.elementIndex },
            a.frameId,
          );
          if (!result.ok) return { success: false, error: result.error };
          return {
            success: true,
            observation: `Clicked [${a.elementIndex}] in frame ${a.frameId} via synthetic events (real mouse input is top-frame only). If the page did not react, the control may require trusted input.`,
          };
        });
      }
```

(c) `buildHoverTool` handler 内、`const a = args as {...}` 之后、`requireCdpInput` 之前插入：

```ts
      if (a.frameId !== 0) {
        return {
          success: false,
          error:
            "hover is only supported in the top frame for now. For elements inside iframes, try clicking directly, or use read_page to check whether the target content is already visible.",
        };
      }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/agent/tools/mouse.test.ts`
Expected: PASS（含保留的 CDP 顶层用例）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/tools/mouse.ts src/lib/agent/tools/mouse.test.ts
git commit -m "feat(mouse): subframe clicks via in-frame synthetic events; hover top-frame only"
```

---

### Task 4: geometry 瘦身 + 错误模型收缩

分路径后 `elementToPagePoint` 只服务顶层。删除整套 chrome↔CDP frame 映射。

**Files:**
- Modify: `src/lib/dom-actions/geometry.ts`（整文件重写，~40 行）
- Modify: `src/lib/agent/tools/mouse.ts`（`geometryErrorToActionResult` 收缩 + 调用点签名）
- Test: `src/lib/dom-actions/geometry.test.ts`（重写）
- Test: `src/__tests__/cross-layer/click-cdp-failure-modes.test.ts`（删两 case、补一 case）

- [ ] **Step 1: 重写 geometry.ts**

整文件替换为：

```ts
import { actByIdxInjected } from "./act-core";

export type GeometryError =
  | { kind: "element-not-found"; index: number }
  | { kind: "element-not-visible"; index: number };

export type PagePoint = { x: number; y: number };

/**
 * Compute viewport coordinates for the center of a TOP-FRAME element by
 * data-pie-idx (scrolled into view first by the rect op). Subframe clicks
 * never use CDP geometry — they run in-frame synthetic clicks (see
 * tools/mouse.ts) — so this function only targets frame 0 and needs no
 * chrome↔CDP frame mapping.
 */
export async function elementToPagePoint(
  tabId: number,
  elementIndex: number,
): Promise<PagePoint | GeometryError> {
  const injection = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: actByIdxInjected,
    args: [{ op: "rect", idx: elementIndex } as const],
  });
  const out = injection[0]?.result;
  const rect = out && out.ok && out.op === "rect" ? out.rect : null;
  if (!rect) return { kind: "element-not-found", index: elementIndex };
  if (rect.w <= 0 || rect.h <= 0) return { kind: "element-not-visible", index: elementIndex };
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}
```

（`resolveChromeToCdpFrameId`、`CdpFrame`、`CdpFrameTreeNode`、`ChromeFrame`、`CdpSession` import 全部删除。）

- [ ] **Step 2: 收缩 mouse.ts 错误映射与调用点**

(a) `geometryErrorToActionResult` 删除 `frame-gone` 与 `cdp-frame-id-unresolved` 两个 case（保留 `element-not-found` / `element-not-visible` 与 `never` exhaustiveness 分支——TS 会在此步强制收缩完成）。

(b) hover/click 两处调用 `elementToPagePoint(ctx.tabId, a.frameId, a.elementIndex, session)` 改为 `elementToPagePoint(ctx.tabId, a.elementIndex)`（此时 `a.frameId` 必为 0）。

- [ ] **Step 3: 重写 geometry.test.ts**

保留并改签名顶层用例，删除 `resolveChromeToCdpFrameId` describe 与 frame-gone 用例：

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { elementToPagePoint } from "./geometry";

beforeEach(() => {
  global.chrome = {
    scripting: {
      executeScript: vi.fn(),
    } as unknown as typeof chrome.scripting,
  } as unknown as typeof chrome;
});

describe("elementToPagePoint — top frame", () => {
  it("returns rect center", async () => {
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockResolvedValue([
      { result: { ok: true, op: "rect", rect: { x: 100, y: 200, w: 50, h: 40 } } },
    ]);
    const result = await elementToPagePoint(7, 3);
    expect(result).toEqual({ x: 125, y: 220 });
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7, frameIds: [0] } }),
    );
  });

  it("returns element-not-found when result is null", async () => {
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockResolvedValue([{ result: null }]);
    expect(await elementToPagePoint(7, 3)).toEqual({ kind: "element-not-found", index: 3 });
  });

  it("returns element-not-visible for zero-sized rect", async () => {
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockResolvedValue([
      { result: { ok: true, op: "rect", rect: { x: 0, y: 0, w: 0, h: 0 } } },
    ]);
    expect(await elementToPagePoint(7, 3)).toEqual({ kind: "element-not-visible", index: 3 });
  });
});
```

- [ ] **Step 4: 更新 cross-layer 失败模式测试**

`click-cdp-failure-modes.test.ts`：删除 `"frame-gone wording when geometry reports frame missing"`（L93-103）与 `"cdp-frame-id-unresolved wording when mapping fails"`（L104-114）两个用例；追加：

```ts
  it("subframe path: vanished frame wording", async () => {
    (chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("No frame with id 21114 in tab 7"),
    );
    const tool = buildClickTool(deps());
    const result = await tool.handler(
      { frameId: 21114, elementIndex: 49 },
      { tabId: 7 } as Parameters<typeof tool.handler>[1],
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("Frame 21114 unreachable or removed. Re-snapshot.");
  });
```

（该用例不需要 `setCdpInputEnabled`——subframe 路径不过 gate；handler 第二参构造沿用文件内现有用例写法。）

- [ ] **Step 5: 全量验证**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿。若有其他文件仍 import 已删符号（`rg "resolveChromeToCdpFrameId|CdpFrameTreeNode|cdp-frame-id-unresolved" src/` 应只剩本 plan 已改文件），一并清理。

- [ ] **Step 6: Commit**

```bash
git add src/lib/dom-actions/geometry.ts src/lib/dom-actions/geometry.test.ts src/lib/agent/tools/mouse.ts src/__tests__/cross-layer/click-cdp-failure-modes.test.ts
git commit -m "refactor(geometry): drop chrome-to-CDP frame mapping; top-frame only"
```

---

### Task 5: snapshot 补采 aria-haspopup / aria-expanded

给 LLM "该元素会展开子内容"的弱信号（决定先 hover 还是直接 click）。

**Files:**
- Modify: `src/lib/dom-actions/interactive-summary.ts`（`InteractiveElementSummary` 加 2 个 optional 字段）
- Modify: `src/lib/dom-actions/probe-core.ts`（`interactiveSummary()` L395-409 填充）
- Modify: `src/lib/agent/tools/read-page.ts`（interactive 行渲染 L124-143 区域）
- Test: `src/lib/dom-actions/probe-core.test.ts` + `src/lib/agent/tools/read-page.test.ts`

- [ ] **Step 1: 写失败测试**

`probe-core.test.ts`（该文件的现有写法是直接 `const r = probePageInjected({ op: "snapshot" })`，照搬）：

```ts
it("captures aria-haspopup and aria-expanded on interactive elements", () => {
  document.body.innerHTML =
    `<button aria-haspopup="menu" aria-expanded="false">Options</button>` +
    `<a href="/x">Plain</a>`;
  const r = probePageInjected({ op: "snapshot" });
  const btn = r.interactiveElements.find((e) => e.tag === "button")!;
  expect(btn.hasPopup).toBe("menu");
  expect(btn.ariaExpanded).toBe("false");
  const link = r.interactiveElements.find((e) => e.tag === "a")!;
  expect(link.hasPopup).toBe("");
  expect(link.ariaExpanded).toBe("");
});
```

`read-page.test.ts` 两步：先给文件内 `elementSummary` builder（约 L19-48）的内联 Partial 类型与默认值对象各加 `hasPopup: ""` / `ariaExpanded: ""`，再追加用例（harness 照抄文件内 L525-568 的 `vi.stubGlobal` 模式）：

```ts
it("renders haspopup/expanded hover hints when present", async () => {
  vi.stubGlobal("chrome", {
    tabs: { get: vi.fn().mockResolvedValue({ id: 7, url: "https://x.com/", discarded: false }) },
    scripting: {
      executeScript: vi.fn().mockResolvedValue([
        {
          frameId: 0,
          result: {
            op: "snapshot" as const,
            html: "",
            interactiveElements: [
              elementSummary({ pieIdx: 1, tag: "button", role: "button", name: "Options", hasPopup: "menu", ariaExpanded: "false" }),
              elementSummary({ pieIdx: 2, tag: "a", role: "link", name: "Plain" }),
            ],
            scrollableHints: [],
          },
        },
      ]),
    },
    webNavigation: {
      getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, url: "https://x.com/" }]),
    },
  });

  const r = await readPageTool.handler({ tabId: 7, mode: "interactive" }, {} as any);
  expect(r.success).toBe(true);
  expect(r.observation).toContain('haspopup="menu"');
  expect(r.observation).toContain('expanded="false"');
  // 未设置 aria 的元素不渲染这两个属性 → 全文只出现一次
  expect(r.observation.match(/haspopup=/g)).toHaveLength(1);
  expect(r.observation.match(/expanded=/g)).toHaveLength(1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/dom-actions/probe-core.test.ts src/lib/agent/tools/read-page.test.ts`
Expected: FAIL（字段不存在）。

- [ ] **Step 3: 实现**

(a) `interactive-summary.ts` 的 `InteractiveElementSummary` 追加（optional——旧 fixture / 历史快照零波及）：

```ts
  /** Raw aria-haspopup value ("true" | "menu" | "listbox" | ... | ""). */
  hasPopup?: string;
  /** Raw aria-expanded value ("true" | "false" | ""). */
  ariaExpanded?: string;
```

(b) `probe-core.ts` `interactiveSummary()` 返回对象追加（注意 self-contained——`normalizeSpace` 是函数内已有 helper）：

```ts
      hasPopup: normalizeSpace(target.getAttribute("aria-haspopup") ?? ""),
      ariaExpanded: normalizeSpace(target.getAttribute("aria-expanded") ?? ""),
```

(c) `read-page.ts` interactive 行渲染，`if (el.selected)` 行之后追加：

```ts
    if (el.hasPopup) attrs.push(attr("haspopup", el.hasPopup));
    if (el.ariaExpanded) attrs.push(attr("expanded", el.ariaExpanded));
```

（`"false"` 是非空字符串、会渲染——`expanded="false"` 本身就是"可展开且当前收起"的信号，正是想要的。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/dom-actions/probe-core.test.ts src/lib/agent/tools/read-page.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/dom-actions/interactive-summary.ts src/lib/dom-actions/probe-core.ts src/lib/agent/tools/read-page.ts src/lib/dom-actions/probe-core.test.ts src/lib/agent/tools/read-page.test.ts
git commit -m "feat(snapshot): capture aria-haspopup/aria-expanded as hover hints"
```

---

### Task 6: tool descriptions + 文档 + 全量验证

**Files:**
- Modify: `src/lib/agent/tools/mouse.ts`（click/hover description）
- Modify: `docs/solutions/2026-05-12-iframe-invariant-trace.md`
- Modify: `docs/specs/2026-06-10-iframe-click-split-path.md`（状态行）

- [ ] **Step 1: 更新 description**

click description 首段之后加一行：

```
Top-frame elements (frameId 0) get real mouse events (CDP). Elements inside iframes (frameId > 0) get synthetic in-frame events — works on virtually all sites, but controls demanding trusted input may ignore it.
```

hover description USE WHEN 区下追加：

```
**Top frame only** (frameId 0). Hover is not supported inside iframes — click directly, or re-run read_page to check whether the content is already visible.
```

Run: `pnpm test src/lib/agent/tools/mouse.test.ts` — description 相关用例（检查 read_page 字样）应保持 PASS。

- [ ] **Step 2: 更新 invariant trace 文档**

`docs/solutions/2026-05-12-iframe-invariant-trace.md`：

(a) 文末追加章节：

```markdown
## 2026-06-10 更新 — click 分路径（spec: docs/specs/2026-06-10-iframe-click-split-path.md）

#81 的 CDP click 升级曾使 iframe 内 click 依赖 chrome↔CDP frame 映射（URL 启发式 +
Page.getFrameTree），OOPIF 下必断（`frame mapping failed`）。现改为：

- click frameId>0 → frame 内合成点击（act-core `click` op，经 `exec-act.ts`），不走 CDP。
  R-iframe-1 的 (frameId, elementIndex) 二元组与 schema required 不变。
- hover frameId>0 → 明确报错（top-frame only）。
- `geometry.ts` 的 `resolveChromeToCdpFrameId` 整套映射已删除。
```

(b) 修正 R-iframe-2 表格中已失效的 `src/lib/agent/frame-discovery.ts:getAllFramesAndDiff` 引用：先 `rg -n "allFrames: true" src/` 枚举当前真实 fan-out callsites（PR #152/#159 后主要在 `src/lib/agent/tools/read-page.ts`），把表格"集中入口"与 `READ_FANOUT_CALLSITES` 列表改为实际现状。

- [ ] **Step 3: spec 状态更新**

`docs/specs/2026-06-10-iframe-click-split-path.md` 头部 `- **状态**: design` 改为 `- **状态**: implemented (2026-06-10)`。

- [ ] **Step 4: 全量验证**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: 三连绿（build 同时跑 R-iframe-1 构建期断言）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/tools/mouse.ts docs/solutions/2026-05-12-iframe-invariant-trace.md docs/specs/2026-06-10-iframe-click-split-path.md docs/plans/2026-06-10-iframe-click-split-path.md
git commit -m "docs(iframe): tool descriptions + invariant trace for click split-path"
```

---

## 真机回归 checklist（merge 前人工执行）

1. 同域 iframe 内按钮 click 命中；
2. 跨域 OOPIF（第三方评论框 / embed 播放器）click 命中——本次回归场景（原报 `frame mapping failed for frameId 21114`）；
3. iframe 套 iframe（双层）click 命中；
4. iframe 滚出顶层视口 → click 仍命中（frame 内 scrollIntoViewIfNeeded 足够）；
5. `srcdoc` 子 frame click 命中（旧 URL 启发式断点）；
6. 纯 iframe 点击任务全程无 CDP 黄条 / 授权卡；
7. hover 子 frame → 固定报错且 LLM 能换路继续；
8. 顶层 click/hover 无回归（含 hover 出菜单后接 click 菜单项）；
9. 带 `aria-haspopup` 的按钮在 read_page `<interactive_index>` 中可见 `haspopup=` 属性。
