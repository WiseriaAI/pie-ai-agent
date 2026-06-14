# P3-B 新订阅首月半价 — 客户端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 客户端读 entitlement 的 `introOffer:{percentOff}`，在 `ManagedSubscribePanel` 登录后的订阅 CTA 旁渲染"首月 N% off"徽标（6 语 i18n）。

**Architecture:** 类型 + normalize 透传 introOffer（缺省即无促销，绝不抛）；`ManagedSubscribePanel` 引入 `useI18n` 仅用于新徽标（不重构该面板其余写死英文的文案，守住范围）；徽标文案进 `managed.subscribe.introBadge`（6 语 + 插值 `{percentOff}`）。

**Tech Stack:** React 19 + TS · vitest + @testing-library/react · 自研 i18n（`@/lib/i18n` 的 `useI18n`/`t`，`{name}` 插值，Provider 外回退 en）

**Spec:** `/Users/wenkang/repos/pie/docs/brainstorming/2026-06-14-managed-provider-p3b-first-month-discount-design.md`
**后端契约前置：** 后端 plan（v2.2 introOffer）须先合并/部署，本计划才有真实数据；但本计划全部可独立 TDD（fake 数据），不阻塞。

**前置：** 在 pie-ai-agent 的隔离 worktree 内开发（off main）。测试 `pnpm test <file>`，提交前 `pnpm test` + `pnpm build`。

---

### Task 1: Entitlement 类型 + normalizeEntitlement 透传 introOffer

**Files:**
- Modify: `src/lib/managed-auth.ts`（`Entitlement` 接口加 `introOffer?`）
- Modify: `src/lib/managed-account.ts`（`normalizeIntroOffer` + `normalizeEntitlement` 透传）
- Test: `src/lib/managed-account.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/lib/managed-account.test.ts` 的 `describe("managed-account", …)` 内追加：

```ts
  it("normalizeEntitlement 透传合法 introOffer", async () => {
    const raw = { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [], introOffer: { percentOff: 50 } };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => raw })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-io1", { fetchFn, locale: "en" });
    expect(res.introOffer).toEqual({ percentOff: 50 });
  });

  it("normalizeEntitlement 无 introOffer 时字段缺省（不强填）", async () => {
    const raw = { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [] };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => raw })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-io2", { fetchFn, locale: "en" });
    expect(res.introOffer).toBeUndefined();
  });

  it("normalizeEntitlement 丢弃畸形 introOffer（percentOff 非正数）", async () => {
    const raw = { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [], introOffer: { percentOff: "x" } };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => raw })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-io3", { fetchFn, locale: "en" });
    expect(res.introOffer).toBeUndefined();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/managed-account.test.ts`
Expected: FAIL —— 第一个用例 `res.introOffer` 为 undefined（normalize 未透传）；TS 也会报 `Entitlement` 无 `introOffer` 属性。

- [ ] **Step 3: 实现**

`src/lib/managed-auth.ts` —— `Entitlement` 接口在 `models` 之后加：

```ts
export interface Entitlement {
  plan: "none" | "active" | "blocked";
  email: string;
  subscription: SubscriptionInfo | null;
  quota: { weekly?: QuotaWindow } | null;
  models: ModelInfo[];
  /** 仅"从未订过"且后端 feature 开时下发；客户端据此打"首月半价"徽标。缺省=无促销。 */
  introOffer?: { percentOff: number };
}
```

`src/lib/managed-account.ts` —— 在 `normalizeModel` 附近加 helper：

```ts
function normalizeIntroOffer(raw: unknown): { percentOff: number } | undefined {
  const o = (raw ?? undefined) as Record<string, unknown> | undefined;
  if (o && typeof o.percentOff === "number" && o.percentOff > 0) return { percentOff: o.percentOff };
  return undefined;
}
```

`normalizeEntitlement` 末尾透传（present 才带，缺省不强填）：

