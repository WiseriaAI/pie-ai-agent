# Loop-detection follow-ups (#64 oscillation + #65 model-authored stuck summary) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Extend the #61 ReAct loop-detection mechanism with (1) deterministic oscillation/period-k detection (#64) and (2) a model-authored failure summary on the reflection hard-stop instead of a canned string (#65), keeping the existing termination guarantee.

**Architecture:**
- #64 is a pure-function extension of `detectLoop` (`loop-detection.ts`): a new `{kind:"oscillation"}` verdict detected by scanning the ring buffer for a repeating period-k block (k≥2, ≥2 full cycles). The loop's existing `if (verdict.kind !== "none")` reflection branch already routes ANY non-`none` verdict, so loop.ts only needs a `buildReflectionNote` branch + a larger ring-buffer cap (to hold `2×maxPeriod` entries).
- #65 replaces the canned hard-stop `summary` with one final **tools-disabled** `streamChat` turn (no tool definitions → the model cannot resume the loop), falling back to the existing deterministic `synthesizeAgentTurnText` / canned string on error/empty/abort. The termination guarantee (`MAX_REFLECTIONS` cap → always `emitDone(success:false)`) is unchanged.

**Tech Stack:** TypeScript / vitest (happy-dom). No new deps.

**Base:** branched from `main` which already contains #61 (PR #63). Baseline: 969 tests green.

---

## Key facts verified against current code (post-#61)

- `loop-detection.ts` exports `stableStringify`, `stepSignature`, `detectLoop(recent, currentSig, options?)`, `recordStep(buffer, entry, cap)`, and types `ToolCallLike` / `StepSignature {sig, allErrored}` / `LoopVerdict` (`none` | `exact-repeat{count}` | `repeat-error{count}`) / `DetectLoopOptions`.
- `detectLoop` checks B (repeat-error) then A (exact-repeat); both look only at the trailing contiguous run equal to `currentSig`.
- In `loop.ts`:
  - `RECENT_STEPS_CAP = 5` (`:729`), `MAX_REFLECTIONS = 2` (`:732`), `REFLECTION_SKIP_RESULT` (`:737`), `buildReflectionNote(verdict, attempt)` (`:744`).
  - Reflection branch at `:1435`: `if (verdict.kind !== "none") { … }` — handles BOTH reflect and the `reflectionCount >= MAX_REFLECTIONS` hard-stop (`:1443`). The hard-stop currently does `emitDone({success:false, summary:"Agent got stuck repeating the same action and stopped.", stepCount:stepIndex}, "fail")`.
  - The wire-time pipeline (used each round): `applySlidingWindow` → `elideStaleObservations` → `applyTokenBudget(_, modelConfig.provider)` → `validateAndRepairAdjacentRoles`. All four are already imported in loop.ts, as is `streamChat` (`:3`) and `synthesizeAgentTurnText` (`:50`).
  - `streamChat(modelConfig, history, signal, toolDefinitions)` yields events: `text-delta {text}`, `tool-call-start/delta/end`, `error {error}`. Passing `[]` for `toolDefinitions` disables all tools.
- `loop-reflection.test.ts` exists: mocks `../model-router` (`streamChat`), `./frame-discovery` (`getAllFramesAndDiff`), and uses the shared chrome mock in `src/test/setup.ts`. Its `streamChat` mock yields the same tool call each invocation.

---

## File Structure

