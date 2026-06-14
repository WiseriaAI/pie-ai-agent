# 内联下拉动画原语 `<DropdownPanel>` + 3 个 Settings 下拉落地 Implementation Plan

> 执行：inline（本 session），塌缩档（原语 TDD + 3 个同构机械迁移）。worktree `/Users/wenkang/repos/pie/pie-ai-agent/.claude/worktrees/design-system-foundation`，分支 `feat/design-system-dropdown-popover`（基于 main 9656fef3，含 #189/#190/#191）。两批合一个 PR。

**Goal:** 新增"不 portal 版 Popover" 原语 `<DropdownPanel>`（定位交调用方 className，内部 `AnimatePresence`+`m.div` slide+fade），落地 3 个贴合触发器的 Settings 下拉（LanguageSelect / AssistantLanguageSelect / ProviderDropdown），把散落的 `scale-in origin-top` CSS 替成统一动画并补上优雅退场（修"开有动画、关瞬断"）。

**Architecture:** 散落 dropdown 分两类——贴合触发器、不需逃逸 overflow 的小菜单（本批）vs 真需 portal 的（PinnedTabDropdown，下一批）。本批三者外部点击监听都挂外层 `relative` 容器，故原语**不 portal**（菜单仍是容器 DOM 子节点）→ 调用方既有 `ref.contains` 外部点击与 CSS 定位零改动，无需 coords 计算。复刻上批 `<Collapse>` 修关瞬断的成功模式。

**Tech Stack:** motion（`m.div`/`AnimatePresence`）· React 19 · vitest + happy-dom（依赖上批 WAAPI stub）

## 前置事实
- `.scale-in` keyframe（index.css）仍被 Markdown 徽章 / Chat 气泡 / SchedulesPanel / PinnedTabDropdown 使用 → **本批保留 keyframe**，只把 3 个 Settings 下拉迁走。
- 测试范式（同 Popover.test）：`MotionProvider` 包裹 + `waitForElementToBeRemoved` 等退场；`afterEach(cleanup)`；原生 chai。

## File Structure
| 文件 | 责任 |
|---|---|
| `src/sidepanel/components/ui/DropdownPanel.tsx`（新） | inline slide+fade 原语，定位/外部点击留给调用方 |
| `src/sidepanel/components/ui/DropdownPanel.test.tsx`（新） | 闭合渲染空 / 开则就地挂载（不 portal）/ 转发 className / 优雅退场卸载 |
| `src/sidepanel/components/LanguageSelect.tsx`（改） | `{open && <div scale-in absolute…>}` → `<DropdownPanel open role="listbox" className="absolute…">` |
| `src/sidepanel/components/AssistantLanguageSelect.tsx`（改） | 同构迁移 |
| `src/sidepanel/components/ProviderDropdown.tsx`（改） | in-flow block 面板同迁，去 `scale-in origin-top` |

## Task 1: `<DropdownPanel>` 原语 + 测试（TDD）
1. 写 `DropdownPanel.test.tsx`（4 例：closed 渲染空 / open 就地挂载且 `container.contains(panel)` 为真 / 转发 className / open→false 后 `waitForElementToBeRemoved` 卸载）。
2. 跑 → FAIL（模块不存在）。
3. 实现 `DropdownPanel.tsx`：`AnimatePresence` 包 `m.div`，props `{open, className, role, style, placement="below", children}`，`dy = placement==="above" ? 6 : -6`，`initial/animate/exit` = opacity+y，`transition={{duration: DURATION.base, ease: EASE_STANDARD}}`。
4. 跑 → PASS。typecheck。commit。

## Task 2: LanguageSelect 迁移
- import `{ DropdownPanel } from "./ui/DropdownPanel"`。
- `{open && (<div role="listbox" className="scale-in origin-top absolute z-10 mt-1 flex w-full flex-col gap-0.5 rounded-[9px] border border-line bg-surface p-1">…</div>)}`
  → `<DropdownPanel open={open} role="listbox" className="absolute z-10 mt-1 flex w-full flex-col gap-0.5 rounded-[9px] border border-line bg-surface p-1">…</DropdownPanel>`（去 `scale-in origin-top`）。
- 跑 `LanguageSelect.test.tsx` → PASS。commit。

## Task 3: AssistantLanguageSelect 迁移
- 同 Task 2 结构（className 一致）。跑其测试 → PASS。commit。

## Task 4: ProviderDropdown 迁移
- import 同上。
- `{open && (<div className="scale-in origin-top flex flex-col rounded-[10px] border border-line bg-surface">…</div>)}`
  → `<DropdownPanel open={open} className="flex flex-col rounded-[10px] border border-line bg-surface">…</DropdownPanel>`（去 `scale-in origin-top`；面板 in-flow，原语 transform 不脱流可兼容；内部 `autoFocus` input 随 mount 触发不受影响）。
- 跑 `ProviderDropdown.test.tsx` → PASS。commit。

## 验证
`pnpm typecheck`（0）+ 全量 `pnpm test`（绿）+ `pnpm build`；真机：三处下拉打开 slide+fade、关闭有退场不瞬断、外部点击/ESC/选择仍正常、Settings 页无错。

## 续作（同 PR 第二批）：PinnedTabDropdown 迁 portal Popover ✅
- 新增 `useAnchorRect`（ui/useAnchorRect.ts）：封装 anchor 测量 + resize/scroll-capture 跟踪，返回 `DOMRect`，placement/clamp 留调用方。3 测试。
- PinnedTabDropdown 退化为纯内容+交互组件：删 `open`/`onExited` props、`onAnimationEnd`、220ms timeout fallback、`scale-in/out`+绝对定位。单测**零改动**仍 12 绿。
- Chat.tsx：portaled `<Popover>` 包 PinnedTabDropdown（`useAnchorRect(pinBarRef)` 算 `{left, top: bottom+4, width}`，`AnimatePresence` 接管 mount/leave）→ 删 `pinDropdownVisible` 双状态机 + onExited effect。
- 关键决策：①外部点击/ESC 仍留 PinnedTabDropdown 内（`containerRef`），换来单测零改动；②Popover 在 Chat 层包，故组件内不含 `m.div`、单测不需 MotionProvider；③ModelPicker dogfood `useAnchorRect` 留 follow-up（hook 已就位，不动现稳定核心避免回归）。
- 全量 2491 绿+typecheck0+build，已 sync dist 待真机。

## 范围外（后续批）
- SkillSlashPopover（`placement="above"`）/ ContextRing（inline-style 定位）按需评估迁 Popover + useAnchorRect。
- `<Drawer>` + SessionDrawer 容器（最高风险，单列）。
- QuoteChip 是 tooltip 语义（hover），不在 dropdown 迁移范围。
- Follow-up：ModelPicker dogfood `useAnchorRect`（删其手写 updateCoords/coords/两 effect，flip/clamp 抽纯函数）。
