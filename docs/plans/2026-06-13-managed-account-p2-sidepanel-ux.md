# Managed Account · P2 侧栏 UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **设计源**：`docs/specs/2026-06-13-managed-account-p2-sidepanel-ux-design.md`（含状态机表、错误 CTA 矩阵、Paper 原型）。本 plan 只写 how + 步骤，需求与验收看 spec。

**Goal:** 把客户端订阅面板从旧 entitlement 形状迁到 v2，并重做侧栏 UX：单条周额度进度条 + 订阅到期/续费/取消态 + 错误 CTA 按 plan×error.type 分流。

**Architecture:** 纯前端（`pie-ai-agent`）。新增两个纯函数/呈现单元（`managed-format.ts`、`QuotaBar.tsx`）做基座，再迁共享类型 `Entitlement` → v2，最后重做两个面板。全部走既有语义 Tailwind token（`text-fg-1`/`bg-pending`/`text-warning`…），唯一新增 `success` 绿 token。组件靠 deps 注入做单测（无真实网络）。

**Tech Stack:** React 19 + TS 6 · TailwindCSS v4（CSS-first `@theme`，无 config 文件）· vitest + happy-dom + @testing-library/react · pnpm。

---

## Prerequisites（执行前）

- **隔离工作区**：用 `superpowers:using-git-worktrees` 建 worktree（main 受保护，不在 main 上改）。⚠️ subagent cwd 不随 worktree 切换，派活 prompt 必须 `cd <worktree 绝对路径>`。
- **baseline**：`pnpm install` 后 `pnpm test` 全绿、`pnpm typecheck` 0 错，确认干净起点。
- 门禁命令（每个 commit 前按需跑）：`pnpm test`、`pnpm typecheck`、`pnpm build`。
- 提交信息结尾加：
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

## 依赖顺序

T1（format 纯函数）→ T2（QuotaBar，用 T1）→ T3（success token）→ T4（v2 类型迁移 + getEntitlement + 非面板 fixture + 面板保活）→ T5（ManagedAccountPanel 重做，用 T1/T2/T3）→ T6（ManagedErrorCta 重做，用 T1/T4）→ T7（终检）。

每个任务结束时 `pnpm typecheck` 与 `pnpm test` 必须全绿后再 commit。

---

## File Structure

| 文件 | 动作 | 责任 | 任务 |
|---|---|---|---|
| `src/lib/managed-format.ts` | 新建 | 日期格式化 + 周额度档位/class 映射（纯函数） | T1 |
| `src/lib/managed-format.test.ts` | 新建 | 上述单测 | T1 |
| `src/sidepanel/components/QuotaBar.tsx` | 新建 | 周额度条呈现组件 | T2 |
| `src/sidepanel/components/QuotaBar.test.tsx` | 新建 | QuotaBar 渲染测试 | T2 |
| `src/sidepanel/index.css` | 改 | 加 `success`/`success-tint` token（4 块 + `@theme`） | T3 |
| `src/lib/managed-auth.ts` | 改 | `Entitlement` → v2 + 子类型导出 | T4 |
| `src/lib/managed-account.ts` | 改 | `getEntitlement` 加 `normalizeEntitlement` | T4 |
| `src/lib/managed-auth.test.ts` | 改 | fixture → v2 | T4 |
| `src/lib/managed-account.test.ts` | 改 | fixture → v2 + normalize 断言 | T4 |
| `src/sidepanel/components/ManagedSubscribePanel.test.tsx` | 改 | fixture → v2 | T4 |
| `src/sidepanel/components/NewConfigWizard.managed.test.tsx` | 改 | fixture → v2 | T4 |
| `src/sidepanel/components/ManagedAccountPanel.tsx` | 改 | T4 保活 1 行 → T5 全状态重做 | T4/T5 |
| `src/sidepanel/components/ManagedAccountPanel.test.tsx` | 改 | T4 fixture 保活 → T5 全状态断言 | T4/T5 |
| `src/sidepanel/components/ManagedErrorCta.tsx` | 改 | plan×kind 矩阵 + 拉 entitlement | T6 |
| `src/sidepanel/components/ManagedErrorCta.test.tsx` | 改 | 矩阵分支断言 | T6 |

---

## Task 1: managed-format（日期 + 周额度档位 纯函数）

**Files:**
- Create: `src/lib/managed-format.ts`
- Test: `src/lib/managed-format.test.ts`

- [ ] **Step 1: 写失败测试**

