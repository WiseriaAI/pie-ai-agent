# 设计系统动画原语地基 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **工作目录**：本工程在 worktree `/Users/wenkang/repos/pie/pie-ai-agent/.claude/worktrees/design-system-foundation`，分支 `feat/design-system-motion`。subagent cwd 不随 worktree 切换——每个派活 prompt 必须强制 `cd` 到该绝对路径。

**Goal:** 引入 motion 动画原语 `<Collapse>` / `<Popover>`（封装在 `ui/`，业务组件不直接碰 motion API），并各落地一处高频场景，补齐"开有动画、关直接卸载"的不对称。

**Architecture:** 全局挂一个 `MotionProvider`（`LazyMotion + domAnimation` 精简档 + `MotionConfig reducedMotion="user"`），原语通过 `AnimatePresence` 让关闭也有动画再卸载。motion 的 transition 吃与 CSS `--duration-*`/`--ease-standard` 数值对齐的 JS 常量（`DURATION`/`EASE_STANDARD`），保持两端视觉一致。落地点选 `ThinkingSection`（Collapse）与 `ModelPicker`（Popover，收编其手写 mounted/shown/RAF/onTransitionEnd 状态机）。

**Tech Stack:** motion@12.40.0（`motion/react`，已装）· React 19 · TailwindCSS v4 · vitest + happy-dom + @testing-library/react

**前置已完成（spike 结论）：**
- 依赖 `motion` + `@formkit/auto-animate` 已装并 commit（`01439f6f`）。
- CSP：motion 全量包内 `eval(`/`new Function` 各 0 次 → 静态 CSP-safe（manifest `script-src 'self' 'wasm-unsafe-eval'`，无 `unsafe-eval`）。
- 体积（gzip）：`LazyMotion+domAnimation` +31KB / `auto-animate` +3KB。选型 B：motion 声明式原语为主。
- happy-dom 可测性：`m.div`+`AnimatePresence` 能渲染，exit 卸载可被 `waitForElementToBeRemoved` 测到；断言用原生 chai（`toBeNull`/`toBeTruthy`），每文件 `afterEach(() => cleanup())`（`src/test/setup.ts` 不全局 cleanup）。

**范围外（留作后续 Batch）：** `<Drawer>` / `<AnimatedList>` 原语及其落地（SessionDrawer / 会话列表）；ModelPicker 内部 accordion 折叠（grid-rows 方案已工作，YAGNI 不动）。本 plan 只做 2 个原语 + 2 处落地，可独立交付 + 真机验证。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `src/sidepanel/components/ui/motion.tsx`（新） | `MotionProvider` + `DURATION`/`EASE_STANDARD` 常量 + re-export `m`/`AnimatePresence`。唯一 `motion/react` 入口 |
| `src/sidepanel/components/ui/motion.test.tsx`（新） | provider 渲染 + token 常量值 |
| `src/sidepanel/components/ui/Collapse.tsx`（新） | `<Collapse open>` 双向高度动画 |
| `src/sidepanel/components/ui/Collapse.test.tsx`（新） | open/close 渲染与卸载时机 |
| `src/sidepanel/components/ui/Popover.tsx`（新） | `<Popover open>` portal + 进出场动画 |
| `src/sidepanel/components/ui/Popover.test.tsx`（新） | portal 挂载、open/close 卸载 |
| `src/sidepanel/main.tsx`（改） | 挂 `MotionProvider` |
| `src/sidepanel/components/ThinkingSection.tsx`（改） | 落地 `<Collapse>` |
| `src/sidepanel/components/ModelPicker.tsx`（改） | 落地 `<Popover>`，删手写动画状态机 |

---

## Task 0: MotionProvider + 时长常量 + 全局挂载

**Files:**
- Create: `src/sidepanel/components/ui/motion.tsx`
- Create: `src/sidepanel/components/ui/motion.test.tsx`
- Modify: `src/sidepanel/main.tsx`

- [ ] **Step 1: 写失败测试**