- **Modify** `src/lib/agent/loop-detection.ts` — add `oscillation` verdict + `detectOscillation` + options; integrate into `detectLoop`.
- **Modify** `src/lib/agent/loop-detection.test.ts` — oscillation cases (TDD).
- **Modify** `src/lib/agent/loop.ts` — `buildReflectionNote` oscillation branch; bump `RECENT_STEPS_CAP`; add `REFLECTION_GIVEUP_RESULT`; add `generateStuckSummary` helper; rewire the hard-stop to use it.
- **Modify** `src/lib/agent/loop-reflection.test.ts` — add oscillation→reflect integration case (#64) and model-authored-summary on hard-stop case (#65).
- **Create** `docs/release-notes/v0.12.1.md` — changelog for both follow-ups.

---

## Task 1: #64 — oscillation detection in `loop-detection.ts` (TDD)

**Files:**
- Modify: `src/lib/agent/loop-detection.ts`
- Test: `src/lib/agent/loop-detection.test.ts`

- [ ] **Step 1: Add failing tests**

Append a new `describe` block to `loop-detection.test.ts` (reuse the existing `ok`/`err` helpers if in scope; otherwise red([ine locally as shown):

```ts
describe("detectLoop — oscillation (period-k)", () => {
  const ok = (s: string): StepSignature => ({ sig: s, allErrored: false });

  it("fires oscillation on a→b→a→b (period 2, 2 cycles)", () => {
    // recent = [a, b, a]; current = b → trailing [a,b,a,b] = 2× [a,b]
    expect(detectLoop([ok("a"), ok("b"), ok("a")], "b")).toEqual({
      kind: "oscillation",
      period: 2,
      cycles: 2,
    });
  });

  it("does NOT fire on a→b→a (only 1.5 cycles)", () => {
    expect(detectLoop([ok("a"), ok("b")], "a")).toEqual({ kind: "none" });
  });

  it("fires oscillation on a→b→c→a→b→c (period 3, 2 cycles)", () => {
    expect(
      detectLoop([ok("a"), ok("b"), ok("c"), ok("a"), ok("b")], "c"),
    ).toEqual({ kind: "oscillation", period: 3, cycles: 2 });
  });

  it("prefers exact-repeat over oscillation for identical runs", () => {
    // [a,a,a] is a pure repeat, not an oscillation
    expect(detectLoop([ok("a"), ok("a")], "a")).toEqual({
      kind: "exact-repeat",
      count: 3,
    });
  });

  it("does not treat a period whose block is all-identical as oscillation", () => {
    // trailing [a,a,a,a]: period-2 block [a,a] is all-identical → not oscillation;
    // exact-repeat (period 1) fires instead.
    expect(detectLoop([ok("a"), ok("a"), ok("a")], "a")).toEqual({
      kind: "exact-repeat",
      count: 4,
    });
  });

  it("respects oscillationMinCycles override", () => {
    // require 3 cycles → a→b→a→b (2 cycles) should NOT fire
    expect(
      detectLoop([ok("a"), ok("b"), ok("a")], "b", { oscillationMinCycles: 3 }),
    ).toEqual({ kind: "none" });
  });
});
```

- [ ] **Step 2: Run, confirm FAIL**

Run: `pnpm test -- src/lib/agent/loop-detection.test.ts`
Expected: FAIL (oscillation verdict not produced).

- [ ] **Step 3: Implement**

In `loop-detection.ts`:

(3a) Extend the `LoopVerdict` union (add the oscillation variant):

```ts
export type LoopVerdict =
  /** No loop detected. */
  | { kind: "none" }
  /** A — the same signature is about to run for the Nth consecutive time. */
  | { kind: "exact-repeat"; count: number }
  /** B — the same signature repeated and the prior occurrences all errored. */
  | { kind: "repeat-error"; count: number }
  /** C — the agent is cycling between the same `period` distinct actions
   *  (e.g. a→b→a→b), repeated `cycles` full times, with no progress. */
  | { kind: "oscillation"; period: number; cycles: number };
```

(3b) Extend `DetectLoopOptions`:

```ts
export interface DetectLoopOptions {
  /** Consecutive identical steps (incl. the current one) that trip A. Default 3. */
  exactRepeatThreshold?: number;
  /** Consecutive identical errored steps (incl. current) that trip B. Default 2. */
  repeatErrorThreshold?: number;
  /** Largest cycle period to scan for (C). Default 3. Period 1 == exact-repeat. */
  oscillationMaxPeriod?: number;
  /** Minimum number of full cycles required to call it an oscillation (C).
   *  Default 2 (i.e. the block must appear at least twice: a→b→a→b). */
  oscillationMinCycles?: number;
}
```

(3c) Add the detector helper ABOVE `detectLoop`:

```ts
/**
 * #64(C) — detect a period-p oscillation in the signature sequence
 * `seq` (oldest→newest, current step last). Returns the smallest qualifying
 * period in [2, maxPeriod] whose last `minCycles` blocks are all identical,
 * or null. A block whose entries are all identical is NOT an oscillation
 * (that is exact-repeat / period 1, handled separately).
 */
function detectOscillation(
  seq: ReadonlyArray<string>,
  maxPeriod: number,
  minCycles: number,
): { period: number; cycles: number } | null {
  for (let p = 2; p <= maxPeriod; p++) {
    const need = p * minCycles;
    if (seq.length < need) continue;
    const tail = seq.slice(seq.length - need);
    const pattern = tail.slice(tail.length - p); // last p entries define the block
    // The block must contain at least two distinct sigs, else it's a pure repeat.
    if (new Set(pattern).size < 2) continue;
    let matches = true;
    for (let i = 0; i < need; i++) {
      if (tail[i] !== pattern[i % p]) {
        matches = false;
        break;
      }
    }
    if (matches) return { period: p, cycles: minCycles };
  }
  return null;
}
```

(3d) Extend `detectLoop` — read the two new options and, AFTER the existing B/A checks and BEFORE `return { kind: "none" }`, add the oscillation scan:

```ts
export function detectLoop(
  recent: ReadonlyArray<StepSignature>,
  currentSig: string,
  options: DetectLoopOptions = {},
): LoopVerdict {
  const exactRepeatThreshold = options.exactRepeatThreshold ?? 3;
  const repeatErrorThreshold = options.repeatErrorThreshold ?? 2;
  const oscillationMaxPeriod = options.oscillationMaxPeriod ?? 3;
  const oscillationMinCycles = options.oscillationMinCycles ?? 2;

  let run = 0;
  let runAllErrored = true;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].sig !== currentSig) break;
    run++;
    if (!recent[i].allErrored) runAllErrored = false;
  }
  const effective = run + 1; // include the current step

  if (run > 0 && runAllErrored && effective >= repeatErrorThreshold) {
    return { kind: "repeat-error", count: effective };
  }
  if (effective >= exactRepeatThreshold) {
    return { kind: "exact-repeat", count: effective };
  }

  // C — oscillation (period ≥ 2). Checked after the period-1 detectors so a
  // pure repeat is always reported as exact-repeat, not oscillation.
  const seq = [...recent.map((r) => r.sig), currentSig];
  const osc = detectOscillation(seq, oscillationMaxPeriod, oscillationMinCycles);
  if (osc) {
    return { kind: "oscillation", period: osc.period, cycles: osc.cycles };
  }

  return { kind: "none" };
}
```

- [ ] **Step 4: Run, confirm PASS**

Run: `pnpm test -- src/lib/agent/loop-detection.test.ts`
Expected: PASS (oscillation cases + all pre-existing A/B cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/loop-detection.ts src/lib/agent/loop-detection.test.ts
git commit -m "feat(agent): oscillation / period-k loop detection (#64)"
```

---

## Task 2: #64 — wire oscillation into `loop.ts` (reflection note + ring-buffer cap)

**Files:**
- Modify: `src/lib/agent/loop.ts` — `RECENT_STEPS_CAP` (`:725-729`), `buildReflectionNote` (`:744-758`)

- [ ] **Step 1: Bump the ring-buffer cap**

The oscillation detector needs `oscillationMaxPeriod × oscillationMinCycles = 3 × 2 = 6` signatures in `seq` (= `recent` + current), so `recent` must hold ≥ 5. Bump the cap to 6 to comfortably cover period-3×2 with slack. Replace the `RECENT_STEPS_CAP` declaration + comment:

```ts
/** Max recent step signatures kept for loop detection. Chosen to hold at least
 *  oscillationMaxPeriod × oscillationMinCycles (= 3 × 2 = 6) signatures including
 *  the current step, so a period-3 oscillation (a→b→c→a→b→c) is detectable; also
 *  comfortably exceeds exactRepeatThreshold (3) so a trailing identical run is
 *  never truncated before tripping the A-detector. */
const RECENT_STEPS_CAP = 6;
```

- [ ] **Step 2: Add the oscillation branch to `buildReflectionNote`**

`buildReflectionNote` builds the `why` clause by verdict kind. Add an `oscillation` branch. Replace the `why` assignment:

```ts
  const why =
    verdict.kind === "repeat-error"
      ? `your last ${verdict.count} attempts at the same action all failed`
      : verdict.kind === "exact-repeat"
        ? `you have issued the same action ${verdict.count} times in a row with no apparent progress`
        : verdict.kind === "oscillation"
          ? `you are cycling between the same ${verdict.period} actions (a ${verdict.period}-step loop) without making progress`
          : // unreachable defensive default (LoopVerdict has no other kind that reaches here)
            "you appear to be repeating an action without progress";
```

- [ ] **Step 3: Verify**

Run: `pnpm test` and `pnpm build`
Expected: green. The existing `loop-reflection.test.ts` (identical errored clicks → B-detector) is unaffected by oscillation. TypeScript must narrow `verdict.period` correctly in the new branch.

- [ ] **Step 4: Commit**

```bash
git add src/lib/agent/loop.ts
git commit -m "feat(agent): route oscillation verdict through reflection + widen ring buffer (#64)"
```

---

## Task 3: #65 — model-authored failure summary on hard-stop

**Files:**
- Modify: `src/lib/agent/loop.ts` — add `REFLECTION_GIVEUP_RESULT`, add `generateStuckSummary`, rewire the `reflectionCount >= MAX_REFLECTIONS` branch (`:1443-1466`).

- [ ] **Step 1: Add the giveup tool_result content constant**

After `REFLECTION_SKIP_RESULT` (`:737-741`), add:

```ts
/** Trusted tool_result content used on the hard-stop (reflection budget
 *  exhausted) path. Unlike REFLECTION_SKIP_RESULT it does NOT invite another
 *  attempt — the next turn has NO tools — it asks the model for a final
 *  failure summary. NOT wrapped in <untrusted_*> (runtime-authored). */
const REFLECTION_GIVEUP_RESULT =
  "You are being stopped: you repeated the same action too many times without " +
  "progress and will not be allowed to act further. Reply with a brief final " +
  "summary (1–3 sentences) of what you were trying to do, what you attempted, " +
  "and why it could not be completed. Do not attempt any tool calls.";
```

- [ ] **Step 2: Add the `generateStuckSummary` helper**

After `buildReflectionNote` (`:758`, before the `// ── Main loop ─` section), add. This re-runs the same wire-time pipeline on the updated history and asks the model for a summary with NO tools (so it cannot resume the loop). Returns `null` on abort / stream error / empty output so the caller can fall back.

```ts
/**
 * #65 — final, tools-disabled LLM turn that asks the stuck model to author its
 * own failure summary. Passing an empty tool list means the model cannot emit
 * a tool call to resume the loop; we only collect its text. Returns the trimmed
 * text, or null on abort / stream error / empty output (caller falls back to a
 * deterministic summary). Costs one LLM call, only on the rare hard-stop path.
 */
async function generateStuckSummary(
  modelConfig: ModelConfig,
  history: AgentMessage[],
  signal: AbortSignal,
): Promise<string | null> {
  if (signal.aborted) return null;
  const slid = applySlidingWindow(history);
  const elided = elideStaleObservations(slid);
  const budgeted = await applyTokenBudget(elided, modelConfig.provider);
  const { repaired } = validateAndRepairAdjacentRoles(budgeted);
  let text = "";
  try {
    for await (const event of streamChat(modelConfig, repaired, signal, [])) {
      if (signal.aborted) return null;
      if (event.type === "text-delta") text += event.text;
      else if (event.type === "error") return null;
      // tool-call-* events are ignored — no tools were offered.
    }
  } catch {
    return null;
  }
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}
```

- [ ] **Step 3: Rewire the hard-stop branch**

In the reflection branch, the `if (reflectionCount >= MAX_REFLECTIONS) { … }` block currently builds `skipResults` from `REFLECTION_SKIP_RESULT` (shared with the reflect path) and emits a canned summary. Change ONLY the hard-stop block so it (a) uses giveup-flavored tool_results and (b) asks the model for the summary. The shared `skipResults` (built at `:1436-1441` from `REFLECTION_SKIP_RESULT`) stays for the reflect path; the hard-stop builds its OWN `giveupResults`.

Replace the hard-stop block (`:1443-1466`) with:

```ts
        if (reflectionCount >= MAX_REFLECTIONS) {
          // Reflection budget exhausted — hard terminate (#61). #65: give the
          // model ONE final tools-disabled turn to author its own failure
          // summary, falling back to a deterministic string. Termination is
          // still guaranteed — we emitDone(success:false) regardless.
          const giveupResults: ContentBlock[] = completedToolCalls.map((tc) => ({
            type: "tool_result",
            toolUseId: tc.id,
            content: REFLECTION_GIVEUP_RESULT,
            isError: true,
          }));
          history.push({ role: "assistant", content: assistantBlocks });
          history.push({ role: "user", content: giveupResults });
          if (ctx.onStepSnapshot) {
            const snap = buildSessionAgentSnapshot(history, stepIndex, hasImageContent);
            ctx.onStepSnapshot(snap).catch((e) => {
              console.warn(
                `[agent] snapshot (reflection-giveup) failed for session=${ctx.sessionId} step=${stepIndex}:`,
                e,
              );
            });
          }
          const llmSummary = await generateStuckSummary(modelConfig, history, signal);
          if (signal.aborted) return; // → finally emits an abort done
          const summary =
            llmSummary ?? "Agent got stuck repeating the same action and stopped.";
          await emitDone(
            {
              type: "agent-done-task",
              success: false,
              summary,
              stepCount: stepIndex,
            },
            "fail",
          );
          return;
        }
```

NOTE: leave the `skipResults` declaration at `:1436` as-is — it is still used by the reflect (non-giveup) path below. The giveup path now uses its own `giveupResults`.

- [ ] **Step 4: Verify**

Run: `pnpm test` and `pnpm build`
Expected: green. `ModelConfig` and `AgentMessage` types are already imported in loop.ts; `applySlidingWindow` / `elideStaleObservations` / `applyTokenBudget` / `validateAndRepairAdjacentRoles` / `streamChat` are all already imported.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/loop.ts
git commit -m "feat(agent): model-authored failure summary on reflection hard-stop (#65)"
```

---

## Task 4: Integration tests for #64 + #65

**Files:**
- Modify: `src/lib/agent/loop-reflection.test.ts`

Reuse the existing harness in this file (mocked `streamChat` / `getAllFramesAndDiff` / chrome). Read the file first to match its exact setup (mock factory shape, how `runAgentLoop` is imported and invoked, how `port.postMessage` and `onStepSnapshot` are captured).

- [ ] **Step 1: #64 oscillation → reflect integration test**

Add a test that drives an a→b→a→b oscillation by making the mocked `streamChat` ALTERNATE between two distinct tool calls per invocation (e.g. `click {elementIndex:1}` on even calls, `click {elementIndex:2}` on odd calls — distinct args ⇒ distinct signatures). Assert that a `tool:"reflect"` agent-step is emitted whose `observation` matches `/cycling between the same 2 actions/` (the oscillation note). Keep bounds loose (don't pin exact step index).

Sketch (adapt to the file's actual mock factory):

```ts
it("detects an a→b→a→b oscillation and emits a reflect step (#64)", async () => {
  let n = 0;
  streamChatMock.mockImplementation(async function* (_cfg, _hist, _sig, tools) {
    // final tools-disabled summary turn (if reached) → yield text
    if (Array.isArray(tools) && tools.length === 0) {
      yield { type: "text-delta", text: "I kept alternating between two buttons." };
      return;
    }
    const idx = n % 2 === 0 ? 1 : 2; // alternate → a, b, a, b …
    n++;
    const id = `t${n}`;
    yield { type: "tool-call-start", id, index: 0, name: "click" };
    yield { type: "tool-call-delta", index: 0, argsDelta: JSON.stringify({ elementIndex: idx, frameId: 0 }) };
    yield { type: "tool-call-end", index: 0 };
  });

  await runAgentLoop(ctx); // build ctx per the file's existing pattern

  const reflectSteps = postedAgentSteps().filter((s) => s.tool === "reflect");
  expect(reflectSteps.length).toBeGreaterThanOrEqual(1);
  expect(reflectSteps.some((s) => /cycling between the same 2 actions/.test(s.observation ?? ""))).toBe(true);
});
```

- [ ] **Step 2: #65 model-authored summary integration test**

Drive the existing identical-action loop to the hard-stop (as the existing test does), but make the mocked `streamChat` detect the final tools-disabled turn (`tools.length === 0`) and yield a distinctive text. Assert the `agent-done-task` posted has `success:false` and a `summary` containing that text (proving the model-authored summary path, not the canned fallback).

Sketch:

```ts
it("uses the model-authored summary on hard-stop when available (#65)", async () => {
  streamChatMock.mockImplementation(async function* (_cfg, _hist, _sig, tools) {
    if (Array.isArray(tools) && tools.length === 0) {
      yield { type: "text-delta", text: "FINAL_SUMMARY: the Place Order button never worked." };
      return;
    }
    // same identical click every action turn (drives the loop to hard-stop)
    const id = `t${++callCount}`;
    yield { type: "tool-call-start", id, index: 0, name: "click" };
    yield { type: "tool-call-delta", index: 0, argsDelta: JSON.stringify({ elementIndex: 5, frameId: 0 }) };
    yield { type: "tool-call-end", index: 0 };
  });

  await runAgentLoop(ctx);

  const done = postedDoneMessages().find((m) => m.type === "agent-done-task");
  expect(done?.success).toBe(false);
  expect(done?.summary).toContain("FINAL_SUMMARY: the Place Order button never worked.");
});
```

Also confirm (can be the same or a third test) the FALLBACK: if the tools-disabled turn yields an `error` event or empty text, the done summary falls back to `"Agent got stuck repeating the same action and stopped."`.

- [ ] **Step 3: Run + verify**

Run: `pnpm test -- src/lib/agent/loop-reflection.test.ts` then full `pnpm test`.
Expected: new tests pass; existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/agent/loop-reflection.test.ts
git commit -m "test(agent): integration coverage for oscillation (#64) + model-authored stuck summary (#65)"
```

---

## Task 5: Release note + final verification

**Files:**
- Create: `docs/release-notes/v0.12.1.md`

- [ ] **Step 1: Full verification**

Run: `pnpm test` (all green) and `pnpm build` (succeeds, manifest invariants pass).

- [ ] **Step 2: Write release note**

Create `docs/release-notes/v0.12.1.md` in the established English-first + `## 中文摘要` format. Cover: (#64) oscillation/period-k detection extending the loop detector; (#65) the hard-stop now produces a model-authored failure summary (one final tools-disabled LLM turn) instead of a canned message, with a deterministic fallback and the termination guarantee preserved. Do NOT bump package.json/manifest version (release flow owns that).

- [ ] **Step 3: Commit**

```bash
git add docs/release-notes/v0.12.1.md
git commit -m "docs(release-notes): v0.12.1 — oscillation detection + model-authored stuck summary (#64/#65)"
```

---

## Self-Review

**Spec coverage:**
- #64 oscillation detection → Task 1 (pure detector + TDD) + Task 2 (route through existing reflection branch via buildReflectionNote + cap bump) + Task 4 step 1 (integration). ✅
- #65 model-authored stuck summary → Task 3 (REFLECTION_GIVEUP_RESULT + generateStuckSummary + rewire hard-stop, with fallback + preserved termination guarantee) + Task 4 step 2 (integration incl. fallback). ✅
- Both issues' constraints honored: oscillation stays deterministic/zero-LLM; #65 keeps the `MAX_REFLECTIONS` termination guarantee and only adds one LLM call on the rare hard-stop, with deterministic fallback. ✅

**Placeholder scan:** all code steps give complete, paste-ready code with precise anchors. Task 4 sketches are marked "adapt to the file's actual mock factory" because the exact mock variable names live in the existing test file — the implementer must read it first (explicitly instructed). ✅

**Type consistency:** new `LoopVerdict` `oscillation` variant (`period`/`cycles`) is consumed in `buildReflectionNote` (Task 2) and asserted in tests (Tasks 1, 4). `generateStuckSummary(modelConfig, history, signal)` signature matches its call site in Task 3. `DetectLoopOptions` new fields (`oscillationMaxPeriod`/`oscillationMinCycles`) consumed in `detectLoop`. ✅

**Line-number caveat:** loop.ts line numbers are from the current worktree; locate insertion points via the named anchors (`RECENT_STEPS_CAP`, `buildReflectionNote`, `REFLECTION_SKIP_RESULT`, `if (reflectionCount >= MAX_REFLECTIONS)`), not absolute lines.
