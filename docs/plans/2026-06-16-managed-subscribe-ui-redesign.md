# Managed Subscribe UI Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `ManagedSubscribePanel`'s sign-in and subscribe screens up to the polished `ManagedAccountPanel` design language — token-driven `Button`s, shared StatusPill, official Google G, collapsible redeem, fully i18n'd.

**Architecture:** Presentation + i18n only; auth/checkout/poll/redeem logic is untouched. Extract the existing `StatusPill` into a shared component and reuse it. Add a multicolor `GoogleGlyph`. Give `RedeemCodeForm` an opt-in `collapsible` mode. Rewrite the two `ManagedSubscribePanel` branches against the shared shell, reusing `managed.account.*` keys where the wording is identical.

**Tech Stack:** React 19 + TS, TailwindCSS v4 (token classes), vitest + @testing-library/react + happy-dom, existing `Button` / `Collapse` / `motion` UI primitives, `useI18n`.

**Spec:** `docs/specs/2026-06-16-managed-subscribe-ui-redesign.md`

**Reference tokens (do not invent values):** card `rounded-[14px] border border-line bg-surface p-3.5`; caps header `caps text-fg-3`; headline `text-[16px] font-semibold tracking-[-0.01em] text-fg-1`; email `font-mono text-[12px] text-fg-2`; body `text-[12px] leading-[17px] text-fg-2`; control radius `rounded-control` (10px); `Button` variants `primary` (`bg-fg-1 text-canvas`) / `ghost`.

---

## File Structure

- **Create** `src/sidepanel/components/ManagedStatusPill.tsx` — the dot+label pill, shared by account + subscribe panels.
- **Create** `src/sidepanel/components/ManagedStatusPill.test.tsx`.
- **Modify** `src/sidepanel/components/icons.tsx` — add multicolor `GoogleGlyph` (brand exception; not `currentColor`) + a `SparkGlyph` + `ChevronGlyph` (currentColor).
- **Modify** `src/sidepanel/components/ManagedAccountPanel.tsx` — delete inline `StatusPill`, import the shared one. (Pure refactor, no visual change.)
- **Modify** all 6 dictionaries under `src/lib/i18n/dictionaries/` — add `managed.subscribe.*` keys.
- **Modify** `src/sidepanel/components/RedeemCodeForm.tsx` — add `collapsible?: boolean`.
- **Modify** `src/sidepanel/components/RedeemCodeForm.test.tsx` — add collapsible-mode tests.
- **Modify** `src/sidepanel/components/ManagedSubscribePanel.tsx` — rewrite both branches.
- **Modify** `src/sidepanel/components/ManagedSubscribePanel.test.tsx` — expand redeem before asserting on it.

---

## Task 1: Extract shared `ManagedStatusPill`

**Files:**
- Create: `src/sidepanel/components/ManagedStatusPill.tsx`
- Create: `src/sidepanel/components/ManagedStatusPill.test.tsx`
- Modify: `src/sidepanel/components/ManagedAccountPanel.tsx:16-29` (remove inline `StatusPill`, import shared), `:78-81` (call sites unchanged)

- [ ] **Step 1: Write the failing test**

```tsx
// src/sidepanel/components/ManagedStatusPill.test.tsx
import { describe, expect, it, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ManagedStatusPill } from "./ManagedStatusPill";

afterEach(() => cleanup());

describe("ManagedStatusPill", () => {
  it("renders the label", () => {
    render(<ManagedStatusPill tone="neutral" label="Inactive" />);
    expect(screen.getByText("Inactive")).toBeTruthy();
  });

  it("applies tone classes (success)", () => {
    render(<ManagedStatusPill tone="success" label="Active" />);
    const el = screen.getByText("Active");
    expect(el.className).toContain("text-success");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test ManagedStatusPill`
Expected: FAIL — cannot find `./ManagedStatusPill`.

- [ ] **Step 3: Create the component (verbatim copy of the existing inline pill)**

```tsx
// src/sidepanel/components/ManagedStatusPill.tsx
export type StatusTone = "success" | "warning" | "neutral";

export function ManagedStatusPill({ tone, label }: { tone: StatusTone; label: string }) {
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test ManagedStatusPill`
Expected: PASS (2 tests).