Create `src/sidepanel/components/ui/motion.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MotionProvider, DURATION, EASE_STANDARD } from "./motion";

afterEach(() => cleanup());

describe("MotionProvider", () => {
  it("renders its children", () => {
    render(<MotionProvider><span>child</span></MotionProvider>);
    expect(screen.getByText("child")).toBeTruthy();
  });

  it("exposes duration tokens (seconds) mirroring the CSS --duration-* values", () => {
    // index.css: --duration-fast 140ms / base 200ms / slow 260ms
    expect(DURATION).toEqual({ fast: 0.14, base: 0.2, slow: 0.26 });
  });

  it("exposes the standard easing tuple mirroring --ease-standard", () => {
    // index.css: --ease-standard cubic-bezier(0.32, 0.72, 0, 1)
    expect(EASE_STANDARD).toEqual([0.32, 0.72, 0, 1]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/ui/motion.test.tsx`
Expected: FAIL — `Failed to resolve import "./motion"`

- [ ] **Step 3: 实现 motion.tsx**

Create `src/sidepanel/components/ui/motion.tsx`:

```tsx
import { LazyMotion, domAnimation, MotionConfig, m, AnimatePresence } from "motion/react";
import type { ReactNode } from "react";

/** Motion duration tokens in SECONDS — numeric mirrors of the CSS --duration-*
 *  tokens in index.css (140/200/260ms), so motion transitions and the residual
 *  CSS keyframes stay visually in lockstep. */
export const DURATION = { fast: 0.14, base: 0.2, slow: 0.26 } as const;

/** Mirror of --ease-standard (cubic-bezier(0.32,0.72,0,1)) as a motion easing
 *  tuple. */
export const EASE_STANDARD = [0.32, 0.72, 0, 1] as const;

/** App-wide motion provider.
 *  - `LazyMotion features={domAnimation}` loads ONLY the DOM-animation feature
 *    bundle (measured +31KB gzip vs +50KB for a full `motion` import).
 *  - `strict` makes `motion.*` throw, forcing every consumer onto the
 *    tree-shakeable `m.*`.
 *  - `MotionConfig reducedMotion="user"` makes all motion animations honor the
 *    OS prefers-reduced-motion setting (jump to final state, no movement),
 *    complementing the CSS @media (prefers-reduced-motion) guard in index.css. */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}

// Single import surface: UI primitives pull `m` / `AnimatePresence` from here
// (never directly from "motion/react"), keeping the m.*↔LazyMotion pairing and
// the strict-mode contract centralized.
export { m, AnimatePresence };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/ui/motion.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: 全局挂载 MotionProvider**

Modify `src/sidepanel/main.tsx` — 加 import 并把 `<App />` 包进 `<MotionProvider>`。

import 区（在 `import { runStartupMigrations } ...` 后加）：
```tsx
import { MotionProvider } from "./components/ui/motion";
```

render 区改为：
```tsx
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <I18nProvider>
        <MotionProvider>
          <App />
        </MotionProvider>
      </I18nProvider>
    </StrictMode>,
  );
```

- [ ] **Step 6: typecheck + build（验证 CSP-safe 构建 + 记录包体增量）**

Run: `pnpm typecheck && pnpm build 2>&1 | grep -E 'index.html.*js|built in'`
Expected: typecheck 0 错；build 成功。记录 `index.html-*.js` 的 gzip 大小（基线参考：按钮批为 gzip 161.03KB；引入 motion 后预期 +~31KB gzip）。

- [ ] **Step 7: Commit**

```bash
git add src/sidepanel/components/ui/motion.tsx src/sidepanel/components/ui/motion.test.tsx src/sidepanel/main.tsx
git commit -m "feat(ui): MotionProvider (LazyMotion+domAnimation) + duration/ease 常量 + 全局挂载"
```

---

## Task 1: `<Collapse>` 原语

**Files:**
- Create: `src/sidepanel/components/ui/Collapse.tsx`
- Create: `src/sidepanel/components/ui/Collapse.test.tsx`

- [ ] **Step 1: 写失败测试**

Create `src/sidepanel/components/ui/Collapse.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, waitForElementToBeRemoved } from "@testing-library/react";
import { MotionProvider } from "./motion";
import { Collapse } from "./Collapse";

afterEach(() => cleanup());

function tree(open: boolean) {
  return (
    <MotionProvider>
      <Collapse open={open}>
        <div>panel-body</div>
      </Collapse>
    </MotionProvider>
  );
}

