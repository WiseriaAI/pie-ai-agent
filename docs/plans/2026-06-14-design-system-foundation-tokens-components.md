# 设计系统地基 · Token + Button/IconButton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把设计系统的 token 化从"仅颜色/字号"扩展到圆角/动画/阴影，并新建 `Button` / `IconButton` 两个承载组件与 `ICON_SIZE` 常量，作为后续全 UI 规整化的地基。

**Architecture:** 全部为**新增**——新 token 用语义命名（`--radius-chip/control/card`）避免覆盖 Tailwind 默认、零副作用；新组件落在新建的 `src/sidepanel/components/ui/` 目录。本 plan **不改动任何现有组件**，因此零回归、可独立合并。现有 `rounded-[Npx]` / `text-[Npx]` 等 inline 值的迁移留给后续 Batch 1+ 各组件 plan。动画原语（Collapse/Popover/Drawer/AnimatedList）与 `motion` 库 spike 属于**下一个 plan**（依赖 spike 结论，不在此）。

**Tech Stack:** TailwindCSS v4（CSS-first `@theme`）· React 19 + TS · vitest + happy-dom + @testing-library/react

**Spec:** `docs/specs/2026-06-14-ui-design-system-motion-polish.md`（本 plan 覆盖 spec §4.1 token、§4.2 组件、§4.1 图标尺寸常量；§4.3 实心/描边为约定，随迁移执行；§5 动画为下一个 plan）

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/sidepanel/index.css`（Modify） | `@theme` 追加 radius / type-scale / motion / shadow token（新增，不覆盖默认） |
| `src/sidepanel/index.theme.test.ts`（Create） | token 回潮防护：断言 CSS 含新增 token 定义 |
| `src/sidepanel/components/ui/tokens.ts`（Create） | `ICON_SIZE` 数值常量（14/16/20）供 SVG 组件用 |
| `src/sidepanel/components/ui/tokens.test.ts`（Create） | 断言 ICON_SIZE 档位值 |
| `src/sidepanel/components/ui/Button.tsx`（Create） | 统一按钮：4 variant × 2 size + loading/icon 槽 |
| `src/sidepanel/components/ui/Button.test.tsx`（Create） | Button 行为 + variant + a11y 测试 |
| `src/sidepanel/components/ui/IconButton.tsx`（Create） | 图标按钮：2 size × 2 variant，必填 aria-label |
| `src/sidepanel/components/ui/IconButton.test.tsx`（Create） | IconButton 行为 + a11y 测试 |

---

## Task 1: 扩展 `@theme` 设计 token（CSS，纯新增）

**Files:**
- Modify: `src/sidepanel/index.css`（`@theme` 块，当前在 121–143 行，只含 color + font）
- Test: `src/sidepanel/index.theme.test.ts`（Create）

> CSS token 不适合 React 单测（happy-dom 不计算 CSS 值）。验证用三段证据：① 文件内容断言（回潮防护）；② `pnpm build`（Tailwind 编译新 utility 不报错）；③ `pnpm typecheck`。

- [ ] **Step 1: 写回潮防护测试（先失败）**

Create `src/sidepanel/index.theme.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

// Reads the raw CSS so the token contract can't silently regress.
const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");