- [ ] **Step 5: Refactor `ManagedAccountPanel` to use it**

In `ManagedAccountPanel.tsx`: delete the local `function StatusPill(...)` block (lines ~16-29). Add import at top:

```tsx
import { ManagedStatusPill } from "./ManagedStatusPill";
```

Replace the three `<StatusPill .../>` usages with `<ManagedStatusPill .../>` (same props), e.g.:

```tsx
  const pill = isActive
    ? <ManagedStatusPill tone="success" label={t("managed.account.active")} />
    : isBlocked
      ? <ManagedStatusPill tone="warning" label={t("managed.account.paymentFailed")} />
      : <ManagedStatusPill tone="neutral" label={t("managed.account.inactive")} />;
```

- [ ] **Step 6: Run account panel tests to verify no regression**

Run: `pnpm test ManagedAccountPanel`
Expected: PASS (unchanged behavior).

- [ ] **Step 7: Commit**

```bash
git add src/sidepanel/components/ManagedStatusPill.tsx src/sidepanel/components/ManagedStatusPill.test.tsx src/sidepanel/components/ManagedAccountPanel.tsx
git commit -m "refactor(managed): extract shared ManagedStatusPill"
```

---

## Task 2: Add `GoogleGlyph` / `SparkGlyph` / `ChevronGlyph`