`src/lib/managed-format.test.ts`：
```ts
import { describe, expect, it } from "vitest";
import { quotaTier, formatDate, formatResetDate, TIER_FILL_CLASS, TIER_TEXT_CLASS } from "./managed-format";

describe("managed-format", () => {
  it("quotaTier 边界：<0.80 neutral / [0.80,0.95) caution / >=0.95 critical", () => {
    expect(quotaTier(0)).toBe("neutral");
    expect(quotaTier(0.79)).toBe("neutral");
    expect(quotaTier(0.8)).toBe("caution");
    expect(quotaTier(0.94)).toBe("caution");
    expect(quotaTier(0.95)).toBe("critical");
    expect(quotaTier(1)).toBe("critical");
  });

  it("档位 class 映射齐全", () => {
    expect(TIER_FILL_CLASS.neutral).toBe("bg-fg-1");
    expect(TIER_FILL_CLASS.caution).toBe("bg-pending");
    expect(TIER_FILL_CLASS.critical).toBe("bg-warning");
    expect(TIER_TEXT_CLASS.neutral).toBe("text-fg-1");
    expect(TIER_TEXT_CLASS.caution).toBe("text-pending");
    expect(TIER_TEXT_CLASS.critical).toBe("text-warning");
  });

  it("formatDate：unix 秒 → 'Mon DD, YYYY'，null/非有限 → null", () => {
    expect(formatDate(1750000000)).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
    expect(formatDate(null)).toBeNull();
    expect(formatDate(undefined)).toBeNull();
    expect(formatDate(Number.NaN)).toBeNull();
  });

  it("formatResetDate：unix 秒 → 'Ddd, Mon DD'，null → null", () => {
    expect(formatResetDate(1750400000)).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}$/);
    expect(formatResetDate(null)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/managed-format.test.ts`
Expected: FAIL（`Cannot find module './managed-format'`）

- [ ] **Step 3: 实现**

`src/lib/managed-format.ts`：
```ts
export type QuotaTier = "neutral" | "caution" | "critical";

/** 周额度告警三档：<80% 中性 / 80–95% 黄铜 / ≥95% 红。见 ADR / spec §5.4。 */
export function quotaTier(fraction: number): QuotaTier {
  if (fraction >= 0.95) return "critical";
  if (fraction >= 0.8) return "caution";
  return "neutral";
}

/** 进度条 fill 的 Tailwind 背景类（按档）。 */
export const TIER_FILL_CLASS: Record<QuotaTier, string> = {
  neutral: "bg-fg-1",
  caution: "bg-pending",
  critical: "bg-warning",
};

/** 百分比文字的 Tailwind 文本类（按档）。 */
export const TIER_TEXT_CLASS: Record<QuotaTier, string> = {
  neutral: "text-fg-1",
  caution: "text-pending",
  critical: "text-warning",
};

/** unix 秒 → "Jun 20, 2026"；null/非有限 → null（调用方据此省略整行）。 */
export function formatDate(unixSec: number | null | undefined): string | null {
  if (unixSec == null || !Number.isFinite(unixSec)) return null;
  return new Date(unixSec * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** unix 秒 → "Mon, Jun 16"；null/非有限 → null。 */
export function formatResetDate(unixSec: number | null | undefined): string | null {
  if (unixSec == null || !Number.isFinite(unixSec)) return null;
  return new Date(unixSec * 1000).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/managed-format.test.ts`
Expected: PASS（4 个 it 全绿）

- [ ] **Step 5: typecheck + commit**

Run: `pnpm typecheck`（Expected: 0 错）
```bash
git add src/lib/managed-format.ts src/lib/managed-format.test.ts
git commit -m "feat(managed): add managed-format (date + quota tier helpers)"
```

---

## Task 2: QuotaBar 周额度条组件

**Files:**
- Create: `src/sidepanel/components/QuotaBar.tsx`
- Test: `src/sidepanel/components/QuotaBar.test.tsx`

- [ ] **Step 1: 写失败测试**

`src/sidepanel/components/QuotaBar.test.tsx`：
```tsx
import { afterEach, describe, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import QuotaBar from "./QuotaBar";

afterEach(() => cleanup());

describe("QuotaBar", () => {
  it("中性档（71%）：显示百分比/重置日，fill 用 bg-fg-1", () => {
    const { container } = render(<QuotaBar usedFraction={0.71} resetAt={1750400000} />);
    expect(screen.getByText("71%")).toBeTruthy();
    expect(screen.getByText("used")).toBeTruthy();
    expect(screen.getByText(/^Resets /)).toBeTruthy();
    expect(container.querySelector(".bg-fg-1")).toBeTruthy();
  });

  it("黄铜档（88%）：fill 用 bg-pending", () => {
    const { container } = render(<QuotaBar usedFraction={0.88} resetAt={1750400000} />);
    expect(screen.getByText("88%")).toBeTruthy();
    expect(container.querySelector(".bg-pending")).toBeTruthy();
  });

  it("红档（≥95%）：fill 用 bg-warning", () => {
    const { container } = render(<QuotaBar usedFraction={0.97} resetAt={1750400000} />);
    expect(screen.getByText("97%")).toBeTruthy();
    expect(container.querySelector(".bg-warning")).toBeTruthy();
  });

  it("分数越界被 clamp（>1 显示 100%）", () => {
    render(<QuotaBar usedFraction={1.4} resetAt={1750400000} />);
    expect(screen.getByText("100%")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/QuotaBar.test.tsx`
Expected: FAIL（`Cannot find module './QuotaBar'`）

- [ ] **Step 3: 实现**