```ts
export function normalizeEntitlement(raw: unknown): Entitlement {
  const r = (raw ?? {}) as Record<string, unknown>;
  const plan = r.plan === "active" || r.plan === "blocked" ? r.plan : "none";
  const introOffer = normalizeIntroOffer(r.introOffer);
  return {
    plan,
    email: typeof r.email === "string" ? r.email : "",
    subscription: (r.subscription as Entitlement["subscription"]) ?? null,
    quota: (r.quota as Entitlement["quota"]) ?? null,
    models: Array.isArray(r.models) ? (r.models as unknown[]).map(normalizeModel) : [],
    ...(introOffer ? { introOffer } : {}),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/managed-account.test.ts`
Expected: PASS（既有 normalize/getEntitlement 用例不回归 —— 旧用例无 introOffer，`toEqual` 仍成立，因 introOffer 仅在场时才进对象）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/managed-auth.ts src/lib/managed-account.ts src/lib/managed-account.test.ts
git commit -m "feat(managed): pass through entitlement.introOffer"
```

---

### Task 2: i18n 徽标文案（6 语 + parity）

**Files:**
- Modify: `src/lib/i18n/dictionaries/en.ts`（权威；`managed` 加 `subscribe.introBadge`）
- Modify: `src/lib/i18n/dictionaries/{zh-CN,zh-TW,es-419,ja,pt-BR}.ts`
- Test: `src/lib/i18n/__tests__/dictionary-parity.test.ts`（已有，自动校验 6 语 key 对齐）

- [ ] **Step 1: 先确认 parity 现状（基线绿）**

Run: `pnpm test src/lib/i18n/__tests__/dictionary-parity.test.ts`
Expected: PASS（动手前基线绿）。

- [ ] **Step 2: 加 en 权威 key（会先让 parity 失败）**

`src/lib/i18n/dictionaries/en.ts` —— `managed:` 块内（在 `account` 之前或之后均可，建议 `models` 之后）加：

```ts
    subscribe: {
      introBadge: "First month {percentOff}% off",
    },
```

- [ ] **Step 3: 跑 parity 确认失败**

Run: `pnpm test src/lib/i18n/__tests__/dictionary-parity.test.ts`
Expected: FAIL —— 其余 5 语缺 `managed.subscribe.introBadge`。

- [ ] **Step 4: 给其余 5 语补同一 key**

各文件的 `managed:` 块内加 `subscribe.introBadge`（保留 `{percentOff}` 插值占位）：

`src/lib/i18n/dictionaries/zh-CN.ts`：
```ts
    subscribe: {
      introBadge: "首月立减 {percentOff}%",
    },
```
`src/lib/i18n/dictionaries/zh-TW.ts`：
```ts
    subscribe: {
      introBadge: "首月立減 {percentOff}%",
    },
```
`src/lib/i18n/dictionaries/es-419.ts`：
```ts
    subscribe: {
      introBadge: "{percentOff}% de descuento el primer mes",
    },
```
`src/lib/i18n/dictionaries/ja.ts`：
```ts
    subscribe: {
      introBadge: "初月 {percentOff}% オフ",
    },
```
`src/lib/i18n/dictionaries/pt-BR.ts`：
```ts
    subscribe: {
      introBadge: "{percentOff}% de desconto no primeiro mês",
    },
