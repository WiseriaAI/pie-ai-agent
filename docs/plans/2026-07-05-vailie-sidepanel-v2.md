# Vailie SidePanel v2.0.0 重制实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Pie side panel 重制为 Vailie v2.0.0 —— Sky Peach 设计语言 + VailieMark IP + IA 重构（IP 菜单枢纽）+ 改名，一次发版。

**Architecture:** 权威 = spec `docs/specs/2026-07-05-vailie-sidepanel-redesign.md`（含 §2.1 G1–G8 裁决）+ 参考代码 `docs/specs/vailie-redesign-reference/`。改造策略：token 层换值（工具类名不变，大量换肤自动生效）→ 新增 VailieMark/胶囊 composer 壳/菜单枢纽 → 存量组件机械重贴皮（**逻辑零改动**，G4）→ 品牌串 sweep。

**Tech Stack:** React 19 + TS 6, TailwindCSS v4 (`@theme` in CSS, no config), Vite 8 + @crxjs, vitest + happy-dom。

## Global Constraints

- 仓库 = `pie-ai-agent`（独立 git repo）。**先建分支**：`git checkout -b redesign/vailie-v2`（main 受保护）。
- 每个 task 结束跑 `pnpm test` 必须绿；全部完成后 `pnpm test` + `pnpm typecheck` + `pnpm build` 三绿。**tsc 0 错误是硬约束，任何新报错=真实回归。**
- 后端域名 `account.pie.chat` / `api.pie.chat` **一个字符都不改**（`managed-config.ts`、manifest host_permissions）；`feedback@pie.chat` 暂留。
- 服务端下发的字符串（如 entitlement `planName`）**不在客户端改**——后端改名缓迁，本计划只改客户端自有文案。
- `--c-brand-peach` 仅存在于 VailieMark 内部,**禁止**用于任何 UI 文字/填充/描边（spec §3.1）。
- JetBrains Mono 仅用于技术值：URL、脱敏 key、`/slug`、排期表达式、录制 SEQUENCE url、runId。**模型 id/名称、provider 名、普通标签一律 Inter**（spec §3.2）。
- 商店名公式（G7）：en = `Vailie · AI Assistant for Chrome`；其余语言用「浏览器助手」等价词、**不出现 Chrome 商标**；全部 ≤45 字符。**不用 "(formerly Pie)"**。
- manifest `version` 必须等于 package.json `version`（= `2.0.0`）。
- 远端 GH 操作前 `gh auth switch --user WiseriaAI`。
- 动效预算（G3）：同屏动效 VailieMark ≤2（顶栏 idle + 当前活跃轮）；历史/静态位一律 `animate={false}`。
- Commit message 风格照旧仓库惯例（`feat:`/`refactor:`/`chore:`），每 task 一 commit。

## 文件地图（谁负责什么）

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/sidepanel/index.css` | 改 | token 层换 Sky Peach 值；保留字体/字号/motion/阴影 token |
| `src/sidepanel/index.theme.test.ts` | 改 | token 断言同步 |
| `src/sidepanel/components/VailieMark.tsx` + `vailie-mark.css` | 建 | IP 色团组件（从参考代码拷贝） |
| `src/sidepanel/components/ui/IconButton.tsx` | 建 | 裸图标按钮原语（顶栏用） |
| `src/sidepanel/components/Chat.tsx` | 改 | Composer 两态壳（内部 Composer 函数）、EmptyState 色团 |
| `src/sidepanel/App.tsx` | 改 | 新顶栏（IP 枢纽入口 + 右侧＋）、hub 状态、主题下传 |
| `src/sidepanel/components/MenuHub.tsx` | 建 | 菜单枢纽 overlay |
| `src/sidepanel/theme-mode.ts` | 建 | `ThemeMode` 类型（从 TopBarThemeButton 迁出） |
| `src/sidepanel/components/TopBar{List,Schedules,Settings,Theme}Button.tsx` | 删 | 旧顶栏按钮 |
| `src/sidepanel/components/Settings.tsx` | 改 | 主题 segmented 进 general、tabs 居中无界、openTab prop |
| `src/sidepanel/components/AgentStepGroup.tsx` / `AgentStepLine.tsx` | 改 | 活跃行指示器 → VailieMark（纯换皮，G4） |
| `src/sidepanel/components/SessionDrawer.tsx` | 改 | 重贴皮 + 今天/昨天分组 + 搜索 |
| `src/sidepanel/components/RecordingMode.tsx` | 改 | magenta → 品牌蓝 + VailieMark recording |
| `src/lib/skills/builtin.ts` | 改 | 删 confirm 卡死文案（spec §7.4） |
| `src/lib/i18n/dictionaries/*.ts` ×6 | 改 | 品牌串 + 开场语重写 |
| `_locales/*/messages.json` ×6 | 改 | G7 商店名 + 描述 |
| `manifest.json` + `package.json` | 改 | 名字/版本 2.0.0/vailie.ai matches |
| `src/content/subscribe-bridge.ts` | 改 | ALLOWED_HOSTS + vailie.ai |
| `scripts/render-icons.html` | 建 | 图标导出器（canvas 画 MESH → PNG） |
| `public/icons/icon-*.png` | 换 | 新 IP 图标 |

---

## Phase 1 · 地基

### Task 1: Sky Peach token 层落地

**Files:**
- Modify: `src/sidepanel/index.css:3-153`（四个色块 + @theme 色映射）
- Test: `src/sidepanel/index.theme.test.ts`

**Interfaces:**
- Produces: 工具类 `bg-canvas/text-fg-1/bg-field/text-accent/…` 不变但值全换；新增工具类 `text-fg-4`、`text-warning-fg`、`text-danger-fg`、`bg-surface-deep`、`bg-overlay-strong`、`rounded-field`(11px)、`rounded-pill`(999px)；`rounded-card` 由 14px 变 **16px**（全局位移，设计意图）。

**关键约束：这是合并不是整段替换。** 现 `@theme` 里的 `--font-*`、`--text-*`、`--ease-standard`、`--duration-*`、`--shadow-pop/overlay`、`--radius-chip/control` **原样保留**；只替换色值映射、`--radius-card` 值，并新增 reference 里多出的映射。

- [ ] **Step 1: 改测试断言（先红）**

`src/sidepanel/index.theme.test.ts` 改两处、加一个 describe：

```ts
// ① radius 断言:--radius-card 14px → 16px,并补 field/pill
  it("defines the 3-tier semantic radius scale (additive, not overriding Tailwind defaults)", () => {
    expect(css).toContain("--radius-chip: 6px");
    expect(css).toContain("--radius-control: 10px");
    expect(css).toContain("--radius-card: 16px");
    expect(css).toContain("--radius-field: 11px");
    expect(css).toContain("--radius-pill: 999px");
  });

// ② bubble 断言换 Sky Peach 值
  it("defines the user-bubble color token for both themes", () => {
    expect(css).toContain("--c-bubble: #E9EEF4"); // light
    expect(css).toContain("--c-bubble: #22303E"); // dark
    expect(css).toContain("--color-bubble: var(--c-bubble)");
  });