`src/sidepanel/components/QuotaBar.tsx`：
```tsx
import { quotaTier, TIER_FILL_CLASS, TIER_TEXT_CLASS, formatResetDate } from "@/lib/managed-format";

export default function QuotaBar({ usedFraction, resetAt }: { usedFraction: number; resetAt: number }) {
  const f = Math.max(0, Math.min(1, usedFraction));
  const pct = Math.round(f * 100);
  const tier = quotaTier(f);
  const reset = formatResetDate(resetAt);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <div className="caps text-fg-3">THIS WEEK</div>
        <div className="flex items-baseline gap-1">
          <span className={`text-[14px] font-semibold tabular ${TIER_TEXT_CLASS[tier]}`}>{pct}%</span>
          <span className="text-[11px] text-fg-3">used</span>
        </div>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-field">
        <div className={`h-2 rounded-full ${TIER_FILL_CLASS[tier]}`} style={{ width: `${pct}%` }} />
      </div>
      {reset && <div className="text-[11px] text-fg-3">Resets {reset}</div>}
    </div>
  );
}
```
（`.caps` 与 `.tabular` 是 `index.css` 已有工具类。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/QuotaBar.test.tsx`
Expected: PASS（4 个 it 全绿）

- [ ] **Step 5: typecheck + commit**

Run: `pnpm typecheck`（Expected: 0 错）
```bash
git add src/sidepanel/components/QuotaBar.tsx src/sidepanel/components/QuotaBar.test.tsx
git commit -m "feat(managed): add QuotaBar weekly-usage component"
```

---

## Task 3: 新增 success 语义 token

**Files:**
- Modify: `src/sidepanel/index.css`（`@layer base` 四个块 + `@theme` 块）

> 黄铜档复用已存在的 `--c-pending`/`--color-pending`，红档复用 `--c-warning`/`--color-warning`；本任务只补绿。CSS 无单元测试，靠 `pnpm build` 验证无语法错 + grep 确认变量在位；类的实际生效在 T5 由面板使用后随 build 验证。

- [ ] **Step 1: `:root`（默认/light）块加变量**

在 `src/sidepanel/index.css` 的 `:root { … }`（约 7–29 行）`--c-fg-4` 之后加：
```css
    --c-success: #3E8E63;
    --c-success-tint: rgba(62, 142, 99, 0.10);
```

- [ ] **Step 2: `@media (prefers-color-scheme: dark)` 块加变量**

在该块 `:root { … }`（约 32–55 行）`--c-fg-4` 之后加：
```css
      --c-success: #5FA37D;
      --c-success-tint: rgba(95, 163, 125, 0.14);
```

- [ ] **Step 3: `[data-theme="light"]` 块加变量**

在 `[data-theme="light"] { … }`（约 62–85 行）`--c-fg-4` 之后加：
```css
    --c-success: #3E8E63;
    --c-success-tint: rgba(62, 142, 99, 0.10);
```

- [ ] **Step 4: `[data-theme="dark"]` 块加变量**

在 `[data-theme="dark"] { … }`（约 87–110 行）`--c-fg-4` 之后加：
```css
    --c-success: #5FA37D;
    --c-success-tint: rgba(95, 163, 125, 0.14);
```

- [ ] **Step 5: `@theme` 块 wire 成 Tailwind 颜色**

在 `@theme { … }`（约 113–133 行）`--color-overlay: var(--c-overlay);` 之后加：
```css
  --color-success: var(--c-success);
  --color-success-tint: var(--c-success-tint);
```

- [ ] **Step 6: 验证**

Run: `grep -n "c-success\|color-success" src/sidepanel/index.css`
Expected: 共 9 行（4 块 × `--c-success` + 4 块 × `--c-success-tint` 实为 8 行变量 + `@theme` 2 行 wiring = 10 行；至少应见 light/dark 两套定义 + @theme 两行）

Run: `pnpm build`
Expected: 构建成功（无 CSS 解析错）

- [ ] **Step 7: commit**

```bash
git add src/sidepanel/index.css
git commit -m "feat(theme): add success semantic color token (light + dark)"
```

---

## Task 4: entitlement v2 类型迁移 + getEntitlement + 非面板 fixture（面板保活）

**Files:**
- Modify: `src/lib/managed-auth.ts`
- Modify: `src/lib/managed-account.ts`
- Modify: `src/lib/managed-auth.test.ts`
- Modify: `src/lib/managed-account.test.ts`
- Modify: `src/sidepanel/components/ManagedSubscribePanel.test.tsx`
- Modify: `src/sidepanel/components/NewConfigWizard.managed.test.tsx`
- Modify: `src/sidepanel/components/ManagedAccountPanel.tsx`（保活 1 行）
- Modify: `src/sidepanel/components/ManagedAccountPanel.test.tsx`（fixture 保活）

> 共享类型变更会牵动所有消费者；本任务把类型 + getEntitlement + 全部非面板 fixture 一起迁，并对面板做最小保活（删掉读 `budgetRemainingUsd` 的那行），使 typecheck/test 重新全绿。面板全状态重做在 T5。

- [ ] **Step 1: 改 `Entitlement` 为 v2（`src/lib/managed-auth.ts`）**

把第 3–7 行的 `Entitlement` 替换为：
```ts
export interface QuotaWindow {
  usedFraction: number;
  resetAt: number;
}
export interface SubscriptionInfo {
  planName: string;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}
