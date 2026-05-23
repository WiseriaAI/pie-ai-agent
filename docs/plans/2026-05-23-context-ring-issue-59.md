# Context Ring (Issue #59) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the user a small SVG ring in the composer that visualizes "last LLM call's real input usage / model context limit", with a hover tooltip and a click-popover showing per-session cumulative tokens. Ring stays hidden until the first call returns real usage.

**Architecture:** SW captures `done.usage` per agent step, RMW-writes `SessionAgentState.contextUsage` (single writer, same storage key as the in-flight agent state, with explicit carry-over through `buildSessionAgentTombstone` so cross-task totals survive). SW pushes a new `agent-usage` wire event to the panel; panel mirrors it into an in-memory slot field and `useSession.setActive` rehydrates from storage on session switch. New `ContextRing.tsx` component renders the ring + tooltip + popover; it's mounted into the existing `Composer` action row in `Chat.tsx`.

**Tech Stack:** TypeScript 6, React 19, vitest + happy-dom + @testing-library/react, Chrome Extension MV3 storage + Port API, TailwindCSS v4 (inline styles for ring SVG since strokes are dynamic per-state).

**Spec:** `docs/specs/2026-05-23-context-ring-issue-59.md` — visual prototype in Pie Frontend Paper file, artboard "ContextRing · States · Dark".

**Pre-flight:** Verify you're on a fresh feature branch (e.g. `feat/issue-59-context-ring`), not `main`. `pnpm install`. `pnpm test` to baseline-pass. Reading `CLAUDE.md` is required for repo conventions (commit etiquette, build invariants in `tool-names.ts`, etc.).

---

## Task 1: Add types — SessionAgentState.contextUsage + AgentUsageMessage

**Files:**
- Modify: `src/lib/sessions/types.ts`
- Modify: `src/types/messages.ts`

Pure type additions. No runtime test; validated via `pnpm build` typecheck and downstream tasks that consume the types.

- [ ] **Step 1: Add `contextUsage` to `SessionAgentState`**

Open `src/lib/sessions/types.ts`. Find `export interface SessionAgentState { … }` (currently has `agentMessages`, `stepIndex`, `hasImageContent`, `pendingConfirm?`, `currentFocusTabId?`, `lastTaskSynth?`). Append a new optional field just before the closing `}`:

```ts
  /**
   * Issue #59 — per-session token usage. SW single-writer (loop.ts done
   * branch RMW). Tombstone carries over via `buildSessionAgentTombstone`,
   * so totals survive across tasks. Absent on old sessions / sessions
   * whose first LLM call hasn't returned yet — panel treats absence as
   * "don't render ring".
   */
  contextUsage?: {
    /** Cross-task cumulative input tokens across all LLM calls in this session. */
    totalInputTokens: number;
    /** Cross-task cumulative output tokens. */
    totalOutputTokens: number;
    /** Most recent step's real input usage. Numerator for ring percentage. */
    lastInputTokens: number;
    /** Most recent step's real output usage. Shown in popover total row. */
    lastOutputTokens: number;
  };
```

- [ ] **Step 2: Define `AgentUsageMessage` and add to `PortMessageToPanel`**

Open `src/types/messages.ts`. After the existing `ChatErrorMessage` interface (search for `interface ChatErrorMessage`), insert:

```ts
/**
 * Issue #59 — SW → Panel: emitted after each agent step whose stream produced
 * a real `done.usage`. Panel mirrors into `slot.usage` for ring rendering.
 * SW is the sole accumulator (`totalInputTokens`/`totalOutputTokens` are
 * pre-summed); panel replaces slot value, never `+=`, to avoid double-counting.
 *
 * Not emitted when:
 *   - provider doesn't surface `done.usage` (no fallback estimate)
 *   - `done.usage.inputTokens <= 0`
 *   - stream aborted before `done`
 */
export interface AgentUsageMessage {
  type: "agent-usage";
  /** M2-U2 — session routing. See ChatChunkMessage.sessionId. */
  sessionId: string;
  /** Most recent step's real input usage (provider `done.usage.inputTokens`). */
  lastInputTokens: number;
  /** Most recent step's real output usage. */
  lastOutputTokens: number;
  /** SW-cumulative running total of input tokens for this session. */
  totalInputTokens: number;
  /** SW-cumulative running total of output tokens for this session. */
  totalOutputTokens: number;
}
```

Then find `export type PortMessageToPanel` (search for it). Add `AgentUsageMessage` to the union. Example before/after — find the existing line that looks like:

```ts
export type PortMessageToPanel =
  | ChatChunkMessage
  | ChatDoneMessage
  | ChatErrorMessage
  | AgentStepMessage
  | AgentDoneTaskMessage
  …
```