// ③ 文件末尾新增 describe
describe("Sky Peach palette (v2.0.0 redesign)", () => {
  it("uses the sky-blue accent in light and dark", () => {
    expect(css).toContain("--c-accent: #2F8BFF");       // light
    expect(css).toContain("--c-accent-strong: #1D6BD6"); // light
    expect(css).toContain("--c-accent: #6FB3FF");       // dark
  });
  it("uses restrained amber for warning", () => {
    expect(css).toContain("--c-warning: #C9821E");
    expect(css).toContain("--c-warning-fg: #B0781E");
  });
  it("maps the new utilities in @theme", () => {
    for (const m of ["--color-fg-4", "--color-warning-fg", "--color-danger-fg",
                     "--color-surface-deep", "--color-overlay-strong", "--color-brand-peach"]) {
      expect(css).toContain(`${m}: var(`);
    }
  });
  it("keeps brand peach decorative-only (defined, never a bg-* semantic)", () => {
    expect(css).toContain("--c-brand-peach: #FF9FB2");
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `pnpm test src/sidepanel/index.theme.test.ts`
Expected: FAIL（`--radius-card: 16px`、`#E9EEF4`、`#2F8BFF` 等找不到）

- [ ] **Step 3: 换 index.css 的四个色块**

用 `docs/specs/vailie-redesign-reference/tokens.css` 的 `@layer base` 整段（`:root` / `@media dark` / `[data-theme="light"]` / `[data-theme="dark"]` 四块）**替换** `index.css` 对应四块（第 4–123 行）。注意保留文件头的 `@import "tailwindcss";` 与 `@layer base {` 结构。

- [ ] **Step 4: 合并 @theme**

`index.css` 的 `@theme` 块（第 125–185 行）：
1. 色映射部分替换为 reference `@theme` 的完整色映射（`--color-canvas` … `--color-brand-peach`，reference tokens.css:122-147）。
2. `--radius-card: 14px` → `16px`；新增 `--radius-field: 11px;` 与 `--radius-pill: 999px;`（放 `--radius-card` 后）。
3. `--font-*`、`--text-*`、`--ease-standard`、`--duration-*`、`--shadow-*`、`--radius-chip`、`--radius-control` **一行不动**。

- [ ] **Step 5: 跑测试确认绿 + 全量回归**

Run: `pnpm test src/sidepanel/index.theme.test.ts` → PASS
Run: `pnpm test` → 全绿（若有测试断言旧色值/旧 radius，逐个更新断言为新值——它们是设计快照不是逻辑）
Run: `pnpm build` → 成功

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/index.css src/sidepanel/index.theme.test.ts
git commit -m "feat(redesign): land Sky Peach token layer (values only, utility names unchanged)"
```

### Task 2: VailieMark 组件

**Files:**
- Create: `src/sidepanel/components/VailieMark.tsx`（从 `docs/specs/vailie-redesign-reference/VailieMark.tsx` 拷贝）
- Create: `src/sidepanel/components/vailie-mark.css`（从 `docs/specs/vailie-redesign-reference/vailie-mark.css` 拷贝）
- Modify: `src/sidepanel/index.css:1`（追加 import）
- Test: `src/sidepanel/components/VailieMark.test.tsx`

**Interfaces:**
- Produces: `VailieMark({ size?: number = 28, state?: VailieState = "idle", animate?: boolean = true, className?: string, label?: string })`；`export type VailieState = "idle" | "thinking" | "working" | "done" | "recording"`。后续 Task 5/8/9/13/16 消费。

- [ ] **Step 1: 写失败测试**

```tsx
// src/sidepanel/components/VailieMark.test.tsx
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { VailieMark } from "./VailieMark";

describe("VailieMark", () => {
  it("renders the state class and sizes the box", () => {
    const { container } = render(<VailieMark size={32} state="thinking" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("vailie-mark--thinking");
    expect(el.style.width).toBe("32px");
    expect(el.style.height).toBe("32px");
    expect(el.style.backgroundImage).toContain("radial-gradient");
  });
  it("is aria-hidden when decorative, img-role when labelled", () => {
    const { container, rerender } = render(<VailieMark />);
    expect((container.firstElementChild as HTMLElement).getAttribute("aria-hidden")).toBe("true");
    rerender(<VailieMark label="Vailie 正在思考" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute("role")).toBe("img");
    expect(el.getAttribute("aria-label")).toBe("Vailie 正在思考");
  });
  it("G3: animate={false} adds the static class (no motion)", () => {
    const { container } = render(<VailieMark state="working" animate={false} />);
    expect((container.firstElementChild as HTMLElement).className).toContain("vailie-mark--static");
  });
  it("never sets border/shadow/clip — shape is the gradient", () => {
    const { container } = render(<VailieMark />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.border).toBe("");
    expect(el.style.boxShadow).toBe("");
    expect(el.style.borderRadius).toBe("");
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `pnpm test src/sidepanel/components/VailieMark.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 拷贝实现**

```bash
cp docs/specs/vailie-redesign-reference/VailieMark.tsx src/sidepanel/components/VailieMark.tsx
cp docs/specs/vailie-redesign-reference/vailie-mark.css src/sidepanel/components/vailie-mark.css
```

在 `src/sidepanel/index.css` 第 1 行 `@import "tailwindcss";` 之后追加：

```css
@import "./components/vailie-mark.css";
```

- [ ] **Step 4: 跑测试确认绿**

Run: `pnpm test src/sidepanel/components/VailieMark.test.tsx` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/VailieMark.tsx src/sidepanel/components/vailie-mark.css src/sidepanel/index.css src/sidepanel/components/VailieMark.test.tsx
git commit -m "feat(redesign): VailieMark brand blob (4 states + recording, G3 static support)"
```

### Task 3: IconButton 原语

**Files:**
- Create: `src/sidepanel/components/ui/IconButton.tsx`
- Test: `src/sidepanel/components/ui/IconButton.test.tsx`

**Interfaces:**
- Produces: `IconButton({ size?: number = 44, active?: boolean, ...ButtonHTMLAttributes })`——裸图标、hover 亮 field 底、`active` = accent-tint、focus-visible ring。Task 5 顶栏消费。

- [ ] **Step 1: 写失败测试**

```tsx
// src/sidepanel/components/ui/IconButton.test.tsx
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { IconButton } from "./IconButton";

describe("IconButton (无界原语)", () => {
  it("renders a bare icon button with hit-target size", () => {
    const { getByRole } = render(<IconButton aria-label="新对话" size={40}><svg /></IconButton>);
    const btn = getByRole("button", { name: "新对话" });
    expect(btn.style.width).toBe("40px");
    expect(btn.className).toContain("hover:bg-field");
    expect(btn.className).toContain("focus-visible:ring-2");
    expect(btn.className).not.toContain("border");
  });
  it("active paints the accent tint", () => {
    const { getByRole } = render(<IconButton aria-label="菜单" active><svg /></IconButton>);
    expect(getByRole("button").className).toContain("bg-accent-tint");
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `pnpm test src/sidepanel/components/ui/IconButton.test.tsx` → FAIL（模块不存在）

- [ ] **Step 3: 实现**

从 `docs/specs/vailie-redesign-reference/ui-primitives.tsx` 拷贝 `IconButton`（含 `IconButtonProps`）为独立文件：

```tsx
// src/sidepanel/components/ui/IconButton.tsx
import type { ButtonHTMLAttributes, ReactNode } from "react";

/** 无界原语：静默裸图标 → hover 亮 field 底；active = accent-tint 选中态；
 *  focus-visible 恒有 ring（hover 不是唯一可达性提示，spec §5）。 */
export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: number;
  active?: boolean;
  children: ReactNode;
}
export function IconButton({ size = 44, active, className, children, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      style={{ width: size, height: size }}
      className={
        "flex items-center justify-center rounded-[12px] transition-colors " +
        "text-fg-2 hover:bg-field hover:text-fg-1 " +
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line " +
        (active ? "bg-accent-tint text-accent-strong " : "") +
        (className ?? "")
      }
      {...rest}
    >
      {children}
    </button>
  );
}
```

- [ ] **Step 4: 跑测试确认绿 → Commit**

Run: `pnpm test src/sidepanel/components/ui/IconButton.test.tsx` → PASS

```bash
git add src/sidepanel/components/ui/IconButton.tsx src/sidepanel/components/ui/IconButton.test.tsx
git commit -m "feat(redesign): IconButton borderless primitive"
```

### Task 4: Composer 两态壳（G2：展开态=现状原样）

**Files:**
- Modify: `src/sidepanel/components/Chat.tsx:2085-2240`（内部 `Composer` 函数的 JSX 壳）
- Test: `src/sidepanel/components/Chat.test.tsx`（追加断言）

**Interfaces:**
- Consumes: 现有 Composer props 全部不变（`input/streaming/onSubmit/onStop/ToolsMenu/ModelPicker/ContextRing/…`）。
- Produces: 视觉两态。**展开判定 `expanded = focused || streaming || popoverOpen`**（streaming 时 Stop 必须可见；popover 需要锚点稳定）。

**实现要点（与参考代码的一处刻意偏离）**：参考 `Composer.tsx` 用 input↔textarea 两个元素切换——那会在形变瞬间丢焦点造成聚焦死循环。**实现用单一 `<textarea>` 常驻**（节点不重挂，焦点/光标保留），胶囊态靠 CSS 收纳：wrapper `relative`，＋/发送在胶囊态 absolute 定位于两端，动作行 `hidden`；展开态反之。视觉结果与参考代码一致。

- [ ] **Step 1: 加失败断言**

在 `src/sidepanel/components/Chat.test.tsx` 现有 describe 内追加（沿用该文件现有的 render/mock 基建；`data-testid="composer-shell"` 由 Step 3 引入）：

```tsx
  it("composer collapses to a capsule when idle and expands on focus (G2)", async () => {
    // …沿用本文件现有的 Chat 挂载方式…
    const shell = await screen.findByTestId("composer-shell");
    expect(shell.className).toContain("rounded-[26px]");     // capsule
    expect(shell.className).not.toContain("rounded-[18px]");
    const ta = screen.getByPlaceholderText(/./); // composer textarea
    ta.focus();
    await waitFor(() => expect(shell.className).toContain("rounded-[18px]")); // expanded
    // 展开态动作行可见(ModelPicker 触发器在文档流里)
    expect(shell.querySelector('[data-testid="composer-actions"]')).toBeTruthy();
  });
```

- [ ] **Step 2: 跑测试确认红**

Run: `pnpm test src/sidepanel/components/Chat.test.tsx` → FAIL（`composer-shell` 不存在）

- [ ] **Step 3: 改 Composer JSX 壳**

`Chat.tsx` Composer 函数内（line ~2085 起）。新增局部状态与判定：

```tsx
  const [focused, setFocused] = useState(false);
  const expanded = focused || streaming || popoverOpen;
```

外层 wrapper（原 line 2096 `flex flex-col gap-2 rounded-card border border-line bg-field …`）替换为：

```tsx
        {/* Composer 两态壳(G2)。展开态=旧版上下两段原样;胶囊态=收纳型 pill。
            单一 textarea 常驻:形变不重挂节点,焦点/光标不丢。 */}
        <div
          data-testid="composer-shell"
          onFocusCapture={() => setFocused(true)}
          onBlurCapture={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocused(false);
          }}
          className={
            "relative transition-all duration-150 ease-out " +
            (expanded
              ? "flex flex-col gap-2 rounded-[18px] bg-surface-deep px-3.5 py-3 shadow-[0_6px_24px_rgba(29,107,214,0.10)]"
              : "flex items-center rounded-[26px] bg-field h-[52px]")
          }
        >
```

textarea（原 line 2098–2158，onPaste/onDrop/onKeyDown 等 props **全部原样保留**）只改 `rows` 与 `className`：

```tsx
          <textarea
            /* …原有全部 props 不动… */
            rows={expanded ? 3 : 1}
            className={
              expanded
                ? "min-h-[84px] resize-none bg-transparent text-[13px] leading-5 text-fg-1 placeholder:text-fg-3 disabled:opacity-50"
                : "flex-1 min-w-0 resize-none self-center overflow-hidden bg-transparent pl-[52px] pr-[52px] text-[13px] leading-5 text-fg-1 placeholder:text-fg-3 disabled:opacity-50"
            }
          />
```

动作行（原 line 2160 `<div className="flex items-center gap-2">`，内部 ToolsMenu/ModelPicker/ContextRing/Stop/Send **一行不动**）加显隐与 testid：

```tsx
          <div data-testid="composer-actions" className={expanded ? "flex items-center gap-2" : "hidden"}>
```

动作行之后、wrapper 闭合前，追加胶囊态的两端按钮（复用现有回调；`PieSendButton` 就是现有发送按钮组件）：

```tsx
          {!expanded && (
            <>
              {/* 胶囊态 ＋:absolute 于左端圆心。点击=聚焦 textarea 触发展开
                  (展开态里有完整 ToolsMenu);onMouseDown+preventDefault 防按钮抢焦点 */}
              <button
                type="button"
                aria-label={t("chat.toolsMenu")}
                onMouseDown={(e) => { e.preventDefault(); (e.currentTarget.parentElement?.querySelector("textarea") as HTMLTextAreaElement)?.focus(); }}
                className="absolute left-0 top-0 flex h-[52px] w-[52px] items-center justify-center text-fg-2 hover:text-fg-1 rounded-[26px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              </button>
              <div className="absolute right-0 top-0 flex h-[52px] w-[52px] items-center justify-center">
                <PieSendButton onClick={onSubmit} disabled={!input.trim()} />
              </div>
            </>
          )}
```

- [ ] **Step 4: 跑测试确认绿 + 全量**

Run: `pnpm test src/sidepanel/components/Chat.test.tsx` → PASS；`pnpm test` → 全绿（Composer 相关旧断言若依赖 `rounded-card border` 类名，更新为新类名）；`pnpm build` → 成功。

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/Chat.tsx src/sidepanel/components/Chat.test.tsx
git commit -m "feat(redesign): two-form composer shell — capsule idle / full action row expanded (G2)"
```

---

## Phase 2 · IA 重构

### Task 5: 新顶栏（IP 入口 + 右侧＋，G1/G8）

**Files:**
- Create: `src/sidepanel/theme-mode.ts`
- Modify: `src/sidepanel/App.tsx`（顶栏 JSX + imports + hub 状态占位）
- Delete: `src/sidepanel/components/TopBarListButton.tsx`、`TopBarSchedulesButton.tsx`、`TopBarSettingsButton.tsx`、`TopBarThemeButton.tsx`、`TopBarNewSessionButton.tsx`（右＋改用 IconButton 统一）
- Test: `src/sidepanel/components/__tests__/topbar.test.tsx`（新）

**Interfaces:**
- Produces: 顶栏 = `[VailieMark 28 + "Vailie" 字标（button，开 hub，pendingCount>0 时角标点）] …… [IconButton ＋ 新对话]`；`ThemeMode` 类型改从 `src/sidepanel/theme-mode.ts` 导出；`const [hubOpen, setHubOpen] = useState(false)`（Task 6 消费）。
- 快捷键 **原样保留**：`Cmd/Ctrl+K` 新会话、`Cmd/Ctrl+D` 切 SessionDrawer、Esc 返回对话（App.tsx:312-331 不动）。

- [ ] **Step 1: 建 theme-mode.ts（解 TopBarThemeButton 类型依赖）**

```ts
// src/sidepanel/theme-mode.ts
/** 主题三态。v2.0.0 起 UI 落点在 Settings > general(G8),App 仍持有状态。 */
export type ThemeMode = "light" | "dark" | "system";
```

App.tsx 顶部 `import TopBarThemeButton, { type ThemeMode } from "@/sidepanel/components/TopBarThemeButton";` 改为 `import { type ThemeMode } from "@/sidepanel/theme-mode";`，并删除其余四个 TopBar* import。

- [ ] **Step 2: 写失败测试**

```tsx
// src/sidepanel/components/__tests__/topbar.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
// 按本目录现有 App 级测试的 mock 基建挂载 App(或抽出 TopBar 为独立组件后直测)。
import App from "@/sidepanel/App";

describe("v2 top bar (G1/G8)", () => {
  it("has exactly two interactive slots: brand hub trigger + new session", async () => {
    render(<App />);
    expect(await screen.findByRole("button", { name: /Vailie/ })).toBeTruthy(); // IP+字标
    expect(screen.getByRole("button", { name: /新对话|New session/i })).toBeTruthy();
    // 旧按钮消失
    expect(screen.queryByRole("button", { name: /settings/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /schedule/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /theme/i })).toBeNull();
  });
});
```

- [ ] **Step 3: 跑测试确认红**

Run: `pnpm test src/sidepanel/components/__tests__/topbar.test.tsx` → FAIL

- [ ] **Step 4: 改 App.tsx 顶栏 JSX**

替换 App.tsx:342-402 的顶栏块：

```tsx
      {/* ── Top bar(v2:无界宽顶栏)────────────────────────────────── */}
      <div
        style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 12px", flexShrink: 0, zIndex: 10 }}
        className="bg-canvas"
      >
        {/* IP + 字标 = 菜单枢纽入口(G1)。字标同为热区;hover 现 caret。 */}
        <button
          type="button"
          aria-label="Vailie 菜单"
          aria-expanded={hubOpen}
          onClick={() => setHubOpen((v) => !v)}
          className="group relative flex items-center gap-2 rounded-[12px] px-1.5 py-1 hover:bg-field transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
        >
          <VailieMark size={28} state="idle" />
          <span className="text-[14px] font-semibold tracking-[-0.01em] text-fg-1">Vailie</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
            className="text-fg-3 opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
          {/* pending 确认角标(pinned-tab-drift 恢复卡,spec §6 迁移) */}
          {pendingCount > 0 && (
            <span aria-label={`${pendingCount} 个待确认`} className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent" />
          )}
        </button>

        <div style={{ flex: 1 }} />

        {/* 右侧唯一常驻:新对话(G1 高频一键) */}
        <IconButton size={40} aria-label="新对话" title="新对话 (⌘K)" onClick={() => void handleNewSession()}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </IconButton>
      </div>
```

同文件：新增 `const [hubOpen, setHubOpen] = useState(false);`；imports 加 `import { VailieMark } from "@/sidepanel/components/VailieMark";`、`import { IconButton } from "@/sidepanel/components/ui/IconButton";`。上面代码里的中文 aria-label/title（"新对话"、"Vailie 菜单"、"个待确认"）落地时改用 `t()` 走字典（新增 `topbar.newSession`、`topbar.menu`、`topbar.pendingCount` keys ×6 语言，App 层用 `useT()`——照 Chat.tsx 现有用法）。会话标题不再进顶栏（对话流内首条即上下文）——删除 `sessionTitle` 的 span 渲染（`sessionTitle` 变量保留给 aria/hub 用）。**主题按钮渲染删除，但 `themeMode/setThemeMode` 状态与 effect 原样保留**（Task 7 从 Settings 消费）。Settings 组件调用处先传 props 占位：`themeMode={themeMode} onThemeModeChange={setThemeMode}`（Task 7 落地接收端；本 task 内先在 Settings props 类型上加这两个可选字段以保 tsc 绿）。

- [ ] **Step 5: 删除旧 TopBar 组件**

```bash
git rm src/sidepanel/components/TopBarListButton.tsx src/sidepanel/components/TopBarSchedulesButton.tsx src/sidepanel/components/TopBarSettingsButton.tsx src/sidepanel/components/TopBarThemeButton.tsx src/sidepanel/components/TopBarNewSessionButton.tsx
```

若有引用它们的测试，一并更新/删除（断言迁往新 topbar.test.tsx）。

- [ ] **Step 6: 跑测试确认绿 + 全量 → Commit**

Run: `pnpm test` → 全绿；`pnpm typecheck` → 0 错。

```bash
git add -A && git commit -m "feat(redesign): v2 top bar — IP hub trigger + lone new-session button (G1/G8)"
```

### Task 6: MenuHub 菜单枢纽

**Files:**
- Create: `src/sidepanel/components/MenuHub.tsx`
- Modify: `src/sidepanel/App.tsx`（渲染 hub + 路由回调）、`src/sidepanel/components/Settings.tsx`（`openTab` prop）
- Modify: `src/lib/i18n/dictionaries/*.ts` ×6（新增 `menu.*` keys）
- Test: `src/sidepanel/components/MenuHub.test.tsx`

**Interfaces:**
- Consumes: Task 5 的 `hubOpen/setHubOpen`。
- Produces: `MenuHub({ open, onClose, onHistory, onSkills, onSchedules, onSettings, version })`。路由映射（push 子页栈用现有 view 机制实现，UX 等价）：历史 → `setDrawerOpen(true)`；技能 → `setView("settings")` + `openTab:{tab:"skills",nonce}`；定时 → `setView("schedules")`；设置 → `setView("settings")`。

- [ ] **Step 1: 写失败测试**

```tsx
// src/sidepanel/components/MenuHub.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { MenuHub } from "./MenuHub";

const noop = () => {};
describe("MenuHub (菜单枢纽,G1:只收低频目的地)", () => {
  it("lists exactly history/skills/schedules/settings + brand footer", () => {
    render(<MenuHub open onClose={noop} onHistory={noop} onSkills={noop} onSchedules={noop} onSettings={noop} version="2.0.0" />);
    for (const name of ["会话历史", "技能", "定时任务", "设置"]) {
      expect(screen.getByRole("menuitem", { name: new RegExp(name) })).toBeTruthy();
    }
    expect(screen.queryByRole("menuitem", { name: /新对话/ })).toBeNull(); // 高频不进枢纽
    expect(screen.getByText(/v2\.0\.0/)).toBeTruthy();
    expect(screen.getByText(/Apache-2\.0/)).toBeTruthy();
  });
  it("invokes the route callback then closes", () => {
    const onSkills = vi.fn(); const onClose = vi.fn();
    render(<MenuHub open onClose={onClose} onHistory={noop} onSkills={onSkills} onSchedules={noop} onSettings={noop} version="2.0.0" />);
    fireEvent.click(screen.getByRole("menuitem", { name: /技能/ }));
    expect(onSkills).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("closes on Escape and renders nothing when closed", () => {
    const onClose = vi.fn();
    const { rerender, container } = render(<MenuHub open onClose={onClose} onHistory={noop} onSkills={noop} onSchedules={noop} onSettings={noop} version="2.0.0" />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    rerender(<MenuHub open={false} onClose={onClose} onHistory={noop} onSkills={noop} onSchedules={noop} onSettings={noop} version="2.0.0" />);
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `pnpm test src/sidepanel/components/MenuHub.test.tsx` → FAIL

- [ ] **Step 3: 实现 MenuHub**

```tsx
// src/sidepanel/components/MenuHub.tsx
/** 菜单枢纽(spec §6 C 屏):IP 点击后的低频目的地面板。无边框列表,
 *  overlay 落在顶栏下方;层次=surface+弹层投影(无界弹层规格 spec §3.3)。 */
import { useEffect, useRef } from "react";
import { useT } from "@/lib/i18n";

interface MenuHubProps {
  open: boolean;
  onClose: () => void;
  onHistory: () => void;
  onSkills: () => void;
  onSchedules: () => void;
  onSettings: () => void;
  version: string;
}

export function MenuHub({ open, onClose, onHistory, onSkills, onSchedules, onSettings, version }: MenuHubProps) {
  const t = useT(); // hooks 全部在 early-return 之前(顺序规则)
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDoc);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onDoc); };
  }, [open, onClose]);

  if (!open) return null;
  const rows: { label: string; onPick: () => void; icon: JSX.Element }[] = [
    { label: t("menu.history"), onPick: onHistory, icon: <IconClock /> },
    { label: t("menu.skills"), onPick: onSkills, icon: <IconSpark /> },
    { label: t("menu.schedules"), onPick: onSchedules, icon: <IconRepeat /> },
    { label: t("menu.settings"), onPick: onSettings, icon: <IconGear /> },
  ];
  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Vailie"
      className="drawer-down absolute left-3 top-[54px] z-30 w-[228px] rounded-[16px] bg-surface p-2 shadow-[0_8px_28px_rgba(21,25,31,0.14)]"
    >
      {rows.map((r) => (
        <button
          key={r.label}
          type="button"
          role="menuitem"
          onClick={() => { r.onPick(); onClose(); }}
          className="flex w-full items-center gap-3 rounded-[11px] px-3 py-2.5 text-[13px] text-fg-1 hover:bg-field transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
        >
          <span className="text-fg-3">{r.icon}</span>
          {r.label}
        </button>
      ))}
      {/* 品牌区(G7:不写 formerly Pie) */}
      <div className="mt-2 px-3 pb-1 pt-2 text-[11px] leading-4 text-fg-3">
        Vailie · v{version}
        <br />
        {t("menu.brandLine")} {/* "开源 Apache-2.0 · 无遥测" */}
      </div>
    </div>
  );
}

/* 16px 线性图标(stroke=currentColor,与顶栏一致) */
function IconClock() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></svg>; }
function IconSpark() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" /></svg>; }
function IconRepeat() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 014-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 01-4 4H3" /></svg>; }
function IconGear() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h0a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h0a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v0a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" /></svg>; }
```

- [ ] **Step 4: 接线 App.tsx + Settings openTab**

App.tsx 渲染（顶栏 div 后）：

```tsx
      <MenuHub
        open={hubOpen}
        onClose={() => setHubOpen(false)}
        onHistory={() => setDrawerOpen(true)}
        onSkills={() => { setView("settings"); setSettingsOpenTab({ tab: "skills", nonce: Date.now() }); }}
        onSchedules={() => setView("schedules")}
        onSettings={() => setView("settings")}
        version={chrome.runtime.getManifest().version}
      />