export interface ModelInfo {
  id: string;
  name: string;
}
export interface Entitlement {
  plan: "none" | "active" | "blocked";
  email: string;
  /** plan==none 时为 null；blocked 时非 null（供更新支付）。 */
  subscription: SubscriptionInfo | null;
  /** plan!=active 时为 null；具名窗口 map（P3 可加 fiveHour）。 */
  quota: { weekly?: QuotaWindow } | null;
  /** 仅 plan==active 非空。 */
  models: ModelInfo[];
}
```
（`LoginResult` 不变。）

- [ ] **Step 2: getEntitlement 加 normalize（`src/lib/managed-account.ts`）**

`import` 行补类型：
```ts
import type { Entitlement } from "./managed-auth";
```
（已有，无需改。）把 `getEntitlement`（10–17 行）替换为带 normalize 的版本，并在其下加 `normalizeEntitlement`：
```ts
export async function getEntitlement(apiKey: string, deps: ManagedAccountDeps = {}): Promise<Entitlement> {
  const fetchFn = deps.fetchFn ?? fetch;
  const resp = await fetchFn(`${ACCOUNT_BASE}/me/entitlement`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) throw new Error(`Failed to load entitlement (${resp.status})`);
  return normalizeEntitlement(await resp.json());
}

/** 容忍后端缺字段/新激活边缘：补齐 v2 安全默认，绝不抛。 */
export function normalizeEntitlement(raw: unknown): Entitlement {
  const r = (raw ?? {}) as Record<string, unknown>;
  const plan = r.plan === "active" || r.plan === "blocked" ? r.plan : "none";
  return {
    plan,
    email: typeof r.email === "string" ? r.email : "",
    subscription: (r.subscription as Entitlement["subscription"]) ?? null,
    quota: (r.quota as Entitlement["quota"]) ?? null,
    models: Array.isArray(r.models) ? (r.models as Entitlement["models"]) : [],
  };
}
```

- [ ] **Step 3: 迁 `src/lib/managed-account.test.ts` fixture**

把第 8 行的 `json` 与第 14 行的断言换成 v2，并加一个 normalize 容错断言。替换 6–15 行的 it 为：
```ts
  it("getEntitlement GETs /me/entitlement with Bearer and parses v2", async () => {
    const v2 = {
      plan: "active", email: "u@x.com",
      subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false },
      quota: { weekly: { usedFraction: 0.5, resetAt: 1750400000 } },
      models: [{ id: "default", name: "标准" }],
    };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => v2 })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-virtual", { fetchFn });
    expect(fetchFn).toHaveBeenCalledWith("https://account.pie.chat/me/entitlement", {
      headers: { authorization: "Bearer sk-virtual" },
    });
    expect(res).toEqual(v2);
  });

  it("normalizeEntitlement 容忍缺字段：plan 落 none、数组/对象补默认", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ email: "u@x.com" }) })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-virtual", { fetchFn });
    expect(res).toEqual({ plan: "none", email: "u@x.com", subscription: null, quota: null, models: [] });
  });
```
顶部 import 增补：
```ts
import { getEntitlement, openCheckout, openPortal } from "./managed-account";
```
（已有，无需改。）

- [ ] **Step 4: 迁 `src/lib/managed-auth.test.ts` fixture**

把第 10 行与第 27 行里的 `entitlement: { plan: "none", email: "u@x.com", budgetRemainingUsd: 0 }` 两处都替换为：
```ts
{ plan: "none", email: "u@x.com", subscription: null, quota: null, models: [] }
```

- [ ] **Step 5: 迁 `ManagedSubscribePanel.test.tsx` fixture（5 处）**

把文件内所有 `budgetRemainingUsd` 的 entitlement 字面量迁 v2：
- `{ plan: "active", email: "u@x.com", budgetRemainingUsd: 6 }`（及 5/6 等）→ `{ plan: "active", email: "u@x.com", subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false }, quota: { weekly: { usedFraction: 0, resetAt: 1750400000 } }, models: [{ id: "default", name: "标准" }] }`
- `{ plan: "none", email: "u@x.com", budgetRemainingUsd: 0 }`（含 89 行单独的 `budgetRemainingUsd: 0` 对象）→ `{ plan: "none", email: "u@x.com", subscription: null, quota: null, models: [] }`

验证：`grep -n budgetRemainingUsd src/sidepanel/components/ManagedSubscribePanel.test.tsx` 应无输出。

- [ ] **Step 6: 迁 `NewConfigWizard.managed.test.tsx` fixture（1 处）**

第 24 行 `entitlement: { plan: "active", email: "u@x.com", budgetRemainingUsd: 6 }` → 
```ts
entitlement: { plan: "active", email: "u@x.com", subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false }, quota: { weekly: { usedFraction: 0, resetAt: 1750400000 } }, models: [{ id: "default", name: "标准" }] }
```

- [ ] **Step 7: 面板保活（`ManagedAccountPanel.tsx` 第 44 行）**

把第 44 行
```tsx
          <div className="text-fg-3">Plan: <span className="text-fg-1">{ent.plan}</span> · Remaining: ${ent.budgetRemainingUsd.toFixed(2)}</div>
```
替换为（暂去掉余额，仅保编译；T5 全重做）：
```tsx
          <div className="text-fg-3">Plan: <span className="text-fg-1">{ent.plan}</span></div>