**Files:**
- Modify: `src/sidepanel/components/icons.tsx` (append)
- Test: `src/sidepanel/components/icons.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

```tsx
// src/sidepanel/components/icons.test.tsx
import { describe, expect, it, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { GoogleGlyph, SparkGlyph, ChevronGlyph } from "./icons";

afterEach(() => cleanup());

describe("brand/icon glyphs", () => {
  it("GoogleGlyph renders 4 brand-colored paths", () => {
    const { container } = render(<GoogleGlyph />);
    const fills = [...container.querySelectorAll("path")].map((p) => p.getAttribute("fill"));
    expect(fills).toEqual(
      expect.arrayContaining(["#EA4335", "#4285F4", "#FBBC05", "#34A853"]),
    );
  });

  it("SparkGlyph and ChevronGlyph render an svg", () => {
    expect(render(<SparkGlyph />).container.querySelector("svg")).toBeTruthy();
    expect(render(<ChevronGlyph />).container.querySelector("svg")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test icons`
Expected: FAIL — exports not found.

- [ ] **Step 3: Append to `icons.tsx`**

```tsx
// --- Brand mark: official 4-color Google "G". Fixed brand colors (NOT currentColor). ---
export function GoogleGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

// Spark / sparkle accent for the intro-offer badge. Uses currentColor.
export function SparkGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M8 1.5c.3 2.7 1.8 4.2 4.5 4.5-2.7.3-4.2 1.8-4.5 4.5-.3-2.7-1.8-4.2-4.5-4.5C6.2 5.7 7.7 4.2 8 1.5Z" />
    </svg>
  );
}

// Right-pointing chevron. Uses currentColor.
export function ChevronGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 14 14" width={size} height={size} fill="none" aria-hidden>
      <path d="M5 3L9 7L5 11" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test icons`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/icons.tsx src/sidepanel/components/icons.test.tsx
git commit -m "feat(icons): add Google brand glyph, spark, chevron"
```

---

## Task 3: Add i18n keys to all 6 dictionaries

**Files:**
- Modify: `src/lib/i18n/dictionaries/{en,zh-CN,zh-TW,es-419,ja,pt-BR}.ts` — the `managed.subscribe` object.

Parity is typecheck-enforced (`satisfies EnDict`), so every locale must get every key. Add into the existing `subscribe: { introBadge: ... }` block.

- [ ] **Step 1: Add keys to `en.ts`** (`managed.subscribe`)

```ts
    subscribe: {
      introBadge: "First month {percentOff}% off",
      signInTitle: "Pie Official",
      signInCaption: "Hosted models · managed",
      signInBody: "Use the official Pie service — no API key needed. Sign in to get started.",
      benefitModels: "Latest models",
      benefitQuota: "Weekly quota",
      benefitNoSetup: "No setup",
      signInButton: "Sign in with Google",
      refreshStatus: "I've paid — refresh status",
      waiting: "Waiting for payment confirmation…",
      notActiveYet: "Subscription not active yet — finish payment, then refresh.",
      loginFailed: "Login failed",
      refreshFailed: "Refresh failed",
    },
```

- [ ] **Step 2: Add the same keys to `zh-CN.ts`**

```ts
    subscribe: {
      introBadge: "首月立减 {percentOff}%",
      signInTitle: "Pie 官方",
      signInCaption: "托管模型 · 开箱即用",
      signInBody: "使用 Pie 官方服务，无需 API key。登录即可开始。",
      benefitModels: "最新模型",
      benefitQuota: "每周额度",
      benefitNoSetup: "免配置",
      signInButton: "使用 Google 登录",
      refreshStatus: "我已付款 — 刷新状态",
      waiting: "等待支付确认…",
      notActiveYet: "订阅尚未生效 — 完成付款后刷新。",
      loginFailed: "登录失败",
      refreshFailed: "刷新失败",
    },
```

- [ ] **Step 3: Add to `zh-TW.ts`**

```ts
    subscribe: {
      introBadge: "首月立減 {percentOff}%",
      signInTitle: "Pie 官方",
      signInCaption: "託管模型 · 開箱即用",
      signInBody: "使用 Pie 官方服務，無需 API key。登入即可開始。",
      benefitModels: "最新模型",
      benefitQuota: "每週額度",
      benefitNoSetup: "免設定",
      signInButton: "使用 Google 登入",
      refreshStatus: "我已付款 — 重新整理狀態",
      waiting: "等待付款確認…",
      notActiveYet: "訂閱尚未生效 — 完成付款後重新整理。",
      loginFailed: "登入失敗",
      refreshFailed: "重新整理失敗",
    },
```

- [ ] **Step 4: Add to `es-419.ts`**

```ts
    subscribe: {
      introBadge: "Primer mes {percentOff}% de descuento",
      signInTitle: "Pie Oficial",
      signInCaption: "Modelos gestionados · listo para usar",
      signInBody: "Usa el servicio oficial de Pie, sin clave de API. Inicia sesión para empezar.",
      benefitModels: "Modelos más recientes",
      benefitQuota: "Cuota semanal",
      benefitNoSetup: "Sin configuración",
      signInButton: "Iniciar sesión con Google",
      refreshStatus: "Ya pagué — actualizar estado",
      waiting: "Esperando confirmación del pago…",
      notActiveYet: "La suscripción aún no está activa — completa el pago y actualiza.",
      loginFailed: "Error al iniciar sesión",
      refreshFailed: "Error al actualizar",
    },
```

- [ ] **Step 5: Add to `ja.ts`**

```ts
    subscribe: {
      introBadge: "初月 {percentOff}% オフ",
      signInTitle: "Pie 公式",
      signInCaption: "マネージドモデル · すぐに利用可能",
      signInBody: "Pie 公式サービスを利用 — API キー不要。ログインして始めましょう。",
      benefitModels: "最新モデル",
      benefitQuota: "週間クォータ",
      benefitNoSetup: "設定不要",
      signInButton: "Google でログイン",
      refreshStatus: "支払い済み — 状態を更新",
      waiting: "支払いの確認を待っています…",
      notActiveYet: "サブスクリプションはまだ有効ではありません — 支払い完了後に更新してください。",
      loginFailed: "ログインに失敗しました",
      refreshFailed: "更新に失敗しました",
    },
```

- [ ] **Step 6: Add to `pt-BR.ts`**

```ts
    subscribe: {
      introBadge: "Primeiro mês {percentOff}% de desconto",
      signInTitle: "Pie Oficial",
      signInCaption: "Modelos gerenciados · pronto para usar",
      signInBody: "Use o serviço oficial da Pie, sem chave de API. Entre para começar.",
      benefitModels: "Modelos mais recentes",
      benefitQuota: "Cota semanal",
      benefitNoSetup: "Sem configuração",
      signInButton: "Entrar com o Google",
      refreshStatus: "Já paguei — atualizar status",
      waiting: "Aguardando confirmação do pagamento…",
      notActiveYet: "A assinatura ainda não está ativa — conclua o pagamento e atualize.",
      loginFailed: "Falha ao entrar",
      refreshFailed: "Falha ao atualizar",
    },
```

- [ ] **Step 7: Typecheck (parity gate)**

Run: `pnpm typecheck`
Expected: 0 errors. (A missing/extra key in any locale fails here.)

- [ ] **Step 8: Commit**

```bash
git add src/lib/i18n/dictionaries
git commit -m "i18n(managed): add subscribe screen keys (6 locales)"
```

---

## Task 4: `RedeemCodeForm` collapsible mode

**Files:**
- Modify: `src/sidepanel/components/RedeemCodeForm.tsx`
- Modify: `src/sidepanel/components/RedeemCodeForm.test.tsx` (append)

Behavior: `collapsible` (default `false`) keeps the current always-open layout. When `true`, the label becomes a toggle button (accessible name = label, so it never collides with the submit "Redeem"), and the input row is wrapped in `Collapse`, starting closed.

- [ ] **Step 1: Write the failing tests** (append to `RedeemCodeForm.test.tsx`)

```tsx
  it("collapsible: input hidden until toggled open", () => {
    render(<RedeemCodeForm apiKey="sk-v" onRedeemed={vi.fn()} deps={{ redeem: vi.fn() }} collapsible />);
    expect(screen.queryByPlaceholderText(/PIE-/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /have a redemption code/i }));
    expect(screen.getByPlaceholderText(/PIE-/)).toBeTruthy();
  });

  it("collapsible: toggle exposes aria-expanded", () => {
    render(<RedeemCodeForm apiKey="sk-v" onRedeemed={vi.fn()} deps={{ redeem: vi.fn() }} collapsible />);
    const toggle = screen.getByRole("button", { name: /have a redemption code/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test RedeemCodeForm`
Expected: FAIL — `collapsible` not a prop; input always present.

- [ ] **Step 3: Implement collapsible mode**

In `RedeemCodeForm.tsx`: add imports + prop + state, extract the input row, branch the render.

```tsx
import { useState } from "react";
import { Collapse } from "./ui/Collapse";
import { ChevronGlyph } from "./icons";
// ...existing imports...

interface Props {
  apiKey: string;
  onRedeemed: (ent: Entitlement) => void;
  deps?: RedeemCodeFormDeps;
  /** When true, render the label as a toggle that reveals the input via Collapse. */
  collapsible?: boolean;
}

export default function RedeemCodeForm({ apiKey, onRedeemed, deps, collapsible = false }: Props) {
  const { t } = useI18n();
  const doRedeem = deps?.redeem ?? ((k: string, c: string) => redeemApi(k, c));
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

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

  const inputRow = (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={t("managed.redeem.placeholder")}
          className="h-9 flex-1 rounded-control border border-line bg-field px-3 font-mono text-[12px] uppercase placeholder:normal-case placeholder:text-fg-3"
        />
        <button
          type="button"
          disabled={busy || !code.trim()}
          onClick={submit}
          className="h-9 shrink-0 rounded-control border border-line px-3 text-[12px] text-fg-2 transition-colors hover:border-fg-3 hover:text-fg-1 disabled:opacity-40"
        >
          {busy ? t("managed.redeem.redeeming") : t("managed.redeem.button")}
        </button>
      </div>
      {err && <div className="text-[12px] text-warning">{err}</div>}
    </div>
  );

  if (collapsible) {
    return (
      <div className="flex flex-col gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center justify-between"
        >
          <span className="text-[12px] text-fg-2">{t("managed.redeem.label")}</span>
          <span className="flex items-center gap-1 text-[12px] font-medium text-accent">
            {!open && t("managed.redeem.button")}
            <span className={open ? "-rotate-90 transition-transform" : "rotate-90 transition-transform"}>
              <ChevronGlyph />
            </span>
          </span>
        </button>
        <Collapse open={open}>
          <div className="pt-1">{inputRow}</div>
        </Collapse>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[12px] text-fg-3">{t("managed.redeem.label")}</label>
      {inputRow}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass (new + existing)**

Run: `pnpm test RedeemCodeForm`
Expected: PASS — both new tests + the 5 existing (default mode unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/components/RedeemCodeForm.tsx src/sidepanel/components/RedeemCodeForm.test.tsx
git commit -m "feat(redeem): add collapsible mode to RedeemCodeForm"
```

---

## Task 5: Rewrite `ManagedSubscribePanel` (sign-in + subscribe + polling)

**Files:**
- Modify: `src/sidepanel/components/ManagedSubscribePanel.tsx` (render + error strings only; keep all hooks/handlers)
- Modify: `src/sidepanel/components/ManagedSubscribePanel.test.tsx` (redeem expand step)

Keep the entire logic block (lines 1-172: state, refs, polling, `handleLogin`/`handleCheckout`/`handleRefresh`) **unchanged except** replacing the 3 hardcoded English error strings with i18n:
- `handleLogin` catch: `t("managed.subscribe.loginFailed")`
- `handleCheckout` catch: `t("managed.account.checkoutFailed")`
- `handleRefresh`: success-but-not-active line → `t("managed.subscribe.notActiveYet")`; catch → `t("managed.subscribe.refreshFailed")`

- [ ] **Step 1: Update imports + error strings**

At top of `ManagedSubscribePanel.tsx`, add:

```tsx
import { Button } from "./ui/Button";
import { ManagedStatusPill } from "./ManagedStatusPill";
import { GoogleGlyph, SparkGlyph } from "./icons";
```

In the handlers, swap the literals:

```tsx
      setErr(e instanceof Error ? e.message : t("managed.subscribe.loginFailed"));
// ...
      setErr(e instanceof Error ? e.message : t("managed.account.checkoutFailed"));
// ...
      setErr(t("managed.subscribe.notActiveYet"));
// ...
      setErr(e instanceof Error ? e.message : t("managed.subscribe.refreshFailed"));
```

- [ ] **Step 2: Replace the `return (...)` JSX (lines ~174-246)**

```tsx
  return (
    <div className="flex flex-col gap-4 rounded-[14px] border border-line bg-surface p-3.5 text-[13px]">
      {!session ? (
        <>
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] bg-field text-[15px] font-semibold text-fg-1">
              P
            </div>
            <div className="flex flex-col gap-0.5">
              <div className="text-[14px] font-medium text-fg-1">{t("managed.subscribe.signInTitle")}</div>
              <div className="font-mono text-[11px] text-fg-3">{t("managed.subscribe.signInCaption")}</div>
            </div>
          </div>
          <p className="leading-[19px] text-fg-2">{t("managed.subscribe.signInBody")}</p>
          <div className="flex items-center gap-2 text-[11px] font-medium text-fg-2">
            <span>{t("managed.subscribe.benefitModels")}</span>
            <span className="h-[3px] w-[3px] rounded-full bg-line" />
            <span>{t("managed.subscribe.benefitQuota")}</span>
            <span className="h-[3px] w-[3px] rounded-full bg-line" />
            <span>{t("managed.subscribe.benefitNoSetup")}</span>
          </div>
          <Button
            variant="primary"
            size="md"
            fullWidth
            loading={busy}
            onClick={handleLogin}
            iconLeft={<GoogleGlyph />}
          >
            {t("managed.subscribe.signInButton")}
          </Button>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <div className="caps text-fg-3">{t("managed.account.section")}</div>
            <ManagedStatusPill tone="neutral" label={t("managed.account.inactive")} />
          </div>
          <div className="flex flex-col gap-1">
            <div className="text-[16px] font-semibold tracking-[-0.01em] text-fg-1">
              {t("managed.account.noSubscription")}
            </div>
            <div className="font-mono text-[12px] text-fg-2">{session.entitlement.email}</div>
          </div>
          <p className="text-[12px] leading-[17px] text-fg-2">{t("managed.account.noneBody")}</p>
          {session.entitlement.plan === "none" && session.entitlement.introOffer && (
            <span className="inline-flex items-center gap-1.5 self-start rounded-full bg-accent/15 px-2.5 py-1 text-[12px] font-medium text-accent">
              <SparkGlyph />
              {t("managed.subscribe.introBadge", { percentOff: session.entitlement.introOffer.percentOff })}
            </span>
          )}
          <div className="flex flex-col gap-1">
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
            ) : (
              <Button variant="primary" size="md" fullWidth disabled={busy} onClick={handleCheckout}>
                {t("managed.account.subscribe")}
              </Button>
            )}
            <Button variant="ghost" size="sm" fullWidth disabled={busy} onClick={handleRefresh}>
              {t("managed.subscribe.refreshStatus")}
            </Button>
          </div>
          {session.entitlement.plan === "none" && (
            <div className="border-t border-line pt-3.5">
              <RedeemCodeForm
                apiKey={session.apiKey}
                collapsible
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
          )}
        </>
      )}
      {err && (
        <div className="rounded-lg border border-warning-line bg-warning-tint px-3 py-2 text-[12px] text-warning">
          {err}
        </div>
      )}
    </div>
  );
```

- [ ] **Step 3: Run the panel tests (expect the redeem test to fail)**

Run: `pnpm test ManagedSubscribePanel`
Expected: the redeem test (`登录后（plan:none）显示兑换输入框…`) FAILS — input is now collapsed; all others PASS.

- [ ] **Step 4: Update the redeem test to expand first**

In `ManagedSubscribePanel.test.tsx`, the test at ~line 159, after `await screen.findByRole("button", { name: /^subscribe$/i });` insert a toggle click before touching the input:

```tsx
    await screen.findByRole("button", { name: /^subscribe$/i });
    fireEvent.click(screen.getByRole("button", { name: /have a redemption code/i }));
    fireEvent.change(screen.getByPlaceholderText(/PIE-/), { target: { value: "PIE-AAAAA-BBBBB-CCCCC" } });
    fireEvent.click(screen.getByRole("button", { name: /^redeem$/i }));
```

- [ ] **Step 5: Run the panel tests to verify all pass**

Run: `pnpm test ManagedSubscribePanel`
Expected: PASS (all). Note `/^subscribe$/i` matches the Subscribe button; the redeem toggle's accessible name is "Have a redemption code? Redeem" so `/^redeem$/i` still uniquely matches the submit button.

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/components/ManagedSubscribePanel.tsx src/sidepanel/components/ManagedSubscribePanel.test.tsx
git commit -m "feat(managed): redesign ManagedSubscribePanel sign-in + subscribe screens"
```

---

## Task 6: Full verification + visual parity

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `pnpm test`
Expected: all green (no regressions across the suite).

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors (repo-wide invariant).

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: success (build-time invariants pass).

- [ ] **Step 4: Sync dist + manual visual check**

Run: `pnpm build && pnpm sync:dist`, then reload the extension at `chrome://extensions` and open Settings → add config → "Official subscription". Verify against the Paper artboards `P4 — Managed Subscribe · Redesign`:
- signed-out: brand row, value, benefits, Google G button (spinner while signing in)
- signed-in none: SUBSCRIPTION caps + Inactive pill + "No active subscription" + email + body + intro badge + Subscribe + "I've paid — refresh status" + collapsed redeem (expands on click)
- after Subscribe: centered "Waiting for payment confirmation…" row
- toggle light/dark theme — both match the two prototypes.

- [ ] **Step 5: Commit anything outstanding** (e.g., spec/plan docs if not already committed)

```bash
git add docs/specs docs/plans
git commit -m "docs(managed): add subscribe redesign spec + plan"
```

---

## Self-Review

- **Spec coverage:** sign-in screen (T5), subscribe screen (T5), polling waiting state (T5), StatusPill alignment (T1), Google G + spark + chevron (T2), i18n 6-locale (T3), collapsible redeem (T4), motion via Collapse + spinner (T4/T5), a11y aria-expanded/role=status (T4/T5), verification (T6). ✓
- **Placeholder scan:** none — every code step has full content. ✓
- **Type consistency:** `ManagedStatusPill`/`StatusTone` (T1) used in T1+T5; `GoogleGlyph`/`SparkGlyph`/`ChevronGlyph` (T2) used in T4/T5; `collapsible` prop (T4) used in T5; new i18n keys (T3) consumed in T5. ✓
- **Behavioral guard:** `RedeemCodeForm` default mode untouched → its 5 existing tests + `ManagedAccountPanel` tests stay green; only the one subscribe-panel redeem test gains a toggle-click step. ✓
