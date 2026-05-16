# Chat 空状态居中招呼语 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chat 空状态从「顶部对齐 + READY + headline + skill 推荐」改成「垂直居中 + 随机招呼语 + 副标题」，去掉 skill 推荐区。

**Architecture:** 单文件改动 (`Chat.tsx` 的 `EmptyState` 子组件) + 两份 i18n 字典新增/删除 key。Greeting 通过 `useMemo` 在 mount 时随机抽 1/7，session 内稳定。`enabledSkills` state 保留（`SkillSlashPopover` 还在用）。

**Tech Stack:** React 19 / TypeScript / TailwindCSS v4 / vitest + @testing-library/react。

**Spec:** `docs/specs/2026-05-17-chat-empty-state-centered-greeting.md`

---

## File Structure

| 文件 | 改动 |
|---|---|
| `src/lib/i18n/dictionaries/en.ts` | +7 keys (`chat.greeting1`…`greeting7`)；-4 keys (`chat.ready`, `chat.readyHeadline`, `chat.suggested`, `chat.forAll`) |
| `src/lib/i18n/dictionaries/zh-CN.ts` | 同上 |
| `src/sidepanel/components/Chat.tsx` | `EmptyState` 重写 (1224–1278 行)；caller (899–902 行) 删 props |
| `src/sidepanel/components/Chat.test.tsx` | 新增 1 个 test：空状态渲染显示随机招呼语之一 |

---

## Task 1: 在两份 i18n 字典里新增 7 条 greeting

**Files:**
- Modify: `src/lib/i18n/dictionaries/en.ts:128` (在 `readyDescription` 之后插入)
- Modify: `src/lib/i18n/dictionaries/zh-CN.ts:128` (在 `readyDescription` 之后插入)

- [ ] **Step 1: 编辑 `src/lib/i18n/dictionaries/en.ts`**

在 `readyDescription` 行之后、`suggested` 之前插入：

```ts
    greeting1: "Hey, what are we looking at today?",
    greeting2: "So, what's the plan?",
    greeting3: "I'm here — what's up?",
    greeting4: "What can I do for you today?",
    greeting5: "Hey there — where to?",
    greeting6: "Got something on your mind?",
    greeting7: "Anything fun on this page?",
```

- [ ] **Step 2: 编辑 `src/lib/i18n/dictionaries/zh-CN.ts`**

在 `readyDescription` 行之后、`suggested` 之前插入：

```ts
    greeting1: "嗨，今天我们看点什么？",
    greeting2: "来呀，今天想做点什么？",
    greeting3: "我在呢，想做点什么？",
    greeting4: "今天我能帮上什么忙？",
    greeting5: "嘿，想去哪儿？我陪你。",
    greeting6: "想到什么了？跟我说说。",
    greeting7: "看看这页有什么好玩的？",
```

- [ ] **Step 3: 验证两份字典编译通过**

Run: `pnpm test -- --run --reporter=basic src/lib/i18n`
Expected: PASS（dict 类型 inference 应该无错误）

如果 i18n 类型测试 fail（key 集合不一致），打开 dictionaries/types.ts，看是不是 en 是 source of truth，是的话两份必须同步新增。

- [ ] **Step 4: Commit**

```bash
git add src/lib/i18n/dictionaries/en.ts src/lib/i18n/dictionaries/zh-CN.ts
git commit -m "i18n(chat): add 7 greeting variants (bilingual)"
```

---

## Task 2: 写 EmptyState 新行为的 failing test

**Files:**
- Modify: `src/sidepanel/components/Chat.test.tsx` (末尾追加新 describe 块)

- [ ] **Step 1: 阅读 `Chat.test.tsx` 1–140 行，理解现有 `renderChat()` / `makeSession()` 帮手**

不需要新建 setup，复用现有 mock。

- [ ] **Step 2: 在 `Chat.test.tsx` 末尾追加 test**

```tsx
describe("EmptyState centered greeting", () => {
  it("renders one of the 7 greetings (zh-CN locale)", async () => {
    // Locale defaults to 'en' in I18nProvider initial state; set zh-CN via
    // chrome.storage to match what we want to assert on.
    chromeMock.storage.local.set({ ui_locale: "zh-CN" });

    const session = makeSession();
    render(<Chat session={session} onOpenSettings={() => {}} />);

    // Wait for locale resolution + first render.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const greetings = [
      "嗨，今天我们看点什么？",
      "来呀，今天想做点什么？",
      "我在呢，想做点什么？",
      "今天我能帮上什么忙？",
      "嘿，想去哪儿？我陪你。",
      "想到什么了？跟我说说。",
      "看看这页有什么好玩的？",
    ];
    const found = greetings.some((g) => screen.queryByText(g) !== null);
    expect(found).toBe(true);
  });

  it("does NOT render 'READY' caps label or SUGGESTED skill section", async () => {
    const session = makeSession();
    render(<Chat session={session} onOpenSettings={() => {}} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByText("READY")).toBeNull();
    expect(screen.queryByText("就绪")).toBeNull();
    expect(screen.queryByText("SUGGESTED")).toBeNull();
    expect(screen.queryByText("推荐")).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test -- --run src/sidepanel/components/Chat.test.tsx -t "EmptyState centered greeting"`
Expected: FAIL — 第 1 个 case 找不到任何 greeting；第 2 个 case 找到 "READY"/"SUGGESTED"。

不 commit，进 Task 3。

---

## Task 3: 重写 EmptyState 组件（去 skill 区 + READY + 加居中 + 随机 greeting）

**Files:**
- Modify: `src/sidepanel/components/Chat.tsx:1224-1278` (EmptyState 函数体)
- Modify: `src/sidepanel/components/Chat.tsx:899-902` (caller)