describe("Collapse", () => {
  it("renders children when open", () => {
    render(tree(true));
    expect(screen.queryByText("panel-body")).not.toBeNull();
  });

  it("renders nothing when initially closed", () => {
    render(tree(false));
    expect(screen.queryByText("panel-body")).toBeNull();
  });

  it("animates closed then unmounts children", async () => {
    const { rerender } = render(tree(true));
    expect(screen.queryByText("panel-body")).not.toBeNull();
    rerender(tree(false));
    await waitForElementToBeRemoved(() => screen.queryByText("panel-body"), { timeout: 2000 });
    expect(screen.queryByText("panel-body")).toBeNull();
  });

  it("forwards className onto the animating wrapper", () => {
    render(
      <MotionProvider>
        <Collapse open className="ml-3 border-l">
          <div>panel-body</div>
        </Collapse>
      </MotionProvider>,
    );
    const wrapper = screen.getByText("panel-body").parentElement!;
    expect(wrapper.className).toContain("ml-3");
    expect(wrapper.className).toContain("border-l");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/ui/Collapse.test.tsx`
Expected: FAIL — `Failed to resolve import "./Collapse"`

- [ ] **Step 3: 实现 Collapse.tsx**

Create `src/sidepanel/components/ui/Collapse.tsx`:

```tsx
import type { ReactNode } from "react";
import { m, AnimatePresence, DURATION, EASE_STANDARD } from "./motion";

interface CollapseProps {
  /** true: mount + animate open. false: animate closed, then unmount. */
  open: boolean;
  children: ReactNode;
  /** Classes on the animating wrapper (e.g. spacing/border on the revealed
   *  block). */
  className?: string;
}

/** Two-way height-auto expand/collapse. motion animates height 0 ↔ "auto"
 *  (it measures the content); AnimatePresence keeps the node mounted through
 *  the exit animation so CLOSING is animated too — fixing the common
 *  "open animates, close just unmounts" asymmetry. overflow-hidden clips the
 *  content while height is mid-transition. */
export function Collapse({ open, children, className }: CollapseProps) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <m.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: DURATION.base, ease: EASE_STANDARD }}
          style={{ overflow: "hidden" }}
          className={className}
        >
          {children}
        </m.div>
      )}
    </AnimatePresence>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/ui/Collapse.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/ui/Collapse.tsx src/sidepanel/components/ui/Collapse.test.tsx
git commit -m "feat(ui): <Collapse> 双向高度动画原语"
```

---

## Task 2: ThinkingSection 落地 Collapse + 真机验证

**Files:**
- Modify: `src/sidepanel/components/ThinkingSection.tsx`
- 验证: `src/sidepanel/components/ThinkingSection.test.tsx`（不改，应仍通过）

- [ ] **Step 1: 先跑现有测试确认基线绿**

Run: `pnpm test src/sidepanel/components/ThinkingSection.test.tsx`
Expected: PASS (2 tests) — 落地后必须仍然 PASS（契约不变：折叠时文本不在 DOM、点击后可见）。

- [ ] **Step 2: 落地 Collapse**

Modify `src/sidepanel/components/ThinkingSection.tsx`。

加 import（在 `import MarkdownContent from "./Markdown";` 后）：
```tsx
import { Collapse } from "./ui/Collapse";
```

把当前的条件渲染块：
```tsx
      {open && thinking && (
        <div className="view-enter ml-3 border-l border-line pl-2.5 text-[12px] leading-5 text-fg-2">
          <MarkdownContent content={thinking} />
        </div>
      )}
```
替换为（去掉 `view-enter`——动画改由 Collapse 接管双向高度+淡入）：
```tsx
      <Collapse open={open && !!thinking} className="ml-3 border-l border-line pl-2.5 text-[12px] leading-5 text-fg-2">
        <MarkdownContent content={thinking} />
      </Collapse>
```

- [ ] **Step 3: 跑测试确认仍通过**

Run: `pnpm test src/sidepanel/components/ThinkingSection.test.tsx`
Expected: PASS (2 tests)。
（说明：`queryByText("secret reasoning")` 在折叠态返回 null，因为 `open && !!thinking` 为 false → Collapse 不渲染 children；点击后同步挂载，`getByText` 命中。）

- [ ] **Step 4: typecheck**

Run: `pnpm typecheck`
Expected: 0 错。

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/ThinkingSection.tsx
git commit -m "feat(ui): ThinkingSection 思考折叠落地 <Collapse>（开关都有动画）"
```