```

> 注：这 5 个文件是 `satisfies Translations<EnDict>`，缺 key 会同时让 tsc 与 parity 报错；补齐即可。文案为合理默认，ship 前可由产品微调（见 spec §10）。

- [ ] **Step 5: 跑 parity + tsc 确认通过**

Run: `pnpm test src/lib/i18n/__tests__/dictionary-parity.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/lib/i18n/dictionaries/
git commit -m "i18n(managed): add subscribe.introBadge in 6 locales"
```

---

### Task 3: ManagedSubscribePanel 渲染徽标

**Files:**
- Modify: `src/sidepanel/components/ManagedSubscribePanel.tsx`（引入 `useI18n`；session 态、Subscribe 按钮上方渲染徽标）
- Test: `src/sidepanel/components/ManagedSubscribePanel.test.tsx`

- [ ] **Step 1: 写失败测试**

在 `src/sidepanel/components/ManagedSubscribePanel.test.tsx` 的 `describe("ManagedSubscribePanel", …)` 内追加（组件在测试中未挂 I18nProvider → `useI18n` 回退 en，故断言英文）：

```ts
  it("eligible（introOffer 在场）→ 登录后显示首月半价徽标", async () => {
    render(<ManagedSubscribePanel
      onCreated={vi.fn()}
      deps={{
        login: vi.fn(async (): Promise<LoginResult> => ({ apiKey: "sk-v", entitlement: { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [], introOffer: { percentOff: 50 } } })),
        checkout: vi.fn(async () => {}),
      }}
    />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    await screen.findByRole("button", { name: /subscribe/i });
    expect(screen.getByText(/first month 50% off/i)).toBeTruthy();
  });

  it("非 eligible（无 introOffer）→ 不显示徽标", async () => {
    render(<ManagedSubscribePanel
      onCreated={vi.fn()}
      deps={{
        login: vi.fn(async (): Promise<LoginResult> => ({ apiKey: "sk-v", entitlement: { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [] } })),
        checkout: vi.fn(async () => {}),
      }}
    />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    await screen.findByRole("button", { name: /subscribe/i });
    expect(screen.queryByText(/first month/i)).toBeNull();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/ManagedSubscribePanel.test.tsx`
Expected: FAIL —— 找不到 "first month 50% off" 文本（徽标未渲染）。

- [ ] **Step 3: 实现**

`src/sidepanel/components/ManagedSubscribePanel.tsx`：

顶部 import 加：

```ts
import { useI18n } from "@/lib/i18n";
```

组件函数体开头（`const login = …` 之前）取 `t`：

```ts
  const { t } = useI18n();
```

在 `session` 分支里、`Subscribe` 按钮**之前**插入徽标（仅 introOffer 在场时）：

```tsx
          <div className="text-fg-3">Plan: {session.entitlement.plan}</div>
          {session.entitlement.introOffer && (
            <span className="self-start rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
              {t("managed.subscribe.introBadge", { percentOff: session.entitlement.introOffer.percentOff })}
            </span>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={handleCheckout}
            className="h-9 rounded-[10px] bg-accent px-4 text-[12px] font-medium text-canvas disabled:opacity-40"
          >
            Subscribe
          </button>
```

> 仅给徽标引入 i18n；面板其余写死英文文案不在本范围内重构（YAGNI，避免越界）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/ManagedSubscribePanel.test.tsx`
Expected: PASS（既有 5 个用例不回归）。

- [ ] **Step 5: 提交**

```bash
git add src/sidepanel/components/ManagedSubscribePanel.tsx src/sidepanel/components/ManagedSubscribePanel.test.tsx
git commit -m "feat(subscribe): show first-month discount badge when eligible"
```

---

### Task 4: 全量门禁

**Files:** 无（仅验证）

- [ ] **Step 1: 全量单测**

Run: `pnpm test`
Expected: 全绿（沿用 P3-A：~2470+ passed / 1 skipped 量级，无新失败）。

- [ ] **Step 2: 构建（含构建期不变量）**

Run: `pnpm build`
Expected: 成功（`tool-names.ts`/`tools.ts` 构建期断言不 throw；tsc 0 错）。

---

## 自查（写完计划后对照 spec）

- **spec §5.1 类型 + normalize 透传** → Task 1 ✓
- **spec §5.2 paywall 徽标 + i18n 6 语 + 插值** → Task 2（文案）+ Task 3（渲染）✓
- **类型一致性**：`introOffer?: { percentOff: number }`（auth 与 account 一致）、i18n key `managed.subscribe.introBadge`、插值变量名 `percentOff` 全计划一致 ✓
- **测试设计**：normalize 三态（透传/缺省/畸形丢弃）；徽标显隐两态；i18n parity 6 语；均无 placeholder ✓
- **范围守护**：徽标只挂 `ManagedSubscribePanel`（spec 指定）；`ManagedAccountPanel` 的 plan:none 订阅入口**不在本计划**（churned 用户本就不 eligible、无 introOffer；signed-in-never-subscribed 是极边缘场景，如需可作快速跟进，非本期）。
- **依赖顺序**：Task 1（类型）→ Task 3（用类型）；Task 2（en key）→ Task 3（`t(key)` 类型安全需 key 先在 EnDict）。
