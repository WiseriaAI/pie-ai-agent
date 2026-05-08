# Multimodal Image Input v1 — Implementation Notes

**Plan:** `docs/plans/2026-05-04-multimodal-image-input.md`
**Brainstorm:** `docs/specs/2026-05-04-multimodal-image-input-requirements.md`
**Branch:** `feat/multimodal-image-input` (in `.worktrees/multimodal-image-input`)
**Final test count:** 448 tests passing (baseline 446 + 2 new R15 tests)
**Tasks:** 15 / 15 implemented

## Decisions Locked During Implementation

- ChatMessage IR: additive `attachments?: Attachment[]` (preserves Phase 1 wire invariant)
- Resize: panel-side DOM Canvas + SW-side OffscreenCanvas (env-split, shared validate)
- Screenshot tool split: `capture_visible_tab` + `capture_fullpage_tab` (separate tools, both class=read + always-high risk)
- CDP fullpage attach: task-scope (mirrors Phase 2.5 keyboard via `acquireCdpSession` ownerToken)
- Per-task screenshot budget: 5 captures (shared across both tools)
- Pre-capture: SW pre-captures BEFORE confirm card; 5s stale invalidate
- No-persist storage: image bytes never reach chrome.storage; per-session cache 30 MB / 3-turn LRU
- 4 evict paths (R13): emitDone (a) / SW startup (b) / setActive (c) / port disconnect (d). Path (e) explicit-clear deferred to v1.1.
- R14 fail-on-image: hasImageContent=true + in-flight → status='failed' (not 'paused'); drift card hides Resume (already Discard-only via M1 invariant — verified by 4 regression tests)
- R15: agent system prompt ends with image-untrusted boundary line, placed AFTER `<user_task>` so it is the last context the LLM sees before generating a response
- R9 mixed-vision-provider: 4 sub-paths (a) upload affordance disabled [Task 13], (b) provider switch clears pending attachments [Task 15], (c) loop short-circuits screenshot dispatch [Task 15], (d) SkillsList warning when allowedTools has screenshot [Task 15]

## Architecture Highlights

- HARD GATE in Task 6: `extractText` skips image blocks (without it, a 2 MB image inflates token count by ~750K and head-trim deletes user pairs)
- Image surcharge per provider: anthropic 1568 / openai+openrouter 765 per image
- Provider shapers: anthropic.ts (snake_case media_type) + openai.ts (image_url with data URL); 3 standalone shapers (no abstraction layer)
- SW pre-capture cache: pure module `screenshot-precapture.ts` with one-shot consume + 5s stale + 4 cleanup paths (reject / port-disconnect / abort / storage-write-failure)
- Storage scrub: `setSessionMeta` replaces image attachments with placeholders before chrome.storage write (load-bearing for 8 MB LRU archive threshold)
- R15 placement: prompt body order is `STATIC_AGENT_SYSTEM_PROMPT → keyboard guidance (if enabled) → meta tool guidance (if enabled) → tab tools guidance → pinned context (if present) → <user_task> → R15 line`. This ensures R15 is the trailing text the LLM reads. Pixels cannot be wrapped in `<untrusted_*>` tags, so the prompt-level instruction is the only enforcement layer.

## R9 sub-path implementation details

- **(a) Upload affordance disabled** (`Chat.tsx`): camera/upload button is `disabled` when `!supportsVision`, paste handler early-returns. `Task 13`.
- **(b) Provider switch clears pending attachments** (`Chat.tsx`): `useEffect` watches `supportsVision`; when it flips to `false` and `attachments.length > 0`, calls `showLocalToast` and `setAttachments([])`. Dep array is `[supportsVision]` intentionally — fires only on provider flip, not on every attachment mutation. `Task 15`.
- **(c) Loop short-circuits screenshot dispatch** (`loop.ts`): at the top of the `capture_visible_tab / capture_fullpage_tab` branch, calls `getProviderMeta(modelConfig.provider)` and, if `!supportsVision`, pushes an error `tool_result` and `continue`s before `sendConfirmRequest`. Avoids wasted confirm-card + pre-capture for a tool whose result the provider can't accept. `Task 15`.
- **(d) SkillsList vision warning** (`SkillsList.tsx`): `SkillsList` loads `supportsVision` via a self-contained `useEffect` (matching `Chat.tsx` pattern, no prop plumbing). `SkillRow` receives `supportsVision` as a prop; if `!supportsVision && skill.allowedTools` contains `capture_visible_tab` or `capture_fullpage_tab`, renders a `text-fg-3 text-xs` warning row. `Task 15`.

## Manual Acceptance Checklist (user-driven)

After this branch is merged, run `pnpm dev`, load the extension, and verify:

