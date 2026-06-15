# P3-C 兑换码兑换订阅 — 客户端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Pie 扩展侧栏让用户输入兑换码换取订阅：契约 v2.3 的 `subscription.source` 透传 + `/redeem` API + 复用式 `RedeemCodeForm` 输入框（plan:none 的 Subscribe 面板 + plan:active 的 redemption 账户面板）+ redemption 来源专属渲染（隐藏"管理订阅"、显示"兑换激活，有效期至 X"）+ 6 语 i18n。

**Architecture:** 纯客户端、BYOK 之外的 managed 分支。后端是事实源；客户端只透传 `source`、调 `/redeem`、按 `source` 切渲染。兑换成功后端直接回新鲜 entitlement（无需轮询，区别于 Stripe checkout）。

**Tech Stack:** React 19 + TS · Vite + @crxjs · vitest + @testing-library/react · 自研 i18n（`@/lib/i18n`，`useI18n()`/`t(key,params)`，6 locale，`satisfies Translations<EnDict>` + dictionary-parity 测试）。

**前置（重要）：** 后端 P3-C 必须先合并部署（`/redeem` 端点 + 契约 v2.3 上线），客户端才能联调。**worktree 基于 `origin/main`（已含 #192；本地 main 落后 origin ~21 且有 2 条未推送 HITL docs，勿基于本地 main）**。

**权威契约/spec：** 工作区根 `docs/brainstorming/2026-06-15-managed-provider-p3c-redemption-codes-design.md` · `pie-managed-backend/docs/contract.md`（v2.3）。

---

## 约定 & 命令

- 工作目录 `pie-ai-agent`。测试 `pnpm test`，单文件 `pnpm test src/lib/managed-account.test.ts`。构建 `pnpm build`（构建期不变量在 tool-names.ts/tools.ts 会 throw）。
- i18n：`en` 是权威 `EnDict`；其余 5 个 locale `satisfies Translations<EnDict>`；新增 key 必须 6 个字典同步加，否则 dictionary-parity 测试红。`t(key, params)` 用 `{name}` 插值。
- 组件测试不套 `I18nProvider` 时，`useI18n()` 回退英文 `makeT("en")`，故断言用英文文案。
- worktree：在 `pie-ai-agent` 仓 `git worktree add .claude/worktrees/managed-p3c-client -b worktree-managed-p3c-client origin/main`（`.claude/worktrees` 已 gitignore）。
- 客户端 main 有 ruleset（需 1 approve）：走 push→PR，owner 在 GitHub UI 合，**助手不自合**。

## 文件结构（决策锁定）

**新建：**
- `src/sidepanel/components/RedeemCodeForm.tsx` — 复用式兑换输入框（input + 按钮 + 行内错误），两面板共用。
- `src/sidepanel/components/RedeemCodeForm.test.tsx`。

**修改：**
- `src/lib/managed-auth.ts` — `SubscriptionInfo` 加 `source`。
- `src/lib/managed-account.ts` — `normalizeSubscription`（默认 `source:'stripe'`）接入 `normalizeEntitlement`；新增 `redeem()` + `RedeemError`。
- `src/lib/managed-account.test.ts` — 补 source 断言 + redeem 用例。
- `src/lib/i18n/dictionaries/{en,zh-CN,zh-TW,es-419,ja,pt-BR}.ts` — `managed.redeem` 块 + `managed.account.redeemedUntil`。
- `src/sidepanel/components/ManagedSubscribePanel.tsx`（+ `.test.tsx`）— 登录后内嵌 `RedeemCodeForm`。
- `src/sidepanel/components/ManagedAccountPanel.tsx`（+ `.test.tsx`）— redemption 来源专属渲染 + 内嵌 `RedeemCodeForm`；既有 fixture 补 `source`。

---

## Task 1: `SubscriptionInfo.source` 类型 + normalize 透传

**Files:**
- Modify: `src/lib/managed-auth.ts`
- Modify: `src/lib/managed-account.ts`
- Test: `src/lib/managed-account.test.ts`

- [ ] **Step 1: 改既有测试加 source 断言（先让它失败）**

