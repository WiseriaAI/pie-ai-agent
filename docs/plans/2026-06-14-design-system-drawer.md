# `<Drawer>` overlay 原语 + SessionDrawer 容器迁移 Implementation Plan

> 执行：inline（本 session），塌缩档（原语 TDD + 单一同构迁移）。worktree `/Users/wenkang/repos/pie/pie-ai-agent/.claude/worktrees/design-system-foundation`，分支 `feat/design-system-drawer`（基于 origin/main 30f4d289，含 #187/#189/#190/#191/#193）。设计系统动画工程**最高风险一批，单列**。

**Goal:** 抽出「完整 Drawer 对话框原语」`<Drawer>`（motion 驱动遮罩淡入 + 面板侧滑 + ESC + focus trap + 焦点恢复 + `role=dialog/aria-modal/aria-label`），把 `SessionDrawer`（675 行）迁上去，删掉其手写的 `useDrawerTransition`（延迟卸载 + 双 rAF + 240ms timeout）+ 手写 focus/ESC effect + 早返回，SessionDrawer 退化为纯内容容器。

**Architecture:** 原语吃满 overlay 全部机制（前几批 Collapse/Popover 一致的「一原语吃满一类完整职责」原则）；SessionDrawer 只剩会话列表内容 + storage/archived 数据逻辑。**非 portal、`position: fixed` 内联**渲染（保持现行为，不像 Popover 那样 portal 到 body——降风险），AnimatePresence 管进出场。Token 收拢：面板滑入 `DURATION.slow`(260，原 240)、遮罩淡入 `DURATION.base`(200)、ease `EASE_STANDARD`（原 inline 即此曲线）。顺带补 a11y 缺口：现 inline transition 不吃 `prefers-reduced-motion`，换 motion 后由 `MotionProvider reducedMotion="user"` 自动兜底。

**Tech Stack:** motion（`m.div`/`AnimatePresence`）· React 19 · vitest + happy-dom（依赖既有 WAAPI stub）

## 前置事实
- 单消费者：全仓仅 `SessionDrawer` 是 drawer（grep 确认），原语单落地，符合前几批节奏。
- App.tsx 始终挂载 `<SessionDrawer isOpen={drawerOpen} .../>`（line 388），由 `isOpen` 驱动；AnimatePresence 在原语内部管条件 mount/unmount，App 侧零改动。
- 测试范式（同 Popover.test/DropdownPanel.test）：`MotionProvider` 包裹 + `waitForElementToBeRemoved` 等退场；`afterEach(cleanup)`；原生 chai。WAAPI stub 让 m.div 同步挂载 + 动画瞬时完成 → 现有同步 `getByRole("dialog")` 断言不变。
- 现 `FOCUSABLE_SELECTORS` 含 `[role='listitem']`（drawer 行可进 Tab 循环）——**原封不动搬进原语**，保持现行为。
- 当前 backdrop 关闭中 `pointerEvents:none` 让点击穿透；迁 AnimatePresence 后退场期 backdrop 仍短暂在场，再次点击只会重复 `setDrawerOpen(false)`（幂等无害）→ 放弃该微优化，可接受。

## File Structure
| 文件 | 责任 |
|---|---|
| `src/sidepanel/components/ui/Drawer.tsx`（新） | 完整 overlay 原语：AnimatePresence + 遮罩(淡入/点击关) + 面板(侧滑) + ESC + focus trap + 焦点恢复 + 初始聚焦 + dialog a11y |
| `src/sidepanel/components/ui/Drawer.test.tsx`（新） | closed 渲染空 / open 渲染 dialog / ESC→onClose / backdrop 点击→onClose / 初始聚焦首个 focusable / 关闭恢复前焦点 / focus trap 首尾回环 / 退场卸载 |
| `src/sidepanel/components/SessionDrawer.tsx`（改） | 删 `useDrawerTransition`+`DRAWER_TRANSITION_MS`/`DRAWER_EASING`+focus/ESC effect+`preFocusRef`+`drawerRef`+早返回；内容裹进 `<Drawer>` |

## Task 1: `<Drawer>` 原语 + 测试（TDD）

**Files:**
- Create: `src/sidepanel/components/ui/Drawer.tsx`
- Test: `src/sidepanel/components/ui/Drawer.test.tsx`

- [ ] **Step 1: 写失败测试 `Drawer.test.tsx`**

```tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitForElementToBeRemoved } from "@testing-library/react";
import { useState } from "react";
import { MotionProvider } from "./motion";
import { Drawer } from "./Drawer";

afterEach(() => cleanup());

function wrap(ui: React.ReactNode) {
  return render(<MotionProvider>{ui}</MotionProvider>);
}

describe("Drawer", () => {
  it("renders nothing when closed", () => {
    wrap(<Drawer open={false} onClose={() => {}} ariaLabel="Sessions"><button>x</button></Drawer>);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders a dialog with aria-modal + aria-label when open", () => {
    wrap(<Drawer open onClose={() => {}} ariaLabel="Sessions"><button>x</button></Drawer>);
    const d = screen.getByRole("dialog");
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(d.getAttribute("aria-label")).toBe("Sessions");
  });

  it("calls onClose on ESC", () => {
    const onClose = vi.fn();
    wrap(<Drawer open onClose={onClose} ariaLabel="S"><button>x</button></Drawer>);
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose on backdrop click", () => {
    const onClose = vi.fn();
    wrap(<Drawer open onClose={onClose} ariaLabel="S" backdropTestId="bd"><button>x</button></Drawer>);
    fireEvent.click(document.querySelector("[data-testid='bd']")!);
    expect(onClose).toHaveBeenCalled();
  });

  it("focuses the first focusable element on open", () => {
    wrap(<Drawer open onClose={() => {}} ariaLabel="S"><button>first</button><button>second</button></Drawer>);
    expect(document.activeElement?.textContent).toBe("first");
  });

  it("traps focus: Shift+Tab on first wraps to last", () => {
    wrap(<Drawer open onClose={() => {}} ariaLabel="S"><button>first</button><button>last</button></Drawer>);
    const first = screen.getByText("first");
    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement?.textContent).toBe("last");
  });

  it("restores focus to the pre-open element on close, then unmounts", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "trigger";
    document.body.appendChild(trigger);
    trigger.focus();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setOpen(false)}>close</button>
          <Drawer open={open} onClose={() => setOpen(false)} ariaLabel="S"><button>inside</button></Drawer>
        </>
      );
    }
    wrap(<Harness />);
    fireEvent.click(screen.getByText("close"));
    await waitForElementToBeRemoved(() => screen.queryByRole("dialog"));
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `pnpm test src/sidepanel/components/ui/Drawer.test.tsx`
Expected: FAIL（`Drawer` 模块不存在）。

- [ ] **Step 3: 实现 `Drawer.tsx`**

```tsx
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { m, AnimatePresence, DURATION, EASE_STANDARD } from "./motion";

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  /** Slide-in edge. v1 only "left" (SessionDrawer). */
  side?: "left";
  /** Panel width in px. */
  width?: number;
  /** Optional data-testid forwarded to the backdrop (lets consumers/tests target it). */
  backdropTestId?: string;
  /** Inline styles merged onto the panel (consumer owns bg/border/layout). */
  panelStyle?: CSSProperties;
  children: ReactNode;
}

const FOCUSABLE_SELECTORS = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[role='listitem']",
].join(", ");

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS));
}

export function Drawer({
  open,
  onClose,
  ariaLabel,
  side = "left",
  width = 296,
  backdropTestId,
  panelStyle,
  children,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const preFocusRef = useRef<Element | null>(null);

  // Open lifecycle: save+set initial focus; ESC + focus trap; restore focus on close.
  useEffect(() => {
    if (!open) return;
    preFocusRef.current = document.activeElement;
    const panel = panelRef.current;
    if (panel) {
      const focusable = getFocusable(panel);
      if (focusable.length > 0) focusable[0]!.focus();
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const current = panelRef.current;
      if (!current) return;
      const focusable = getFocusable(current);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (preFocusRef.current instanceof HTMLElement) preFocusRef.current.focus();
    };
  }, [open, onClose]);

  const offscreen = side === "left" ? "-100%" : "100%";

  return (
    <AnimatePresence>
      {open && (
        <>
          <m.div
            data-testid={backdropTestId}
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DURATION.base, ease: EASE_STANDARD }}
            style={{
              position: "fixed",
              inset: 0,
              background: "var(--c-overlay-strong)",
              zIndex: 40,
            }}
          />
          <m.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            initial={{ x: offscreen }}
            animate={{ x: 0 }}
            exit={{ x: offscreen }}
            transition={{ duration: DURATION.slow, ease: EASE_STANDARD }}
            style={{
              position: "fixed",
              top: 0,
              [side]: 0,
              width,
              height: "100%",
              zIndex: 50,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              ...panelStyle,
            }}
          >
            {children}
          </m.div>
        </>
      )}
    </AnimatePresence>
  );
}
```

注：`[side]: 0` 是计算属性键（`left: 0`）。`panelStyle` 让 SessionDrawer 注入 `background`/`borderRight`（其专属外观），原语只管定位 + 动画 + 布局骨架。

- [ ] **Step 4: 跑测试确认 PASS**

Run: `pnpm test src/sidepanel/components/ui/Drawer.test.tsx`
Expected: PASS（8 例）。`pnpm typecheck` → 0。

- [ ] **Step 5: commit**

```bash
git add src/sidepanel/components/ui/Drawer.tsx src/sidepanel/components/ui/Drawer.test.tsx
git commit -m "feat(ui): add Drawer overlay primitive (motion-driven backdrop+slide+focus-trap)"
```

## Task 2: SessionDrawer 迁移到 `<Drawer>`

**Files:**
- Modify: `src/sidepanel/components/SessionDrawer.tsx`

- [ ] **Step 1: 删手写生命周期机制**

删除：
- `useDrawerTransition` 整个函数（L60-82）及其上方注释块（L49-59）。
- 常量 `DRAWER_TRANSITION_MS` / `DRAWER_EASING`（L84-85）。
- `FOCUSABLE_SELECTORS` / `getFocusableElements`（L89-101）——搬进原语，SessionDrawer 不再需要。
- ESC + focus trap effect 整段（L287-342）。
- `preFocusRef`（L283）、`drawerRef`（L279）。
- `const { mounted, open: animateOpen } = useDrawerTransition(...)` + `if (!mounted) return null;`（L349-353）。
- import `useRef`（若仅 drawerRef/preFocusRef 用到则去；`StorageIndicator`/`SessionRowWithDelete` 不用 ref，需确认无其它 `useRef` 用途——当前仅这两处用 → 从 `import { useCallback, useEffect, useRef, useState }` 去掉 `useRef`）。

- [ ] **Step 2: 加 Drawer import**

在 import 区加：
```tsx
import { Drawer } from "./ui/Drawer";
```

- [ ] **Step 3: 用 `<Drawer>` 包裹内容**

把 `return ( <> {backdrop div} {panel div} </> )`（L378-604）整体替换为：

```tsx
  return (
    <Drawer
      open={isOpen}
      onClose={onClose}
      ariaLabel={t("sessions.header")}
      backdropTestId="drawer-backdrop"
      panelStyle={{
        background: "var(--c-surface-deep)",
        borderRight: "1px solid var(--c-line)",
      }}
    >
      {/* Header */}
      <div style={{ padding: "14px 16px 12px 16px", display: "flex", alignItems: "center", gap: 8 }}>
        … 原 Header 内容（logo svg + 标题 + count）原样保留 …
      </div>

      {/* ACTIVE section divider */}
      … 原样 …

      {/* Session list (scrollable) */}
      … 原样（含 sessionListRef={useAnimatedList} 的 ul）…

      {/* SHOW ARCHIVED toggle */}
      … 原样 …

      {/* Archived session list */}
      … 原样 …

      {/* Storage indicator */}
      <StorageIndicator />
    </Drawer>
  );
