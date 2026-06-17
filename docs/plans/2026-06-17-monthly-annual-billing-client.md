# 月付/年付订阅区分 — 客户端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** paywall 支持月付/年付两个订阅入口（年付带「省 X%」徽标），账户面板显示当前计费周期；全程不暴露真实定价。

**Architecture:** 后端已上线契约 v2.4：`plan:none` 带 `annualOffer?:{savePercent?}`（在场=年付可买、savePercent=省钱比例徽标）、`subscription` 带 `interval?:'month'|'year'`（仅 stripe source）；`/billing/checkout` 接受可选 `{interval}`。客户端只透传/展示后端给的相对比例，绝不知美元。**向后兼容**：年付未开（无 annualOffer）时 paywall 退化为现状单按钮。

**Tech Stack:** React 19 + TS、vitest + @testing-library/react、6 语 i18n 字典（parity 测试强约束键集一致）。

**前置**：后端计划 `pie-managed-backend/docs/plans/2026-06-17-monthly-annual-billing-backend.md` 已实现并部署（契约 v2.4 生效）。spec：工作区根 `docs/brainstorming/2026-06-17-monthly-annual-billing-design.md`。所有路径相对 `pie-ai-agent/`，命令在 `pie-ai-agent/` 下跑。

**门禁**（每个 commit 前）：`pnpm test` + `pnpm build`。

---

## 文件结构（改动地图）

| 文件 | 责任 | 改动 |
|---|---|---|
| `src/lib/managed-auth.ts` | entitlement 类型 | `SubscriptionInfo.interval?`、`Entitlement.annualOffer?`（Task 1） |
| `src/lib/managed-account.ts` | API 客户端 + normalize | `normalizeSubscription` 透 interval、`normalizeEntitlement` 透 annualOffer、`openCheckout` 加 interval body（Task 1） |
| `src/lib/managed-account.test.ts` | 单测 | normalize 三态 + openCheckout interval（Task 1） |
| `src/lib/i18n/dictionaries/*.ts`（6 个） | 文案 | 年付按钮/徽标/计费周期标签（Task 2） |
| `src/lib/i18n/__tests__/dictionary-parity.test.ts` | 键集校验 | 新键显式断言（Task 2） |
| `src/sidepanel/components/ManagedSubscribePanel.tsx` | paywall | 单按钮 → 月付/年付两按钮 + 徽标（Task 3） |
| `src/sidepanel/components/ManagedAccountPanel.tsx` | 账户面板 | active stripe 显示计费周期标签（Task 4） |

---

## Task 1: 类型 + normalize + openCheckout interval

**Files:**
- Modify: `src/lib/managed-auth.ts`
- Modify: `src/lib/managed-account.ts`
- Test: `src/lib/managed-account.test.ts`

`annualOffer` 的**存在性**= 年付是否可买，必须独立于 `savePercent` 保留（不可照搬 `normalizeIntroOffer` 的「缺值即丢」，否则空 `{}` 被误删、年付按钮消失）。`openCheckout` 仅在传 interval 时带 body（不传 → 与现状一致，护住既有测试）。

- [ ] **Step 1: 写失败测试**

`src/lib/managed-account.test.ts` 的 `describe("managed-account", …)` 内追加：