```

- [ ] **Step 8: 面板测试 fixture 保活（`ManagedAccountPanel.test.tsx` 第 13 行）**

第 13 行 `({ plan: "active", email: "u@x.com", budgetRemainingUsd: 4.2 })` → 
```ts
({ plan: "active", email: "u@x.com", subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false }, quota: { weekly: { usedFraction: 0.71, resetAt: 1750400000 } }, models: [{ id: "default", name: "标准" }] })
```

- [ ] **Step 9: 全量 typecheck + test + grep**

Run: `pnpm typecheck`
Expected: 0 错（`budgetRemainingUsd` 已不存在于类型，所有消费者已迁）

Run: `pnpm test src/lib/managed-auth.test.ts src/lib/managed-account.test.ts src/sidepanel/components/ManagedSubscribePanel.test.tsx src/sidepanel/components/NewConfigWizard.managed.test.tsx src/sidepanel/components/ManagedAccountPanel.test.tsx`
Expected: 全 PASS

Run: `grep -rn budgetRemainingUsd src/`
Expected: 无输出

- [ ] **Step 10: commit**

```bash
git add src/lib/managed-auth.ts src/lib/managed-account.ts src/lib/managed-auth.test.ts src/lib/managed-account.test.ts src/sidepanel/components/ManagedSubscribePanel.test.tsx src/sidepanel/components/NewConfigWizard.managed.test.tsx src/sidepanel/components/ManagedAccountPanel.tsx src/sidepanel/components/ManagedAccountPanel.test.tsx
git commit -m "refactor(managed): migrate Entitlement to v2 (subscription/quota/models)"
```

---

## Task 5: ManagedAccountPanel 全状态重做

**Files:**
- Modify: `src/sidepanel/components/ManagedAccountPanel.tsx`
- Modify: `src/sidepanel/components/ManagedAccountPanel.test.tsx`

- [ ] **Step 1: 写失败测试（覆盖全状态）**

把 `src/sidepanel/components/ManagedAccountPanel.test.tsx` 整体替换为：
```tsx
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import ManagedAccountPanel from "./ManagedAccountPanel";
import type { Entitlement } from "@/lib/managed-auth";

afterEach(() => cleanup());

const active: Entitlement = {
  plan: "active", email: "u@x.com",
  subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false },
  quota: { weekly: { usedFraction: 0.71, resetAt: 1750400000 } },
  models: [{ id: "default", name: "标准" }],
};

