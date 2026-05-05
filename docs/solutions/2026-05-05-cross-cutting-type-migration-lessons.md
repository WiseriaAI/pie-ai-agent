---
title: Cross-Cutting Type Migration — Engineering Lessons (v1.5 Multi-Pin Epic)
date: "2026-05-05"
module: sessions/multi-pin-type-migration
problem_type: best_practice
component: development_workflow
symptoms:
  - "Silent no-op: per-iteration focus refresh never fired because storage read targeted wrong state slice"
  - "Snapshot clobber: new cross-step fields (currentFocusTabId) dropped silently by full-replace setSessionAgent()"
  - "Panel UI silently broken by stripping legacy fields before all readers migrated"
  - "Multiple unit tests green, build green, but feature broken end-to-end"
root_cause: logic_error
resolution_type: workflow_improvement
severity: high
related_components:
  - testing_framework
  - assistant
tags:
  - type-migration
  - phased-deletion
  - dual-write-shim
  - snapshot-merge
  - integration-testing
  - silent-failure
  - cross-cutting-refactor
  - subagent-driven-development
---

# Cross-Cutting Type Migration — Engineering Lessons (v1.5 Multi-Pin Epic)

> **Scope:** This is **pattern documentation**, not feature documentation. The v1.5 multi-pin feature itself is documented in `docs/solutions/2026-05-03-multi-session-invariant-trace.md` (§v1.5 section, lines 258-295) and `docs/release-notes/v0.5.2.md`. The plan is at `docs/superpowers/plans/2026-05-04-tabs-create-and-multi-pin-v2.md`. Read those for "what shipped". Read this for "how to ship the next cross-cutting migration without the failure modes that almost slipped through this one."

## Problem

