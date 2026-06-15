# Managed Subscribe UI Redesign

**Date:** 2026-06-16
**Status:** Approved (Paper prototype reviewed)
**Surface:** `ManagedSubscribePanel` — the "Official subscription" tab inside the new-config wizard (sign-in + subscribe flows)

## Context

`ManagedSubscribePanel.tsx` was built function-first. Its two states — *signed out* (Google sign-in) and *signed in · plan none* (subscribe + redeem) — never got the visual polish the rest of the managed family already has. The shipped `ManagedAccountPanel` (subscription management for an already-configured instance) is the polished reference: caps section header, dot StatusPill, 16px/600 headline, mono email, token-driven buttons.

This redesign brings the two subscribe-flow screens up to that same language, normalizes icons (official Google G), and moves hardcoded English into i18n.

Approved visual prototypes live in the Paper file **"Pie Frontend"**:
- `P4 — Managed Subscribe · Redesign (Modern A)` (dark)
- `P4 — Managed Subscribe · Redesign (Light)`

## Goals

1. **Design-language alignment** — the sign-in / subscribe screens read as one family with `ManagedAccountPanel` (same card shell, caps header, StatusPill, headline type, token-driven buttons).
2. **Refinement** — proper type hierarchy (Inter / JetBrains Mono via existing tokens), real motion (Collapse for redeem, loading spinners, centered waiting state) instead of abrupt swaps.
3. **Icon normalization** — official 4-color Google G on the sign-in button; chevron on the redeem affordance; spinner on the waiting state.
4. **i18n** — every user-visible string lives in the dictionary, with all 6 locales filled.

## Non-goals

- No change to auth / checkout / polling / redeem **logic** — the existing flow in `ManagedSubscribePanel` (login → optional poll after checkout → refresh → onCreated) and `RedeemCodeForm` is preserved. This is presentation + i18n only.
- No backend/contract changes. Pricing is never shown client-side (backend remains source of truth); the only commerce signal is the existing `introOffer.percentOff` badge.
- No change to where the panel is mounted (`NewConfigWizard`).

## Approved design

### Screen A — Signed out (sign in)

Card (shared shell: `rounded-[14px] border border-line bg-surface p-3.5`) containing:

- **Brand identity row** — 36×36 avatar tile ("P") + title **"Pie Official"** + mono caption **"Hosted models · managed"**.
- **Value sentence** — "Use the official Pie service — no API key needed. Sign in to get started."
- **Benefits line** — compact middot-separated row: "Latest models · Weekly quota · No setup".
- **Google button** — full-width primary (`bg-fg-1`, inverts with theme), official 4-color Google **G** on the left, label "Sign in with Google". Shows a spinner while busy.

### Screen B — Signed in · plan none (subscribe)

Card containing, top to bottom:

- **Header row** — caps `SUBSCRIPTION` (left) + neutral StatusPill **"Inactive"** (right).
- **Headline block** — **"No active subscription"** (16px/600) + mono email.
- **Body** — "Subscribe to use the official Pie service — no API key needed."
- **Intro badge** *(only when `introOffer` present)* — accent-tint pill with a spark glyph + "First month {percentOff}% off".
- **Subscribe** — full-width primary button (spinner while busy).
- **"I've paid — refresh status"** — centered ghost link (hidden while polling unless timed out).
- **Redeem affordance** — divider, then a "Have a redemption code?" row whose "Redeem" toggle reveals the input via Collapse.

Wording, caps header, StatusPill, and headline are **reused verbatim** from the `managed.account.*` keys so the subscribe screen and the account panel's none-state stay byte-identical.

### Screen B′ — Polling (checkout opened)

After Subscribe opens the Stripe tab, the primary button is replaced by a **centered** waiting row (`bg-field` pill: spinner + "Waiting for payment confirmation…"), with the "I've paid — refresh status" ghost link beneath it.

## Key decisions

- **Reuse `ManagedAccountPanel` framing for Screen B** (user choice): headline = `managed.account.noSubscription`, pill = neutral `managed.account.inactive`, caps = `managed.account.section`, body = `managed.account.noneBody`. The subscribe screen is the *status* frame, not a sales frame.
- **Extract `StatusPill`** out of `ManagedAccountPanel` into a shared component so both panels render the identical pill. The shipped neutral pill (`bg-field text-fg-2`, `bg-fg-3` dot) is the alignment target (the Paper prototype's accent-tint pill was prototype-only).
- **Google G is a fixed-color brand mark**, not a `currentColor` glyph — it gets its own component, separate from the `currentColor` glyphs in `icons.tsx`.
- **Google sign-in & Subscribe use the `Button` component** (`variant="primary"`, `fullWidth`, `loading`), replacing the ad-hoc `<button>`s. The "I've paid" action uses `variant="ghost"`.
- **Redeem becomes collapsible** via a new `collapsible` prop on `RedeemCodeForm` (default false keeps `ManagedAccountPanel` unchanged). The label row is the toggle; the input row animates in via `Collapse`.

## i18n

New keys under `managed.subscribe` (added to all 6 dictionaries — parity is typecheck-enforced via `satisfies EnDict`):

| key | en |
|---|---|
| `signInTitle` | "Pie Official" |
| `signInCaption` | "Hosted models · managed" |
| `signInBody` | "Use the official Pie service — no API key needed. Sign in to get started." |
| `benefitModels` | "Latest models" |
| `benefitQuota` | "Weekly quota" |
| `benefitNoSetup` | "No setup" |
| `signInButton` | "Sign in with Google" |
| `subscribe` | "Subscribe" |
| `refreshStatus` | "I've paid — refresh status" |
| `waiting` | "Waiting for payment confirmation…" |
| `redeemCta` | "Redeem" |
| `notActiveYet` | "Subscription not active yet — finish payment, then refresh." |
| `loginFailed` | "Login failed" |
| `refreshFailed` | "Refresh failed" |

Reused existing keys: `managed.account.{section,noSubscription,inactive,noneBody,checkoutFailed}`, `managed.subscribe.introBadge`, `managed.redeem.*`.

## Motion & a11y

- Redeem input reveal: existing `Collapse` (height+opacity, `DURATION.base`).
- Loading: `Button`'s built-in spinner; waiting-row spinner mirrors that style (`animate-spin`, `aria-hidden`).
- Waiting row: `role="status"` + `aria-live="polite"` so confirmation polling is announced.
- Redeem toggle: `aria-expanded`.
- Respects existing reduced-motion handling baked into the `motion` primitives.

## Acceptance criteria

1. Both screens visually match the approved Paper prototypes (dark + light auto-handled by tokens).
2. No hardcoded user-visible strings remain in `ManagedSubscribePanel` / `RedeemCodeForm`; all 6 dictionaries typecheck (parity holds).
3. Sign-in button renders the 4-color Google G and a spinner while busy.
4. Redeem affordance starts collapsed, expands on click with animation, and redeem/error behavior is unchanged.
5. Polling waiting state is centered and announced to AT.
6. `ManagedAccountPanel` is visually unchanged (StatusPill extraction is a pure refactor).
7. `pnpm test`, `pnpm typecheck`, `pnpm build` all green.