- [ ] **Step 6: 真机 CSP + 动画验证（用户参与）**

Run: `pnpm build && pnpm sync:dist`
然后提示用户：去 `chrome://extensions` 刷新扩展 → 打开 sidepanel → 跑一个会产生 thinking 的任务 → 点击"思考过程"展开/收起。
确认：(a) 展开**和收起都有平滑高度动画**（不再是开有动画、关瞬断）；(b) 打开 DevTools console，**无 CSP 报错**（如 `Refused to evaluate ... unsafe-eval`）。
这是 spec 列为前置硬门槛的"真机 CSP 验证"——motion 第一次在真实扩展页跑动画。

---

## Task 3: `<Popover>` 原语

**Files:**
- Create: `src/sidepanel/components/ui/Popover.tsx`
- Create: `src/sidepanel/components/ui/Popover.test.tsx`

- [ ] **Step 1: 写失败测试**

Create `src/sidepanel/components/ui/Popover.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, waitForElementToBeRemoved } from "@testing-library/react";
import { MotionProvider } from "./motion";
import { Popover } from "./Popover";

afterEach(() => cleanup());

function tree(open: boolean) {
  return (
    <MotionProvider>
      <Popover open={open} role="dialog" className="fixed" style={{ left: 10, top: 20 }}>
        <div>popover-body</div>
      </Popover>
    </MotionProvider>
  );
}

describe("Popover", () => {
  it("renders nothing when closed", () => {
    render(tree(false));
    expect(screen.queryByText("popover-body")).toBeNull();
  });

  it("portals content under document.body when open (escapes the render container)", () => {
    const { container } = render(tree(true));
    const panel = screen.getByRole("dialog");
    expect(document.body.contains(panel)).toBe(true);
    expect(container.contains(panel)).toBe(false);
    expect(screen.getByText("popover-body")).toBeTruthy();
  });

  it("applies the forwarded positioning style + className", () => {
    render(tree(true));
    const panel = screen.getByRole("dialog");
    expect(panel.className).toContain("fixed");
    expect((panel as HTMLElement).style.left).toBe("10px");
  });

  it("animates closed then unmounts", async () => {
    const { rerender } = render(tree(true));
    expect(screen.queryByText("popover-body")).not.toBeNull();
    rerender(tree(false));
    await waitForElementToBeRemoved(() => screen.queryByText("popover-body"), { timeout: 2000 });
    expect(screen.queryByText("popover-body")).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/ui/Popover.test.tsx`
Expected: FAIL — `Failed to resolve import "./Popover"`

- [ ] **Step 3: 实现 Popover.tsx**

Create `src/sidepanel/components/ui/Popover.tsx`:

```tsx
import type { CSSProperties, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { m, AnimatePresence, DURATION, EASE_STANDARD } from "./motion";

interface PopoverProps {
  /** true: mount + animate in. false: animate out, then unmount. */
  open: boolean;
  /** Positioning (left/top/bottom/…) measured by the CALLER — Popover owns only
   *  mount + animation, never placement. Merged onto the portaled element. */
  style?: CSSProperties;
  className?: string;
  /** Forwarded onto the portaled element so the caller can run outside-click /
   *  measurement against it. */
  popoverRef?: RefObject<HTMLDivElement | null>;
  /** e.g. "dialog" / "menu" — forwarded for a11y. */
  role?: string;
  children: ReactNode;
}

/** Portaled popover with scale+fade enter/exit. Replaces the hand-rolled
 *  mounted/shown + double-RAF + onTransitionEnd dance: AnimatePresence keeps the
 *  node mounted through the exit animation, so close is animated and unmounts on
 *  its own. Portaled to document.body so ancestor overflow/stacking never clips
 *  it. */
export function Popover({ open, style, className, popoverRef, role, children }: PopoverProps) {
  return createPortal(
    <AnimatePresence>
      {open && (
        <m.div
          ref={popoverRef}
          role={role}
          style={style}
          className={className}
          initial={{ opacity: 0, scale: 0.96, y: 4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 4 }}
          transition={{ duration: DURATION.fast, ease: EASE_STANDARD }}
        >
          {children}
        </m.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/ui/Popover.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/ui/Popover.tsx src/sidepanel/components/ui/Popover.test.tsx
git commit -m "feat(ui): <Popover> portal + 进出场动画原语"
```