```ts
  it("normalizeEntitlement 透传 annualOffer:{savePercent}", async () => {
    const raw = { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [], annualOffer: { savePercent: 20 } };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => raw })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-an1", { fetchFn, locale: "en" });
    expect(res.annualOffer).toEqual({ savePercent: 20 });
  });

  it("normalizeEntitlement 保留空 annualOffer:{}（年付可买、无徽标，不被误丢）", async () => {
    const raw = { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [], annualOffer: {} };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => raw })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-an2", { fetchFn, locale: "en" });
    expect(res.annualOffer).toEqual({});
  });

  it("normalizeEntitlement 无 annualOffer → absent", async () => {
    const raw = { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [] };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => raw })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-an3", { fetchFn, locale: "en" });
    expect(res.annualOffer).toBeUndefined();
  });

  it("normalizeEntitlement 丢弃畸形 annualOffer.savePercent（非正数→剔除 savePercent，仍在场）", async () => {
    const raw = { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [], annualOffer: { savePercent: "x" } };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => raw })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-an4", { fetchFn, locale: "en" });
    expect(res.annualOffer).toEqual({});
  });

  it("normalizeSubscription 透传 interval=year（仅 month/year 合法）", async () => {
    const raw = { plan: "active", email: "u@x.com", subscription: { planName: "Pie Pro", currentPeriodEnd: 9, cancelAtPeriodEnd: false, source: "stripe", interval: "year" }, quota: null, models: [] };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => raw })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-iv1", { fetchFn, locale: "en" });
    expect(res.subscription).toMatchObject({ interval: "year" });
  });

  it("normalizeSubscription 非法/缺 interval → 省略", async () => {
    const raw = { plan: "active", email: "u@x.com", subscription: { planName: "Pie Pro", currentPeriodEnd: 9, cancelAtPeriodEnd: false, source: "redemption" }, quota: null, models: [] };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => raw })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-iv2", { fetchFn, locale: "en" });
    expect((res.subscription as Record<string, unknown>).interval).toBeUndefined();
  });

  it("openCheckout 带 interval → POST body 含 {interval}", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ url: "https://checkout.test/y" }) })) as unknown as typeof fetch;
    const openTab = vi.fn();
    await openCheckout("sk-virtual", { fetchFn, openTab }, "year");
    expect(fetchFn).toHaveBeenCalledWith("https://account.pie.chat/billing/checkout", {
      method: "POST",
      headers: { authorization: "Bearer sk-virtual", "content-type": "application/json" },
      body: JSON.stringify({ interval: "year" }),
    });
    expect(openTab).toHaveBeenCalledWith("https://checkout.test/y");
  });
```

> 既有用例 `openCheckout POSTs /billing/checkout`（不传 interval、断言无 body）必须仍通过——保证向后兼容。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/managed-account.test.ts`
Expected: FAIL（`annualOffer`/`interval` 未透传、`openCheckout` 不接 interval）

- [ ] **Step 3: 实现 managed-auth.ts（类型）**

`SubscriptionInfo` 接口加 interval（在 `source` 后）：

```ts
export interface SubscriptionInfo {
  planName: string;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  /** 当前驱动 active 的来源：stripe（付费订阅，可开 portal）/ redemption（兑换码，无账单可管）。 */
  source: "stripe" | "redemption";
  /** 计费周期；仅 stripe source 有，redemption 省略。缺省按月付兜底显示。 */
  interval?: "month" | "year";
}
```

`Entitlement` 接口加 annualOffer（在 `introOffer?` 后）：

```ts
  /** 仅"从未订过"且后端 feature 开时下发；客户端据此打"首月半价"徽标。缺省=无促销。 */
  introOffer?: { percentOff: number };
  /** 仅年付 feature 开时下发（plan:none）；存在=年付可买（出年付按钮），savePercent 在则打"年付省 X%"徽标。 */
  annualOffer?: { savePercent?: number };
```

- [ ] **Step 4: 实现 managed-account.ts（normalize + openCheckout）**

`normalizeSubscription` 返回对象加 interval（在 `source` 后）：

```ts
  return {
    planName: typeof s.planName === "string" && s.planName ? s.planName : "Pie",
    currentPeriodEnd: typeof s.currentPeriodEnd === "number" ? s.currentPeriodEnd : null,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd === true,
    source: s.source === "redemption" ? "redemption" : "stripe",
    ...(s.interval === "month" || s.interval === "year" ? { interval: s.interval } : {}),
  };