1. **Upload + analyze (Anthropic)**: paste a screenshot → confirm thumbnail renders → send → receive response referencing image content.
2. **Upload + analyze (OpenAI)**: switch provider to OpenAI → repeat → wire format works.
3. **Cross-turn follow-up**: after image-bearing message, ask "再看看刚才那张图哪里有问题" → LLM still sees image (R11 cache cross-turn).
4. **Panel reload mid-session**: reload sidepanel → past messages render `[图已释放]` placeholder → new chat: LLM sees text-only context (R12).
5. **Screenshot tool (visible)**: ask "Take a visible-area screenshot" → confirm card with thumbnail → approve → image flows to LLM.
6. **Screenshot tool (fullPage)**: ask "Capture full page" → CDP banner → approve → image arrives.
7. **Budget exhaustion**: 6 sequential screenshot calls → 6th returns `screenshot-budget-exceeded`.
8. **Pinned tab not visible**: switch to a non-pinned tab → trigger screenshot → returns `pinned-tab-not-visible`.
9. **R14 fail-on-image**: kill SW (chrome://serviceworker-internals/) mid-image task → reopen panel → drift card shows Discard only (no Resume button).
10. **Provider switch with pending attachment (R9 b)**: paste image → switch provider to MiniMax → toast appears, attachments cleared, input area shows no thumbnails.
11. **3-image cap (R1)**: paste 4 images → only 3 attached, toast shown for 4th.
12. **>25 MB upload**: drag a >25 MB file → reject toast shown, no attachment added.

## Deferred to v1.1

- Anthropic `cache_control: ephemeral` on image content blocks (BYOK cost mitigation; ~9.4K tokens/round per image without it)
- Settings toggle: 1568 max-edge (default high tier) vs 1092 max-edge (BYOK cost optimized)
- Archived bundle thumbnail (256 px / ~50 KB per image)
- Multi-image reorder UI (drag-to-rearrange thumbnails)
- Skill `promptTemplate` image embed
- Resume-with-re-upload flow for image-bearing paused tasks (R14 forces `failed` today)
- Gemini provider vision (Gemini provider entry itself unshipped)
- MiniMax / 智谱 / 百炼 vision (per-provider brainstorms)
- R13 path (e) explicit-clear UI affordance

## Known Pre-existing Issue (out of Phase 5 scope)

- Anthropic `tool_result` block pass-through ships `toolUseId` (camelCase) to the wire while the API expects `tool_use_id` (snake_case). Apparently tolerated by Anthropic API today; surfaced during Task 5 code review. Not a Phase 5 regression — flagged for separate audit.

## Files Touched (commit order, Task 1 → 15)

```
a2d85fa feat(image-input): types + ChatMessage attachments + supportsVision flag (Task 1)
e56d412 feat(image-input): panel-side resize (DOM Canvas) + input validation (Task 2)
2d43b4a fix(image-input): Task 1 review follow-up — JSDoc honesty + type tightening
ed0f8fd fix(image-input): Task 2 review follow-up — totality + perf + comments
e1f51fa feat(image-input): SW-side resize (OffscreenCanvas) + test polyfill (Task 3)
ea30c16 feat(image-input): SW per-session image cache (4 evict paths) (Task 4)
997b207 fix(image-input): Task 4 review follow-up — getImages defensive copy
60ed87a feat(image-input): provider vision shapers — Anthropic + OpenAI/OpenRouter (Task 5)
ce91af4 feat(image-input): sliding-window image-skip + per-provider surcharge (Task 6)
7f0d18f feat(image-input): screenshot tools registration — names + risk + schema (Task 7)
0db517d feat(image-input): capture_visible_tab handler + per-task budget (Task 8)
e4fc35d fix(image-input): Task 8 review follow-up — totality + budget invariants
9da7a2f feat(image-input): capture_fullpage_tab handler — CDP task-scope (Task 9)
8660d58 feat(image-input): SW pre-capture + confirm card thumbnail (Task 10)
26bdb30 feat(image-input): loop integration — hydration + screenshot dispatch (Task 11)
ce55a4a feat(image-input): SW lifecycle wiring — R13 evict paths + R14 image-fail (Task 12)
270bb59 fix(image-input): Task 12 review follow-up — Critical + Important
a66641e chore(background): remove dead acquireCdpSession import from index.ts
f42c910 feat(image-input): panel chat input — paste/drag/upload + thumbnail render (Task 13)
3d37c05 fix(image-input): Task 13 review follow-up — toast unmount leak + behavior
1462f17 feat(image-input): placeholder rendering + R14 drift-card Discard-only (Task 14)
[Task 15 commit — R15 system prompt + R9 sub-paths b/c/d + solutions doc]
```
