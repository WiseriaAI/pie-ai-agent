# 动画铺开（AnimatedList + Collapse 铺开）Implementation Plan

> 执行：inline（本 session），真机验证点暂停等用户。worktree `/Users/wenkang/repos/pie/pie-ai-agent/.claude/worktrees/design-system-foundation`，分支 `feat/design-system-motion-rollout`（基于 main df1c4906，含 #189+#190）。

**Goal:** 新增 `useAnimatedList`（auto-animate 封装）原语并落地会话列表；用既有 `<Collapse>` 铺开两处单向折叠（InstancesList / AgentStepLine），修"开有动画、关瞬断"。

**Architecture:** auto-animate（+3KB，spike 已装于 #190 依赖）做列表增删/重排；hook 式 `useAnimatedList` 返回 ref 挂到现成 `<ul>`，不破坏其 role/style/aria。auto-animate 默认尊重 prefers-reduced-motion。Collapse 复用 #190 原语。

**Tech Stack:** @formkit/auto-animate@0.9.0（`useAutoAnimate`）· motion · React 19 · vitest + happy-dom

## 前置 spike 结论（关键）
auto-animate 在 happy-dom 调 `el.animate()` 崩（happy-dom 无 WAAPI），且这会波及**任何落地了 auto-animate 的组件的现有测试**（SessionDrawer 列表 mutation → 崩）。解法：`src/test/setup.ts` 补 `Element.prototype.animate` stub。**坑**：motion 在 `animate` 存在时改用 WAAPI，所以 stub 必须报告动画**瞬间完成**（`finished` 立即 resolve + `onfinish` setter microtask 触发），否则 motion 的 AnimatePresence exit 永不卸载。已实测：修正后 motion 11 测试 + 全量 2483 测试全绿。

## File Structure
| 文件 | 责任 |
|---|---|
| `src/test/setup.ts`（改，已就位） | WAAPI `animate` stub（瞬间完成，兼容 motion + auto-animate） |
| `src/sidepanel/components/ui/AnimatedList.tsx`（新） | `useAnimatedList` hook（useAutoAnimate + token 调参） |
| `src/sidepanel/components/ui/AnimatedList.test.tsx`（新） | hook 挂载 + 增删反应 + 不崩 |
| `src/sidepanel/components/SessionDrawer.tsx`（改） | 活跃会话 `<ul>` 加 `useAnimatedList` ref |
| `src/sidepanel/components/InstancesList.tsx`（改） | `drawer-down` 单向 → `<Collapse>` |
| `src/sidepanel/components/AgentStepLine.tsx`（改） | `view-enter` 单向 → `<Collapse>` |

## Task 0: setup.ts WAAPI stub（spike 已完成）
已就位并验证（全量 2483 绿）。随本批一起 commit。

## Task 1: `useAnimatedList` 原语
- Create `ui/AnimatedList.tsx`：
```tsx
import { useAutoAnimate } from "@formkit/auto-animate/react";

/** List auto-animation. Attach the returned ref to a list container; its direct
 *  children animate on add / remove / reorder. Honors prefers-reduced-motion
 *  automatically (auto-animate default). Tuned to the design-system motion
 *  tokens (--duration-base 200ms / --ease-standard). */
export function useAnimatedList<T extends HTMLElement = HTMLElement>() {
  const [ref] = useAutoAnimate<T>({
    duration: 200, // --duration-base
    easing: "cubic-bezier(0.32, 0.72, 0, 1)", // --ease-standard
  });
  return ref;
}
```
- Create `ui/AnimatedList.test.tsx`（验证挂载 + 增删反应 + 不崩，依赖 Task 0 stub）。
- 跑 `pnpm test src/sidepanel/components/ui/AnimatedList.test.tsx` → PASS。

## Task 2: SessionDrawer 会话列表落地
- 在主组件顶层加 `const listRef = useAnimatedList<HTMLUListElement>();`，import `useAnimatedList`。
- 活跃会话 `<ul role="list" style={...}>`（约 L490）加 `ref={listRef}`。
- 跑 SessionDrawer 现有测试 → 仍 PASS（stub 保证不崩）。

## Task 3: InstancesList → Collapse
- import `{ Collapse } from "./ui/Collapse"`。
- L68 `{isOpen && <div className="drawer-down border-t border-line bg-surface">{props.renderForm(inst.id)}</div>}`
  → `<Collapse open={isOpen} className="border-t border-line bg-surface">{props.renderForm(inst.id)}</Collapse>`。

## Task 4: AgentStepLine → Collapse
- import `{ Collapse } from "./ui/Collapse"`。
- L84 `{expanded && (<div className="view-enter ml-4 flex flex-col gap-1.5 border-l border-line pl-2.5 text-[11px]">...</div>)}`
  → `<Collapse open={expanded} className="ml-4 flex flex-col gap-1.5 border-l border-line pl-2.5 text-[11px]">...</Collapse>`（去 view-enter）。

## 验证
typecheck 0 + 全量测试绿 + build；真机：会话删除/新建列表平滑、实例展开收起双向、agent step 展开收起双向、CSP console 干净。

## 范围外（后续批）
`<Drawer>` + SessionDrawer 容器；散落 inline dropdown（PinnedTabDropdown/ProviderDropdown/LanguageSelect 的 inline→portal 迁 Popover）；CollapsibleText（maxHeight 截断语义，不适配 Collapse）。