`src/lib/managed-account.test.ts`：第一个用例的 `v2.subscription` 加 `source: "stripe"`：
```ts
      subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false, source: "stripe" },
```
并在该文件末尾加：
```ts
  it("normalizeEntitlement 给 subscription 补 source 默认 stripe（后端漏发时）", async () => {
    const raw = { plan: "active", email: "u@x.com", subscription: { planName: "Pie Pro", currentPeriodEnd: 1, cancelAtPeriodEnd: false }, quota: null, models: [] };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => raw })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-src1", { fetchFn, locale: "en" });
    expect(res.subscription).toEqual({ planName: "Pie Pro", currentPeriodEnd: 1, cancelAtPeriodEnd: false, source: "stripe" });
  });

  it("normalizeEntitlement 透传 source=redemption + cancelAtPeriodEnd", async () => {
    const raw = { plan: "active", email: "u@x.com", subscription: { planName: "Pie Pro", currentPeriodEnd: 9, cancelAtPeriodEnd: true, source: "redemption" }, quota: null, models: [] };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => raw })) as unknown as typeof fetch;
    const res = await getEntitlement("sk-src2", { fetchFn, locale: "en" });
    expect(res.subscription).toMatchObject({ source: "redemption", cancelAtPeriodEnd: true });
  });
```

- [ ] **Step 2: 跑失败**

Run: `pnpm test src/lib/managed-account.test.ts`
Expected: FAIL（旧 `toEqual(v2)` 缺 source / 新用例 source 未透传）

- [ ] **Step 3: 实现类型 + normalize**

`src/lib/managed-auth.ts` 的 `SubscriptionInfo` 加 `source`：
```ts
export interface SubscriptionInfo {
  planName: string;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  /** 当前驱动 active 的来源：stripe（付费订阅，可开 portal）/ redemption（兑换码，无账单可管）。 */
  source: "stripe" | "redemption";
}
```

`src/lib/managed-account.ts` 加 `normalizeSubscription` 并接入 `normalizeEntitlement`：
```ts
function normalizeSubscription(raw: unknown): Entitlement["subscription"] {
  if (raw == null || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  return {
    planName: typeof s.planName === "string" && s.planName ? s.planName : "Pie",
    currentPeriodEnd: typeof s.currentPeriodEnd === "number" ? s.currentPeriodEnd : null,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd === true,
    source: s.source === "redemption" ? "redemption" : "stripe",
  };
}
```
把 `normalizeEntitlement` 里的 `subscription: (r.subscription as Entitlement["subscription"]) ?? null,` 改为：
```ts
    subscription: normalizeSubscription(r.subscription),
```

- [ ] **Step 4: 跑通过**

Run: `pnpm test src/lib/managed-account.test.ts`
Expected: PASS

- [ ] **Step 5: 修其它引用 subscription 形状的测试（tsc/测试驱动）**

Run: `pnpm test && pnpm build`
Expected: 若 `ManagedAccountPanel.test.tsx`、`managed-auth.test.ts` 等的 fixture `subscription` 缺 `source` 报错/失败，给它们的 `subscription` 字面量补 `source: "stripe"`（Task 6 会再动 ManagedAccountPanel.test.tsx，这里先让全绿）。tsc 0 错。

- [ ] **Step 6: Commit**

```bash
git add src/lib/managed-auth.ts src/lib/managed-account.ts src/lib/managed-account.test.ts
git commit -m "feat(managed): SubscriptionInfo.source (v2.3) + normalizeSubscription default stripe"
```

---

## Task 2: `redeem()` API + `RedeemError`

**Files:**
- Modify: `src/lib/managed-account.ts`
- Test: `src/lib/managed-account.test.ts`

- [ ] **Step 1: 写失败测试** — `src/lib/managed-account.test.ts` 末尾加（顶部 import 补 `redeem, RedeemError`）：