---

## Task 4: ModelPicker 落地 Popover（收编手写动画状态机）

**Files:**
- Modify: `src/sidepanel/components/ModelPicker.tsx`
- 验证: `src/sidepanel/components/ModelPicker.test.tsx`（不改，应仍通过）

**背景**：当前 ModelPicker 用 `mounted`/`shown` 双 state + 双 RAF useEffect + `onTransitionEnd` 手动管 popover 进出场卸载。Popover 原语用 AnimatePresence 接管这一切。定位（`coords`/`updateCoords` + 两个定位 useEffect + outside-click effect）**保留不动**。

- [ ] **Step 1: 先跑现有测试确认基线绿**

Run: `pnpm test src/sidepanel/components/ModelPicker.test.tsx`
Expected: PASS（含 `renders the popover via a portal under document.body`）。落地后必须仍 PASS。

- [ ] **Step 2: 改 import**

在 `src/sidepanel/components/ModelPicker.tsx` 顶部：
- 删除：`import { createPortal } from "react-dom";`（Popover 内部负责 portal，本文件不再直接用）
- 加：`import { Popover } from "./ui/Popover";`

- [ ] **Step 3: 删除手写动画 state**

删除这两行（当前 L68-69）：
```tsx
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
```
（连同其上方 L65-67 的注释块一并删除。）

- [ ] **Step 4: 删除双 RAF useEffect**

删除整段（当前 L127-136）：
```tsx
  useEffect(() => {
    if (open) {
      setMounted(true);
      // Two RAFs so the element paints in its initial (hidden) state before we
      // flip `shown`, guaranteeing the enter transition actually runs.
      const r = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(r);
    }
    setShown(false); // trigger exit transition; unmount on its end
  }, [open]);
```

- [ ] **Step 5: 把 `mounted && coords && createPortal(...)` 换成 `<Popover>`**

把当前 render 里的整段（当前 L184-256，从 `{mounted && coords && createPortal(` 到 `document.body,\n      )}`）替换为：

```tsx
      <Popover
        open={open && !!coords}
        popoverRef={popoverRef}
        role="dialog"
        style={{ left: coords?.left, top: coords?.top, bottom: coords?.bottom }}
        className="fixed z-[100] w-[300px] max-w-[calc(100vw-1.5rem)] rounded-card border border-line bg-surface shadow-pop"
      >
          <div className="flex items-baseline justify-between px-3.5 pt-2.5 pb-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-fg-3">{t("modelPicker.title")}</span>
            <span className="font-mono text-[10px] text-fg-3">{props.instances.length} {t("modelPicker.providersSuffix")}</span>
          </div>
          <div className="flex max-h-[360px] flex-col overflow-y-auto">
            {props.instances.map((inst) => {
              const isExpanded = expandedId === inst.id;
              const isCurrentProvider = inst.id === props.currentInstanceId;
              return (
                <div key={inst.id} className={isExpanded ? "bg-field" : ""}>
                  <button
                    onClick={() => toggleProvider(inst)}
                    className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left transition-colors hover:bg-field"
                  >
                    <ProviderIcon provider={inst.provider} size={22} className={isCurrentProvider ? "text-accent" : "text-fg-2"} />
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg-1">{providerName(inst)}</span>
                    {!isExpanded && isCurrentProvider && props.currentModel && (
                      <span className="font-mono text-[10px] text-accent">{shortModel(props.currentModel)}</span>
                    )}
                    <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden style={{ transform: isExpanded ? "rotate(90deg)" : "none", flexShrink: 0, transition: "transform 0.2s ease" }}>
                      <path d="M3 2L5 4L3 6" fill="none" stroke="#8A929E" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateRows: isExpanded ? "1fr" : "0fr",
                      transition: "grid-template-rows 0.22s ease",
                    }}
                  >
                    <div style={{ overflow: "hidden" }}>
                      <ExpandedModels
                        inst={inst}
                        isExpanded={isExpanded}
                        query={query}
                        setQuery={setQuery}
                        currentModel={isCurrentProvider ? props.currentModel : null}
                        onPick={(model) => { props.onSelect(inst.id, model); setOpen(false); }}
                        placeholder={`${providerName(inst)} ${t("modelPicker.searchSuffix")}`}
                        emptyText={t("modelPicker.noModels")}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {props.onManage && (
            <button
              onClick={() => { setOpen(false); props.onManage?.(); }}
              className="flex w-full items-center gap-2 border-t border-line px-3.5 py-2 text-left text-[11px] text-fg-2 transition-colors hover:bg-field"
            >
              <span>{t("modelPicker.manage")}</span>
            </button>
          )}
      </Popover>
```

