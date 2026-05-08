---
title: "pendingRecording chip: dark-mode invisible due to undefined CSS token fallback"
date: 2026-05-05
category: ui-bugs
module: sidepanel/composer
problem_type: ui_bug
component: tooling
symptoms:
  - Chip background remained #f5f5f5 (light gray) in BOTH light and dark mode
  - Foreground text (--c-fg-1, near-white in dark mode) was washed out / unreadable on the light fallback background
  - Chip dismiss button (× ) had its own background switching correctly, leaving the outer chip visually inconsistent across themes
root_cause: config_error
resolution_type: code_fix
severity: medium
tags: [dark-mode, css-tokens, tailwind-v4, theming, recording-chip, sidepanel]
---

# pendingRecording chip: dark-mode invisible due to undefined CSS token fallback

## Problem

The "pendingRecording" chip rendered in Pie's chat composer (after a user clicks "Finish" on a recording) was unreadable in dark mode — light-gray background, near-white text on top. Reported by the user during dogfood after the v1 reframe shipped.

## Symptoms

- Dark mode: chip background was light gray (`#f5f5f5`), foreground text near-invisible.
- Light mode: chip looked acceptable because `#f5f5f5` happened to be close to the genuine light-mode field color, masking the bug during initial development.
- The dismiss button (`×`) on the same chip used `var(--c-canvas)` and switched theme correctly, producing a visible "outer-light + inner-dark" inconsistency in dark mode.

## What Didn't Work

No prior failed attempts — direct fix on first sighting (the bug was obvious once the user reported the dark-mode rendering).

## Solution

The chip was originally introduced in commit `d9cb699` (Reframe 4-6 — drop SaveSkillDialog) using inline `style={{}}` with a CSS-variable fallback to a hardcoded hex:

**Before** (`src/sidepanel/components/Chat.tsx`):

```tsx
<div
  data-testid="pending-recording-chip"
  style={{
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    margin: "0 12px 6px",
    background: "var(--c-bg-2, #f5f5f5)",   // ← non-existent token; fallback always fires
    border: "1px solid var(--c-line, #ccc)",
    borderRadius: 6,
    fontSize: 13,
    color: "var(--c-fg-1)",
  }}
>
  <span>📼 已录制 {pendingRecording.stepCount} 步 — 写提示后 Send 让 LLM 创建 skill</span>
  <button
    style={{
      marginLeft: "auto",
      background: "var(--c-canvas)",
      color: "var(--c-fg-1)",
      border: "1px solid var(--c-line)",
      /* … */
    }}
  >×</button>
</div>
```

**After** (commit `9ab6fdf`):

```tsx
<div
  data-testid="pending-recording-chip"
  className="mx-3 mb-1.5 flex items-center gap-2 rounded-md border border-line bg-field px-2.5 py-1.5 text-[13px] text-fg-1"
>
  <span className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-pending" aria-hidden="true" />
  <span className="font-mono text-[10px] font-semibold tracking-[0.08em] text-pending">REC</span>
  <span className="text-fg-1">
    {pendingRecording.stepCount}
    <span className="ml-1 text-fg-3">{pendingRecording.stepCount === 1 ? "step" : "steps"}</span>
  </span>
  <span className="text-fg-3">·</span>
  <span className="text-fg-2">写提示 → Send 让 LLM 创建 skill</span>
  <button
    className="ml-auto flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border border-line bg-canvas text-fg-2 hover:border-fg-3 hover:text-fg-1"
  >×</button>
</div>
```

The fix required two pieces:

1. **Replace inline styles with Tailwind v4 utilities**: `bg-field` / `border-line` / `text-fg-1` / `text-pending` resolve via the `@theme` block in `src/sidepanel/index.css` to the actual `var(--c-*)` tokens, which ARE defined and theme-aware.
2. **Register the missing pending magenta in `@theme`** (already part of the prior paper-landing commit `fe5d725`):

   ```css
   @theme {
     /* … */
     --color-pending: var(--c-pending);
   }
   ```

   Without this, `bg-pending` / `text-pending` would not resolve to a Tailwind utility.

## Why This Works

**Why `var(--c-bg-2, #f5f5f5)` failed:** CSS custom-property resolution treats the comma-separated default as a static fallback. When the browser cannot find `--c-bg-2` in the cascade, it substitutes `#f5f5f5` unconditionally — there is no theme lookup, no inheritance from `:root`, no `prefers-color-scheme` consultation. Since `--c-bg-2` is defined nowhere in `src/sidepanel/index.css` (the actual token list is `--c-canvas / --c-surface / --c-field / --c-line / --c-fg-{1,2,3} / --c-accent / --c-warning / --c-pending / --c-danger-{fg,line} / --c-overlay`), the browser always rendered `#f5f5f5` regardless of which theme was active.

