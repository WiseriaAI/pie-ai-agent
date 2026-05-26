# Hover + CDP Click Upgrade — Solution Trace

> Spec: `docs/specs/2026-05-26-hover-and-cdp-click-upgrade-design.md`
> Plan: `docs/plans/2026-05-26-hover-and-cdp-click-upgrade.md`
> Issue: #81
> Release: v0.14.0

## What changed

- Added `hover` tool (real CDP `mouseMoved` event) — unlocks hover-only menus, tooltips, hover cards.
- Upgraded `click` from synthetic `(el).click()` to CDP `mouseMoved → mousePressed → mouseReleased` sequence — sites that check `event.isTrusted` now accept Pie clicks.
- Added inline sidepanel consent card for the first hover/click/keyboard call (tri-state `cdp_input_enabled` flag: `undefined | true | false`). Silently migrates from the old binary `keyboard_simulation_enabled`.
- iframe geometry via CDP `DOM.getNodeForFrameOwner` + `DOM.getBoxModel` — cross-origin iframes now clickable (CDP runs in browser process, not bound by same-origin policy).

## Invariants Established

- **R-cdp-1**: all `acquireCdpSession` calls route through `requireCdpInput` or the approved screenshot DI shim. Enforced by `src/__tests__/cross-layer/cdp-tools-routing.test.ts` (greps the codebase; any new caller is rejected).
- **R-iframe-1 (extended)**: `hover` joins `click/type/select` in the write-class tools requiring `frameId`. Asserted at module load in `src/lib/agent/tools.ts` via two IIFE checks — one for `BUILT_IN_TOOLS` (type/select), one for `getMouseTools` (click/hover).

## Storage Schema

- `cdp_input_enabled: true | false | undefined` (`src/lib/cdp-input-enabled.ts`)
  - `undefined`: first hover/click/keyboard call triggers inline consent card
  - `true`: tools run; Chrome shows the yellow debugger bar while a task is active
  - `false`: tools refused at handler entry; user must re-enable via Settings
- Migration: `migrateLegacyKeyboardFlag()` runs at SW install / startup. `keyboard_simulation_enabled` → `cdp_input_enabled` 1:1 if new key unset; legacy key deleted.

## Onboarding Flow

1. Tool handler calls `requireCdpInput({sessionId, requestConsent})`
2. If `cdp_input_enabled === undefined`: SW posts `{type: "cdp-onboarding-request", sessionId}` over the per-session chat-stream port
3. Sidepanel renders `CdpOnboardingCard` via `useCdpOnboarding` hook
4. User clicks Enable / Not now → sidepanel posts `{type: "cdp-onboarding-response", sessionId, enabled}` back
5. SW writes flag + resolves Promise; cross-session pending requests auto-resolve when another sidepanel flips the flag to `true` (via `chrome.storage.onChanged`)

## Manual Test Checklist

Before tagging the next release:

1. **First-use flow**: Fresh profile → load extension → ask agent to click on amazon.com → see consent card → click Enable → see Chrome yellow bar → click completes.
2. **Decline flow**: As above but click Not now → click fails with `CDP input is disabled` error → Settings shows toggle in Disabled state.
3. **Hover scenario**: amazon.com top-nav hover → submenu expands → `read_page` lists new items → click submenu item.
4. **Same-origin iframe**: Page embedding a same-origin iframe → agent clicks inside iframe → geometry path resolves correctly.
5. **Cross-origin iframe**: Page embedding YouTube → click Play → CDP `DOM.getBoxModel` returns origin even cross-origin → click lands.
6. **DevTools conflict**: Open DevTools → ask agent to click → `cdp-attach-conflict` error → close DevTools → retry succeeds.
7. **Yellow bar Cancel**: Mid-task click Chrome's debug bar Cancel button → task aborts cleanly (existing `cdp-detached-midway` path).
8. **Legacy migration**: Pre-upgrade had `keyboard_simulation_enabled = true` → upgrade → Settings shows CDP toggle Enabled → click works without consent card.

## Performance Notes

- `click` RTT: synthetic `el.click()` <5ms → CDP 3-event sequence + geometry 50–150ms.
- `hover` RTT: 30–80ms (1 CDP event + geometry).
- Negligible against per-iteration LLM latency.

## Known Limitations (follow-up backlog)

- Screenshot tool (`src/background/cdp-adapter.ts`) bypasses `requireCdpInput` because it predates the unified flag — should be migrated in a follow-up so screenshots also honor the user's consent state.
- chrome→CDP frameId mapping falls back to URL + DOM-order; same-URL siblings with identical structure could mis-resolve in pathological pages. Add stamp-based disambiguation if reports come in.