```

新增 `normalizeAnnualOffer`（放在 `normalizeIntroOffer` 之后）——**与 intro 不同：对象在场即保留，savePercent 仅正数才带**：

```ts
/** annualOffer 存在性=年付可买，独立于 savePercent 保留（区别于 introOffer 的缺值即丢）。 */
function normalizeAnnualOffer(raw: unknown): { savePercent?: number } | undefined {
  if (raw == null || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  return typeof o.savePercent === "number" && o.savePercent > 0 ? { savePercent: o.savePercent } : {};
}
```

`normalizeEntitlement`：取 annualOffer 并条件透传（在 `introOffer` 那行旁）：

```ts
export function normalizeEntitlement(raw: unknown): Entitlement {
  const r = (raw ?? {}) as Record<string, unknown>;
  const plan = r.plan === "active" || r.plan === "blocked" ? r.plan : "none";
  const introOffer = normalizeIntroOffer(r.introOffer);
  const annualOffer = normalizeAnnualOffer(r.annualOffer);
  return {
    plan,
    email: typeof r.email === "string" ? r.email : "",
    subscription: normalizeSubscription(r.subscription),
    quota: (r.quota as Entitlement["quota"]) ?? null,
    models: Array.isArray(r.models) ? (r.models as unknown[]).map(normalizeModel) : [],
    ...(introOffer ? { introOffer } : {}),
    ...(annualOffer ? { annualOffer } : {}),
  };
}
```

`openBilling` 改为可带 body；`openCheckout` 加 interval 参数：

```ts
async function openBilling(path: "/billing/checkout" | "/billing/portal", apiKey: string, deps: ManagedAccountDeps, body?: Record<string, unknown>): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch;
  const openTab = deps.openTab ?? ((url: string) => { chrome.tabs.create({ url }); });
  const init: RequestInit = body
    ? { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body) }
    : { method: "POST", headers: { authorization: `Bearer ${apiKey}` } };
  const resp = await fetchFn(`${ACCOUNT_BASE}${path}`, init);
  if (!resp.ok) throw new Error(`${path} failed (${resp.status})`);
  const { url } = (await resp.json()) as { url: string };
  openTab(url);
}

export const openCheckout = (apiKey: string, deps: ManagedAccountDeps = {}, interval?: "month" | "year") =>
  openBilling("/billing/checkout", apiKey, deps, interval ? { interval } : undefined);