- [ ] **Step 1: 重写 EmptyState 函数体**

把 `Chat.tsx` 第 1224–1279 行整段（从 `function EmptyState({` 到对应闭合的 `}`）替换为：

```tsx
function EmptyState() {
  const t = useT();
  const greeting = useMemo(() => {
    const keys = [
      "greeting1",
      "greeting2",
      "greeting3",
      "greeting4",
      "greeting5",
      "greeting6",
      "greeting7",
    ] as const;
    const pick = keys[Math.floor(Math.random() * keys.length)];
    return t(`chat.${pick}` as const);
  }, [t]);
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex max-w-[280px] flex-col items-center gap-3">
        <h1 className="text-[24px] font-semibold leading-8 tracking-[-0.015em] text-fg-1">
          {greeting}
        </h1>
        <p className="text-[13px] leading-5 text-fg-2">
          {t("chat.readyDescription")}
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 改 caller（899–902 行）**

把：

```tsx
          <EmptyState
            skills={enabledSkills.slice(0, 3)}
            onPickSkill={(slug) => setInput(`/${slug} `)}
          />
```

改成：

```tsx
          <EmptyState />
```

- [ ] **Step 3: 确认 `useMemo` 已经 import（应该在 line 1 已经有）**

Grep 确认：

```bash
grep -n "^import.*useMemo" src/sidepanel/components/Chat.tsx
```

Expected: 命中第 1 行 `import { useState, useEffect, useRef, useMemo } from "react";`

- [ ] **Step 4: Run failing test again to verify PASS**

Run: `pnpm test -- --run src/sidepanel/components/Chat.test.tsx -t "EmptyState centered greeting"`
Expected: PASS（两个 case 都过）

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/Chat.tsx src/sidepanel/components/Chat.test.tsx
git commit -m "feat(chat): centered random greeting empty state, drop skill suggestions"
```

---

## Task 4: 删除 4 个 orphan i18n keys

**Files:**
- Modify: `src/lib/i18n/dictionaries/en.ts`
- Modify: `src/lib/i18n/dictionaries/zh-CN.ts`

- [ ] **Step 1: Grep 确认 4 个 key 在 src 内已无引用**

```bash
grep -rn "chat\.ready\b\|chat\.readyHeadline\|chat\.suggested\|chat\.forAll" src
```

Expected: 无命中（如果有命中说明 Task 3 漏改了 EmptyState 某处，回去补）。

注意：`chat.readyDescription` 仍在用（副标题），不要误删。

- [ ] **Step 2: 编辑 `src/lib/i18n/dictionaries/en.ts` 删 4 行**

删除：

```ts
    ready: "READY",
    readyHeadline: "What should I do on this page?",
    suggested: "SUGGESTED",
    forAll: "/ for all",
```

保留 `readyDescription`。

- [ ] **Step 3: 编辑 `src/lib/i18n/dictionaries/zh-CN.ts` 删 4 行**

删除：

```ts
    ready: "就绪",
    readyHeadline: "需要我在这页上做什么？",
    suggested: "推荐",
    forAll: "/ 查看全部",
```

保留 `readyDescription`。

- [ ] **Step 4: 跑全套 i18n + Chat test 确认无回归**

Run: `pnpm test -- --run src/lib/i18n src/sidepanel/components/Chat.test.tsx`
Expected: 全 PASS

- [ ] **Step 5: 跑 `pnpm build` 确认 build-time invariants 不动**

Run: `pnpm build`
Expected: 成功，不 throw

- [ ] **Step 6: Commit**

```bash
git add src/lib/i18n/dictionaries/en.ts src/lib/i18n/dictionaries/zh-CN.ts
git commit -m "i18n(chat): drop orphaned ready/suggested/forAll keys"
```

---

## Task 5: 手动验收

- [ ] **Step 1: `pnpm dev` 启动 dev server**

```bash
pnpm dev
```

- [ ] **Step 2: 装 / reload extension**

`chrome://extensions` → reload Pie。

- [ ] **Step 3: 打开 side panel，新开 session，核对：**

- [ ] 招呼语垂直居中（在 header 和输入框中间偏中）
- [ ] 没有 "READY" 小字 caps 标签
- [ ] 没有 skill 推荐列表
- [ ] 副标题居中，最多两行
- [ ] 多次开新 session 能看到不同招呼语

- [ ] **Step 4: 切到 EN locale 再开新 session，核对英文招呼语正常**

Settings → Language → English → 新 session。

- [ ] **Step 5: 输入 `/` 确认 SkillSlashPopover 仍弹出（保证 enabledSkills 没被误删）**

- [ ] **Step 6: 全部通过即结案。若发现问题：fix → commit (NEW commit, never amend)。**

---

## Self-Review

- ✓ Spec coverage：
  - 招呼语 7 条 → Task 1 (i18n) + Task 2/3 (random pick 实现)
  - 副标题保留 → Task 3 (`t("chat.readyDescription")`)
  - 删 skill 区 + READY 标签 → Task 3 (component 改写) + Task 4 (i18n key 清理)
  - 垂直居中布局 → Task 3 (`min-h-full justify-center items-center text-center max-w-[280px]`)
  - 随机策略 mount-once → Task 3 (`useMemo([t])`)
- ✓ 无占位符（每步都有代码或命令）
- ✓ 类型一致：`greeting1`…`greeting7` 在 Task 1 添加，在 Task 3 通过 `as const` keys 数组 + 模板字符串引用，键名一致
- ✓ 不 break 现有 enabledSkills 流（Task 4 grep 验证 + Task 5 Step 5 手动验证）