Add `| AgentUsageMessage` somewhere in the union (alphabetical or grouped — match the file's existing pattern; if no clear pattern, slot it right after `ChatErrorMessage`).

- [ ] **Step 3: Typecheck**

Run: `pnpm build`
Expected: PASS (no type errors). If a downstream consumer of `PortMessageToPanel` does exhaustive switch checking on `msg.type`, TypeScript will complain — that's the desired signal for Task 4/6 wiring. For now, fix any compile errors that are *not* about exhaustive checks (those will be addressed in their respective tasks).

- [ ] **Step 4: Commit**

```bash
git add src/lib/sessions/types.ts src/types/messages.ts
git commit -m "feat(types): add SessionAgentState.contextUsage + AgentUsageMessage (#59)"
```

---

## Task 2: Tombstone carry-over for contextUsage

**Files:**
- Modify: `src/lib/agent/loop.ts:534` (function `buildSessionAgentTombstone`)
- Modify: `src/lib/agent/loop.ts` — every callsite of `buildSessionAgentTombstone` (search `buildSessionAgentTombstone(`)
- Test: `src/lib/agent/loop.test.ts` (existing file, append a new describe block)

Goal: `buildSessionAgentTombstone` accepts an optional `carryUsage`. Without it, tombstone is unchanged (back-compat). With it, the tombstone state carries `contextUsage`. All `emitDone` callsites read `getSessionAgent(sessionId)` first and pass `prev?.contextUsage` through.

- [ ] **Step 1: Write the failing test**

Open `src/lib/agent/loop.test.ts`. Append a new describe block at the end of the file:

```ts
describe("issue #59 — buildSessionAgentTombstone with carryUsage", () => {
  it("omits contextUsage when carryUsage not provided", () => {
    const tomb = buildSessionAgentTombstone();
    expect(tomb.contextUsage).toBeUndefined();
    expect(tomb.agentMessages).toEqual([]);
    expect(tomb.stepIndex).toBe(0);
    expect(tomb.hasImageContent).toBe(false);
  });

  it("carries contextUsage when provided", () => {
    const carry = {
      totalInputTokens: 5000,
      totalOutputTokens: 200,
      lastInputTokens: 1000,
      lastOutputTokens: 50,
    };
    const tomb = buildSessionAgentTombstone(undefined, carry);
    expect(tomb.contextUsage).toEqual(carry);
  });

  it("coexists with lastTaskSynth", () => {
    const tomb = buildSessionAgentTombstone("synth text", {
      totalInputTokens: 1,
      totalOutputTokens: 2,
      lastInputTokens: 3,
      lastOutputTokens: 4,
    });
    expect(tomb.lastTaskSynth).toBe("synth text");
    expect(tomb.contextUsage?.totalInputTokens).toBe(1);
  });

  it("treats null carryUsage same as undefined (omit field)", () => {
    // Defensive: callers may forward `prev?.contextUsage` which is undefined,
    // but some test paths might pass explicit null. Either way no field.
    const tomb = buildSessionAgentTombstone(undefined, undefined);
    expect("contextUsage" in tomb).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm test src/lib/agent/loop.test.ts -- -t "buildSessionAgentTombstone with carryUsage"`
Expected: FAIL with "expected 2 arguments, got 1" or similar — current signature takes one arg.

- [ ] **Step 3: Update signature and body**

Open `src/lib/agent/loop.ts`. Find `export function buildSessionAgentTombstone(` (around line 534). Replace with:

```ts
export function buildSessionAgentTombstone(
  lastTaskSynth?: string | null,
  carryUsage?: SessionAgentState["contextUsage"],
): SessionAgentState {
  const base: SessionAgentState = {
    agentMessages: [],
    stepIndex: 0,
    hasImageContent: false,
  };
  if (lastTaskSynth != null) {
    base.lastTaskSynth = lastTaskSynth;
  }
  if (carryUsage != null) {
    base.contextUsage = carryUsage;
  }
  return base;
}
```

- [ ] **Step 4: Update emitDone callsites to thread carryUsage**

In `src/lib/agent/loop.ts`, search for every occurrence of `buildSessionAgentTombstone(`. Each callsite currently looks roughly like:

```ts
const tombstone = buildSessionAgentTombstone(synth);
await setSessionAgent(sessionId, tombstone);
```

…or sometimes the value is passed inline. For each callsite, ensure `prev` (the `getSessionAgent(sessionId)` result already used by `emitDone` to fold synth) is read first, then pass `prev?.contextUsage` through. A typical patch:

```ts
// BEFORE
const tombstone = buildSessionAgentTombstone(synth);

// AFTER
const prev = await getSessionAgent(sessionId);  // may already exist nearby — reuse if so
const tombstone = buildSessionAgentTombstone(synth, prev?.contextUsage);
```

If a callsite already reads the prior state for `lastTaskSynth` purposes, just add the second argument — don't double-read.

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm test src/lib/agent/loop.test.ts`
Expected: PASS (the new describe + the existing `buildSessionAgentTombstone` / `mergeSessionAgentSnapshot` tests; the existing tests should remain green because the second parameter is optional).

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent/loop.ts src/lib/agent/loop.test.ts
git commit -m "feat(agent): tombstone carries contextUsage across tasks (#59)"
```

---

## Task 3: mergeContextUsage helper + verify snapshot merge preserves contextUsage

**Files:**
- Modify: `src/lib/agent/loop.ts` — add exported pure helper `mergeContextUsage`
- Test: `src/lib/agent/loop.test.ts` — two new describe blocks (helper + snapshot merge regression)

Goal: introduce a small pure function the loop will call to compute the next `contextUsage` value; separately add a regression test confirming that the existing `mergeSessionAgentSnapshot` already preserves `contextUsage` (since it does `{ ...existing, ...snapshot }` and step snapshots don't include `contextUsage`).

- [ ] **Step 1: Write failing tests for helper**

Append to `src/lib/agent/loop.test.ts`:

```ts
describe("issue #59 — mergeContextUsage", () => {
  it("initializes from undefined prev", () => {
    const next = mergeContextUsage(undefined, { inputTokens: 1200, outputTokens: 80 });
    expect(next).toEqual({
      totalInputTokens: 1200,
      totalOutputTokens: 80,
      lastInputTokens: 1200,
      lastOutputTokens: 80,
    });
  });

  it("accumulates over prior contextUsage", () => {
    const prev = {
      totalInputTokens: 5000,
      totalOutputTokens: 200,
      lastInputTokens: 900,
      lastOutputTokens: 40,
    };
    const next = mergeContextUsage(prev, { inputTokens: 300, outputTokens: 20 });
    expect(next).toEqual({
      totalInputTokens: 5300,
      totalOutputTokens: 220,
      lastInputTokens: 300,
      lastOutputTokens: 20,
    });
  });

  it("treats prev as new-shape baseline (no field omitted)", () => {
    const next = mergeContextUsage(undefined, { inputTokens: 1, outputTokens: 0 });
    expect(next).toHaveProperty("totalOutputTokens", 0);
    expect(next).toHaveProperty("lastOutputTokens", 0);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm test src/lib/agent/loop.test.ts -- -t "mergeContextUsage"`
Expected: FAIL with "mergeContextUsage is not defined" (import will need adding too).

- [ ] **Step 3: Implement `mergeContextUsage` in loop.ts**

In `src/lib/agent/loop.ts`, near `buildSessionAgentTombstone` (it's a sibling pure helper), add and export:

```ts
/**
 * Issue #59 — fold one step's real LLM usage into a session's running totals.
 * Pure function — no I/O. Caller persists the result via setSessionAgent.
 *
 * If `prev` is undefined, treats the step as the first LLM call for this
 * session (zeros baseline). `lastInputTokens` / `lastOutputTokens` always
 * reflect just-this-step (the ring's numerator + popover's "most recent").
 */
export function mergeContextUsage(
  prev: SessionAgentState["contextUsage"] | undefined,
  step: { inputTokens: number; outputTokens: number },
): NonNullable<SessionAgentState["contextUsage"]> {
  return {
    totalInputTokens: (prev?.totalInputTokens ?? 0) + step.inputTokens,
    totalOutputTokens: (prev?.totalOutputTokens ?? 0) + step.outputTokens,
    lastInputTokens: step.inputTokens,
    lastOutputTokens: step.outputTokens,
  };
}
```

If `loop.test.ts` imports from `./loop` via named imports (search for `import { buildSessionAgentTombstone …}`), add `mergeContextUsage` to that import.

- [ ] **Step 4: Write snapshot-merge regression test**

Append to `src/lib/agent/loop.test.ts` (right after the prior describe block):

```ts
describe("issue #59 — mergeSessionAgentSnapshot preserves contextUsage", () => {
  it("non-tombstone spread keeps existing.contextUsage when snapshot omits it", () => {
    const existing: SessionAgentState = {
      agentMessages: [{ role: "user", content: "hi" }],
      stepIndex: 3,
      hasImageContent: false,
      currentFocusTabId: 99,
      contextUsage: {
        totalInputTokens: 5000,
        totalOutputTokens: 200,
        lastInputTokens: 1000,
        lastOutputTokens: 50,
      },
    };
    const snapshot: SessionAgentState = {
      agentMessages: [{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }],
      stepIndex: 4,
      hasImageContent: false,
    };
    const merged = mergeSessionAgentSnapshot(existing, snapshot);
    expect(merged.contextUsage).toEqual(existing.contextUsage);
    expect(merged.currentFocusTabId).toBe(99); // sibling carry-over still works
    expect(merged.stepIndex).toBe(4); // snapshot wins for shared fields
  });

  it("tombstone full-replace drops existing.contextUsage IF tombstone doesn't carry it", () => {
    const existing: SessionAgentState = {
      agentMessages: [{ role: "user", content: "x" }],
      stepIndex: 5,
      hasImageContent: false,
      contextUsage: {
        totalInputTokens: 5000,
        totalOutputTokens: 200,
        lastInputTokens: 1000,
        lastOutputTokens: 50,
      },
    };
    // Tombstone shape WITHOUT carry — simulates a (buggy) caller forgetting
    // to pass carryUsage; documents that responsibility lives at the caller.
    const tombstoneWithoutCarry = buildSessionAgentTombstone();
    const merged = mergeSessionAgentSnapshot(existing, tombstoneWithoutCarry);
    expect(merged.contextUsage).toBeUndefined();
  });

  it("tombstone full-replace keeps carryUsage when caller passed it", () => {
    const existing: SessionAgentState = {
      agentMessages: [{ role: "user", content: "x" }],
      stepIndex: 5,
      hasImageContent: false,
      contextUsage: {
        totalInputTokens: 5000,
        totalOutputTokens: 200,
        lastInputTokens: 1000,
        lastOutputTokens: 50,
      },
    };
    const tombstoneWithCarry = buildSessionAgentTombstone(undefined, existing.contextUsage);
    const merged = mergeSessionAgentSnapshot(existing, tombstoneWithCarry);
    expect(merged.contextUsage).toEqual(existing.contextUsage);
  });
});
```

- [ ] **Step 5: Run all loop tests**

Run: `pnpm test src/lib/agent/loop.test.ts`
Expected: PASS (all new and old tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent/loop.ts src/lib/agent/loop.test.ts
git commit -m "feat(agent): mergeContextUsage helper + snapshot-merge regression (#59)"
```

---

## Task 4: Loop done-branch — capture, persist, postMessage

**Files:**
- Modify: `src/lib/agent/loop.ts` — inside the streaming consumer loop around line 1388-1430, and immediately after stream exits

This is the wiring task: the helper from Task 3 plus the tombstone carry from Task 2 already exist; here we capture `done.usage`, RMW-write the agent state, and post the wire event. Unit testing the full loop is impractical (no streamChat IoC); end-to-end coverage comes in Task 9 (cross-layer). This task is a careful diff with a thorough manual review.

- [ ] **Step 1: Locate the stream consumer**

Open `src/lib/agent/loop.ts`. Find the second `for await (const event of streamChat(...))` (line ~1388 — the first one at ~817 is for `generateStuckSummary`, not the main loop). It currently has branches for `text-delta`, `tool-call-start`, `tool-call-delta`, `tool-call-end`, `error`.

- [ ] **Step 2: Add `done` capture branch**

Inside that `for await` loop, before the existing `} else if (event.type === "error") {` branch, insert:

```ts
        } else if (event.type === "done") {
          // Issue #59 — capture real provider-reported usage for the ring.
          // Stored to a local and applied after the stream finishes; abort
          // and error paths skip the apply.
          if (event.usage && event.usage.inputTokens > 0) {
            lastStepUsage = event.usage;
          }
```

- [ ] **Step 3: Declare `lastStepUsage` local above the loop**

Above the `for await` (next to the existing `let __sawAnyEvent = false;`), declare:

```ts
      let lastStepUsage: { inputTokens: number; outputTokens: number } | null = null;
```

- [ ] **Step 4: Apply usage after stream exits**

Just after the `console.log("[sw][debug] streamChat exited", { … })` block and BEFORE the existing `if (signal.aborted) return;` guard, insert:

```ts
      // Issue #59 — persist & announce step usage. Done before the abort
      // check intentionally: if the provider emitted done with usage,
      // the LLM round-trip really happened and the tokens were really
      // spent; we should account for them even if the user aborted right
      // after. Storage failure is non-fatal (warn-only) — the loop must
      // not die over a metric write; the panel will catch up on the next
      // successful step.
      if (lastStepUsage) {
        try {
          const cur = await getSessionAgent(sessionId);
          const nextUsage = mergeContextUsage(cur?.contextUsage, lastStepUsage);
          const base: SessionAgentState = cur ?? {
            agentMessages: [],
            stepIndex: 0,
            hasImageContent: false,
          };
          await setSessionAgent(sessionId, { ...base, contextUsage: nextUsage });
          try {
            port.postMessage(
              withSession(
                {
                  type: "agent-usage",
                  lastInputTokens: nextUsage.lastInputTokens,
                  lastOutputTokens: nextUsage.lastOutputTokens,
                  totalInputTokens: nextUsage.totalInputTokens,
                  totalOutputTokens: nextUsage.totalOutputTokens,
                },
                sessionId,
              ),
            );
          } catch (e) {
            // Port disconnected mid-step — panel will rehydrate from
            // SessionAgentState on next mount via useSession.setActive.
            console.warn(
              `[agent] post agent-usage failed for session=${sessionId}:`,
              e,
            );
          }
        } catch (e) {
          console.warn(
            `[agent] persist contextUsage failed for session=${sessionId}:`,
            e,
          );
        }
      }
```

- [ ] **Step 5: Verify imports**

The file already imports `getSessionAgent`, `setSessionAgent`, and `SessionAgentState`. `mergeContextUsage` is defined in this same file (added in Task 3) so no import needed. `withSession` is a private function in this file.

- [ ] **Step 6: Build to catch typos**

Run: `pnpm build`
Expected: PASS. The `done`-branch type narrowing requires the union member to exist (it does, from `src/lib/model-router/types.ts:50-54`).

- [ ] **Step 7: Run existing loop tests to verify no regression**

Run: `pnpm test src/lib/agent/loop.test.ts`
Expected: PASS — pure helper additions don't touch the streaming path's existing test surface.

- [ ] **Step 8: Commit**

```bash
git add src/lib/agent/loop.ts
git commit -m "feat(agent): capture done.usage per step + persist + post agent-usage (#59)"
```

---

## Task 5: Runtime-map slot.usage field

**Files:**
- Modify: `src/sidepanel/hooks/useSession/runtime-map.ts`

Pure type addition + default. No test (covered by Task 6's port-handler test which reads/writes this field).

- [ ] **Step 1: Import the ContextUsage type**

Open `src/sidepanel/hooks/useSession/runtime-map.ts`. At the top, add to the existing import (or new import):

```ts
import type { SessionAgentState } from "@/lib/sessions/types";
```

- [ ] **Step 2: Add usage field to SessionRuntimeSlot**

In `export type SessionRuntimeSlot = { … }`, add a new field (alphabetize loosely or append at the bottom — match the file's style; appending is fine):

```ts
  /** Issue #59 — most recent contextUsage snapshot, sourced from
   *  agent-usage wire events (mid-task) or getSessionAgent on session
   *  switch (mount/setActive). undefined when no LLM call has returned
   *  yet for this session — the composer hides the ring in that state. */
  usage?: SessionAgentState["contextUsage"];
```

- [ ] **Step 3: EMPTY_SLOT keeps usage undefined**

`EMPTY_SLOT` is the literal at module scope. Since `usage` is optional, you can leave `EMPTY_SLOT` unchanged (omitting the field equals undefined). Verify TypeScript still accepts `EMPTY_SLOT` as `SessionRuntimeSlot` — it should, because the field is optional.

- [ ] **Step 4: Typecheck**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/hooks/useSession/runtime-map.ts
git commit -m "feat(sidepanel): slot.usage field for context ring state (#59)"
```

---

## Task 6: Port-handler `agent-usage` branch (TDD)

**Files:**
- Modify: `src/sidepanel/hooks/useSession/port-handlers.ts` — add new branch in `handleMessage`
- Test: `src/sidepanel/hooks/useSession/port-handlers.test.ts` — new describe

- [ ] **Step 1: Write failing tests**

Open `src/sidepanel/hooks/useSession/port-handlers.test.ts`. At the bottom of the file, append:

```ts
describe("agent-usage", () => {
  it("writes payload fields onto slot.usage for the matching sessionId", () => {
    const deps = makeDeps();
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({
      type: "agent-usage",
      sessionId: "s1",
      lastInputTokens: 1200,
      lastOutputTokens: 80,
      totalInputTokens: 5200,
      totalOutputTokens: 320,
    } as PortMessageToPanel);
    expect(deps.slotsRef.current.get("s1")?.usage).toEqual({
      lastInputTokens: 1200,
      lastOutputTokens: 80,
      totalInputTokens: 5200,
      totalOutputTokens: 320,
    });
  });

  it("does not call persistMessages (no storage write from panel side)", () => {
    const deps = makeDeps();
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({
      type: "agent-usage",
      sessionId: "s1",
      lastInputTokens: 100,
      lastOutputTokens: 5,
      totalInputTokens: 100,
      totalOutputTokens: 5,
    } as PortMessageToPanel);
    expect(deps.persistMessages).not.toHaveBeenCalled();
  });

  it("does not touch other sessions' slots", () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s2", {
      ...EMPTY_SLOT,
      usage: {
        totalInputTokens: 999,
        totalOutputTokens: 99,
        lastInputTokens: 99,
        lastOutputTokens: 9,
      },
    });
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({
      type: "agent-usage",
      sessionId: "s1",
      lastInputTokens: 1,
      lastOutputTokens: 1,
      totalInputTokens: 1,
      totalOutputTokens: 1,
    } as PortMessageToPanel);
    expect(deps.slotsRef.current.get("s2")?.usage?.totalInputTokens).toBe(999);
  });

  it("replaces (does not merge) the slot.usage object — SW pre-summed totals are authoritative", () => {
    const deps = makeDeps();
    deps.slotsRef.current.set("s1", {
      ...EMPTY_SLOT,
      usage: {
        totalInputTokens: 9999,
        totalOutputTokens: 999,
        lastInputTokens: 500,
        lastOutputTokens: 30,
      },
    });
    const { handleMessage } = createPortHandlers(deps);
    handleMessage({
      type: "agent-usage",
      sessionId: "s1",
      lastInputTokens: 200,
      lastOutputTokens: 10,
      totalInputTokens: 10199,
      totalOutputTokens: 1009,
    } as PortMessageToPanel);
    // Slot.usage equals the payload — no double-counting.
    expect(deps.slotsRef.current.get("s1")?.usage?.totalInputTokens).toBe(10199);
    expect(deps.slotsRef.current.get("s1")?.usage?.lastInputTokens).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/sidepanel/hooks/useSession/port-handlers.test.ts -- -t "agent-usage"`
Expected: FAIL — `slot.usage` is undefined because the handler hasn't been added.

- [ ] **Step 3: Add the handler branch**

Open `src/sidepanel/hooks/useSession/port-handlers.ts`. Locate `const handleMessage = (msg: PortMessageToPanel) => { …` and the existing if-chain (`chat-chunk`, `chat-done`, `chat-error`, `agent-step`, etc.). Add a new branch — placement: near the other agent-* branches, before the final fallthrough/no-op:

```ts
    if (msg.type === "agent-usage") {
      patchSlot(id, {
        usage: {
          lastInputTokens: msg.lastInputTokens,
          lastOutputTokens: msg.lastOutputTokens,
          totalInputTokens: msg.totalInputTokens,
          totalOutputTokens: msg.totalOutputTokens,
        },
      });
      return;
    }
```

If `patchSlot` is not in scope at this point in the file, use whatever pattern the neighboring branches use (e.g. `setSlots`/`slotsRef` directly). Check the existing `chat-chunk` branch for the canonical pattern. (At time of writing it's `patchSlot(id, (prev) => ({ … }))` or `patchSlot(id, { … })`.)

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm test src/sidepanel/hooks/useSession/port-handlers.test.ts`
Expected: PASS — both the new describe and all existing branches.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/hooks/useSession/port-handlers.ts src/sidepanel/hooks/useSession/port-handlers.test.ts
git commit -m "feat(sidepanel): handle agent-usage wire event (#59)"
```

---

## Task 7: `useSession.setActive` rehydrates slot.usage from storage (TDD)

**Files:**
- Modify: `src/sidepanel/hooks/useSession/index.ts` — inside `setActive` (around line 754)
- Test: `src/sidepanel/hooks/useSession/index.test.ts` — append a new test in the existing relevant describe

- [ ] **Step 1: Read existing `setActive` to find the slot-hydration site**

Open `src/sidepanel/hooks/useSession/index.ts`. Find `const setActive = useCallback(async (id: string)` (line ~754). Look for the `patchSlot(id, (prev) => { if (prev.streaming) return {}; return { messages: ..., ... } })` block (line ~793).

- [ ] **Step 2: Write the failing test**

Open `src/sidepanel/hooks/useSession/index.test.ts`. Find an existing describe block that exercises `setActive` (search `setActive` for the right neighborhood). Append a new `it` to that describe:

```ts
it("setActive rehydrates slot.usage from SessionAgentState.contextUsage (#59)", async () => {
  // Arrange: pre-write meta + agent state with contextUsage into the in-memory
  // chrome.storage.local mock provided by test/setup.ts.
  const id = "sess-rehydrate";
  await chrome.storage.local.set({
    [`session_${id}_meta`]: {
      id,
      createdAt: 1,
      lastAccessedAt: 1,
      status: "active",
      messages: [],
    },
    [`session_${id}_agent`]: {
      agentMessages: [],
      stepIndex: 0,
      hasImageContent: false,
      contextUsage: {
        totalInputTokens: 5000,
        totalOutputTokens: 200,
        lastInputTokens: 1000,
        lastOutputTokens: 50,
      },
    },
    session_index: [
      { id, lastAccessedAt: 1, status: "active", messageCount: 0 },
    ],
  });

  const { result } = renderHook(() => useSession());
  // Wait for initial mount to finish.
  await waitFor(() => expect(result.current.ready).toBe(true));

  await act(async () => {
    await result.current.setActive(id);
  });

  await waitFor(() => {
    expect(result.current.usage).toEqual({
      totalInputTokens: 5000,
      totalOutputTokens: 200,
      lastInputTokens: 1000,
      lastOutputTokens: 50,
    });
  });
});
```

NOTE — the hook's public surface needs a `usage` getter for this test to compile. If `useSession` exposes a slot-derived view object (search for `deriveActiveView`), add `usage: slot.usage` to that view's output (one-line change in `deriveActiveView` or wherever the active slot is projected to the hook return type). If you're unsure where, search `const active = deriveActiveView` and follow.

- [ ] **Step 3: Add `usage` to the active view (if not already present)**

In `useSession/index.ts` or `useSession/test-utils.ts` / wherever the view derivation lives, add `usage` to the returned object alongside `messages`, `error`, etc. Example skeleton:

```ts
return {
  ready,
  sessionId,
  status,
  streaming: active.streaming,
  messages: active.messages,
  error: active.error,
  // … existing fields …
  usage: active.usage,   // ← issue #59
  // …
};
```

If you added a new field, update the `UseSession` interface (likely co-located) with `usage?: SessionAgentState["contextUsage"]`.

- [ ] **Step 4: Run test to verify it fails for the right reason**

Run: `pnpm test src/sidepanel/hooks/useSession/index.test.ts -- -t "rehydrates slot.usage"`
Expected: FAIL with `result.current.usage` being `undefined` (because setActive doesn't read SessionAgentState yet).

- [ ] **Step 5: Implement rehydration in `setActive`**

In `useSession/index.ts`, add `getSessionAgent` to the existing imports from `@/lib/sessions/storage` (search for `getSessionMeta` — same module).

Then in `setActive`, right after `const meta = await getSessionMeta(id);` and the existing pin-migration block, read the agent state:

```ts
    // Issue #59 — rehydrate the context-ring's data source from storage when
    // switching to a session that may have a prior task's usage already on
    // disk. SW also pushes agent-usage events live during a streaming task;
    // setActive's job is the cold/switch case.
    const agent = await getSessionAgent(id);
```

Then in the `patchSlot(id, (prev) => { if (prev.streaming) return {}; return { … } })` block, add `usage: agent?.contextUsage` to the returned object:

```ts
      return {
        messages: metaForActivate.messages ?? [],
        error: null,
        toast: null,
        accumulated: "",
        streamingText: "",
        usage: agent?.contextUsage,   // ← issue #59
        // …keep other existing fields…
      };
```

- [ ] **Step 6: Run test to verify pass**

Run: `pnpm test src/sidepanel/hooks/useSession/index.test.ts`
Expected: PASS — new test and all existing setActive tests.

- [ ] **Step 7: Commit**

```bash
git add src/sidepanel/hooks/useSession/index.ts src/sidepanel/hooks/useSession/index.test.ts
git commit -m "feat(sidepanel): setActive rehydrates slot.usage from storage (#59)"
```

---

## Task 8: ContextRing component (TDD)

**Files:**
- Create: `src/sidepanel/components/ContextRing.tsx`
- Create: `src/sidepanel/components/__tests__/ContextRing.test.tsx`

- [ ] **Step 1: Write failing test scaffold**

Create `src/sidepanel/components/__tests__/ContextRing.test.tsx`:

```tsx
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ContextRing from "../ContextRing";

afterEach(cleanup);

describe("ContextRing — render gates (#59)", () => {
  it("renders nothing when lastInputTokens is undefined", () => {
    const { container } = render(
      <ContextRing
        lastInputTokens={undefined}
        lastOutputTokens={undefined}
        totalInputTokens={0}
        totalOutputTokens={0}
        maxContextTokens={200_000}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when lastInputTokens is 0", () => {
    const { container } = render(
      <ContextRing
        lastInputTokens={0}
        lastOutputTokens={0}
        totalInputTokens={0}
        totalOutputTokens={0}
        maxContextTokens={200_000}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when maxContextTokens is missing", () => {
    const { container } = render(
      <ContextRing
        lastInputTokens={1000}
        lastOutputTokens={50}
        totalInputTokens={1000}
        totalOutputTokens={50}
        maxContextTokens={undefined}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the ring when usage and max are present", () => {
    render(
      <ContextRing
        lastInputTokens={1000}
        lastOutputTokens={50}
        totalInputTokens={1000}
        totalOutputTokens={50}
        maxContextTokens={200_000}
      />,
    );
    expect(screen.getByTestId("context-ring")).toBeTruthy();
  });
});

describe("ContextRing — color thresholds", () => {
  function getStroke(): string | null {
    // The fill arc is the second <circle> inside the ring's SVG.
    const ring = screen.getByTestId("context-ring");
    const circles = ring.querySelectorAll("circle");
    return circles[1]?.getAttribute("stroke") ?? null;
  }

  it("uses slate color below 60%", () => {
    render(
      <ContextRing
        lastInputTokens={48_000}
        lastOutputTokens={500}
        totalInputTokens={48_000}
        totalOutputTokens={500}
        maxContextTokens={200_000}
      />,
    );
    expect(getStroke()).toBe("#6E767D");
  });

  it("uses amber color in [60%, 80%)", () => {
    render(
      <ContextRing
        lastInputTokens={124_000}
        lastOutputTokens={1400}
        totalInputTokens={124_000}
        totalOutputTokens={1400}
        maxContextTokens={200_000}
      />,
    );
    expect(getStroke()).toBe("#E07A4A");
  });

  it("uses red color at or above 80%", () => {
    render(
      <ContextRing
        lastInputTokens={174_000}
        lastOutputTokens={1400}
        totalInputTokens={174_000}
        totalOutputTokens={1400}
        maxContextTokens={200_000}
      />,
    );
    expect(getStroke()).toBe("#D9544A");
  });
});

describe("ContextRing — popover interaction", () => {
  function renderRing() {
    return render(
      <ContextRing
        lastInputTokens={124_000}
        lastOutputTokens={1400}
        totalInputTokens={8_243}
        totalOutputTokens={1_402}
        maxContextTokens={200_000}
      />,
    );
  }

  it("popover is closed by default", () => {
    renderRing();
    expect(screen.queryByTestId("context-ring-popover")).toBeNull();
  });

  it("click opens the popover with the three rows", () => {
    renderRing();
    fireEvent.click(screen.getByTestId("context-ring"));
    const popover = screen.getByTestId("context-ring-popover");
    expect(popover.textContent).toContain("8,243");
    expect(popover.textContent).toContain("1,402");
    expect(popover.textContent).toContain("9,645"); // total
  });

  it("ESC closes the popover", () => {
    renderRing();
    fireEvent.click(screen.getByTestId("context-ring"));
    expect(screen.queryByTestId("context-ring-popover")).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("context-ring-popover")).toBeNull();
  });

  it("second click on ring closes the popover (toggle)", () => {
    renderRing();
    fireEvent.click(screen.getByTestId("context-ring"));
    fireEvent.click(screen.getByTestId("context-ring"));
    expect(screen.queryByTestId("context-ring-popover")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify the test scaffold fails (module not found)**

Run: `pnpm test src/sidepanel/components/__tests__/ContextRing.test.tsx`
Expected: FAIL — cannot resolve `../ContextRing`.

- [ ] **Step 3: Implement the component**

Create `src/sidepanel/components/ContextRing.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";

export interface ContextRingProps {
  lastInputTokens: number | undefined;
  lastOutputTokens: number | undefined;
  totalInputTokens: number;
  totalOutputTokens: number;
  maxContextTokens: number | undefined;
}

// Visual constants — derived from the Paper prototype "ContextRing · States · Dark".
const RING_RADIUS = 9;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS; // ≈ 56.5
const TRACK_COLOR = "#26262C";
const COLOR_LOW = "#6E767D";
const COLOR_MID = "#E07A4A";
const COLOR_HIGH = "#D9544A";

function colorForPercent(pct: number): string {
  if (pct >= 80) return COLOR_HIGH;
  if (pct >= 60) return COLOR_MID;
  return COLOR_LOW;
}

const numberFormat = new Intl.NumberFormat("en");

export default function ContextRing(props: ContextRingProps) {
  const {
    lastInputTokens,
    lastOutputTokens,
    totalInputTokens,
    totalOutputTokens,
    maxContextTokens,
  } = props;

  const [open, setOpen] = useState(false);

  // Render gate — see spec §5.1 / §6.
  const shouldRender =
    lastInputTokens != null &&
    lastInputTokens > 0 &&
    maxContextTokens != null &&
    maxContextTokens > 0;

  // Hooks must be unconditional — compute even when not rendering.
  const pct = useMemo(() => {
    if (!shouldRender) return 0;
    return Math.min(
      100,
      Math.round((lastInputTokens! / maxContextTokens!) * 100),
    );
  }, [shouldRender, lastInputTokens, maxContextTokens]);

  const stroke = colorForPercent(pct);
  const dashLen = (RING_CIRCUMFERENCE * pct) / 100;

  // ESC key closes popover.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const onClickRing = useCallback(() => setOpen((v) => !v), []);

  if (!shouldRender) return null;

  const totalSum = totalInputTokens + totalOutputTokens;
  const isHigh = pct >= 80;
  const tooltipText =
    `Last call ${numberFormat.format(lastInputTokens!)} / ` +
    `${numberFormat.format(maxContextTokens!)} (${pct}%)`;

  return (
    <div
      data-testid="context-ring"
      onClick={onClickRing}
      title={tooltipText}
      style={{
        position: "relative",
        width: 22,
        height: 22,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      <svg
        width={22}
        height={22}
        viewBox="0 0 22 22"
        style={{ position: "absolute", top: 0, left: 0 }}
      >
        <circle
          cx={11}
          cy={11}
          r={RING_RADIUS}
          fill="none"
          stroke={TRACK_COLOR}
          strokeWidth={2}
        />
        <circle
          cx={11}
          cy={11}
          r={RING_RADIUS}
          fill="none"
          stroke={stroke}
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={`${dashLen} ${RING_CIRCUMFERENCE}`}
          transform="rotate(-90 11 11)"
        />
      </svg>
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontWeight: isHigh ? 600 : 500,
          fontSize: 9,
          color: isHigh ? COLOR_HIGH : pct >= 60 ? "#E6E6E8" : "#B0B0B6",
          lineHeight: 1,
          position: "relative",
          zIndex: 1,
        }}
      >
        {pct}
      </span>
      {open && (
        <div
          data-testid="context-ring-popover"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            bottom: 30,
            right: -8,
            minWidth: 200,
            background: "#1A1A1F",
            border: "1px solid #2E2E34",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
            padding: 0,
            zIndex: 50,
            cursor: "default",
          }}
        >
          <div
            style={{
              padding: "10px 14px 8px",
              borderBottom: "1px solid #26262C",
              fontFamily: "'JetBrains Mono', monospace",
              fontWeight: 500,
              fontSize: 10,
              letterSpacing: "0.14em",
              color: "#5A5A60",
              textTransform: "uppercase",
            }}
          >
            session usage
          </div>
          <PopoverRow label="input" value={totalInputTokens} />
          <PopoverRow label="output" value={totalOutputTokens} />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "8px 14px 10px",
              borderTop: "1px solid #26262C",
            }}
          >
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10,
                letterSpacing: "0.1em",
                color: "#6E767D",
                textTransform: "uppercase",
              }}
            >
              total
            </span>
            <span
              style={{
                fontFamily: "Inter, sans-serif",
                fontWeight: 600,
                fontSize: 13,
                color: "#E6E6E8",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {numberFormat.format(totalSum)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function PopoverRow({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 14px",
      }}
    >
      <span
        style={{
          fontFamily: "Inter, sans-serif",
          fontSize: 12,
          color: "#8A8A92",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: "Inter, sans-serif",
          fontWeight: 500,
          fontSize: 12,
          color: "#E6E6E8",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {numberFormat.format(value)}
      </span>
    </div>
  );
}
```

NOTE: hover tooltip is the native `title` attribute (lightweight, no library, matches the existing project's pattern for low-stakes labels). Visual tooltip with arrow from the Paper prototype is a polish iteration deferrable to a follow-up; the `title` attribute satisfies the spec's "hover affordance for the percentage breakdown".

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm test src/sidepanel/components/__tests__/ContextRing.test.tsx`
Expected: PASS — all 12 tests.

- [ ] **Step 5: Build to check the component compiles in production mode**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/components/ContextRing.tsx src/sidepanel/components/__tests__/ContextRing.test.tsx
git commit -m "feat(sidepanel): ContextRing component with popover + thresholds (#59)"
```

---

## Task 9: Wire ContextRing into Composer

**Files:**
- Modify: `src/sidepanel/components/Chat.tsx` — pass usage + maxContextTokens props through Chat → Composer, render `<ContextRing>` in action row

No unit test for this task; covered by Task 10 cross-layer + manual verification.

- [ ] **Step 1: Import ContextRing in Chat.tsx**

At the top of `src/sidepanel/components/Chat.tsx`, near the other component imports:

```ts
import ContextRing from "./ContextRing";
```

- [ ] **Step 2: Read maxContextTokens at the Chat level**

The Chat component receives `session` (a `UseSession`) and has access to instance / model meta via existing logic (the file already imports `resolveModelMeta` directly or via `useProviderMeta`; search for how `supportsVision` is computed). Mirror that pattern to derive `maxContextTokens`:

```tsx
// Near where supportsVision is computed (search "supportsVision"):
const [maxContextTokens, setMaxContextTokens] = useState<number | undefined>(undefined);
useEffect(() => {
  let cancelled = false;
  (async () => {
    const inst = await getActiveInstance();
    if (!inst) return;
    const meta = await resolveModelMeta(inst.provider, inst.model);
    if (!cancelled) setMaxContextTokens(meta?.maxContextTokens);
  })();
  return () => { cancelled = true; };
}, [currentInstanceId /* or whatever signal indicates instance change */]);
```

NOTE: pick the dependency variable that already exists in this scope and represents the active instance/model. If `supportsVision` is computed via `resolveModelVision`, follow that exact pattern. Don't introduce a new fetch loop if there's an existing instance-resolution hook in the file — reuse it.

- [ ] **Step 3: Pass usage + maxContextTokens to Composer**

Find `<Composer …/>` JSX (line ~1184). Add two new props:

```tsx
<Composer
  // …existing props…
  usage={session.usage}
  maxContextTokens={maxContextTokens}
/>
```

- [ ] **Step 4: Receive props in `Composer` function**

Find `function Composer({ … }` (line ~1382). Add `usage` and `maxContextTokens` to the destructured props and the type literal:

```ts
function Composer({
  // …existing props…
  usage,
  maxContextTokens,
}: {
  // …existing prop types…
  usage?: import("@/lib/sessions/types").SessionAgentState["contextUsage"];
  maxContextTokens?: number;
}) {
```

(Use a top-of-file type alias if the inline `import("…")` syntax is too noisy — match the file's existing style.)

- [ ] **Step 5: Render ContextRing in the action row**

Inside `Composer`'s JSX, find the action row (`<div className="flex items-center gap-2">`). It contains:

```
[ToolsMenu] [flex-1 spacer] [InstanceSelector] [Send|Stop button]
```

Insert `<ContextRing>` between `<InstanceSelector …/>` and the `{streaming ? <stopBtn/> : <PieSendButton/>}` ternary:

```tsx
<InstanceSelector
  // …existing props…
/>
<ContextRing
  lastInputTokens={usage?.lastInputTokens}
  lastOutputTokens={usage?.lastOutputTokens}
  totalInputTokens={usage?.totalInputTokens ?? 0}
  totalOutputTokens={usage?.totalOutputTokens ?? 0}
  maxContextTokens={maxContextTokens}
/>
{streaming ? (
  // …existing stop button…
) : (
  <PieSendButton onClick={onSend} disabled={!input.trim()} />
)}
```

- [ ] **Step 6: Build**

Run: `pnpm build`
Expected: PASS — typecheck, prod bundle.

- [ ] **Step 7: Run all tests**

Run: `pnpm test`
Expected: PASS — no regressions.

- [ ] **Step 8: Commit**

```bash
git add src/sidepanel/components/Chat.tsx
git commit -m "feat(sidepanel): mount ContextRing in Composer action row (#59)"
```

---

## Task 10: Cross-layer end-to-end test

**Files:**
- Create: `src/__tests__/cross-layer/context-usage-end-to-end.test.ts`

Three scenarios in one file:
1. Loop persist → port post → panel slot reflects new usage
2. Cross-task carry-over via tombstone (task1 done → task2 picks up cumulative)
3. SW restart hydration: pre-write SessionAgentState → useSession setActive → slot.usage populated

- [ ] **Step 1: Inspect existing cross-layer test patterns**

Look at `src/__tests__/cross-layer/` to see how tests assemble loop + storage + panel handlers. Match the existing scaffold style (mocking ports, simulating streamChat, etc.). The patterns will tell you how aggressive to be about mocking vs. driving through real helpers.

- [ ] **Step 2: Write the test file**

Create `src/__tests__/cross-layer/context-usage-end-to-end.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  buildSessionAgentTombstone,
  mergeContextUsage,
  mergeSessionAgentSnapshot,
} from "@/lib/agent/loop";
import {
  getSessionAgent,
  setSessionAgent,
} from "@/lib/sessions/storage";
import type { SessionAgentState } from "@/lib/sessions/types";

describe("issue #59 — context usage end-to-end", () => {
  it("persist → post: SW's RMW pattern produces the right SessionAgentState shape", async () => {
    const sessionId = "e2e-1";
    // Simulate step 1
    await setSessionAgent(sessionId, {
      agentMessages: [{ role: "user", content: "hi" }],
      stepIndex: 1,
      hasImageContent: false,
    });
    const cur1 = await getSessionAgent(sessionId);
    const next1 = mergeContextUsage(cur1?.contextUsage, {
      inputTokens: 1200,
      outputTokens: 80,
    });
    await setSessionAgent(sessionId, {
      ...(cur1 as SessionAgentState),
      contextUsage: next1,
    });
    const after1 = await getSessionAgent(sessionId);
    expect(after1?.contextUsage).toEqual({
      totalInputTokens: 1200,
      totalOutputTokens: 80,
      lastInputTokens: 1200,
      lastOutputTokens: 80,
    });

    // Simulate step 2 (RMW again)
    const cur2 = await getSessionAgent(sessionId);
    const next2 = mergeContextUsage(cur2?.contextUsage, {
      inputTokens: 800,
      outputTokens: 50,
    });
    await setSessionAgent(sessionId, {
      ...(cur2 as SessionAgentState),
      contextUsage: next2,
    });
    const after2 = await getSessionAgent(sessionId);
    expect(after2?.contextUsage).toEqual({
      totalInputTokens: 2000,
      totalOutputTokens: 130,
      lastInputTokens: 800,
      lastOutputTokens: 50,
    });
  });

  it("cross-task carry: tombstone preserves cumulative, next task can keep accumulating", async () => {
    const sessionId = "e2e-2";

    // Task 1, two steps
    await setSessionAgent(sessionId, {
      agentMessages: [{ role: "user", content: "task1" }],
      stepIndex: 1,
      hasImageContent: false,
      contextUsage: mergeContextUsage(undefined, {
        inputTokens: 1000,
        outputTokens: 50,
      }),
    });
    const t1mid = await getSessionAgent(sessionId);
    await setSessionAgent(sessionId, {
      ...(t1mid as SessionAgentState),
      contextUsage: mergeContextUsage(t1mid?.contextUsage, {
        inputTokens: 1500,
        outputTokens: 70,
      }),
    });

    // Task 1 ends — tombstone with carry
    const beforeTomb = await getSessionAgent(sessionId);
    const tomb = buildSessionAgentTombstone(undefined, beforeTomb?.contextUsage);
    await setSessionAgent(sessionId, tomb);
    const afterTomb = await getSessionAgent(sessionId);
    expect(afterTomb?.contextUsage?.totalInputTokens).toBe(2500);
    expect(afterTomb?.stepIndex).toBe(0);
    expect(afterTomb?.agentMessages).toEqual([]);

    // Task 2 starts — first step
    await setSessionAgent(sessionId, {
      agentMessages: [{ role: "user", content: "task2" }],
      stepIndex: 1,
      hasImageContent: false,
      contextUsage: afterTomb?.contextUsage, // carry into fresh state
    });
    const t2start = await getSessionAgent(sessionId);
    await setSessionAgent(sessionId, {
      ...(t2start as SessionAgentState),
      contextUsage: mergeContextUsage(t2start?.contextUsage, {
        inputTokens: 600,
        outputTokens: 30,
      }),
    });
    const final = await getSessionAgent(sessionId);
    expect(final?.contextUsage?.totalInputTokens).toBe(3100);
    expect(final?.contextUsage?.lastInputTokens).toBe(600);
  });

  it("snapshot-merge between steps does not clobber contextUsage", async () => {
    // Simulates: SW writes step snapshot via mergeSessionAgentSnapshot.
    // contextUsage was set by an earlier step; the new snapshot (just
    // agentMessages + stepIndex + hasImageContent) must not erase it.
    const existing: SessionAgentState = {
      agentMessages: [{ role: "user", content: "x" }],
      stepIndex: 2,
      hasImageContent: false,
      currentFocusTabId: 42,
      contextUsage: {
        totalInputTokens: 7000,
        totalOutputTokens: 300,
        lastInputTokens: 1100,
        lastOutputTokens: 60,
      },
    };
    const stepSnapshot: SessionAgentState = {
      agentMessages: [
        { role: "user", content: "x" },
        { role: "assistant", content: "y" },
      ],
      stepIndex: 3,
      hasImageContent: false,
    };
    const merged = mergeSessionAgentSnapshot(existing, stepSnapshot);
    expect(merged.contextUsage).toEqual(existing.contextUsage);
    expect(merged.currentFocusTabId).toBe(42);
    expect(merged.stepIndex).toBe(3);
  });
});
```

- [ ] **Step 3: Run the cross-layer tests**

Run: `pnpm test src/__tests__/cross-layer/context-usage-end-to-end.test.ts`
Expected: PASS — three scenarios.

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/cross-layer/context-usage-end-to-end.test.ts
git commit -m "test(cross-layer): context usage e2e — persist, tombstone carry, snapshot merge (#59)"
```

---

## Task 11: Full build + final verification

**Files:** none (verification only)

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: PASS — every test, no regressions. Pay attention to `cross-layer` suite and `loop.test.ts`.

- [ ] **Step 2: Run production build**

Run: `pnpm build`
Expected: PASS. Tools like `tool-names.ts` invariant checks should not be affected (we didn't add tools), and manifest assertions remain stable.

- [ ] **Step 3: Manual verification in dev**

Run: `pnpm dev`. Load the `dist/` extension at `chrome://extensions` (Developer mode). Then run through the checklist below. Tick each ✓ in the commit message (or write a `docs/solutions/2026-05-23-context-ring-issue-59.md` companion if you prefer; it's optional).

```
[ ] open side panel — new session, composer has NO ring
[ ] send first prompt that triggers ≥1 agent step
[ ] ring appears after the first LLM round-trip completes
[ ] ring's center number matches: round(real_input / max * 100)
[ ] ring color matches threshold (<60 slate, 60-80 amber, ≥80 red)
[ ] hover ring → native title tooltip shows "Last call X / Y (Z%)"
[ ] click ring → popover opens with three rows (input/output/total)
[ ] ESC closes popover
[ ] click outside (or click ring again) closes popover
[ ] send another prompt → totals increment, last refreshes
[ ] open a 2nd session (drawer), do agent work → ring tracks 2nd session only
[ ] switch back to 1st session → ring shows 1st session's prior numbers
[ ] swap instance to a model with different maxContextTokens →
    percentage updates immediately (same last, new denominator)
[ ] chrome.runtime.reload() the extension; reopen panel; ring
    rehydrates from storage on session switch
```

- [ ] **Step 4: Push branch + open PR**

```bash
git push -u origin feat/issue-59-context-ring
gh pr create --base main --title "feat: Context Ring — session token usage visualization (#59)" \
  --body "Closes #59. See docs/specs/2026-05-23-context-ring-issue-59.md."
```

---

## Self-review (skill checklist — done at write time)

**Spec coverage** — each section of the spec maps to ≥1 task:
- §2 decisions table → Tasks 1-9 (each row implemented in the matching task)
- §3 data flow → Task 4 (loop) + Task 6 (port-handler) + Task 7 (rehydration)
- §4 storage / tombstone / merge → Tasks 2, 3, 10
- §5 UI ring + tooltip + popover → Task 8
- §6 edge cases (incl. render gates, 0-usage skip, model swap, SW restart) → Tasks 4, 7, 8 (gate tests in component); cross-task carry in Task 10
- §7 testing → Tasks 2 (tombstone), 3 (helper + snapshot), 6 (port-handler), 7 (rehydrate), 8 (component), 10 (cross-layer); manual verification list in Task 11
- §8 out-of-scope items confirmed: no compaction event chips, no per-step breakdown, no cache breakdown, no estimated fallback, no model id/instance in popover, no drawer ring
- §9 file change list → matches Tasks 1, 4, 6, 7, 8, 9 (storage.ts unchanged because mergeSessionAgentSnapshot's spread already preserves contextUsage — covered by Task 3 regression test)

**Placeholder scan** — no "TBD", no "implement later". Tools-menu fetch pattern in Task 9 step 2 is described as "mirror existing supportsVision pattern" with explicit guidance, not a placeholder.

**Type consistency** — `SessionAgentState["contextUsage"]` used everywhere; `AgentUsageMessage` field names (`lastInputTokens` / `lastOutputTokens` / `totalInputTokens` / `totalOutputTokens`) consistent across Tasks 1, 4, 6, 8; `mergeContextUsage` signature matches usage in Task 4 (loop) and Task 10 (cross-layer test).