describe("ManagedAccountPanel", () => {
  it("active：套餐名/邮箱/续费日/周额度条 + Manage subscription → portal", async () => {
    const portal = vi.fn(async () => {});
    render(<ManagedAccountPanel apiKey="sk-v" deps={{ refresh: vi.fn(async () => active), portal }} />);
    expect(await screen.findByText("Pie Pro")).toBeTruthy();
    expect(screen.getByText("u@x.com")).toBeTruthy();
    expect(screen.getByText(/^Renews /)).toBeTruthy();
    expect(screen.getByText("THIS WEEK")).toBeTruthy();
    expect(screen.getByText("71%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /manage subscription/i }));
    await waitFor(() => expect(portal).toHaveBeenCalledWith("sk-v"));
  });

  it("active 取消续费：显示 Cancels + won't renew", async () => {
    const ent: Entitlement = { ...active, subscription: { ...active.subscription!, cancelAtPeriodEnd: true } };
    render(<ManagedAccountPanel apiKey="sk-v" deps={{ refresh: vi.fn(async () => ent) }} />);
    expect(await screen.findByText(/^Cancels /)).toBeTruthy();
    expect(screen.getByText(/won't renew/)).toBeTruthy();
  });

  it("active 且 currentPeriodEnd=null：不报错、省略日期行、仍显示周额度", async () => {
    const ent: Entitlement = { ...active, subscription: { ...active.subscription!, currentPeriodEnd: null } };
    render(<ManagedAccountPanel apiKey="sk-v" deps={{ refresh: vi.fn(async () => ent) }} />);
    expect(await screen.findByText("71%")).toBeTruthy();
    expect(screen.queryByText(/^Renews /)).toBeNull();
    expect(screen.queryByText(/^Cancels /)).toBeNull();
  });

  it("blocked：Payment failed + Update payment method → portal，无周额度条", async () => {
    const portal = vi.fn(async () => {});
    const ent: Entitlement = {
      plan: "blocked", email: "u@x.com",
      subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false },
      quota: null, models: [],
    };
    render(<ManagedAccountPanel apiKey="sk-v" deps={{ refresh: vi.fn(async () => ent), portal }} />);
    expect(await screen.findByText(/Payment failed/)).toBeTruthy();
    expect(screen.queryByText("THIS WEEK")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /update payment method/i }));
    await waitFor(() => expect(portal).toHaveBeenCalledWith("sk-v"));
  });

  it("none：No active subscription + Subscribe → checkout", async () => {
    const checkout = vi.fn(async () => {});
    const ent: Entitlement = { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [] };
    render(<ManagedAccountPanel apiKey="sk-v" deps={{ refresh: vi.fn(async () => ent), checkout }} />);
    expect(await screen.findByText(/No active subscription/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^subscribe$/i }));
    await waitFor(() => expect(checkout).toHaveBeenCalledWith("sk-v"));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/ManagedAccountPanel.test.tsx`
Expected: FAIL（旧面板无 "Pie Pro"/"THIS WEEK"/"Update payment method" 等）

- [ ] **Step 3: 重做组件**

把 `src/sidepanel/components/ManagedAccountPanel.tsx` 整体替换为：
```tsx
import { useEffect, useState } from "react";
import { getEntitlement, openCheckout, openPortal } from "@/lib/managed-account";
import type { Entitlement } from "@/lib/managed-auth";
import { formatDate } from "@/lib/managed-format";
import QuotaBar from "./QuotaBar";

export interface ManagedAccountDeps {
  refresh?: (apiKey: string) => Promise<Entitlement>;
  checkout?: (apiKey: string) => Promise<void>;
  portal?: (apiKey: string) => Promise<void>;
}

function StatusPill({ tone, label }: { tone: "success" | "warning" | "neutral"; label: string }) {
  const box = {
    success: "bg-success-tint text-success",
    warning: "bg-warning-tint text-warning",
    neutral: "bg-field text-fg-2",
  }[tone];
  const dot = { success: "bg-success", warning: "bg-warning", neutral: "bg-fg-3" }[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${box}`}>
      <span className={`h-[5px] w-[5px] rounded-full ${dot}`} />
      {label}
    </span>
  );
}

export default function ManagedAccountPanel({ apiKey, deps }: { apiKey: string; deps?: ManagedAccountDeps }) {
  const refresh = deps?.refresh ?? ((k: string) => getEntitlement(k));
  const checkout = deps?.checkout ?? ((k: string) => openCheckout(k));
  const portal = deps?.portal ?? ((k: string) => openPortal(k));

  const [ent, setEnt] = useState<Entitlement | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setErr(null);
    try { setEnt(await refresh(apiKey)); }
    catch (e) { setErr(e instanceof Error ? e.message : "Failed to load"); }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [apiKey]);

  async function handlePortal() {
    setErr(null);
    try { await portal(apiKey); }
    catch (e) { setErr(e instanceof Error ? e.message : "Failed to open portal"); }
  }
  async function handleCheckout() {
    setErr(null);
    try { await checkout(apiKey); }
    catch (e) { setErr(e instanceof Error ? e.message : "Failed to open checkout"); }
  }

  const container = "flex flex-col gap-[18px] rounded-[14px] border border-line bg-surface p-4 text-[13px]";

  if (!ent) {
    return <div className={container}><div className="text-fg-3">Loading…</div></div>;
  }

  const sub = ent.subscription;
  const isActive = ent.plan === "active";
  const isBlocked = ent.plan === "blocked";
  const periodDate = formatDate(sub?.currentPeriodEnd);

  const pill = isActive
    ? <StatusPill tone="success" label="Active" />
    : isBlocked
      ? <StatusPill tone="warning" label="Payment failed" />
      : <StatusPill tone="neutral" label="Inactive" />;

  const headline = isActive || isBlocked ? (sub?.planName ?? "Pie") : "No active subscription";

  const primary = isActive
    ? { label: "Manage subscription", on: handlePortal }
    : isBlocked
      ? { label: "Update payment method", on: handlePortal }
      : { label: "Subscribe", on: handleCheckout };

  return (
    <div className={container}>
      <div className="flex flex-col gap-[9px]">
        <div className="flex items-center justify-between">
          <div className="caps text-fg-3">SUBSCRIPTION</div>
          {pill}
        </div>
        <div className="flex flex-col gap-1">
          <div className="text-[16px] font-semibold tracking-[-0.01em] text-fg-1">{headline}</div>
          <div className="font-mono text-[12px] text-fg-2">{ent.email}</div>
          {isActive && periodDate && (
            sub?.cancelAtPeriodEnd ? (
              <div className="flex items-center gap-2 pt-0.5">
                <span className="text-[12px] text-fg-2">Cancels {periodDate}</span>
                <span className="rounded-full bg-field px-1.5 py-px font-mono text-[10px] text-fg-2">won't renew</span>
              </div>
            ) : (
              <div className="pt-0.5 text-[12px] text-fg-2">Renews {periodDate}</div>
            )
          )}
        </div>
      </div>

      {isBlocked && (
        <div className="text-[12px] leading-[17px] text-fg-2">
          Your last payment didn't go through. Update your payment method to keep using Pie.
        </div>
      )}
      {ent.plan === "none" && (
        <div className="text-[12px] leading-[17px] text-fg-2">
          Subscribe to use the official Pie service — no API key needed.
        </div>
      )}

      {isActive && ent.quota?.weekly && (
        <QuotaBar usedFraction={ent.quota.weekly.usedFraction} resetAt={ent.quota.weekly.resetAt} />
      )}

      <div className="flex items-center gap-2 pt-0.5">
        <button type="button" onClick={primary.on}
          className="h-9 rounded-[10px] bg-fg-1 px-4 text-[13px] font-semibold text-canvas">{primary.label}</button>
        <div className="flex-1" />
        <button type="button" onClick={load}
          className="h-9 px-2 text-[13px] text-fg-2 hover:text-fg-1">Refresh</button>
      </div>

      {err && (
        <div className="rounded-lg border border-warning-line bg-warning-tint px-3 py-2 text-[12px] text-warning">{err}</div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/ManagedAccountPanel.test.tsx`
Expected: PASS（5 个 it 全绿）

- [ ] **Step 5: typecheck + build + commit**

Run: `pnpm typecheck`（Expected: 0 错）
Run: `pnpm build`（Expected: 成功；确认 `bg-success`/`text-success`/`bg-success-tint` 被实际使用并随 Tailwind 生成）
```bash
git add src/sidepanel/components/ManagedAccountPanel.tsx src/sidepanel/components/ManagedAccountPanel.test.tsx
git commit -m "feat(managed): redesign ManagedAccountPanel with v2 states + quota bar"
```

---

## Task 6: ManagedErrorCta 按 plan×kind 分流

**Files:**
- Modify: `src/sidepanel/components/ManagedErrorCta.tsx`
- Modify: `src/sidepanel/components/ManagedErrorCta.test.tsx`

- [ ] **Step 1: 写失败测试（矩阵分支）**

把 `src/sidepanel/components/ManagedErrorCta.test.tsx` 整体替换为：
```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import ManagedErrorCta from "./ManagedErrorCta";
import type { Entitlement } from "@/lib/managed-auth";

afterEach(() => cleanup());

const ent = (over: Partial<Entitlement>): Entitlement => ({
  plan: "active", email: "u@x.com",
  subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false },
  quota: { weekly: { usedFraction: 1, resetAt: 1750400000 } },
  models: [{ id: "default", name: "标准" }],
  ...over,
});

describe("ManagedErrorCta", () => {
  it("budget + active：信息态（等重置），无按钮", async () => {
    render(<ManagedErrorCta kind="budget" deps={{
      getManagedKey: async () => "sk-v",
      getEnt: async () => ent({ plan: "active" }),
    }} />);
    expect(await screen.findByText(/used this week's quota/i)).toBeTruthy();
    expect(screen.getByText(/^Resets /)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("budget + none：Subscribe → checkout", async () => {
    const checkout = vi.fn(async () => {});
    render(<ManagedErrorCta kind="budget" deps={{
      getManagedKey: async () => "sk-v",
      getEnt: async () => ent({ plan: "none", subscription: null, quota: null, models: [] }),
      checkout,
    }} />);
    const btn = await screen.findByRole("button", { name: /^subscribe$/i });
    fireEvent.click(btn);
    await waitFor(() => expect(checkout).toHaveBeenCalledWith("sk-v"));
  });

  it("auth + blocked：Update payment → portal", async () => {
    const portal = vi.fn(async () => {});
    render(<ManagedErrorCta kind="auth" deps={{
      getManagedKey: async () => "sk-v",
      getEnt: async () => ent({ plan: "blocked", quota: null, models: [] }),
      portal,
    }} />);
    const btn = await screen.findByRole("button", { name: /update payment/i });
    fireEvent.click(btn);
    await waitFor(() => expect(portal).toHaveBeenCalledWith("sk-v"));
  });

  it("budget + blocked：仍按 dunning 走 portal", async () => {
    const portal = vi.fn(async () => {});
    render(<ManagedErrorCta kind="budget" deps={{
      getManagedKey: async () => "sk-v",
      getEnt: async () => ent({ plan: "blocked", quota: null, models: [] }),
      portal,
    }} />);
    const btn = await screen.findByRole("button", { name: /update payment/i });
    fireEvent.click(btn);
    await waitFor(() => expect(portal).toHaveBeenCalledWith("sk-v"));
  });

  it("无 managed key → 不渲染", async () => {
    const { container } = render(<ManagedErrorCta kind="budget" deps={{
      getManagedKey: async () => null,
      getEnt: async () => ent({}),
    }} />);
    await waitFor(() => expect(container.textContent).toBe(""));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/ManagedErrorCta.test.tsx`
Expected: FAIL（旧组件无 `getEnt` dep、无矩阵文案）

- [ ] **Step 3: 重做组件**

把 `src/sidepanel/components/ManagedErrorCta.tsx` 整体替换为：
```tsx
import { useEffect, useState } from "react";
import type { ErrorKind } from "@/lib/model-router/types";
import type { Entitlement } from "@/lib/managed-auth";
import { listInstances } from "@/lib/instances";
import { getEntitlement, openCheckout, openPortal } from "@/lib/managed-account";
import { formatResetDate } from "@/lib/managed-format";

export interface ManagedErrorCtaDeps {
  getManagedKey?: () => Promise<string | null>;
  getEnt?: (apiKey: string) => Promise<Entitlement>;
  portal?: (apiKey: string) => Promise<void>;
  checkout?: (apiKey: string) => Promise<void>;
}

async function defaultGetManagedKey(): Promise<string | null> {
  const insts = await listInstances();
  return insts.find((i) => i.provider === "managed")?.apiKey ?? null;
}

function CtaCard({ tone, title, body, action }: {
  tone: "warning" | "neutral";
  title: string;
  body: string;
  action?: { label: string; on: () => void };
}) {
  const box = tone === "warning" ? "border-warning-line bg-warning-tint" : "border-line bg-field";
  return (
    <div className={`mt-1.5 flex items-center gap-2.5 rounded-xl border px-3 py-2.5 ${box}`}>
      <div className="flex flex-1 flex-col gap-0.5">
        <div className="text-[13px] font-medium text-fg-1">{title}</div>
        <div className="text-[12px] text-fg-2">{body}</div>
      </div>
      {action && (
        <button type="button" onClick={action.on}
          className="shrink-0 rounded-[9px] bg-fg-1 px-3.5 py-2 text-[12px] font-semibold text-canvas">{action.label}</button>
      )}
    </div>
  );
}

export default function ManagedErrorCta({ kind, deps }: { kind: ErrorKind | null; deps?: ManagedErrorCtaDeps }) {
  const getManagedKey = deps?.getManagedKey ?? defaultGetManagedKey;
  const getEnt = deps?.getEnt ?? ((k: string) => getEntitlement(k));
  const portal = deps?.portal ?? ((k: string) => openPortal(k));
  const checkout = deps?.checkout ?? ((k: string) => openCheckout(k));

  const [key, setKey] = useState<string | null>(null);
  const [ent, setEnt] = useState<Entitlement | null>(null);

  useEffect(() => {
    let live = true;
    if (kind === "budget" || kind === "auth") {
      void (async () => {
        const k = await getManagedKey();
        if (!live) return;
        setKey(k);
        if (!k) { setEnt(null); return; }
        try { const e = await getEnt(k); if (live) setEnt(e); }
        catch { if (live) setEnt(null); }
      })();
    } else {
      setKey(null);
      setEnt(null);
    }
    return () => { live = false; };
  }, [kind, getManagedKey, getEnt]);

  if (!key || (kind !== "budget" && kind !== "auth")) return null;
  if (!ent) return null; // entitlement 未就绪 → 暂不渲染，避免闪烁

  // 欠费 dunning：blocked 不论 auth/budget 都引导更新支付
  if (ent.plan === "blocked") {
    return (
      <CtaCard tone="warning" title="Payment failed" body="Update your payment method to continue."
        action={{ label: "Update payment", on: () => { void portal(key).catch(() => {}); } }} />
    );
  }

  if (kind === "auth") {
    // 非 blocked 的 401 → key 真失效/过期
    return <div className="mt-1.5 text-[12px] text-fg-3">Your session expired — sign in again from Settings → Configs.</div>;
  }

  // kind === "budget"
  if (ent.plan === "active") {
    const reset = formatResetDate(ent.quota?.weekly?.resetAt);
    return (
      <CtaCard tone="neutral" title="You've used this week's quota"
        body={reset ? `Resets ${reset}. You can keep chatting then.` : "Resets soon. You can keep chatting then."} />
    );
  }
  // plan === "none"
  return (
    <CtaCard tone="neutral" title="Subscribe to keep chatting" body="Your subscription isn't active."
      action={{ label: "Subscribe", on: () => { void checkout(key).catch(() => {}); } }} />
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/ManagedErrorCta.test.tsx`
Expected: PASS（5 个 it 全绿）

- [ ] **Step 5: typecheck + commit**

Run: `pnpm typecheck`（Expected: 0 错）
```bash
git add src/sidepanel/components/ManagedErrorCta.tsx src/sidepanel/components/ManagedErrorCta.test.tsx
git commit -m "feat(managed): plan-aware ManagedErrorCta (weekly/none/dunning)"
```

---

## Task 7: 全量终检

**Files:** 无（仅验证）

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: 全部 PASS（含新增 managed-format / QuotaBar，及重做的两个面板）

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 0 错

- [ ] **Step 3: build**

Run: `pnpm build`
Expected: 成功（Tailwind 生成 `bg-success`/`text-success`/`bg-success-tint`/`bg-pending` 等；manifest invariant 不受影响）

- [ ] **Step 4: 残留检查**

Run: `grep -rn budgetRemainingUsd src/`
Expected: 无输出

- [ ] **Step 5: 收尾**

用 `superpowers:finishing-a-development-branch` 收口（main 受保护 → 走 PR：先 `gh auth switch --user WiseriaAI` 再 `gh pr create`）。

---

## Self-Review（写完即查）

- **Spec 覆盖**：v2 类型迁移=T4；周额度进度条=T1+T2+T5；状态机 active/canceling/blocked/none/null-period=T5；错误 CTA 矩阵=T6；success token=T3；fixture 迁移=T4；验收 §9 各条均有对应 step。✓
- **占位符**：无 TBD/“适当处理”等；每个改码 step 都给了完整代码与确切命令。✓
- **类型一致**：`Entitlement`/`QuotaWindow`/`SubscriptionInfo`/`ModelInfo`（T4 定义）在 T5/T6 一致使用；`quotaTier`/`TIER_FILL_CLASS`/`TIER_TEXT_CLASS`/`formatDate`/`formatResetDate`（T1）在 T2/T5/T6 一致引用；`ManagedAccountDeps`/`ManagedErrorCtaDeps` 与测试 deps 形状对齐。✓
- **YAGNI**：未引入 entitlement 全局缓存/Context；未做模型展示/多套餐（留 P3/P4）。✓