export const openPortal = (apiKey: string, deps: ManagedAccountDeps = {}) => openBilling("/billing/portal", apiKey, deps);
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/lib/managed-account.test.ts && pnpm build`
Expected: PASS（含既有 openCheckout 无 body 用例）+ tsc 0

- [ ] **Step 6: Commit**

```bash
git add src/lib/managed-auth.ts src/lib/managed-account.ts src/lib/managed-account.test.ts
git commit -m "feat(managed): types + normalize annualOffer/interval + openCheckout interval"
```

---

## Task 2: i18n 6 语新键

**Files:**
- Modify: `src/lib/i18n/dictionaries/en.ts`、`zh-CN.ts`、`zh-TW.ts`、`es-419.ts`、`ja.ts`、`pt-BR.ts`
- Test: `src/lib/i18n/__tests__/dictionary-parity.test.ts`

新增 3 个 subscribe 键 + 2 个 account 键，6 语全配（parity 测试强约束键集一致 + 非空）。

- [ ] **Step 1: 写失败测试**

`src/lib/i18n/__tests__/dictionary-parity.test.ts` 顶部已 import `enDict`/`zhCNDict`。在 `describe("dictionary parity", …)` 内追加：

```ts
  it("annual billing keys present (en/zh-CN sample)", () => {
    expect(enDict.managed.subscribe.monthly).toBe("Monthly");
    expect(enDict.managed.subscribe.annual).toBe("Yearly");
    expect(enDict.managed.subscribe.annualBadge).toBe("Save {savePercent}%");
    expect(enDict.managed.account.billedMonthly).toBe("Billed monthly");
    expect(enDict.managed.account.billedYearly).toBe("Billed yearly");
    expect(zhCNDict.managed.subscribe.annualBadge).toBe("省 {savePercent}%");
    expect(zhCNDict.managed.account.billedYearly).toBe("按年计费");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/i18n/__tests__/dictionary-parity.test.ts`
Expected: FAIL（新键不存在；且既有「same key set as English」会因 en 先加而对其他语言报缺——本步先看新断言失败即可）

- [ ] **Step 3: 实现 6 语字典**

每个字典文件的 `managed.subscribe` 对象内（`introBadge` 旁）加 3 键，`managed.account` 对象内（`redeemedUntil` 旁）加 2 键。逐语言取值：

**en.ts**
```ts
// managed.subscribe
monthly: "Monthly",
annual: "Yearly",
annualBadge: "Save {savePercent}%",
// managed.account
billedMonthly: "Billed monthly",
billedYearly: "Billed yearly",
```
**zh-CN.ts**
```ts
monthly: "按月",
annual: "按年",
annualBadge: "省 {savePercent}%",
billedMonthly: "按月计费",
billedYearly: "按年计费",
```
**zh-TW.ts**
```ts
monthly: "按月",
annual: "按年",
annualBadge: "省 {savePercent}%",
billedMonthly: "按月計費",
billedYearly: "按年計費",
```
**es-419.ts**
```ts
monthly: "Mensual",
annual: "Anual",
annualBadge: "Ahorra {savePercent}%",
billedMonthly: "Facturación mensual",
billedYearly: "Facturación anual",
```
**ja.ts**
```ts
monthly: "月額",
annual: "年額",
annualBadge: "{savePercent}% お得",
billedMonthly: "月額請求",
billedYearly: "年額請求",
```
**pt-BR.ts**
```ts
monthly: "Mensal",
annual: "Anual",
annualBadge: "Economize {savePercent}%",
billedMonthly: "Cobrança mensal",
billedYearly: "Cobrança anual",
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/i18n && pnpm build`
Expected: PASS（parity「same key set」+「non-empty」+ 新断言全绿）+ tsc 0

- [ ] **Step 5: Commit**

```bash
git add src/lib/i18n/dictionaries/ src/lib/i18n/__tests__/dictionary-parity.test.ts
git commit -m "i18n: add monthly/annual billing strings (6 locales)"
```

---

## Task 3: ManagedSubscribePanel 两按钮 + 徽标

**Files:**
- Modify: `src/sidepanel/components/ManagedSubscribePanel.tsx`
- Test: `src/sidepanel/components/ManagedSubscribePanel.test.tsx`

`annualOffer` 缺省（年付未开）→ 维持现状单「Subscribe」按钮（既有用例不动）；`annualOffer` 在场 → 月付/年付两按钮，年付 `savePercent` 在则挂徽标。

- [ ] **Step 1: 写失败测试**

`src/sidepanel/components/ManagedSubscribePanel.test.tsx` 内追加：

```ts
  it("annualOffer 在场 → 显示月付/年付两按钮 + 省钱徽标", async () => {
    render(<ManagedSubscribePanel
      onCreated={vi.fn()}
      deps={{
        login: vi.fn(async (): Promise<LoginResult> => ({ apiKey: "sk-v", entitlement: { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [], annualOffer: { savePercent: 20 } } })),
        checkout: vi.fn(async () => {}),
      }}
    />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    await screen.findByRole("button", { name: /monthly/i });
    expect(screen.getByRole("button", { name: /yearly/i })).toBeTruthy();
    expect(screen.getByText(/save 20%/i)).toBeTruthy();
  });

  it("annualOffer 空 {}（无 savePercent）→ 年付按钮在、无徽标", async () => {
    render(<ManagedSubscribePanel
      onCreated={vi.fn()}
      deps={{
        login: vi.fn(async (): Promise<LoginResult> => ({ apiKey: "sk-v", entitlement: { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [], annualOffer: {} } })),
        checkout: vi.fn(async () => {}),
      }}
    />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    await screen.findByRole("button", { name: /yearly/i });
    expect(screen.queryByText(/save/i)).toBeNull();
  });

  it("annualOffer 缺省 → 单 Subscribe 按钮（向后兼容）", async () => {
    render(<ManagedSubscribePanel
      onCreated={vi.fn()}
      deps={{
        login: vi.fn(async (): Promise<LoginResult> => ({ apiKey: "sk-v", entitlement: { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [] } })),
        checkout: vi.fn(async () => {}),
      }}
    />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    await screen.findByRole("button", { name: /subscribe/i });
    expect(screen.queryByRole("button", { name: /yearly/i })).toBeNull();
  });

  it("点年付按钮 → checkout('year')", async () => {
    const checkout = vi.fn(async () => {});
    render(<ManagedSubscribePanel
      onCreated={vi.fn()}
      deps={{
        login: vi.fn(async (): Promise<LoginResult> => ({ apiKey: "sk-v", entitlement: { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [], annualOffer: { savePercent: 20 } } })),
        checkout,
      }}
    />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    fireEvent.click(await screen.findByRole("button", { name: /yearly/i }));
    await waitFor(() => expect(checkout).toHaveBeenCalledWith("sk-v", "year"));
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/ManagedSubscribePanel.test.tsx`
Expected: FAIL（无月付/年付按钮；checkout 仍单参）

- [ ] **Step 3: 实现**

改 checkout dep 类型 + 默认（顶部）：

```ts
export interface ManagedSubscribeDeps {
  login?: () => Promise<LoginResult>;
  refresh?: (apiKey: string) => Promise<LoginResult["entitlement"]>;
  checkout?: (apiKey: string, interval?: "month" | "year") => Promise<void>;
  redeem?: (apiKey: string, code: string) => Promise<Entitlement>;
}
```

```ts
  const checkout = deps?.checkout ?? ((k: string, interval?: "month" | "year") => openCheckout(k, {}, interval));
```

`handleCheckout` 改为接 interval：

```ts
  async function handleCheckout(interval: "month" | "year") {
    if (!session) return;
    setErr(null);
    try {
      await checkout(session.apiKey, interval);
      // Start auto-polling after checkout opens the Stripe tab
      startPolling();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("managed.account.checkoutFailed"));
    }
  }
```

把 JSX 里 `{polling ? (<spinner/>) : (<Button …onClick={handleCheckout}>{t("managed.account.subscribe")}</Button>)}` 整块替换为（spinner 分支不变，仅改非 polling 分支按 annualOffer 分叉）：

```tsx
            {polling ? (
              <div
                role="status"
                aria-live="polite"
                className="flex items-center justify-center gap-2 rounded-control bg-field py-2.5 text-[12px] text-fg-2"
              >
                <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                  <path d="M14 8A6 6 0 1 1 2 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                {t("managed.subscribe.waiting")}
              </div>
            ) : session.entitlement.annualOffer ? (
              <div className="flex flex-col gap-2">
                <Button variant="primary" size="md" fullWidth disabled={busy} onClick={() => handleCheckout("month")}>
                  {t("managed.subscribe.monthly")}
                </Button>
                <Button variant="primary" size="md" fullWidth disabled={busy} onClick={() => handleCheckout("year")}>
                  <span className="inline-flex items-center gap-1.5">
                    {t("managed.subscribe.annual")}
                    {session.entitlement.annualOffer.savePercent != null && (
                      <span className="rounded-full bg-accent/20 px-1.5 py-px text-[11px] font-medium">
                        {t("managed.subscribe.annualBadge", { savePercent: session.entitlement.annualOffer.savePercent })}
                      </span>
                    )}
                  </span>
                </Button>
              </div>
            ) : (
              <Button variant="primary" size="md" fullWidth disabled={busy} onClick={() => handleCheckout("month")}>
                {t("managed.account.subscribe")}
              </Button>
            )}
```

> 既有用例点 `/subscribe/i` 走「annualOffer 缺省」单按钮分支，不受影响；`handleCheckout` 现强制带 interval，旧默认调用变 `handleCheckout("month")`，checkout fake 收到额外参数无害。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/ManagedSubscribePanel.test.tsx && pnpm build`
Expected: PASS（含全部既有用例：already-active、auto-poll、polling 指示、introOffer 徽标、redeem 等）+ tsc 0

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/ManagedSubscribePanel.tsx src/sidepanel/components/ManagedSubscribePanel.test.tsx
git commit -m "feat(paywall): monthly/annual subscribe buttons + annual save badge"
```

---

## Task 4: ManagedAccountPanel 计费周期标签

**Files:**
- Modify: `src/sidepanel/components/ManagedAccountPanel.tsx`
- Test: `src/sidepanel/components/ManagedAccountPanel.test.tsx`

active 且 stripe source 且有 interval → 在续费/取消行附近显示「按月/按年计费」标签；redemption（无 interval）不显示。

- [ ] **Step 1: 写失败测试**

`src/sidepanel/components/ManagedAccountPanel.test.tsx` 内追加（沿用该文件既有 render + deps.refresh 模式；若文件用不同 import，按其现有 import 调整）：

```ts
  it("active stripe + interval=year → 显示「按年计费」", async () => {
    const refresh = vi.fn(async (): Promise<Entitlement> => ({
      plan: "active", email: "u@x.com",
      subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false, source: "stripe", interval: "year" },
      quota: { weekly: { usedFraction: 0, resetAt: 1750400000 } }, models: [],
    }));
    render(<ManagedAccountPanel apiKey="sk-acc-y" deps={{ refresh }} />);
    expect(await screen.findByText(/billed yearly/i)).toBeTruthy();
  });

  it("active stripe + interval=month → 显示「按月计费」", async () => {
    const refresh = vi.fn(async (): Promise<Entitlement> => ({
      plan: "active", email: "u@x.com",
      subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false, source: "stripe", interval: "month" },
      quota: { weekly: { usedFraction: 0, resetAt: 1750400000 } }, models: [],
    }));
    render(<ManagedAccountPanel apiKey="sk-acc-m" deps={{ refresh }} />);
    expect(await screen.findByText(/billed monthly/i)).toBeTruthy();
  });

  it("redemption（无 interval）→ 不显示计费周期标签", async () => {
    const refresh = vi.fn(async (): Promise<Entitlement> => ({
      plan: "active", email: "u@x.com",
      subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: true, source: "redemption" },
      quota: { weekly: { usedFraction: 0, resetAt: 1750400000 } }, models: [],
    }));
    render(<ManagedAccountPanel apiKey="sk-acc-r" deps={{ refresh }} />);
    await screen.findByText(/active via code/i); // 等渲染完成（redeemedUntil 文案）
    expect(screen.queryByText(/billed/i)).toBeNull();
  });
```

> 若 `ManagedAccountPanel.test.tsx` 顶部未 import `Entitlement`，加 `import type { Entitlement } from "@/lib/managed-auth";`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/sidepanel/components/ManagedAccountPanel.test.tsx`
Expected: FAIL（无 billed monthly/yearly 文案）

- [ ] **Step 3: 实现**

`src/sidepanel/components/ManagedAccountPanel.tsx`：在 `const periodDate = …` 下方加派生值：

```ts
  const intervalLabel = isActive && !isRedemption && sub?.interval
    ? sub.interval === "year" ? t("managed.account.billedYearly") : t("managed.account.billedMonthly")
    : null;
```

在 headline 那块、`{ent.email}` 行之后、`{isActive && periodDate && (…)}` 之前插入标签：

```tsx
          {intervalLabel && (
            <div className="pt-0.5">
              <span className="rounded-full bg-field px-1.5 py-px font-mono text-[10px] text-fg-2">{intervalLabel}</span>
            </div>
          )}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/sidepanel/components/ManagedAccountPanel.test.tsx && pnpm build`
Expected: PASS（既有账户面板用例不回归）+ tsc 0

- [ ] **Step 5: 全量门禁 + Commit**

Run: `pnpm test && pnpm build`
Expected: 全绿 + 构建成功

```bash
git add src/sidepanel/components/ManagedAccountPanel.tsx src/sidepanel/components/ManagedAccountPanel.test.tsx
git commit -m "feat(account): show billing interval label for stripe subscriptions"
```

---

## Self-Review（写计划后自查）

- **Spec 覆盖**：§5.1 类型+normalize+openCheckout→T1；§5.4 i18n→T2；§5.2 paywall→T3；§5.3 账户面板→T4。✓
- **类型一致**：`SubscriptionInfo.interval`、`Entitlement.annualOffer`（managed-auth.ts）与 normalize（managed-account.ts）、组件读取处同名同形；i18n 键 `managed.subscribe.{monthly,annual,annualBadge}`、`managed.account.{billedMonthly,billedYearly}` 在 T2 定义、T3/T4 引用一致。✓
- **向后兼容**：`annualOffer` 缺省→单按钮（既有 ManagedSubscribePanel 用例不动）；`openCheckout` 不传 interval→无 body（既有 managed-account 用例不动）；`normalizeAnnualOffer` 保留空 `{}`（不照搬 introOffer 缺值即丢）。✓
- **无占位符**：每步含完整代码/命令/预期；6 语取值全列。✓
- **依赖顺序**：T1（类型）→T2（文案）→T3/T4（组件，依赖前两者）。✓