```ts
  it("redeem POSTs /redeem?locale= with Bearer + {code}, 解析并缓存 entitlement", async () => {
    const ent = { plan: "active", email: "u@x.com", subscription: { planName: "Pie Pro", currentPeriodEnd: 9, cancelAtPeriodEnd: true, source: "redemption" }, quota: null, models: [] };
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ent })) as unknown as typeof fetch;
    const res = await redeem("sk-r", "PIE-AAAAA-BBBBB-CCCCC", { fetchFn, locale: "en" });
    expect(fetchFn).toHaveBeenCalledWith("https://account.pie.chat/redeem?locale=en", {
      method: "POST",
      headers: { authorization: "Bearer sk-r", "content-type": "application/json" },
      body: JSON.stringify({ code: "PIE-AAAAA-BBBBB-CCCCC" }),
    });
    expect(res.subscription?.source).toBe("redemption");
    expect(getCachedEntitlement("sk-r")).toEqual(res);
  });

  it("redeem 非 2xx → 抛 RedeemError 带后端 error code 与 status", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: "code_already_redeemed" }) })) as unknown as typeof fetch;
    await expect(redeem("sk-r2", "X", { fetchFn })).rejects.toMatchObject({ code: "code_already_redeemed", status: 409 });
  });

  it("redeem 错误体不可解析 → RedeemError code=redeem_failed", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500, json: async () => { throw new Error("no json"); } })) as unknown as typeof fetch;
    await expect(redeem("sk-r3", "X", { fetchFn })).rejects.toMatchObject({ code: "redeem_failed", status: 500 });
  });
```

- [ ] **Step 2: 跑失败**

Run: `pnpm test src/lib/managed-account.test.ts`
Expected: FAIL（`redeem`/`RedeemError` 未导出）

- [ ] **Step 3: 实现** — `src/lib/managed-account.ts` 加：

```ts
/** /redeem 失败：携带后端 error code（code_not_found / code_already_redeemed / code_expired / too_many_attempts / …）。 */
export class RedeemError extends Error {
  constructor(public code: string, public status: number) {
    super(code);
    this.name = "RedeemError";
  }
}

/** 兑换码兑换订阅。成功回新鲜 entitlement（已归一化并写入缓存）；失败抛 RedeemError。 */
export async function redeem(apiKey: string, code: string, deps: ManagedAccountDeps = {}): Promise<Entitlement> {
  const fetchFn = deps.fetchFn ?? fetch;
  const locale = deps.locale ?? getLocale();
  const resp = await fetchFn(`${ACCOUNT_BASE}/redeem?locale=${encodeURIComponent(locale)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!resp.ok) {
    let errCode = "redeem_failed";
    try {
      const b = (await resp.json()) as { error?: string };
      if (b && typeof b.error === "string") errCode = b.error;
    } catch {
      /* 非 JSON 错误体：保留 redeem_failed */
    }
    throw new RedeemError(errCode, resp.status);
  }
  const ent = normalizeEntitlement(await resp.json());
  entitlementCache.set(apiKey, ent);
  return ent;
}
```

- [ ] **Step 4: 跑通过**

Run: `pnpm test src/lib/managed-account.test.ts && pnpm build`
Expected: PASS，tsc 0 错。

- [ ] **Step 5: Commit**

```bash
git add src/lib/managed-account.ts src/lib/managed-account.test.ts
git commit -m "feat(managed): redeem() API + RedeemError carrying backend error code"
```

---

## Task 3: i18n — `managed.redeem` 块 + `account.redeemedUntil`（6 语）

**Files:**
- Modify: `src/lib/i18n/dictionaries/en.ts`（权威）+ `zh-CN.ts` + `zh-TW.ts` + `es-419.ts` + `ja.ts` + `pt-BR.ts`
- Test: i18n dictionary-parity 测试（既有）会校验 6 字典 key 一致

- [ ] **Step 1: en.ts 加 key（权威）**

`managed.account` 块加一行：
```ts
      redeemedUntil: "Active via code · until {date}",
```
`managed` 下加 `redeem` 块（放在 `subscribe` 块后）：
```ts
    redeem: {
      label: "Have a redemption code?",
      placeholder: "PIE-XXXXX-XXXXX-XXXXX",
      button: "Redeem",
      redeeming: "Redeeming…",
      errNotFound: "Invalid redemption code.",
      errUsed: "This code has already been used.",
      errExpired: "This code has expired.",
      errRateLimited: "Too many attempts. Please try again later.",
      errFailed: "Couldn't redeem the code. Please try again.",
    },