Shipping a 10-task cross-cutting migration that replaces a type field used by N consumers (here: `SessionMeta.pinnedTabId/Origin` → `pinnedTabs: Array<{tabId, origin}>`) requires keeping the build green across every intermediate task **while also** keeping production runtime behavior correct — not just unit-test-passing. Two orthogonal failure modes compound: breaking the type system mid-chain (all subsequent tasks can't compile), and silently broken runtime behavior that no unit test catches because the bug lives in the interaction between a helper function and the storage round-trip it is called from.

Both failure modes nearly shipped during the v1.5 epic — caught only by code review reading actual call-sites, not by 572 passing tests.

## Symptoms

What goes wrong if you do not apply these patterns:

- **Compile errors mid-chain**: deleting a type field in Task 1 causes all N-1 subsequent tasks to inherit a broken build; you cannot run tests against a task while a later task still reads the deleted field.
- **Silent no-op features**: a new tool (`focus_tab`) appears to work, multiple tests pass, but every agent-loop iteration silently falls back to `pinnedTabs[0]` because a missing `await` makes `agentSnap` a `Promise` object, causing `?.currentFocusTabId` to always be `undefined`.
- **Dropped state across snapshot boundaries**: `currentFocusTabId` set by `focus_tab` in iteration N is overwritten by the next `onStepSnapshot` call because the snapshot builder produces a fresh object that does not carry the field; `setSessionAgent` does a full key replace.
- **Tests-pass-but-feature-broken**: 551 tests green, build clean, and the feature silently does nothing in production — because pure-helper unit tests do not exercise the storage round-trip where the async bug lives.
- **Silent regression in unrelated consumers**: strip-on-write that removes the old field during migration breaks React hooks reading `meta.pinnedOrigin` at their existing field paths, freezing derived state at `null` with no error.

## What Didn't Work

**1. Deleting the legacy fields in Task 1.**
The original Task 1 plan included "delete `SessionMeta.pinnedTabId/Origin`". This would have broken every file that reads those fields (`storage.ts`, `useSession.ts`, `Chat.tsx`, `background/index.ts`) in the same commit, making Tasks 2–9 impossible to execute against a green build. Caught before dispatch — but worth documenting because deletion is the natural first instinct.

**2. Strip-on-write storage migration.**
Task 2's initial approach deleted the legacy fields during every `setSessionMeta` call. This immediately broke 6 `useSession.test.ts` tests — they read `meta.pinnedTabId` after `setSessionMeta` and found it gone. More critically, `useSession.ts` line 647 reads `meta.pinnedOrigin` for React state; stripping the field on write froze that derived state at `null` with no error or test failure to surface it.

**3. Pure-helper unit tests for storage-round-trip code.**
`resolveFocusedPin(pinnedTabs, currentFocusTabId)` had 3 passing unit tests that verified its pure logic. The loop's call-site had two compounding bugs neither test could see: the missing `await` on `getSessionAgent` (making `agentSnap` a `Promise`), and the wrong field path (`agentSnap?.pinnedTabs` — `pinnedTabs` is on `SessionMeta`, not `SessionAgentState`). All 551 tests passed. The bug was caught by code review reading the production call-site, not by any automated check.

**4. Trusting that `setSessionAgent(sessionId, snapshot)` preserves fields.**
`buildSessionAgentSnapshot(history, stepIndex, skillStack, hasImageContent)` returns a fresh object. It does not carry `currentFocusTabId` or `pendingConfirm`. Because `setSessionAgent` writes `chrome.storage.local.set({[agentKey(id)]: state})` — a full key replace — every step boundary overwrites whatever `focus_tab` had written to `currentFocusTabId` in the previous iteration. Caught by code review; the 7 `focus_tab` tests did not exercise the persistence path.

## Solution

Four patterns, applied in the order they were needed during the v1.5 chain:

### Pattern 1: Phased Deletion Keeps Every Intermediate Commit Green

When migrating a type field with N consumers, mark it `@deprecated` with a removal-task reference rather than deleting it in the same commit that introduces the replacement. Add new fields and helpers alongside the old ones. Tasks 2–9 migrate consumers one-by-one, each commit independently green. Task 10 runs a grep audit and deletes only when no production reader remains.

```typescript
// Task 1: field is deprecated, NOT deleted
interface SessionMeta {
  /** @deprecated v1.5 — will be removed in Task 10. Use pinnedTabs[0].tabId */
  pinnedTabId?: number;
  /** @deprecated v1.5 — will be removed in Task 10. Use pinnedTabs[0].origin */
  pinnedOrigin?: string;
  pinnedTabs?: Array<{ tabId: number; origin: string }>;
}

// Task 10: delete only after grep returns 0 hits
//   grep -rn "meta\.pinnedTabId" src/ → 0 results
//   grep -rn "meta\.pinnedOrigin" src/ → 0 results
// → safe to delete legacy field declarations
```

### Pattern 2: Dual-Write Shim Keeps Old Readers Working During Migration

When a storage field is being replaced and N consumers still read the old shape, make the new shape canonical and synthesize the old shape from the new on every write. Old readers continue to work unmodified. New code reads from `pinnedTabs[]`. The shim is the single place to delete in Task 10.

```typescript
function syncLegacyFromArray(meta: SessionMeta): SessionMeta {
  const next = { ...meta };
  delete next.pinnedTabId;   // drop caller-supplied stale legacy
  delete next.pinnedOrigin;
  const primary = next.pinnedTabs?.[0];
  if (primary) {
    next.pinnedTabId = primary.tabId;   // synthesize from primary pin
    next.pinnedOrigin = primary.origin;
  }
  return next;
}
```

Every `setSessionMeta` call passes through `syncLegacyFromArray` before writing to storage. `pinnedTabs[]` drives the value; legacy fields are derived output. Consumers that haven't migrated yet still read the correct value.

### Pattern 3: Merge-Not-Replace Snapshot Writes Preserve Fields Added by Other Code Paths

When a storage write helper does a full key replace, any field written by a different code path (a tool, a lifecycle event) is silently dropped at the next write. Extract a `mergeSessionAgentSnapshot` pure helper that merges new snapshot fields over the existing state. Only bypass the merge for tombstone resets (task completion with `stepIndex=0, agentMessages=[]`) to keep `emitDone` clean.

```typescript
export function mergeSessionAgentSnapshot(
  existing: SessionAgentState | undefined,
  snapshot: SessionAgentState,
): SessionAgentState {
  const isTombstone =
    snapshot.stepIndex === 0 && snapshot.agentMessages.length === 0;
  if (isTombstone) return snapshot;
  return existing ? { ...existing, ...snapshot } : snapshot;
}
```

The agent loop's `onStepSnapshot` now calls `mergeSessionAgentSnapshot(await getSessionAgent(sessionId), snapshot)` before writing. Fields set by `focus_tab` (`currentFocusTabId`) and by `setPendingConfirm` (`pendingConfirm`) survive across step boundaries.

### Pattern 4: Integration Tests That Empirically Fail When Async/Field-Path Is Wrong

Replace the per-iteration inline refresh with an extracted async helper whose tests are written to fail when the `await` is removed or the field path is wrong.

```typescript
// Broken call-site (pre-fix):
const agentSnap = getSessionAgent(sessionId); // missing await → Promise object
const focus = resolveFocusedPin(
  agentSnap?.pinnedTabs ?? ctx.pinnedTabs, // wrong: pinnedTabs not on SessionAgentState
  agentSnap?.currentFocusTabId,            // always undefined
);

// Correct extracted helper:
export async function readFocusFromStorage(
  sessionId: string,
  ctxPinnedTabs: ReadonlyArray<{ tabId: number; origin: string }>,
): Promise<{ tabId: number; origin: string } | undefined> {
  const [agentSnap, metaSnap] = await Promise.all([
    getSessionAgent(sessionId),
    getSessionMeta(sessionId),
  ]);
  const refreshedPins = metaSnap?.pinnedTabs ?? ctxPinnedTabs ?? [];
  return resolveFocusedPin(refreshedPins, agentSnap?.currentFocusTabId);
}
```

Regression tests for `readFocusFromStorage` call the function through a real (fake-storage) round-trip and assert the return value. They are designed to fail when:
- the `await` is removed (returns `Promise` which has no `.pinnedTabs`)
- the field path reads from `agentSnap.pinnedTabs` instead of `metaSnap.pinnedTabs`
- `currentFocusTabId` is read from `metaSnap` instead of `agentSnap`

## Why This Works

Each pattern decouples the migration's safety from the order in which consumers are updated:

- **Phased deletion** means every task can proceed independently against a green type system. The deprecated annotation is a self-documenting contract: "this field will be here until Task 10; migrate at your own pace."
- **Dual-write** means no consumer needs to know the migration is in progress. New shape is canonical; old shape is derived. Correctness is enforced in one place (the shim), not across every reader.
- **Merge-not-replace** makes it safe to add new fields to a persisted type without auditing every write path — the merge preserves what it doesn't know about.
- **Integration tests over pure-helper tests** catch bugs that live in the gap between the helper's logic and the context it is called from. A pure test proves the helper is correct in isolation; an integration test proves the call-site uses it correctly including async discipline.

These four patterns compose: phased deletion buys time for dual-write to run; dual-write buys correctness for old readers while new ones migrate; merge-not-replace buys field safety at write boundaries; integration tests enforce the invariants that cannot be checked by type signatures alone (async correctness, field-path matching, storage round-trip behavior).

## Prevention

Concrete checklist for future cross-cutting migrations:

1. **Audit storage write helpers before adding any new field.** Open each write helper and determine: does it do `chrome.storage.local.set({[key]: freshObject})` (full replace) or does it read-merge-write? If full replace, every new field added to the type is at risk of being dropped at the next write. Plan a `mergeSnapshot` helper or convert to a merge-write before adding the field.

2. **Never delete a type field in the same commit that introduces the replacement.** If N > 3 production reads exist, use phased deletion: `@deprecated <version> — removed in Task N` JSDoc, keep declarations through all migration tasks, run `grep -rn "fieldName" src/` in the final task to confirm zero production hits before deleting.

3. **Use dual-write (not strip-on-write) for storage field shape migration.** Make the new shape canonical; synthesize the old shape from new data in the write helper. Remove the synthesizer only after all readers have migrated to the new shape. Strip-on-write breaks readers silently — no type error, no failing test, just frozen state.

4. **For any helper that is called through a storage round-trip in production, write at least one integration test that exercises the full path.** The test should fail when: (a) the `await` keyword is removed from the storage call, (b) the field path is changed to a field that does not exist on the type actually returned. Pure-function tests for the helper's logic are insufficient because they cannot observe async discipline or field-path mistakes.

5. **Add a search step to code review for the missing-await pattern.** Before merging any commit that calls `getX(sessionId)` and then does `?.field` on the result, search for the pattern `getX(` not preceded by `await` or `const [...] = await Promise.all`. This pattern compiles silently and produces a `Promise` object whose optional-chain accesses always return `undefined`.

This generalizes the project's existing memory rule (`feedback_cross_layer_integration_tests.md` — auto memory [claude]): "Any cross-layer wire field must have a wire→DisplayMessage transit regression test; high unit-test count cannot replace integration tests (Phase 5 acceptance bug lesson)." The v1.5 epic confirms the same insight applies not just to wire→panel hops, but to **any cross-layer state path** — storage round-trips, snapshot persistence, async helper call-sites.

## Related Issues

- `docs/solutions/2026-05-03-multi-session-invariant-trace.md` §v1.5 (lines 258-295) — Feature trace: schema, lifecycle table, dual-write shim, T10 cleanup. Read this for "what shipped".
- `docs/solutions/2026-05-04-multimodal-image-input-v1-acceptance-bugs.md` — Canonical cross-layer integration gap story; same class of bug at a different layer (wire→DisplayMessage). The integration test template originates here.
- `docs/superpowers/plans/2026-05-04-tabs-create-and-multi-pin-v2.md` — The plan that specified phased deletion + dual-write + clean-break sequencing.
- `docs/release-notes/v0.5.2.md` — User-facing BREAKING notice for the storage shape change.
- `docs/solutions/2026-05-02-session-as-first-class-persistent-layer-m1.md` — `writeAtomic` precedent and snapshot scrub symmetry (open/close pattern).

## Engineering Process Notes

- **Subagent-driven development worked well** for this 10-task chain. ~15-30 min per task (implementer + spec reviewer + code-quality reviewer). Critical bugs were caught by reviewers reading actual call-sites, not by tests.
- **Two critical bugs caught in review** (snapshot clobber, missing-await) would have shipped silently if relying on test-passing as the merge gate. Code review of the actual production flow remains load-bearing.
- **Plan revision mid-chain is OK.** The original plan said "strip-on-write"; switched to dual-write after the runtime regression surfaced. Documenting the why-we-changed in the commit message kept the plan→code traceable.