（关键差异：外层 `{mounted && coords && createPortal(<div ref={popoverRef} role="dialog" onTransitionEnd=... style={{...,opacity,transform,transition}} className="fixed ...">` → `<Popover open={open && !!coords} popoverRef={popoverRef} role="dialog" style={{left,top,bottom}} className="fixed ...">`。删掉了 inline 的 opacity/transform/transition（进出场交给 Popover）和 `onTransitionEnd`。内部内容原样保留。结尾 `</div>,\n        document.body,\n      )}` → `</Popover>`。)

- [ ] **Step 6: 跑测试确认仍通过**

Run: `pnpm test src/sidepanel/components/ModelPicker.test.tsx`
Expected: PASS（全部）。
（`getByRole("dialog")` 命中 Popover 的 `role="dialog"`；portal 到 body；open 后 effect flush 测好 `coords`，`open && !!coords` 为 true 同步挂载。`does not open when locked` 时 open=false → Popover 渲染 null。）

- [ ] **Step 7: typecheck + 全量测试 + build**

Run: `pnpm typecheck && pnpm test && pnpm build 2>&1 | tail -3`
Expected: typecheck 0；全量测试全绿；build 成功。

- [ ] **Step 8: Commit**

```bash
git add src/sidepanel/components/ModelPicker.tsx
git commit -m "feat(ui): ModelPicker 进出场落地 <Popover>，删手写 mounted/shown/RAF/onTransitionEnd"
```

- [ ] **Step 9: 真机验证（用户参与）**

Run: `pnpm build && pnpm sync:dist`
提示用户：刷新扩展 → 打开 Composer 的模型选择器，确认开关都有 scale+fade 进出场（不再瞬断）、定位正确（上方/下方翻转、贴边 clamp）、外点关闭正常、console 无 CSP 报错。

---

## Self-Review

**1. Spec coverage**（对照 `docs/specs/2026-06-14-ui-design-system-motion-polish.md` §5）：
- §5.1 选 motion `LazyMotion+domAnimation+m.*` → Task 0 ✓
- §5.1 Task 0 spike（CSP/包体/真机）→ 已完成（spike）+ Task 2/4 Step 真机验证 ✓
- §5.2 `<Collapse>` 双向 + 落地 ThinkingSection → Task 1 + Task 2 ✓
- §5.2 `<Popover>` AnimatePresence scale+fade + 收编手写 onAnimationEnd → Task 3 + Task 4 ✓
- §5.2 `<Drawer>` / `<AnimatedList>` → **明确范围外**（本 plan 头部已声明，留作后续 Batch）
- §5.3 吃 `--duration-*`/`--ease-standard` + `useReducedMotion` 双保险 → `DURATION`/`EASE_STANDARD` 常量 + `MotionConfig reducedMotion="user"` + 现有 CSS @media ✓
- §5.3 高频纯入场（bubble-in）保留 CSS → 不动 index.css keyframes ✓

**2. Placeholder scan**：无 TBD/TODO；每个改代码的 step 都有完整代码块；测试代码均为 spike 验证过的可跑结构。✓

**3. Type consistency**：`MotionProvider`/`DURATION`/`EASE_STANDARD`/`m`/`AnimatePresence` 从 `./motion` 一致导出；`Collapse({open,children,className})` / `Popover({open,style,className,popoverRef,role,children})` 的 prop 名在落地 task（Task 2/4）调用处一致；`DURATION.base`(Collapse)/`DURATION.fast`(Popover) 均为已定义键。✓

---

## Execution Handoff

完成后用 `superpowers:subagent-driven-development` 逐 task 执行（fresh subagent + 两阶段 review），或在本 session inline 执行。Task 2 Step 6 / Task 4 Step 9 的真机验证需要用户参与，执行到那里时暂停等用户反馈。全部 task 完成后走 `superpowers:finishing-a-development-branch`（main 受保护，PR；先 `gh auth switch --user WiseriaAI`）。