```

- [ ] **Step 2: 其余 5 语补同结构 key（译文如下）**

`zh-CN.ts`：
```ts
      redeemedUntil: "兑换激活 · 有效期至 {date}",
```
```ts
    redeem: {
      label: "有兑换码？",
      placeholder: "PIE-XXXXX-XXXXX-XXXXX",
      button: "兑换",
      redeeming: "兑换中…",
      errNotFound: "兑换码无效。",
      errUsed: "该兑换码已被使用。",
      errExpired: "该兑换码已过期。",
      errRateLimited: "尝试过于频繁，请稍后再试。",
      errFailed: "兑换失败，请重试。",
    },
```
`zh-TW.ts`：
```ts
      redeemedUntil: "兌換啟用 · 有效期至 {date}",
```
```ts
    redeem: {
      label: "有兌換碼？",
      placeholder: "PIE-XXXXX-XXXXX-XXXXX",
      button: "兌換",
      redeeming: "兌換中…",
      errNotFound: "兌換碼無效。",
      errUsed: "此兌換碼已被使用。",
      errExpired: "此兌換碼已過期。",
      errRateLimited: "嘗試過於頻繁，請稍後再試。",
      errFailed: "兌換失敗，請重試。",
    },
```
`es-419.ts`：
```ts
      redeemedUntil: "Activo por código · hasta {date}",
```
```ts
    redeem: {
      label: "¿Tienes un código de canje?",
      placeholder: "PIE-XXXXX-XXXXX-XXXXX",
      button: "Canjear",
      redeeming: "Canjeando…",
      errNotFound: "Código de canje no válido.",
      errUsed: "Este código ya se usó.",
      errExpired: "Este código ha caducado.",
      errRateLimited: "Demasiados intentos. Inténtalo más tarde.",
      errFailed: "No se pudo canjear el código. Inténtalo de nuevo.",
    },
```
`ja.ts`：
```ts
      redeemedUntil: "コードで有効 · {date} まで",
```
```ts
    redeem: {
      label: "引き換えコードをお持ちですか？",
      placeholder: "PIE-XXXXX-XXXXX-XXXXX",
      button: "引き換える",
      redeeming: "引き換え中…",
      errNotFound: "引き換えコードが無効です。",
      errUsed: "このコードはすでに使用されています。",
      errExpired: "このコードは有効期限が切れています。",
      errRateLimited: "試行回数が多すぎます。しばらくしてからお試しください。",
      errFailed: "コードを引き換えできませんでした。もう一度お試しください。",
    },
```
`pt-BR.ts`：
```ts
      redeemedUntil: "Ativo por código · até {date}",
```
```ts
    redeem: {
      label: "Tem um código de resgate?",
      placeholder: "PIE-XXXXX-XXXXX-XXXXX",
      button: "Resgatar",
      redeeming: "Resgatando…",
      errNotFound: "Código de resgate inválido.",
      errUsed: "Este código já foi usado.",
      errExpired: "Este código expirou.",
      errRateLimited: "Muitas tentativas. Tente novamente mais tarde.",
      errFailed: "Não foi possível resgatar o código. Tente novamente.",
    },
```

- [ ] **Step 3: 跑 parity + 全量**

Run: `pnpm test src/lib/i18n && pnpm build`
Expected: dictionary-parity PASS（6 字典 key 全等），tsc 0 错（每个 locale 仍 `satisfies Translations<EnDict>`）。

- [ ] **Step 4: Commit**

```bash
git add src/lib/i18n/dictionaries
git commit -m "i18n(managed): redeem block + account.redeemedUntil (6 locales)"
```

---

## Task 4: `RedeemCodeForm` 复用组件

**Files:**
- Create: `src/sidepanel/components/RedeemCodeForm.tsx`
- Test: `src/sidepanel/components/RedeemCodeForm.test.tsx`

- [ ] **Step 1: 写失败测试** — 新建 `src/sidepanel/components/RedeemCodeForm.test.tsx`：

```tsx
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import RedeemCodeForm from "./RedeemCodeForm";
import { RedeemError } from "@/lib/managed-account";
import type { Entitlement } from "@/lib/managed-auth";