```

新增状态 `const [settingsOpenTab, setSettingsOpenTab] = useState<{ tab: "configs" | "skills" | "search" | "general"; nonce: number } | null>(null);`，传给 `<Settings openTab={settingsOpenTab} …/>`。Settings.tsx 接收：

```tsx
  // props 增加:openTab?: { tab: Tab; nonce: number } | null
  useEffect(() => {
    if (openTab) setTab(openTab.tab);
  }, [openTab?.nonce]);
```

i18n ×6 字典新增（en 示例；zh-CN:会话历史/技能/定时任务/设置/开源 Apache-2.0 · 无遥测；其余语言等价翻译）：

```ts
  menu: {
    history: "Session history",
    skills: "Skills",
    schedules: "Schedules",
    settings: "Settings",
    brandLine: "Open-source Apache-2.0 · No telemetry",
  },
```

- [ ] **Step 5: 跑测试确认绿 + 全量 → Commit**

Run: `pnpm test` → 全绿；`pnpm typecheck` → 0 错。

```bash
git add -A && git commit -m "feat(redesign): MenuHub — low-frequency destinations behind the IP mark (G1)"
```

### Task 7: 主题控件迁入 Settings general（G8）

**Files:**
- Modify: `src/sidepanel/components/Settings.tsx`（general tab 顶部加主题 segmented；props 加 `themeMode/onThemeModeChange`）
- Test: `src/sidepanel/components/__tests__/settings-theme.test.tsx`（新）

**Interfaces:**
- Consumes: Task 5 App 下传的 `themeMode: ThemeMode` + `onThemeModeChange(m: ThemeMode)`。

- [ ] **Step 1: 写失败测试**

```tsx
// src/sidepanel/components/__tests__/settings-theme.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import Settings from "@/sidepanel/components/Settings";