```

要点：
- **只删外层 backdrop `<div>` 与 panel `<div>` 的开闭标签 + 它们的 inline 定位/动画 style**；内部所有内容（header / divider / list / archived toggle / archived list / StorageIndicator）原封不动平移进 `<Drawer>` children。
- `data-state` 属性（原 backdrop/panel 上的 `data-state={animateOpen?"open":"closed"}`）随旧 div 删除——无测试/无 CSS 依赖它（grep 确认仅这两处出现）。
- `role="dialog" aria-modal aria-label` 由原语提供，旧 panel div 上这三个属性删除（移到原语）。
- `drawerRef` 引用删除（panel ref 进原语内部）。
- `sessionListRef`（useAnimatedList）、`showArchived` 状态、`activeSessions`/`archivedSessions` 切分、`handleSelectSession`/`handleSoftDelete`/`handleUnarchive`/`handleDeleteForever` —— 全部保留不动。

- [ ] **Step 4: 跑 SessionDrawer 测试确认全绿**

Run: `pnpm test src/sidepanel/components/SessionDrawer.test.tsx`
Expected: PASS（含 visibility/rows/interactions/a11y/storage/header 全部；`isOpen=false→无 dialog`、`isOpen=true→有 dialog`、backdrop 点击关、ESC 关 均由原语满足）。

- [ ] **Step 5: commit**

```bash
git add src/sidepanel/components/SessionDrawer.tsx
git commit -m "refactor(sessions): migrate SessionDrawer onto Drawer primitive, drop hand-rolled transition"
```

## 验证（Task 3）
- `pnpm typecheck` → 0
- 全量 `pnpm test` → 绿（关注 SessionDrawer + Drawer 两文件，及任何依赖 SessionDrawer 渲染的集成测试）
- `pnpm build` → 过
- `pnpm sync:dist` → 真机：抽屉打开（遮罩淡入 + 面板左滑）、关闭（反向退场不瞬断）、ESC 关、点遮罩关、Tab 焦点不逃逸抽屉、关闭后焦点回到列表按钮、archived 折叠、hover 删除、storage 数字均正常；`prefers-reduced-motion` 开时瞬切无位移。

## 范围外（后续批 / follow-up）
- SkillSlashPopover（`placement="above"`）/ ContextRing（inline-style 定位）按需迁 Popover + useAnchorRect。
- ModelPicker dogfood `useAnchorRect`（删手写 updateCoords/coords/两 effect，flip/clamp 抽纯函数）。
- `<Drawer>` 的 `side="right"` 分支已留接口但 v1 无消费者，未来需要时再单测点亮。
- 需要时加 `ui/index.ts` barrel；dogfood `duration`/`ease` token 到 Button/IconButton。