afterEach(() => cleanup());

const activeRedemption: Entitlement = {
  plan: "active", email: "u@x.com",
  subscription: { planName: "Pie Pro", currentPeriodEnd: 9, cancelAtPeriodEnd: true, source: "redemption" },
  quota: null, models: [],
};

describe("RedeemCodeForm", () => {
  it("输入码 + 兑换成功 → 调 redeem 并回调 onRedeemed", async () => {
    const redeem = vi.fn(async () => activeRedemption);
    const onRedeemed = vi.fn();
    render(<RedeemCodeForm apiKey="sk-v" onRedeemed={onRedeemed} deps={{ redeem }} />);
    fireEvent.change(screen.getByPlaceholderText(/PIE-/), { target: { value: " pie-aaaaa-bbbbb-ccccc " } });
    fireEvent.click(screen.getByRole("button", { name: /redeem/i }));
    await waitFor(() => expect(onRedeemed).toHaveBeenCalledWith(activeRedemption));
    expect(redeem).toHaveBeenCalledWith("sk-v", "pie-aaaaa-bbbbb-ccccc"); // trim
  });

  it("空输入时按钮禁用、不调用", () => {
    const redeem = vi.fn();
    render(<RedeemCodeForm apiKey="sk-v" onRedeemed={vi.fn()} deps={{ redeem }} />);
    const btn = screen.getByRole("button", { name: /redeem/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("RedeemError(code_already_redeemed) → 显示本地化错误、不回调", async () => {
    const redeem = vi.fn(async () => { throw new RedeemError("code_already_redeemed", 409); });
    const onRedeemed = vi.fn();
    render(<RedeemCodeForm apiKey="sk-v" onRedeemed={onRedeemed} deps={{ redeem }} />);
    fireEvent.change(screen.getByPlaceholderText(/PIE-/), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: /redeem/i }));
    expect(await screen.findByText(/already been used/i)).toBeTruthy();
    expect(onRedeemed).not.toHaveBeenCalled();
  });

  it("RedeemError(code_not_found) → Invalid redemption code", async () => {
    const redeem = vi.fn(async () => { throw new RedeemError("code_not_found", 404); });
    render(<RedeemCodeForm apiKey="sk-v" onRedeemed={vi.fn()} deps={{ redeem }} />);
    fireEvent.change(screen.getByPlaceholderText(/PIE-/), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: /redeem/i }));
    expect(await screen.findByText(/invalid redemption code/i)).toBeTruthy();
  });

  it("未知错误 → 通用失败文案", async () => {
    const redeem = vi.fn(async () => { throw new Error("network"); });
    render(<RedeemCodeForm apiKey="sk-v" onRedeemed={vi.fn()} deps={{ redeem }} />);
    fireEvent.change(screen.getByPlaceholderText(/PIE-/), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: /redeem/i }));
    expect(await screen.findByText(/couldn't redeem/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑失败**

Run: `pnpm test src/sidepanel/components/RedeemCodeForm.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现** — 新建 `src/sidepanel/components/RedeemCodeForm.tsx`：

```tsx
import { useState } from "react";
import { redeem as redeemApi, RedeemError } from "@/lib/managed-account";
import type { Entitlement } from "@/lib/managed-auth";
import { useI18n } from "@/lib/i18n";

export interface RedeemCodeFormDeps {
  redeem?: (apiKey: string, code: string) => Promise<Entitlement>;
}
interface Props {
  apiKey: string;
  /** 兑换成功后回调（已是新鲜 entitlement）。 */
  onRedeemed: (ent: Entitlement) => void;
  deps?: RedeemCodeFormDeps;
}

/** RedeemError code → i18n key。 */
function errKey(e: unknown): string {
  if (e instanceof RedeemError) {
    switch (e.code) {
      case "code_not_found": return "managed.redeem.errNotFound";
      case "code_already_redeemed": return "managed.redeem.errUsed";
      case "code_expired": return "managed.redeem.errExpired";
      case "too_many_attempts": return "managed.redeem.errRateLimited";
      default: return "managed.redeem.errFailed";
    }
  }
  return "managed.redeem.errFailed";
}

export default function RedeemCodeForm({ apiKey, onRedeemed, deps }: Props) {
  const { t } = useI18n();
  const doRedeem = deps?.redeem ?? ((k: string, c: string) => redeemApi(k, c));
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    const trimmed = code.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const ent = await doRedeem(apiKey, trimmed);
      setCode("");
      onRedeemed(ent);
    } catch (e) {
      setErr(t(errKey(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[12px] text-fg-3">{t("managed.redeem.label")}</label>
      <div className="flex gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={t("managed.redeem.placeholder")}
          className="h-9 flex-1 rounded-[10px] border border-line bg-field px-3 font-mono text-[12px] uppercase placeholder:normal-case placeholder:text-fg-3"
        />
        <button
          type="button"
          disabled={busy || !code.trim()}
          onClick={submit}
          className="h-9 shrink-0 rounded-[10px] border border-line px-3 text-[12px] text-fg-2 disabled:opacity-40"
        >
          {busy ? t("managed.redeem.redeeming") : t("managed.redeem.button")}
        </button>
      </div>
      {err && <div className="text-[12px] text-warning">{err}</div>}
    </div>
  );
}
```

- [ ] **Step 4: 跑通过**

Run: `pnpm test src/sidepanel/components/RedeemCodeForm.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/RedeemCodeForm.tsx src/sidepanel/components/RedeemCodeForm.test.tsx
git commit -m "feat(sidepanel): RedeemCodeForm reusable redeem input"
```

---

## Task 5: ManagedSubscribePanel 内嵌 RedeemCodeForm

**Files:**
- Modify: `src/sidepanel/components/ManagedSubscribePanel.tsx`
- Test: `src/sidepanel/components/ManagedSubscribePanel.test.tsx`

- [ ] **Step 1: 写失败测试** — `src/sidepanel/components/ManagedSubscribePanel.test.tsx` 加（顶部按需 import）：

```ts
  it("登录后（plan:none）显示兑换输入框；兑换成功转 active → onCreated", async () => {
    const login = vi.fn(async (): Promise<LoginResult> => ({
      apiKey: "sk-v",
      entitlement: { plan: "none", email: "u@x.com", subscription: null, quota: null, models: [] },
    }));
    const activeEnt = { plan: "active", email: "u@x.com", subscription: { planName: "Pie Pro", currentPeriodEnd: 9, cancelAtPeriodEnd: true, source: "redemption" as const }, quota: null, models: [] };
    const redeem = vi.fn(async () => activeEnt);
    const onCreated = vi.fn();
    render(<ManagedSubscribePanel onCreated={onCreated} deps={{ login, checkout: vi.fn(async () => {}), redeem }} />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    await screen.findByRole("button", { name: /^subscribe$/i });
    fireEvent.change(screen.getByPlaceholderText(/PIE-/), { target: { value: "PIE-AAAAA-BBBBB-CCCCC" } });
    fireEvent.click(screen.getByRole("button", { name: /^redeem$/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("sk-v", "u@x.com"));
  });
```
（确保 import 含 `waitFor`。）

- [ ] **Step 2: 跑失败**

Run: `pnpm test src/sidepanel/components/ManagedSubscribePanel.test.tsx`
Expected: FAIL（无兑换输入框）

- [ ] **Step 3: 实现** — `ManagedSubscribePanel.tsx`：

import 加：
```ts
import RedeemCodeForm from "./RedeemCodeForm";
import type { Entitlement } from "@/lib/managed-auth";
```
`ManagedSubscribeDeps` 加：
```ts
  redeem?: (apiKey: string, code: string) => Promise<Entitlement>;
```
在 session 块里、`refresh` 按钮之后（`{err && ...}` 之前）插入：
```tsx
          <div className="border-t border-line pt-2.5">
            <RedeemCodeForm
              apiKey={session.apiKey}
              onRedeemed={(ent) => {
                if (ent.plan === "active") {
                  stopPolling();
                  onCreated(session.apiKey, ent.email);
                } else {
                  setSession({ ...session, entitlement: ent });
                }
              }}
              deps={deps?.redeem ? { redeem: deps.redeem } : undefined}
            />
          </div>
```

- [ ] **Step 4: 跑通过**

Run: `pnpm test src/sidepanel/components/ManagedSubscribePanel.test.tsx`
Expected: PASS（既有用例不受影响 + 新用例）

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/ManagedSubscribePanel.tsx src/sidepanel/components/ManagedSubscribePanel.test.tsx
git commit -m "feat(sidepanel): embed RedeemCodeForm in ManagedSubscribePanel (plan:none)"
```

---

## Task 6: ManagedAccountPanel — redemption 来源专属渲染

**Files:**
- Modify: `src/sidepanel/components/ManagedAccountPanel.tsx`
- Test: `src/sidepanel/components/ManagedAccountPanel.test.tsx`

- [ ] **Step 1: 先给既有 fixture 补 source（Task 1 后应已补；若未补在此补）+ 写新失败测试**

`ManagedAccountPanel.test.tsx` 的 `active` fixture 与 `blocked` 用例的 `subscription` 补 `source: "stripe"`：
```ts
  subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: false, source: "stripe" },
```
加新用例：
```ts
  it("redemption 来源：隐藏'管理订阅'、显示兑换有效期、显示兑换输入框", async () => {
    const portal = vi.fn(async () => {});
    const ent: Entitlement = {
      plan: "active", email: "u@x.com",
      subscription: { planName: "Pie Pro", currentPeriodEnd: 1750000000, cancelAtPeriodEnd: true, source: "redemption" },
      quota: { weekly: { usedFraction: 0.2, resetAt: 1750400000 } }, models: [],
    };
    render(<ManagedAccountPanel apiKey="sk-v" deps={{ refresh: vi.fn(async () => ent), portal }} />);
    expect(await screen.findByText(/Active via code/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /manage subscription/i })).toBeNull();
    expect(screen.queryByText(/^Cancels /)).toBeNull(); // 不复用 cancels 文案
    expect(screen.getByPlaceholderText(/PIE-/)).toBeTruthy(); // 可再兑换延期
  });

  it("redemption 再兑换成功 → 刷新展示（不再调 portal）", async () => {
    const ext: Entitlement = {
      plan: "active", email: "u@x.com",
      subscription: { planName: "Pie Pro", currentPeriodEnd: 1760000000, cancelAtPeriodEnd: true, source: "redemption" },
      quota: null, models: [],
    };
    const start: Entitlement = { ...ext, subscription: { ...ext.subscription!, currentPeriodEnd: 1750000000 } };
    const redeem = vi.fn(async () => ext);
    render(<ManagedAccountPanel apiKey="sk-v" deps={{ refresh: vi.fn(async () => start), redeem }} />);
    await screen.findByText(/Active via code/i);
    fireEvent.change(screen.getByPlaceholderText(/PIE-/), { target: { value: "PIE-AAAAA-BBBBB-CCCCC" } });
    fireEvent.click(screen.getByRole("button", { name: /^redeem$/i }));
    await waitFor(() => expect(redeem).toHaveBeenCalledWith("sk-v", "PIE-AAAAA-BBBBB-CCCCC"));
  });
```
（import 补 `fireEvent, waitFor`。）

- [ ] **Step 2: 跑失败**

Run: `pnpm test src/sidepanel/components/ManagedAccountPanel.test.tsx`
Expected: FAIL（仍显示 Manage / 无兑换有效期 / 无输入框）

- [ ] **Step 3: 实现** — `ManagedAccountPanel.tsx`：

import 加：
```ts
import RedeemCodeForm from "./RedeemCodeForm";
```
`ManagedAccountDeps` 加：
```ts
  redeem?: (apiKey: string, code: string) => Promise<Entitlement>;
```
组件内 `const redeem = deps?.redeem;`（默认走 RedeemCodeForm 内部默认）；并算来源：
```ts
  const isRedemption = isActive && sub?.source === "redemption";
```
**日期行**：把现有 `isActive && periodDate && (cancelAtPeriodEnd ? Cancels : Renews)` 块改为优先判 redemption：
```tsx
          {isActive && periodDate && (
            isRedemption ? (
              <div className="pt-0.5 text-[12px] text-fg-2">{t("managed.account.redeemedUntil", { date: periodDate })}</div>
            ) : sub?.cancelAtPeriodEnd ? (
              <div className="flex items-center gap-2 pt-0.5">
                <span className="text-[12px] text-fg-2">{t("managed.account.cancels", { date: periodDate })}</span>
                <span className="rounded-full bg-field px-1.5 py-px font-mono text-[10px] text-fg-2">{t("managed.account.wontRenew")}</span>
              </div>
            ) : (
              <div className="pt-0.5 text-[12px] text-fg-2">{t("managed.account.renews", { date: periodDate })}</div>
            )
          )}
```
**主按钮 / 兑换输入**：把底部按钮行改为——redemption 时不渲染 portal 主按钮、改渲染 `RedeemCodeForm`（仍保留 refresh）：
```tsx
      {isRedemption ? (
        <RedeemCodeForm apiKey={apiKey} onRedeemed={(e) => setEnt(e)} deps={redeem ? { redeem } : undefined} />
      ) : null}

      <div className="flex items-center gap-2 pt-0.5">
        {!isRedemption && (
          <button type="button" onClick={primary.on}
            className="h-9 rounded-[10px] bg-fg-1 px-4 text-[13px] font-semibold text-canvas transition-opacity hover:opacity-90 active:opacity-80">{primary.label}</button>
        )}
        <div className="flex-1" />
        <button type="button" onClick={load}
          className="h-9 px-2 text-[13px] text-fg-2 hover:text-fg-1">{t("managed.account.refresh")}</button>
      </div>
```
（`primary` 在 redemption 分支不会被用到；其定义保持不变，TS 无未用告警因仍在非 redemption 分支引用。）

- [ ] **Step 4: 跑通过**

Run: `pnpm test src/sidepanel/components/ManagedAccountPanel.test.tsx`
Expected: PASS（既有 stripe/blocked/none 用例 + 新 redemption 用例）

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/ManagedAccountPanel.tsx src/sidepanel/components/ManagedAccountPanel.test.tsx
git commit -m "feat(sidepanel): redemption-source rendering in ManagedAccountPanel (hide manage, show validity, embed redeem)"
```

---

## Task 7: 全量门禁 + 客户端 CLAUDE.md 备注

**Files:**
- Modify: `pie-ai-agent/CLAUDE.md`（managed provider 段补一句兑换码）

- [ ] **Step 1: CLAUDE.md 备注**

在 pie-ai-agent `CLAUDE.md` 的 managed provider 相关段落补一句：兑换码——`/redeem` + `subscription.source`（stripe/redemption）；redemption 来源隐藏 portal、显示 `redeemedUntil`、可经 `RedeemCodeForm` 再兑换延期；契约 v2.3。

- [ ] **Step 2: 全量回归 + 构建**

Run: `pnpm test && pnpm build`
Expected: 全量绿（含 dictionary-parity）+ 构建成功（tool-names/tools 不变量不 throw）。

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): note redemption codes (v2.3 source + RedeemCodeForm)"
```

---

## 完成后

跑最终 `pnpm test && pnpm build` 全绿后，用 `superpowers:finishing-a-development-branch`（PR 路径，owner 在 GitHub UI 合，助手不自合）。

ship 前端到端实测（需后端 P3-C 已部署 + 后端用 `gen-codes` 生成测试码）：
- plan:none 用户登录 → 输入码 → 即时转 active（source=redemption）、账户面板显示"兑换激活，有效期至 X"、无"管理订阅"按钮。
- redemption 用户再兑换一张码 → 有效期延长。
- 到期后回落 none（后端 reconcile）→ 面板回到订阅 CTA。
- Stripe 在保用户兑换（后端 trial_end 顺延）→ 客户端仍显示 source=stripe、续费日顺延。