describe("theme segmented in Settings general (G8)", () => {
  it("renders 3 options and reports changes", async () => {
    const onChange = vi.fn();
    render(<Settings onBack={() => {}} onRunSkill={() => {}} openSubscribeNonce={0}
                     themeMode="system" onThemeModeChange={onChange} />);
    fireEvent.click(await screen.findByRole("tab", { name: /general/i }));
    const group = await screen.findByRole("radiogroup", { name: /theme|主题/i });
    expect(group.querySelectorAll('[role="radio"]').length).toBe(3);
    fireEvent.click(screen.getByRole("radio", { name: /dark|深色/i }));
    expect(onChange).toHaveBeenCalledWith("dark");
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `pnpm test src/sidepanel/components/__tests__/settings-theme.test.tsx` → FAIL

- [ ] **Step 3: 实现**

Settings.tsx general tab（line ~354 `tab === "general"` 分支的 section 列表最上方）插入：

```tsx
              {/* 主题(G8:自顶栏迁入;inline segmented,枚举开关规则 spec §6) */}
              <section className="flex flex-col gap-2.5">
                <div className="text-[15px] font-semibold tracking-[-0.005em] text-fg-1">{t("settings.theme.sectionTitle")}</div>
                <div role="radiogroup" aria-label={t("settings.theme.sectionTitle")} className="flex bg-field rounded-[12px] p-[3px]">
                  {(["light", "dark", "system"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={themeMode === m}
                      onClick={() => onThemeModeChange?.(m)}
                      className={
                        "flex-1 text-center text-[13px] py-2 rounded-[9px] transition-colors " +
                        (themeMode === m
                          ? "bg-surface text-fg-1 font-medium shadow-[0_1px_4px_rgba(21,25,31,0.08)]"
                          : "text-fg-2")
                      }
                    >
                      {t(`settings.theme.${m}`)}
                    </button>
                  ))}
                </div>
              </section>
```

i18n ×6 新增 `settings.theme` keys（en: `sectionTitle: "Theme"`, `light: "Light"`, `dark: "Dark"`, `system: "System"`；zh-CN: 主题/浅色/深色/跟随系统；其余等价）。props 类型加 `themeMode?: ThemeMode; onThemeModeChange?: (m: ThemeMode) => void;`（import type 自 `@/sidepanel/theme-mode`）。

- [ ] **Step 4: 跑测试确认绿 → Commit**

Run: `pnpm test` → 全绿。

```bash
git add -A && git commit -m "feat(redesign): theme segmented moves into Settings general (G8)"
```

### Task 8: EmptyState 欢迎屏（A 屏，G5）

**Files:**
- Modify: `src/sidepanel/components/Chat.tsx:1681-1708`（EmptyState 函数）
- Test: `src/sidepanel/components/Chat.test.tsx` 追加断言

- [ ] **Step 1: 加失败断言**

```tsx
  it("empty state shows the hero VailieMark, greeting, no suggestion chips (G5)", async () => {
    // …现有空会话挂载方式…
    const hero = await screen.findByTestId("empty-vailie-mark");
    expect(hero.className).toContain("vailie-mark--idle");
    expect(screen.queryByTestId("suggestion-chips")).toBeNull();
  });
```

- [ ] **Step 2: 跑红** → `pnpm test src/sidepanel/components/Chat.test.tsx` FAIL

- [ ] **Step 3: 先给 VailieMark 加 rest 透传（一行改动）**

`src/sidepanel/components/VailieMark.tsx`：props 接口加 `...rest`（`extends Omit<HTMLAttributes<HTMLSpanElement>, "className" | "style">` 或直接解构 `...rest` 展开到 `<span>`），使 `data-testid` 可透传。

- [ ] **Step 4: 改 EmptyState**

```tsx
function EmptyState() {
  const t = useT();
  const greetingKey = useMemo(() => {
    const keys = ["greeting1","greeting2","greeting3","greeting4","greeting5","greeting6","greeting7"] as const;
    return keys[Math.floor(Math.random() * keys.length)];
  }, []);
  const greeting = t(`chat.${greetingKey}`);
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-5 px-6 text-center">
      <VailieMark size={132} state="idle" data-testid="empty-vailie-mark" />
      <div className="flex max-w-[280px] flex-col items-center gap-3">
        <h1 className="text-[24px] font-semibold leading-8 tracking-[-0.015em] text-fg-1">{greeting}</h1>
        <p className="text-[13px] leading-5 text-fg-2">{t("chat.readyDescription")}</p>
      </div>
    </div>
  );
}
```

imports 加 `VailieMark`。

注意：这是唯一的**大尺寸动效实例**，且空状态时对话流无其他动效——G3 预算内（顶栏 idle + 此处 idle = 2）。

- [ ] **Step 4: 跑绿 → Commit**

```bash
git add -A && git commit -m "feat(redesign): welcome screen — hero mark + greeting, no chips (G5)"
```

### Task 9: 对话流指示器换 VailieMark（B 屏纯换皮，G4）

**Files:**
- Modify: `src/sidepanel/components/AgentStepLine.tsx`（活跃行 spinner → VailieMark）
- Modify: `src/sidepanel/components/Chat.tsx`（MessageBubble thinking 指示器 → VailieMark，如存在独立 spinner）
- Test: `src/sidepanel/components/AgentStepLine.test.tsx`（更新断言）

**硬边界（G4）**：`AgentStepGroup.tsx` 的分组/折叠逻辑、`AgentStepData` 类型、SW→panel step 协议、pending/ok/error 状态流转 **零改动**。只换渲染叶子。

- [ ] **Step 1: 定位现有指示器**

Run: `grep -nE 'animate-spin|spinner|Spinner|animate-pulse' src/sidepanel/components/AgentStepLine.tsx src/sidepanel/components/AgentStepGroup.tsx src/sidepanel/components/Chat.tsx`
把命中的**活跃/pending 态**指示元素记录下来（done/error 态的 ✓/✗ 字形不动）。

- [ ] **Step 2: 更新 AgentStepLine.test.tsx 断言（先红）**

在现有测试上加：pending 态渲染 `.vailie-mark--working`；ok/error 态**不**渲染任何 `.vailie-mark`（历史静态,G3——done 行用原有字形,不加色团）。

```tsx
  it("pending step shows the working mark; finished steps show none (G3/G4)", () => {
    const { container: pending } = render(<AgentStepLine step={{ ...baseStep, status: "pending" }} />);
    expect(pending.querySelector(".vailie-mark--working")).toBeTruthy();
    const { container: done } = render(<AgentStepLine step={{ ...baseStep, status: "ok" }} />);
    expect(done.querySelector(".vailie-mark")).toBeNull();
  });
```

（`baseStep` 按该测试文件现有的构造器/夹具写法。）

- [ ] **Step 3: 跑红** → FAIL

- [ ] **Step 4: 替换 pending 指示器**

AgentStepLine.tsx 里 pending 分支的 spinner 元素替换为：

```tsx
<VailieMark size={16} state="working" label={undefined} />
```

若 Chat.tsx MessageBubble 的 `thinkingStreaming` 有独立动效点（Step 1 grep 结果），同样替换为 `<VailieMark size={16} state="thinking" />`。其余渲染一概不动。

- [ ] **Step 5: 跑绿 + 全量 → Commit**

```bash
git add -A && git commit -m "refactor(redesign): active step indicator → VailieMark, logic untouched (G4)"
```

---

## Phase 3 · 存量功能重贴皮

> Token 换值已让大部分色彩自动就位。本 phase 的手工量集中在：**去边框**（无界）、**等宽字体纠偏**、**录制去 magenta**、**流程卡琥珀化**、以及 D 屏两个净新增（分组/搜索）。每个 task 都是纯视觉——**任何 props/状态/回调改动都算越界**。

**无界替换映射表（Phase 3 所有 task 共用）：**

| 旧模式 | 新模式 |
|---|---|
| `border border-line bg-surface`（卡片） | `bg-surface shadow-[0_4px_16px_rgba(21,25,31,0.05)]` |
| `border border-line bg-field`（输入/容器） | `bg-field`（仅底色差） |
| `border border-line`（列表行分隔） | 删除；行间距 `gap-*` + hover `hover:bg-field` |
| `border-b border-line` / `.hairline`（分割线） | 删除；改 `pt-*` 间距 |
| `rounded-card`（自动变 16px） | 不动（Task 1 已位移） |
| 弹层 `shadow-*` 杂值 | `shadow-[0_8px_28px_rgba(21,25,31,0.14)]` |
| focus `focus-within:border-accent` | `focus-within:bg-surface-deep focus-within:shadow-[0_6px_24px_rgba(29,107,214,0.10)]` |

**例外（不去除的"边框"）**：focus-visible ring（a11y）、`danger-line`/`warning-line` 用于语义强调块的场合改为 tint 底色（`bg-warning-tint`/`bg-danger-fg/10`）而非线。

### Task 10: Chat 面重贴皮（气泡/横幅/chips）

**Files:**
- Modify: `src/sidepanel/components/Chat.tsx`（MessageBubble、PageChangedBanner、pendingRecording chip、引用/文件/图片 chips 区）
- Modify: `src/sidepanel/components/QuoteChip.tsx`、`FileChip.tsx`、`CollapsibleText.tsx`（如有 border）

- [ ] **Step 1: 枚举 border 用点**

Run: `grep -nE 'border(-[btlr])? border-line|hairline' src/sidepanel/components/Chat.tsx src/sidepanel/components/QuoteChip.tsx src/sidepanel/components/FileChip.tsx src/sidepanel/components/CollapsibleText.tsx`

- [ ] **Step 2: 按映射表逐处替换**

代表性改法（pendingRecording chip，Chat.tsx:1574）：

```
- className="mx-3 mb-1.5 flex items-center gap-2 rounded-md border border-line bg-field px-2.5 py-1.5 text-[13px] text-fg-1"
+ className="mx-3 mb-1.5 flex items-center gap-2 rounded-[11px] bg-field px-2.5 py-1.5 text-[13px] text-fg-1"
```

chip 的 × 按钮（line 1595 `rounded-full border border-line bg-canvas`）→ `rounded-full bg-canvas hover:bg-field text-fg-2 hover:text-fg-1`（去 border）。PageChangedBanner（line 1713）同法：外层去 border 加卡片投影，内按钮 `border border-line bg-field` → `bg-field hover:bg-line`。其余命中逐一按表处理。用户气泡 `bg-bubble` 色已由 token 自动更新。

- [ ] **Step 3: 全量测试 + build（断言旧类名的测试更新）→ Commit**

```bash
git add -A && git commit -m "style(redesign): borderless pass — chat surfaces"
```

### Task 11: Settings/BYOK 面重贴皮 + 字体纠偏 + tabs 居中

**Files:**
- Modify: `src/sidepanel/components/Settings.tsx`（SegmentedTabs 无界+居中）
- Modify: `src/sidepanel/components/InstanceForm.tsx`、`InstancesList.tsx`、`NewConfigWizard.tsx`、`CustomProviderFields.tsx`、`ProviderDropdown.tsx`、`ProviderModelList.tsx`、`ModelMetaEditor.tsx`

- [ ] **Step 1: SegmentedTabs 换无界 pill（Settings.tsx:400-425 区域）**

替换现实现的容器与选中态（保留 `data-testid="settings-tabs"` 与 Tab 类型/回调）：

```tsx
    <div data-testid="settings-tabs" role="tablist" className="flex w-full bg-field rounded-[12px] p-[3px]">
      {tabs.map((tb) => {
        const on = tb.id === value;
        return (
          <button key={tb.id} type="button" role="tab" aria-selected={on} onClick={() => onChange(tb.id)}
            className={"flex-1 text-center text-[13px] py-2 rounded-[9px] transition-colors " +
              (on ? "bg-surface text-fg-1 font-medium shadow-[0_1px_4px_rgba(21,25,31,0.08)]" : "text-fg-2")}>
            {tb.label}
          </button>
        );
      })}
    </div>
```

同样处理 InstanceForm 的 ENDPOINT variant 分段与 NewConfigWizard 的方式切换 tab（grep `role="tab"` / 分段容器,同一 pill 样式,**标签必须 `text-center`**——spec 修正 #2）。

- [ ] **Step 2: 等宽字体纠偏（spec §3.2,修正 #1）**

Run: `grep -nE 'font-mono' src/sidepanel/components/ProviderModelList.tsx src/sidepanel/components/ModelPicker.tsx src/sidepanel/components/InstanceForm.tsx src/sidepanel/components/InstancesList.tsx src/sidepanel/components/ModelMetaEditor.tsx`

判定规则逐处执行：**model id/模型名/provider 名 → 删 `font-mono`（落回 Inter）**；URL、脱敏 key（`sk-…****`）、`/slug` → **保留** `font-mono`。`.caps` eyebrow 标签类不动。

- [ ] **Step 3: 无界映射表过一遍上述文件**（卡片/行/输入,同 Task 10 方法）

- [ ] **Step 4: 全量测试(类名断言更新)+ build → Commit**

```bash
git add -A && git commit -m "style(redesign): settings/BYOK borderless pass; centered tabs; Inter for model ids"
```

### Task 12: Managed（Pie Pro）面板重贴皮

**Files:**
- Modify: `src/sidepanel/components/ManagedSubscribePanel.tsx`、`ManagedAccountPanel.tsx`、`ManagedErrorCta.tsx`、`ManagedStatusPill.tsx`、`RedeemCodeForm.tsx`

- [ ] **Step 1**: `grep -nE 'border border-line|hairline' <上述文件>` → 按映射表替换（月/年 radio 卡选中态：`border-accent` 选中线 → `bg-accent-tint` + `shadow-[0_0_0_1.5px_var(--c-accent-line)]`,不算违例——它是选中强调环不是分隔线,但优先试 tint 底色单独成立）。
- [ ] **Step 2**: QuotaBar 色带核对——若 ManagedAccountPanel 内额度条无 80–95% `pending` / ≥95% `warning` 分带,按参考 `ui-primitives.tsx` QuotaBar 的 band 逻辑补色带(**仅样式类切换,不改数据源 `usedFraction`**)。
- [ ] **Step 3**: 全量测试 + build → Commit `style(redesign): managed panels borderless pass`

### Task 13: 录制界面 IP 化（M 屏，spec §7.4/§9.2）

**Files:**
- Modify: `src/sidepanel/components/RecordingMode.tsx`
- Modify: `src/sidepanel/components/Chat.tsx`（pendingRecording chip 的 `bg-pending`/`text-pending` 洋红痕迹——现已是 amber token,核对即可）
- Test: `src/sidepanel/components/__tests__/recording-mode.test.tsx`（如已有则更新,没有则补最小断言）

- [ ] **Step 1**: `grep -nE 'magenta|#[A-F0-9]{6}|pending|REC' src/sidepanel/components/RecordingMode.tsx` 枚举所有模式色硬编码。
- [ ] **Step 2**: Vital Bar 的脉冲点/REC 标识替换为:

```tsx
<VailieMark size={22} state="recording" label={t("chat.recording.recordingAria") /* 若无此 key 则新增 */} />
```

页面 accent 一律回品牌蓝 token（`text-accent`/`bg-accent-tint`）;STEP 计数、SEQUENCE 类型 chip、Footer(Cancel/Finish + esc/⏎)结构与逻辑不动。REDACTED/UNSTABLE 标记色 → `text-warning-fg`。
- [ ] **Step 3**: 最小断言:渲染 RecordingMode 时存在 `.vailie-mark--recording`。跑绿 → Commit `style(redesign): recording mode — brand blue + recording-variant mark`

### Task 14: 流程卡琥珀化 + SessionConfirmCard（spec §7.6）

**Files:**
- Modify: `src/sidepanel/components/CdpOnboardingCard.tsx`、`FileAccessCard.tsx`、`LocalFileRequestCard.tsx`、`FileOutputCard.tsx`、`SessionConfirmCard.tsx`

- [ ] **Step 1**: `grep -nE 'orange|#(E|F)[0-9A-F]{5}|warning' <上述文件>` ——warning token 已经是琥珀(Task 1),此处目标是清掉**硬编码橙色**与残余 border。
- [ ] **Step 2**: 按映射表处理;警示条统一 `bg-warning-tint text-warning-fg rounded-[11px]`(无边框)。SessionConfirmCard 同批覆盖(它驱动顶栏 pending 点,spec §6 迁移已在 Task 5 实现)。
- [ ] **Step 3**: 全量测试 + build → Commit `style(redesign): flow cards — amber attention, borderless`

### Task 15: SessionDrawer 重贴皮 + 分组 + 搜索（D 屏）

**Files:**
- Modify: `src/sidepanel/components/SessionDrawer.tsx`
- Test: `src/sidepanel/components/SessionDrawer.test.tsx`（如有,追加;没有则新建最小断言）

**边界**：归档/恢复/软删/硬删/StorageIndicator 现有功能与回调**全部保留**。净新增仅两个纯展示能力:标题子串过滤 + 日期分组。

- [ ] **Step 1: 写失败断言**

```tsx
  it("filters sessions by title substring", async () => {
    // 挂载含 ["整理书签", "翻译页面"] 两会话的 drawer(按现有测试夹具)
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "书签" } });
    expect(screen.getByText("整理书签")).toBeTruthy();
    expect(screen.queryByText("翻译页面")).toBeNull();
  });
  it("groups sessions by 今天/昨天/更早", () => {
    // 夹具:updatedAt 分别为 now、now-1d、now-3d
    expect(screen.getByText(/今天|Today/)).toBeTruthy();
    expect(screen.getByText(/昨天|Yesterday/)).toBeTruthy();
    expect(screen.getByText(/更早|Earlier/)).toBeTruthy();
  });
```

- [ ] **Step 2: 跑红 → 实现**

搜索：ACTIVE 列表头部加 `<input role="searchbox">`（`bg-field rounded-[11px] px-3 py-2 text-[13px]`,无边框）,state `const [query, setQuery] = useState("")`,过滤 `sessions.filter(s => (s.title ?? "").toLowerCase().includes(query.toLowerCase()))`。

分组（纯展示,放渲染前）：

```tsx
function groupByDay<T extends { updatedAt: number }>(list: T[]): { label: "today" | "yesterday" | "earlier"; items: T[] }[] {
  const now = new Date(); const todayStr = now.toDateString();
  const y = new Date(now); y.setDate(now.getDate() - 1); const yStr = y.toDateString();
  const buckets = { today: [] as T[], yesterday: [] as T[], earlier: [] as T[] };
  for (const s of list) {
    const d = new Date(s.updatedAt).toDateString();
    (d === todayStr ? buckets.today : d === yStr ? buckets.yesterday : buckets.earlier).push(s);
  }
  return (["today", "yesterday", "earlier"] as const).filter((k) => buckets[k].length).map((k) => ({ label: k, items: buckets[k] }));
}
```

组标题用 `text-[11px] tracking-[0.1em] text-fg-3` eyebrow。i18n ×6 加 `sessions.group.today/yesterday/earlier` 与 `sessions.searchPlaceholder`。行样式按映射表去 border。（若 `SessionIndexEntry` 的时间字段名不是 `updatedAt`,以 `src/lib/sessions/types.ts` 实际字段为准,分组函数同构替换。）

- [ ] **Step 3: 跑绿 + 全量 → Commit** `feat(redesign): session drawer — day groups + title filter, borderless`

### Task 16: Schedules 面重贴皮（F 屏）

**Files:**
- Modify: `src/sidepanel/components/Schedules/SchedulesPanel.tsx`、`ScheduleForm.tsx`、`ScheduleRunHistory.tsx`、`src/sidepanel/components/ScheduleDraftCard.tsx`

- [ ] **Step 1**: 无界映射表过一遍（卡/行/表单）。排期表达式、Start URL 保留 `font-mono`（技术值);Title/Prompt/模型名 Inter。
- [ ] **Step 2**: `ScheduleCard` 状态徽章前加静态标识:Active 行 `<VailieMark size={14} state="idle" animate={false} />`,其余状态不加（G3:列表零动效)。运行中的 run（RunHistory `Running`）用 `<VailieMark size={14} state="working" />`——它是"当前活跃"语义,允许动,但同屏至多一个 Running。
- [ ] **Step 3**: 全量测试 + build → Commit `style(redesign): schedules borderless pass + static status marks`

### Task 17: 删 builtin.ts confirm 死文案（spec §7.4）

**Files:**
- Modify: `src/lib/skills/builtin.ts:160-170` 区域
- Test: `src/lib/skills/builtin.test.ts`

- [ ] **Step 1: 加失败断言**

```ts
  it("create_skill_from_recording instructions never claim a confirm card (removed layer)", () => {
    const pkg = BUILTIN_PACKAGES.find((p) => p.id === "create_skill_from_recording")!;
    const all = JSON.stringify(pkg);
    expect(all).not.toMatch(/confirm card/i);
  });
```

（`BUILTIN_PACKAGES` 名字以 builtin.ts 实际导出为准——grep `export const` 确认后对齐。）

- [ ] **Step 2: 跑红 → 删文案**

builtin.ts:165-166 附近删掉 "The user will see a confirm card with the full skill content before it is persisted — that is their review surface." 两行,替换为与现实一致的一句:

```
   The skill is persisted immediately by create_skill; after the call
   succeeds, tell the user the skill was created and how to run it (/slug).
```

- [ ] **Step 3: 跑绿 → Commit** `fix(skills): drop stale confirm-card claim from recording skill instructions`

---

## Phase 4 · 改名收尾

### Task 18: src 品牌串 sweep + 文案重写（×6 语言）

**Files:**
- Modify: `src/lib/i18n/dictionaries/{en,zh-CN,zh-TW,ja,es-419,pt-BR}.ts`
- Modify: `src/content/subscribe-bridge.ts:15`、`src/sidepanel/components/Settings.tsx`（官网链接）、`src/sidepanel/components/FileAccessCard.tsx`、`src/lib/dom-actions/act-core.ts`、`src/background/index.ts`、`src/types/index.ts` 及全部含 `Pie` 断言的测试
- Test: 既有测试更新断言

- [ ] **Step 1: 枚举清单**

Run: `grep -rn '\bPie\b' src/ --include='*.ts' --include='*.tsx' | grep -v 'pie.chat' | grep -v "'pie'" | grep -v '"pie"'`
（IDB 库名 `pie`、`pie.chat` 域名、`feedback@pie.chat` **不改**——存储 key 改名=用户数据迁移事故。）

- [ ] **Step 2: 机械替换**

产品名语境的 `Pie` → `Vailie`（含 `Pie Pro` → `Vailie Pro`、`Pie Official` → `Vailie Official`、agent prompt 里的自称、测试断言）。`subscribe-bridge.ts`:

```ts
const ALLOWED_HOSTS = new Set(["pie.chat", "www.pie.chat", "vailie.ai", "www.vailie.ai", "localhost", "127.0.0.1"]);
```

Settings 官网链接 `https://pie.chat` → `https://vailie.ai`（changelog 链接同查同改）。`PieSendButton` 等**组件名/内部标识符可后置不改**（不面向用户,避免无谓 diff;仅字符串层面改）。

- [ ] **Step 3: 开场语 + readyDescription 重写（G5 + spec §9.3）**

en.ts（zh-CN 给对照,其余四语言按同义翻译,7 条全换）:

```ts
    // Vailie 口吻:在场、轻快、说人话;不吹能力不设防式免责
    greeting1: "Hi, I'm here.",                       // zh-CN: 嗨，我在。
    greeting2: "What are we doing today?",            // zh-CN: 今天做点什么？
    greeting3: "Show me a page, or just ask.",        // zh-CN: 丢个页面给我，或者直接问。
    greeting4: "Ready when you are.",                 // zh-CN: 随时可以开始。
    greeting5: "Let's get something done.",           // zh-CN: 来做点正事吧。
    greeting6: "This tab looks interesting.",         // zh-CN: 这个页面看起来有点意思。
    greeting7: "I can take it from here.",            // zh-CN: 交给我吧。
    readyDescription: "I can read pages, click around, fill forms, and work across tabs — right here in your browser.",
    // zh-CN: 我能读页面、点按钮、填表单、跨标签页干活——就在你的浏览器里。
```

**注意**:`readyDescription` 旧文案的 "Anything risky waits for your approval" 是 confirm-before-act 声明,**该层已移除,必须删**（spec §9.3 安全叙事收紧——这是本 task 里唯一不许走样的句子级要求）。

- [ ] **Step 4: 三绿 → Commit** `feat(rebrand): Pie → Vailie across client copy; Vailie-voice greetings ×6 locales`

### Task 19: manifest / _locales / 版本 2.0.0

**Files:**
- Modify: `manifest.json`（version、default_title、content_scripts matches、host_permissions）
- Modify: `package.json`（version）
- Modify: `_locales/{en,es_419,ja,pt_BR,zh_CN,zh_TW}/messages.json`

- [ ] **Step 1: 六语言名字串（G7 公式,全部 ≤45ch,仅 en 用 for Chrome）**

| locale | extension_name |
|---|---|
| en | `Vailie · AI Assistant for Chrome` |
| zh_CN | `Vailie · 开源 AI 浏览器助手` |
| zh_TW | `Vailie · 開源 AI 瀏覽器助手` |
| ja | `Vailie · オープンなAIブラウザアシスタント` |
| es_419 | `Vailie · Asistente de IA para tu navegador` |
| pt_BR | `Vailie · Assistente de IA para o navegador` |

`extension_description` 各语言改写:首句含过渡说明（en: `Vailie (formerly Pie) is an open-source AI assistant that reads pages, fills forms, and works across tabs.`;zh_CN: `Vailie（原 Pie）是开源 AI 浏览器助手：读页面、填表单、跨标签页干活。`;其余四语言等价,长度 ≤132 字符——manifest description 上限）。

- [ ] **Step 2: manifest.json**

- `"version": "2.0.0"`（package.json 同步 `"version": "2.0.0"`——**两处必须相等**,release workflow 会验）。
- `action.default_title`: `"Open Pie"` → `"Open Vailie"`。
- subscribe-bridge 的 `content_scripts` matches 与（如单列的）`host_permissions` 追加 `https://vailie.ai/*`、`https://www.vailie.ai/*`,保留 pie.chat 两条。**account.pie.chat / api.pie.chat 权限一字不动。**

- [ ] **Step 3: 验证**

Run: `python3 -c "import json;[print(l, len(json.load(open(f'_locales/{l}/messages.json'))['extension_name']['message'])) for l in ['en','es_419','ja','pt_BR','zh_CN','zh_TW']]"`
Expected: 全部 ≤45。
Run: `pnpm build` → dist/manifest.json 里 name/version 正确。

- [ ] **Step 4: Commit** `feat(rebrand): manifest v2.0.0 — Vailie store names ×6, vailie.ai bridge hosts`

### Task 20: 扩展图标重做

**Files:**
- Create: `scripts/render-icons.html`（canvas 导出器,零依赖）
- Replace: `public/icons/icon-16.png`、`icon-32.png`、`icon-48.png`、`icon-128.png`（`icon-128.svg` 同步重画或删除引用）

- [ ] **Step 1: 写导出器**

```html
<!-- scripts/render-icons.html — 打开于浏览器,自动画 4 尺寸并给下载链接。
     MESH 配方 = VailieMark idle(128/48)与 recording 紧衰减范式(32/16,小尺寸要更实的核)。 -->
<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif">
<script>
const LAYERS_LARGE = [ // idle 配方(与 VailieMark.tsx MESH.idle 同源)
  ["rgba(255,179,194,.35)", .54, .42, .24], ["rgba(255,179,194,.65)", .66, .26, .26],
  ["rgba(124,184,255,.65)", .36, .56, .34], ["rgba(124,184,255,.55)", .58, .72, .40],
  ["rgba(213,222,231,.85)", .30, .28, .28], ["rgba(199,210,222,1)", .50, .46, .56],
];
const LAYERS_SMALL = [ // 紧衰减:小图标核更实、辨识度优先
  ["rgba(255,159,178,1)", .54, .30, .30], ["rgba(124,184,255,.9)", .40, .60, .44],
  ["rgba(196,208,222,1)", .50, .48, .52],
];
function draw(size) {
  const c = document.createElement("canvas"); c.width = c.height = size;
  const ctx = c.getContext("2d");
  const layers = size >= 48 ? LAYERS_LARGE : LAYERS_SMALL;
  for (const [color, x, y, r] of [...layers].reverse()) {
    const g = ctx.createRadialGradient(x * size, y * size, 0, x * size, y * size, r * size * 1.7);
    g.addColorStop(0, color); g.addColorStop(1, color.replace(/[\d.]+\)$/, "0)"));
    ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
  }
  const a = document.createElement("a");
  a.href = c.toDataURL("image/png"); a.download = `icon-${size}.png`;
  a.textContent = `下载 icon-${size}.png`; a.style.display = "block"; a.style.margin = "8px";
  document.body.append(a, c);
}
[128, 48, 32, 16].forEach(draw);
</script>
```

- [ ] **Step 2: 手工步骤（记录在 PR 描述里）**

浏览器打开 `scripts/render-icons.html` → 目检 4 尺寸(16px 必须一眼可辨"彩色团",不糊) → 下载 4 个 PNG 覆盖 `public/icons/` → `pnpm build` → chrome://extensions 刷新目检工具栏图标。若 16px 太糊,调 `LAYERS_SMALL` 半径系数(1.7→1.3 更实)再导。

- [ ] **Step 3: Commit** `feat(rebrand): Vailie blob extension icons (16/32/48/128) + exporter script`

---

## Phase 5 · 验证与发版

### Task 21: 三绿 + dogfood 闸（G6）+ 提审

**Files:**
- Create: `docs/release-notes/v2.0.0.md`
- No code changes（修复项除外）

- [ ] **Step 1: 三绿**

```bash
pnpm test && pnpm typecheck && pnpm build
```

Expected: 全部通过,0 tsc 错误。任何红=先修再进闸。

- [ ] **Step 2: dogfood（3–5 天,G6——不许跳过）**

chrome://extensions 加载 `dist/`,日常自用,核对清单（每项过一遍,发现问题记 issue 修完再来）:

- [ ] BYOK:新建 config(含 endpoint variant 分段/自定义 provider)→ Test → 聊天
- [ ] Pro:Google 登录 → 订阅卡(月/年 radio)→ QuotaBar → 管理订阅
- [ ] 真实 agent 任务跑通:步骤折叠行 → VailieMark working → 完成态 → FileOutputCard
- [ ] Composer:胶囊↔展开形变、附加/拾取/录制入口、模型切换、`/` 补全、streaming 停止+排队
- [ ] Schedule:表单建 + 对话建 → 运行记录 → 点开会话
- [ ] 录制 → 生成技能 → `/slug` 运行
- [ ] 引用三类(文本/元素/图片)+ 文件 chip
- [ ] 菜单枢纽四目的地 + `Cmd+K`/`Cmd+D` + 主题三态(浅/深/系统)
- [ ] 暗色全屏过一遍(无死白/死黑块)
- [ ] 语言抽查 zh-CN + ja:文案不溢出、名字串正确
- [ ] 16px 工具栏图标可辨

- [ ] **Step 3: 商店素材（dogfood 期间并行）**

新 UI 截图 ×5(欢迎屏/任务中/枢纽/技能/订阅)、宣传图带 Vailie 字标与色团;商店描述首行 = 过渡句(Task 19 文案)。listing 在 CWS dashboard 手工更新,与提审同批。

- [ ] **Step 4: 发版（repo Release 流程）**

```bash
# release-notes 写好后:
git add docs/release-notes/v2.0.0.md && git commit -m "docs: v2.0.0 release notes"
gh auth switch --user WiseriaAI
# PR → review → merge 到 main 后:
git tag v2.0.0 && git push origin v2.0.0   # workflow 验 manifest.version == tag
```

CWS dashboard 上传 workflow 产出的 zip + 新 listing → 提审。

---

## Self-Review 记录

- **Spec 覆盖**:§3 token(T1)、§4 IP+图标(T2/T20)、§5 原语+composer(T3/T4)、§6 骨架/枢纽/快捷键/pending 迁移/A/B/C/D 屏(T5/6/8/9/15)、§7.1(T12)、§7.2(T11)、§7.3(T16)、§7.4(T13/T17)、§7.5(T10)、§7.6(T14)、§7.7(T7/T11)、§8(T18/19/20)、§9(T1 琥珀/T13 录制/T18 readyDescription)、§12 五阶段=Phase 1–5。G1–G8 全部有落点。
- **已知留白(刻意)**:Phase 3 sweep 任务给映射表+代表性 diff 而非全文件逐行 diff——替换规则是确定性的,全文 diff 会让 plan 不可维护;每 task 以测试+build+目检收口。
- **类型一致性**:`VailieState`/`animate`(T2→T5/8/9/13/16)、`ThemeMode`(T5→T7)、`openTab`(T6→Settings)、`hubOpen`(T5→T6) 已对齐。