describe("design tokens (@theme)", () => {
  it("defines the 3-tier semantic radius scale (additive, not overriding Tailwind defaults)", () => {
    expect(css).toContain("--radius-chip: 6px");
    expect(css).toContain("--radius-control: 10px");
    expect(css).toContain("--radius-card: 14px");
  });

  it("defines the motion duration + easing tokens", () => {
    expect(css).toContain("--ease-standard: cubic-bezier(0.32, 0.72, 0, 1)");
    expect(css).toContain("--duration-fast: 140ms");
    expect(css).toContain("--duration-base: 200ms");
    expect(css).toContain("--duration-slow: 260ms");
  });

  it("defines the type scale tokens", () => {
    expect(css).toContain("--text-body: 13px");
    expect(css).toContain("--text-h2: 18px");
    expect(css).toContain("--text-display: 22px");
  });

  it("defines the two elevation tokens", () => {
    expect(css).toContain("--shadow-pop:");
    expect(css).toContain("--shadow-overlay:");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/index.theme.test.ts`
Expected: FAIL —— 四个断言都报 `expected '…' to contain '--radius-chip: 6px'` 等（token 尚未定义）。

- [ ] **Step 3: 在 `@theme` 末尾追加 token**

编辑 `src/sidepanel/index.css`，在 `@theme { … }` 块内（`--font-mono` 行之后、闭合 `}` 之前）追加：

```css
  /* ── Radius — semantic, additive. Named to AVOID overriding Tailwind's
       default rounded-sm/md/lg so existing rounded-md/lg usages don't shift.
       12 ad-hoc values collapse into 3 tiers + rounded-full (Tailwind default). */
  --radius-chip: 6px;      /* icon button · chip · 小指示 */
  --radius-control: 10px;  /* 按钮 · 输入框 · 小卡（代码事实标准） */
  --radius-card: 14px;     /* 大卡片 · section 面板 */

  /* ── Type scale — mirrors the Foundations board (用途命名). px size + line-height.
       Tailwind v4 maps --text-{name} → text-{name} utility, --text-{name}--line-height
       → that utility's line-height. None collide with default text-xs/sm/base/lg. */
  --text-caps: 11px;
  --text-caps--line-height: 16px;
  --text-caption: 12px;
  --text-caption--line-height: 16px;
  --text-body: 13px;
  --text-body--line-height: 19px;
  --text-body-lg: 14px;
  --text-body-lg--line-height: 21px;
  --text-h3: 16px;
  --text-h3--line-height: 22px;
  --text-h2: 18px;
  --text-h2--line-height: 24px;
  --text-display: 22px;
  --text-display--line-height: 26px;

  /* ── Motion — promote the existing geometric easing + a 3-step duration scale
       to tokens. Shared by残留 CSS transitions and the motion lib (next plan).
       Tailwind v4: --ease-{n} → ease-{n}, --duration-{n} → duration-{n}. */
  --ease-standard: cubic-bezier(0.32, 0.72, 0, 1);
  --duration-fast: 140ms;   /* 退出 · 微交互 */
  --duration-base: 200ms;   /* 标准进出场 */
  --duration-slow: 260ms;   /* 抽屉 · 大面板 */

  /* ── Elevation — replaces hardcoded shadow-[0_8px_24px_…]. */
  --shadow-pop: 0 8px 24px rgba(0, 0, 0, 0.18);
  --shadow-overlay: 0 16px 48px rgba(0, 0, 0, 0.32);
```

> 生成的 utility：`rounded-chip/control/card`、`text-caps/caption/body/body-lg/h3/h2/display`、`ease-standard`、`duration-fast/base/slow`、`shadow-pop/overlay`。`rounded-full` 沿用 Tailwind 默认。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/index.theme.test.ts`
Expected: PASS（4 个测试全绿）。

- [ ] **Step 5: 验证 Tailwind 能编译新 utility + 类型不破**

Run: `pnpm build`
Expected: 构建成功，无 "Cannot apply unknown utility class" 之类报错。

Run: `pnpm typecheck`
Expected: 0 错误。

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/index.css src/sidepanel/index.theme.test.ts
git commit -m "feat(ui): add radius/type/motion/shadow design tokens to @theme"
```

---

## Task 2: `ICON_SIZE` 常量（图标尺寸 3 档）

**Files:**
- Create: `src/sidepanel/components/ui/tokens.ts`
- Test: `src/sidepanel/components/ui/tokens.test.ts`

> 图标尺寸用于 SVG 的 `width`/`height` 数值（非 CSS class），所以落为 TS 常量，供 `icons.tsx` 与各组件复用。

- [ ] **Step 1: 写测试（先失败）**

Create `src/sidepanel/components/ui/tokens.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ICON_SIZE } from "./tokens";

describe("ICON_SIZE", () => {
  it("exposes the 3-tier icon size scale in px", () => {
    expect(ICON_SIZE.sm).toBe(14);
    expect(ICON_SIZE.md).toBe(16);
    expect(ICON_SIZE.lg).toBe(20);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/ui/tokens.test.ts`
Expected: FAIL —— 模块不存在（`Failed to resolve import "./tokens"`）。

- [ ] **Step 3: 创建常量**

Create `src/sidepanel/components/ui/tokens.ts`:

```ts
/**
 * UI icon size scale (px) — sm=按钮内联/密集操作, md=独立 icon button/状态,
 * lg=品牌/强调入口. See docs/specs/2026-06-14-ui-design-system-motion-polish.md §4.1.
 *
 * Use these for SVG width/height. Radius / type / motion live as CSS @theme
 * tokens (utility classes), not here.
 */
export const ICON_SIZE = { sm: 14, md: 16, lg: 20 } as const;
export type IconSizeKey = keyof typeof ICON_SIZE;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/ui/tokens.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/ui/tokens.ts src/sidepanel/components/ui/tokens.test.ts
git commit -m "feat(ui): add ICON_SIZE scale constant"
```

---

## Task 3: `Button` 组件

**Files:**
- Create: `src/sidepanel/components/ui/Button.tsx`
- Test: `src/sidepanel/components/ui/Button.test.tsx`

> Variant 样式直接提炼自现有真实按钮（`InstanceForm.tsx:283-307` primary/secondary/danger）。`rounded-control` 来自 Task 1。Spinner 复用 `InstanceForm.tsx:337-344` 的内联 svg。默认 `variant="secondary" size="sm"`（现状最常见）。

- [ ] **Step 1: 写测试（先失败）**

Create `src/sidepanel/components/ui/Button.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Button } from "./Button";

afterEach(() => cleanup());

describe("Button", () => {
  it("renders children and fires onClick", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire onClick when disabled", () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Save</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("is disabled and suppresses onClick while loading", () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Save</Button>);
    const btn = screen.getByRole("button", { name: /save/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("applies the primary fill class", () => {
    render(<Button variant="primary">Go</Button>);
    expect(screen.getByRole("button").className).toContain("bg-fg-1");
  });

  it("applies the danger tone class", () => {
    render(<Button variant="danger">Forget</Button>);
    expect(screen.getByRole("button").className).toContain("text-warning");
  });

  it("uses the control radius token", () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole("button").className).toContain("rounded-control");
  });

  it("merges custom className", () => {
    render(<Button className="mt-2">Go</Button>);
    expect(screen.getByRole("button").className).toContain("mt-2");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/ui/Button.test.tsx`
Expected: FAIL —— `Failed to resolve import "./Button"`。

- [ ] **Step 3: 实现 Button**

Create `src/sidepanel/components/ui/Button.tsx`:

```tsx
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  loading?: boolean;
  fullWidth?: boolean;
}

// Distilled from existing buttons (InstanceForm.tsx:283-307).
const VARIANT: Record<Variant, string> = {
  primary: "bg-fg-1 text-canvas font-medium hover:opacity-90 active:opacity-80",
  secondary:
    "border border-line bg-transparent text-fg-2 hover:border-fg-3 hover:text-fg-1",
  ghost: "bg-transparent text-fg-2 hover:bg-field hover:text-fg-1",
  danger: "bg-transparent text-warning hover:bg-warning-tint",
};

const SIZE: Record<Size, string> = {
  sm: "h-8 px-3 text-[12px]", // 32px — 现状主力高度
  md: "h-9 px-4 text-[13px]", // 36px
};

export function Button({
  variant = "secondary",
  size = "sm",
  iconLeft,
  iconRight,
  loading = false,
  fullWidth = false,
  disabled,
  className = "",
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={[
        "inline-flex items-center justify-center gap-1.5 rounded-control",
        "transition-[opacity,background-color,border-color,color] duration-150 ease-out",
        "disabled:opacity-30 disabled:pointer-events-none",
        VARIANT[variant],
        SIZE[size],
        fullWidth ? "w-full" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {loading ? <Spinner /> : iconLeft}
      {children != null && <span>{children}</span>}
      {!loading && iconRight}
    </button>
  );
}

function Spinner() {
  return (
    <svg className="h-3 w-3 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
      <path d="M14 8A6 6 0 1 1 2 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/ui/Button.test.tsx`
Expected: PASS（7 个测试全绿）。

- [ ] **Step 5: typecheck**

Run: `pnpm typecheck`
Expected: 0 错误。

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/components/ui/Button.tsx src/sidepanel/components/ui/Button.test.tsx
git commit -m "feat(ui): add unified Button component (4 variants × 2 sizes)"
```

---

## Task 4: `IconButton` 组件

**Files:**
- Create: `src/sidepanel/components/ui/IconButton.tsx`
- Test: `src/sidepanel/components/ui/IconButton.test.tsx`

> 正方形图标按钮。`aria-label` 必填（icon-only 无可读文本）。`rounded-chip` 来自 Task 1。提炼自现有 icon button（`Settings.tsx:174` back-arrow、`TopBarSettingsButton.tsx`）。

- [ ] **Step 1: 写测试（先失败）**

Create `src/sidepanel/components/ui/IconButton.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { IconButton } from "./IconButton";

afterEach(() => cleanup());

const Dot = () => <svg data-testid="dot" width="16" height="16" />;

describe("IconButton", () => {
  it("renders the icon and is reachable by its aria-label", () => {
    render(<IconButton aria-label="Close" icon={<Dot />} />);
    const btn = screen.getByRole("button", { name: "Close" });
    expect(btn).toBeTruthy();
    expect(screen.getByTestId("dot")).toBeTruthy();
  });

  it("fires onClick", () => {
    const onClick = vi.fn();
    render(<IconButton aria-label="Close" icon={<Dot />} onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire onClick when disabled", () => {
    const onClick = vi.fn();
    render(<IconButton aria-label="Close" icon={<Dot />} disabled onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("uses the chip radius token", () => {
    render(<IconButton aria-label="Close" icon={<Dot />} />);
    expect(screen.getByRole("button").className).toContain("rounded-chip");
  });

  it("applies the md size (h-8 w-8) by default", () => {
    render(<IconButton aria-label="Close" icon={<Dot />} />);
    const cls = screen.getByRole("button").className;
    expect(cls).toContain("h-8");
    expect(cls).toContain("w-8");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/ui/IconButton.test.tsx`
Expected: FAIL —— `Failed to resolve import "./IconButton"`。

- [ ] **Step 3: 实现 IconButton**

Create `src/sidepanel/components/ui/IconButton.tsx`:

```tsx
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Size = "sm" | "md";
type Variant = "default" | "ghost";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible label — REQUIRED for an icon-only button. */
  "aria-label": string;
  icon: ReactNode;
  size?: Size;
  variant?: Variant;
}

const SIZE: Record<Size, string> = {
  sm: "h-7 w-7", // 28px
  md: "h-8 w-8", // 32px
};

const VARIANT: Record<Variant, string> = {
  default:
    "border border-line bg-surface text-fg-2 hover:border-fg-3 hover:text-fg-1",
  ghost: "bg-transparent text-fg-2 hover:bg-field hover:text-fg-1",
};

export function IconButton({
  icon,
  size = "md",
  variant = "ghost",
  className = "",
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={[
        "inline-flex shrink-0 items-center justify-center rounded-chip",
        "transition-[background-color,border-color,color] duration-150 ease-out",
        "disabled:opacity-30 disabled:pointer-events-none",
        SIZE[size],
        VARIANT[variant],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {icon}
    </button>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/ui/IconButton.test.tsx`
Expected: PASS（5 个测试全绿）。

- [ ] **Step 5: typecheck**

Run: `pnpm typecheck`
Expected: 0 错误。

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/components/ui/IconButton.tsx src/sidepanel/components/ui/IconButton.test.tsx
git commit -m "feat(ui): add IconButton component (icon-only, aria-label required)"
```

---

## 收尾验证（全 plan 完成后）

- [ ] **全量回归**

Run: `pnpm test`
Expected: 全绿（新增 4 个测试文件，其余不受影响——本 plan 零改动现有组件）。

Run: `pnpm typecheck`
Expected: 0 错误。

Run: `pnpm build`
Expected: 成功，新 utility 编译通过。

- [ ] **真机冒烟（可选但推荐）**：在某个现有视图临时挂一个 `<Button variant="primary">Test</Button>` + `<IconButton aria-label="x" icon={…} />`，`pnpm build && pnpm sync:dist`，Chrome 刷新扩展，确认 `rounded-control`(10px) / `rounded-chip`(6px) / 各 variant 视觉正确，然后撤掉临时挂载。

---

## Self-Review 记录

- **Spec 覆盖**：§4.1 圆角/字号/动画/阴影 token → Task 1；§4.1 图标尺寸 → Task 2；§4.2 Button/IconButton → Task 3/4。§4.3 实心/描边为约定（随迁移执行，无独立 code task）；§5 动画 + motion spike = **下一个 plan**（本 plan 范围外，已在 header 说明）。
- **命名偏离说明**：spec §4.1 用 `--radius-sm/md/lg`，本 plan 改用 `--radius-chip/control/card` 以避免覆盖 Tailwind 默认 keyword 导致现有 `rounded-md/lg` 静默漂移——spec §8 已授权"优先语义命名避免冲突"。**待办：把本命名回写 spec §4.1 保持一致。**
- **类型一致性**：`ICON_SIZE`(Task 2) 在本 plan 不被 Button/IconButton 引用（按钮用 tailwind class）；它供后续图标迁移用，故独立成 task。Button/IconButton 的 prop 名、variant 名前后一致。
- **无 placeholder**：所有组件/测试代码完整给出；CSS token 完整列出。
```