**Why the Tailwind utility succeeds:** Tailwind v4's `@theme` block at `src/sidepanel/index.css:109` maps each design token into a Tailwind color namespace:

```css
@theme {
  --color-canvas: var(--c-canvas);
  --color-surface: var(--c-surface);
  --color-field: var(--c-field);
  --color-line: var(--c-line);
  --color-fg-1: var(--c-fg-1);
  --color-fg-2: var(--c-fg-2);
  --color-fg-3: var(--c-fg-3);
  --color-accent: var(--c-accent);
  --color-pending: var(--c-pending);
  --color-warning: var(--c-warning);
  /* … */
}
```

`bg-field` resolves to `var(--color-field)` → `var(--c-field)`, and `--c-field` IS defined for both light (`#F4F6F8`) and dark (`#1A1E25`) — with the dark override applied via `prefers-color-scheme` and `[data-theme="dark"]`. The resolved value is always theme-correct.

## Prevention

1. **Grep gate in code review** — flag any `style={{` containing `var(--c-<NAME>, #<HEX>)`. A bare hex fallback for a CSS variable is always suspect: if the token is correct the fallback never fires (dead code), if the token is wrong the fallback hides the bug. Add this to the PR checklist or a pre-commit hook:

   ```bash
   grep -rn 'var(--c-[^,)]*,\s*#' src/sidepanel/
   ```

   Zero matches is the pass condition. Valid fallbacks should reference another token (e.g. `var(--c-fg-1, var(--c-fg-2))`), never a bare hex.

2. **Component convention — prefer Tailwind v4 utilities over `style={{}}` for theme-aware properties.** The `@theme` block in `src/sidepanel/index.css` already exposes utilities for every defined token: `bg-canvas / bg-surface / bg-field / border-line / text-fg-{1,2,3} / text-pending / bg-pending / text-accent / text-warning`. Reach for these first. Reserve inline `style={{}}` for genuinely dynamic values (percentage widths, animation keyframe values) that can't be expressed as utilities.

3. **Cross-mode visual check before commit** — when adding any new colored UI element, manually toggle the extension between light and dark before pushing (DevTools `prefers-color-scheme` emulation, or system preference flip). This 30-second check would have caught the chip immediately. Future improvement: add a per-PR screenshot requirement in the GitHub PR template for any commit touching sidepanel component styling.

4. **Add missing tokens to `@theme`, never hardcode hex inline.** If a needed semantic color isn't in `index.css`, add it to:
   - The `:root` light-mode block,
   - The `prefers-color-scheme: dark` and/or `[data-theme="dark"]` overrides,
   - The `@theme` block (so Tailwind utilities resolve),

   in that order. The chip fix's predecessor commit `fe5d725` did exactly this for `--color-pending` (it had been declared in `:root` but not in `@theme`, so `text-pending` / `bg-pending` were unknown utilities). The compound fix removes the need for any inline hex fallback ever.

## Related Issues

- `docs/solutions/2026-05-04-multimodal-image-input-v1.md` — Phase 5 multimodal trace doc that established the rule "scan `index.css` for the closest existing token rather than introducing new colors" — applies directly to the prevention rule above.
- `docs/plans/2026-05-05-record-and-replay.md:3357` — origin of the bug. The plan's TopBarRecordButton snippet (later removed in the paper-landing reframe) used the same `var(--c-pending, #f0f)` / `var(--c-line, #ccc)` inline-fallback pattern that birthed `var(--c-bg-2, #f5f5f5)` two units later. The plan is now stale on this UI detail; the actual ship in `Chat.tsx` uses Tailwind utilities throughout. Future planners should not paste inline-hex-fallback snippets into plan documents — they get copy-pasted into code.
- Commit `9ab6fdf` — the fix.
- Commit `fe5d725` — the `@theme` registration of `--color-pending` that this fix depends on.
- `src/sidepanel/index.css` (`@theme` block, lines 109–127) — definitive list of Tailwind-mapped design tokens; any new UI must reference these.

## Auto memory note

This learning aligns with `feedback_pie_brand_palette` (auto memory [claude]) — Pie 品牌资产严格限定产品 design tokens; status/semantic colors live in `--c-pending` / `--c-warning` / `--c-danger-fg`. The chip bug is the inverse failure mode: NOT introducing a new color, but referencing a non-existent one and falling back to hex. Both lessons converge on the same rule — code that touches color must go through tokens declared in `index.css`, never inline hex.
