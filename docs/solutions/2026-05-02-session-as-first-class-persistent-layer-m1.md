---
title: "Session as First-Class Persistent Layer — M1 (single-session checkpoint & resume)"
date: 2026-05-02
category: docs/solutions/
module: "service_worker / sidepanel_react / agent_loop / chrome_storage_local / wire_protocol"
problem_type: runtime_error
component: assistant
symptoms:
  - "Chat messages disappear when user switches from Chat to Settings sub-view and back (React unmount data loss)"
  - "In-flight agent task is silently destroyed when Chrome MV3 Service Worker idles 30s and is terminated"
  - "Pending agent confirm card is lost when Side Panel closes or SW dies while a tool confirmation is awaiting user approval"
root_cause: incomplete_setup
resolution_type: code_fix
severity: high
related_components:
  - "src/lib/sessions/types.ts"
  - "src/lib/sessions/storage.ts"
  - "src/background/session-recovery.ts"
  - "src/sidepanel/hooks/useSession.ts"
  - "src/lib/agent/loop.ts"
  - "src/types/messages.ts"
related_brainstorm: docs/specs/2026-05-02-checkpoint-resume-requirements.md
related_plan: docs/plans/2026-05-02-001-feat-session-persistent-layer-plan.md
tags:
  - session-persistence
  - service-worker-restart
  - checkpoint-resume
  - chrome-storage-local
  - agent-loop
  - react-state-lift
  - mv3-lifecycle
  - byok-informed-spending
---

# Session as First-Class Persistent Layer — M1

> M1 of the 14-unit `feat/session-persistent-layer` plan. M2 (multi-session UI) and M3 (real per-session sandbox) remain. This learnings file captures M1's design decisions, the corrections that landed during implementation, and the invariants future M2/M3 work must keep.

## Problem

Pre-M1, Chrome AI Agent had no dedicated storage layer for session state. Chat history lived in 11 React `useState` fields inside `<Chat>` and was dropped on every sub-view unmount. The agent loop's full LLM IR, its `AbortController`, and its pending-confirm `Promise` resolvers all lived entirely in Service Worker memory — which Chrome silently recycles after 30s idle. Any one of these three temporary runtimes (React state / SW memory / port closure) dying took its slice of the user-visible session with it. M1 inverts ownership: `chrome.storage.local` becomes the authoritative store; React + SW are caches that hydrate from storage on mount or wake.

## Symptoms

Three observable pre-M1 symptoms, ordered by frequency (from `docs/specs/2026-05-02-checkpoint-resume-requirements.md` Problem Frame):

**1. High frequency — chat history disappears on sub-view switch.**
Reproduction: send several chat messages, switch to Settings tab, return to Chat. The entire history is gone. Root cause: `<Chat>` unmounts on the conditional render at `App.tsx:80-91`; all 11 `useState` fields in `Chat.tsx:106-121` are discarded.

**2. Medium frequency — in-flight agent task vanishes after SW idle.**
Reproduction: trigger a multi-step agent task ("fill out this form"), close the Side Panel for ~30+ seconds, reopen. The task is silently gone with no "Resume" affordance. Root cause: `background/index.ts:268-316` runs `runAgentLoop` entirely in SW memory with a per-port `AbortController`; no step state is written anywhere.

**3. Medium frequency — pending agent confirm card lost on SW death or panel close.**
Reproduction: agent reaches a high-risk step (e.g. CDP `dispatch_keyboard_input`); the confirm card surfaces; user closes Side Panel or SW idle-dies. On reopen the confirm card never reappears. Root cause: the confirm card's `Promise` resolver is in the SW's `pendingConfirmations` Map (SW memory) and the `DisplayMessage` rendering the card is in `<Chat>`'s React state (component-local). No confirm context is persisted.

## What Didn't Work

These are the design pivots and corrections that landed during M1 — the most valuable knowledge to compound for M2/M3.

### 1. R28 original interpretation: "storage holds redacted args" — broke LLM resume

The brainstorm originally framed R28 as a natural extension of Phase 2.5's binary-channel pattern: confirm card shows raw, panel-step display shows redacted, **and** storage at-rest holds redacted. The reasoning was that a local attacker can read storage, so redact there too.

This was wrong and would have silently bricked M1-U5 resume. If `agentMessages` in storage hold `args.text="[redacted]"`, the LLM on resume sees `{ _redactedTextLength: 42 }` and has no semantic context to plan the next step — it would re-plan incoherently or refuse the task.

The correct reading (R28 v2, plan D7) restores Phase 2.5's actual binary-channel intent: storage holds **raw** `agentMessages` for LLM semantic continuity; only the panel-display path (via `redactArgsForPanel`) redacts. The local-attacker trust face is identical to Phase 1 chat content (K9) — adding redaction would be "double-insecure" (attacker already has storage) plus would break LLM resume.

`AgentLoopContext.onStepSnapshot` JSDoc explicitly states "agentMessages is RAW. No call to `redactArgsForPanel` here." The grep audit:

```bash
grep -n 'redactArgsForPanel\|history.push' src/lib/agent/loop.ts
```

`redactArgsForPanel` lines and `history.push` lines must never appear close together — the snapshot callback fires after `history.push` and has no path through `redactArgsForPanel`.

### 2. Task-done stale stepIndex P0 (user-reported, commit `f4bb1d0`)

Original M1-U3 wrote step-boundary snapshots correctly during the loop, but had **no cleanup on task done**. `SessionAgentState` is the current in-flight task's IR (NOT cross-task accumulation); after a task completed with `stepIndex=7`, storage retained `stepIndex=7` indefinitely.

Time bomb: when M1-U5's `detectAndMarkPaused` ran on a later SW wake-up, it would read `stepIndex > 0` as the "in-flight task" signal, see the stale `7` from a long-completed task, and falsely transition the session to `paused` — surfacing a misleading "Resume task" button.

The user reported this during dogfooding after M1-U3 shipped but before M1-U5 was built. Fix: `buildSessionAgentTombstone()` returns `{ agentMessages: [], stepIndex: 0, skillExecutionScopeStack: [] }`. `emitDone()` (every loop exit path: success / fail / abort / max-steps) calls `ctx.onStepSnapshot(buildSessionAgentTombstone())` fire-and-forget. The pure-text-reply path (which bypasses `emitDone`) writes a tombstone independently before returning. `stepIndex === 0` is now the unambiguous "no in-flight task" signal.

**Lesson**: write-side snapshot completeness requires an explicit task-done scrub path, not just step-boundary writes. Persistence is symmetric — every "open" needs a matching "close".

### 3. Multi-turn LLM context gap (pre-existing, raised by user, commit `7a9d71f`)

During M1 review the user noticed that the LLM doesn't see prior conversation turns — every `sendMessage` dispatches only the latest user message as `task` to `runAgentLoop`. This is a Phase-2-era state at `background/index.ts:226-227`, not introduced by M1.

`useSession.sendMessage` in M1 already builds a complete `chatMessages` array from the full DisplayMessage history and posts it via `chat-start`, but the SW-side `handleChatStream` ignores all but the last user message when constructing the `runAgentLoop` context. Net result: the SW has the data on the wire but throws it away.

Two-half fix documented in `docs/ROADMAP.md §5`:

- **Half A** (pure chat multi-turn): ~10-LOC SW change to use the full `messages` array
- **Half B** (agent-task multi-turn): requires a product decision about how a prior agent task's IR (`agent-step` / `agent-confirm` / `agent-summary` DisplayMessages, all filtered out by `useSession.sendMessage`) should appear as an assistant turn — provider 400 on consecutive user messages otherwise

Decision: defer until M1 ships, then dedicated `/ce:brainstorm` + `/ce:plan`. Documented explicitly so it doesn't get buried under session-layer work.

### 4. Port + listener lift required, not just messages (commit `34d5683`)

Initial M1-U2 instinct was to lift only `messages` out of `<Chat>` into App-level state. Wrong: `<Chat>` owns `portRef` and the `port.onMessage` listener. If Chat unmounts while the SW is actively pushing `chat-chunk` / `agent-step` events (user mid-stream switches to Settings), those events hit a detached listener and are silently dropped — the messages never arrive.

Correct lift target: `(messages, port, listener, streaming state)` — the entire port lifecycle — in a single `useSession` hook at App level. Specifically:

- Port opened **once** on hook mount, not per `sendMessage`
- `onMessage` listener attached **once** and stays attached for the hook's lifetime
- `panel-mounted` message sent immediately so the SW can re-emit any live confirm-request (R4)

This is a one-class-of-bug elimination: "listener-attached-after-first-chunk" race ceases to exist.

### 5. First-iteration observation merge skip on resume (M1-U5, `loop.ts:626-748`)

The most easily-missed correctness invariant of M1, called out repeatedly with inline JSDoc and code comments to flag for future readers.

The `runAgentLoop` iteration body opens with an observation merge: take the `observationBlock` from the previous step's tool results and append it into the trailing user message of `history`. This is correct for normal iteration but **wrong for the first iteration of a resumed loop**. A persisted snapshot's trailing user message already contains the observation from the last completed step (the step that closed before SW death). Merging a fresh observation again would produce a double-observation in the same user turn and confuse the LLM.

Fix: `isResumedFirstIteration = !!ctx.resumedAgentMessages` set before the loop; the observation-merge block guards with `if (isResumedFirstIteration) { isResumedFirstIteration = false; } else { ... merge ... }`. Both `AgentLoopContext.resumedAgentMessages` JSDoc (lines 101-113) and the loop body comment (lines 720-727) explain this for future reviewers.

## Solution

Three storage keys per session (`session_${id}_meta`, `session_${id}_agent`, `session_index`) plus an independent `recovery_guard` key.

`SessionMeta` is **panel-write / panel-read** (chat display history, status, title, pinned tab info). `SessionAgentState` is **SW-write / SW-read** (LLM IR for the **current in-flight** task, `stepIndex`, optional `pendingConfirm`). The split (plan D2) is what makes hot writes safe: per-step agent snapshots hit only the `_agent` key; panel meta writes hit only the `_meta` key; neither races the other.

### M1-U1 — Data layer (commits `1aa7216`, `7f1246b`)

Three types in `src/lib/sessions/types.ts`: `SessionMeta`, `SessionAgentState`, `SessionIndexEntry`. The singleton `session_index` key avoids a full-namespace `get(null)` scan for the session drawer (plan D1).

`writeAtomic(batch: WriteBatch)` in `storage.ts` is the **single call site** for `chrome.storage.local.set` with multiple keys (plan D9 atomicity). `createSession` writes meta + agent + index in one atomic batch. `setSessionMeta` updates the index in the same batch only when an index-tracked field changes.

`getTotalBytes()` calls `getBytesInUse(null)` for the real cross-namespace total — not the `JSON.stringify` approximation `skill/storage.ts:getSkillStorageBytes` uses for its narrow subset.

IDs: bare `crypto.randomUUID()`, no `default` magic value, no prefix (plan PRD-3 fix preventing M2 from needing a migration).

### M1-U2 — Lift Chat state (commit `34d5683`)

`useSession` hook at App level owns: `sessionId`, `status`, `messages`, `streaming`, `streamingText`, `error`, `portRef`, and the single persistent `handlePortMessage` listener. On mount it reads `listSessionIndex()`, auto-creates a session if empty, loads messages from the most-recently-accessed entry, then opens the port and sends `panel-mounted` — all before flipping `ready: true` (the `ready` gate disables Chat input until bootstrap completes, preventing user input from racing the seed).

`handlePortMessage` is attached **once** and handles every SW push for the hook's lifetime; per-stream scratch (`accumulatedRef`, `streamFinishedRef`) lives in refs so the single listener instance is reused across many `sendMessage` calls.

Persistence fires at exactly **five boundaries**: `chat-done`, `chat-error`, `agent-done-task`, `onDisconnect`, `clearMessages`. Mid-stream events (`chat-chunk`, `agent-step`, `agent-confirm`) are React state only — no storage write, no churn.

A `chrome.storage.local.onChanged` listener watches the per-session meta key for SW-written `status` changes (e.g. `active → paused` from cold-start recovery) so the panel reacts without reload.

### M1-U3 — Snapshot (commits `428d1fb`, `f4bb1d0`)

`AgentLoopContext` gains:
- `sessionId: string` (required — task identity)
- `onStepSnapshot?: (snapshot: SessionAgentState) => Promise<void>` (optional callback, plan D3 injection — loop body never directly touches `chrome.storage`)
- `resumedAgentMessages?` and `resumedFromStep?` for M1-U5 resume

`buildSessionAgentSnapshot(history, stepIndex)` is a pure helper using `structuredClone(history)` — critical because the loop mutates `history` in-place during the next observation merge; without the clone the persisted reference would diverge silently (plan D4).

`onStepSnapshot` is called **fire-and-forget** (`.catch` log + continue) — storage IO must not stall the next LLM round. Errors are swallowed with a warning so a quota failure does not abort an in-flight task.

`buildSessionAgentTombstone()` returns the empty in-flight marker. `emitDone` (every loop exit) calls it after posting `AgentDoneTaskMessage`; pure-text-reply path writes one before returning.

### M1-U4 — Confirm protocol + R4 recovery (commit `d7d6b2c`)

`SessionConfirmRequestMessage` is a distinct `PortMessageToPanel` variant from `AgentConfirmRequestMessage` (plan D5) — keeps the tool-call confirm channel uncluttered. `kind: "pinned-tab-drift" | "paused-resume"` discriminates scenarios; `payload: unknown` allows future kinds without reshaping consumers.

`PanelMountedMessage` (`type: "panel-mounted", sessionId: string`) serves dual roles:
1. Wire identity for the session on this port (M3-U1 will move this into the port name)
2. R4 trigger: SW re-emits any live confirm-request the user might have left pending

**Two-source invariant** for live confirm: SW checks **both** `pendingConfirmations.has(confirmationId)` (resolver still alive in SW memory) **and** `SessionAgentState.pendingConfirm` (storage record) before re-emitting. Neither source alone is sufficient — a stale storage record without a live resolver means the SW restarted and the user can't actually act on the card.

`pendingConfirm` payload is stored **raw** (no `redactArgsForPanel` — Phase 2.5 binary channel: confirm cards need raw args for informed approval). Storage trust face is the same as Phase 1 chat content (K9). `scrubPendingConfirm` is called from `sendConfirmRequest`'s `finally` block (approve / reject / abort all converge on the same cleanup).

The persist payload uses **explicit field listing** (no spread `...payload`) — adding new fields to `AgentConfirmRequestMessage` requires a conscious decision whether they belong in storage. Precedent: P3-U's `preFetchedContent` is 200KB of page HTML that must NOT land in storage; only `contentPreview` (≤200 chars sanitized) does. Spread would silently include every new field.

### M1-U5 — SW recovery (commit `cb8b73d`)

`detectAndMarkPaused()` is called on **four trigger paths**:
1. SW top-level on every wake-up — **the main path**, since the file re-imports on idle restart
2. `chrome.runtime.onStartup` (Chrome process start) — belt
3. `chrome.runtime.onInstalled` — belt
4. `panel-mounted` message handler — belt (covers panel-wakes-SW)

Critical: **`onStartup` does NOT fire on MV3 idle wake-up**. Only Chrome process start. Top-level fire-and-forget is what actually runs after the common 30s-idle restart case.

`recovery_guard` is an **independent storage key** (NOT inside `SessionMeta`). Calls within 30s skip via the guard; this dedupes concurrent triggers from the four paths.

**Step ordering invariant** (P0):
1. Scan all sessions; for any with `pendingConfirm` record → `markFailedAndScrub` (mark failed **before** scrub so panel never observes `status=active` with `pendingConfirm` cleared mid-state)
2. Re-list and mark `paused` for any remaining `active` session with `stepIndex > 0`
3. Bump `recovery_guard` timestamp

Step 2 must re-list (not reuse Step 1's index) — otherwise sessions just marked `failed` would be re-evaluated and possibly transitioned to `paused`.

**R11 drift card**: `SessionConfirmRequestMessage` kind=`"pinned-tab-drift"` is emitted when the user clicks "Resume task" and the SW discovers the pinned tab is gone or has navigated to a different origin. V1 has exactly **one action** — "Discard task" (plan K-5 informed-approval, never silent abort). Silent auto-resume is deliberately rejected: "Chrome crashed last night, automatically spent N tokens this morning" is the default-prohibited UX in a BYOK model where every API call costs the user money.

`escapeUntrustedWrappers` is applied to all stored task / tab-title / origin strings before they reach the panel — the same helper enforced by Phase 3 cross-tab tools (cross-doc reference below).

## Why This Works

**Root cause lens**: pre-M1 session state was **parasitic** on three independent temporary runtimes (React component state, SW memory, port closure). All three are temporary by design — React state dies on unmount, SW memory dies on idle, port closure dies on disconnect. Any one dying took the user-visible session with it.

M1 inverts ownership: `chrome.storage.local` is the authoritative store; React + SW are read-through caches that hydrate on mount/wake. Each runtime can die independently and the session survives.

The `SessionMeta` / `SessionAgentState` split is what makes hot writes safe without races. Different writers, different keys — no contention. The `stepIndex=0` tombstone reduces M1-U5's recovery decision to a single integer comparison, eliminating a class of "is this session really in flight?" semantic ambiguity.

## Prevention

Concrete invariants future M2 (multi-session UI) and M3 (per-session sandbox) work must keep:

1. **Never spread payloads into storage.** Adding fields to `AgentConfirmRequestMessage` requires explicit opt-in at the persist site. Precedent: P3-U `preFetchedContent` (200KB page HTML) must never reach storage; only `contentPreview` (≤200 chars) does. Spread silently propagates new fields.

2. **D9 atomicity — `writeAtomic()` for every multi-key write.** Never call `chrome.storage.local.set` directly with multiple keys from CRUD code. Single audit point in `src/lib/sessions/storage.ts`.

3. **R28 v2 — storage holds raw, panel display redacts.** `redactArgsForPanel` lives ONLY on `sendAgentStep` / `sendConfirmRequest` paths. `onStepSnapshot` callback must NEVER call it. Run after any `loop.ts` change:
   ```bash
   grep -n 'redactArgsForPanel\|history.push' src/lib/agent/loop.ts
   ```
   `redactArgsForPanel` and `history.push` lines must not appear close together.

4. **Tombstone on every task done.** `emitDone` writes `buildSessionAgentTombstone()`. Pure-text-reply path also writes tombstone. M2-U1 multi-task dispatch must preserve. Any new `runAgentLoop` exit path added in M2/M3 must also fire a tombstone before returning. Invariant: `stepIndex === 0` means "no in-flight task; do not transition to paused on next cold start."

5. **First-iteration observation merge skip — `isResumedFirstIteration` flag.** Resume correctness depends on it. M2-U1 / M3 changes to history initialization shape must verify this skip still fires correctly or replace with equivalent invariant.

6. **Two-source invariant for live confirm.** Never re-render a confirm card from storage alone. SW must verify resolver still alive (`pendingConfirmations.has(confirmationId)`) AND storage record matches.

7. **`SessionAgentState` is "current in-flight task IR", NOT cross-task accumulation.** JSDoc states this explicitly. M2/M3 multi-session work must keep this single-task-only semantic. Cross-task display history lives in `SessionMeta.messages`. Using `agentMessages` as cross-task accumulation breaks the tombstone detector AND the resume path.

8. **SW top-level recovery call is the main path; `onStartup` is belt.** MV3 idle wake-up does not trigger `onStartup`. Top-level fire-and-forget + 30s `recovery_guard` dedup is the production path.

## Test Coverage Reference

76 tests across 4 files (1.78s total):

- `src/lib/sessions/storage.test.ts` — 39 tests: CRUD round-trips, `writeAtomic` multi-key batch verification, `setSessionMeta` index atomicity, `setPendingConfirm`/`scrubPendingConfirm` lifecycle, `markPaused`/`markFailed`/`markFailedAndScrub` ordering, corrupt `session_index` defensive filter
- `src/sidepanel/hooks/useSession.test.ts` — 20 tests: mount bootstrap, port lifecycle, persistence boundaries, `agent-confirm-request` idempotency by `confirmationId`, `panel-mounted` send on mount
- `src/lib/agent/loop.test.ts` — 9 tests: `buildSessionAgentSnapshot` deep-clone (D4), R28 v2 raw-at-rest, tombstone shape + independence
- `src/background/session-recovery.test.ts` — 8 tests: `stepIndex > 0 → paused`, `pendingConfirm → failed` (Step 1 mark before Step 2 ordering invariant), tombstone left alone, 30s guard dedup, `recovery_guard` written to its own key

Test infrastructure (`src/test/setup.ts`) ships mock `chrome.storage.local` with real `onChanged` event emission and mock `chrome.runtime.connect()` returning controllable `Port` stubs with `__emit()` for simulating SW push events. M1 also bootstrapped `happy-dom` + `@testing-library/react` infrastructure for hook tests — first use of component/hook testing in this codebase.

## Related Issues

### Strong cross-references

- **`docs/solutions/2026-04-28-cdp-keyboard-simulation-on-canvas-editors.md`** — Phase 2.5 owner-token + redaction binary channel C4. M1's R28 v2 reinterpretation (storage holds raw, panel display redacts) restores Phase 2.5's actual binary-channel intent. Any paused-and-resumed CDP keyboard task must preserve raw `args.text` in storage to reconstruct LLM context on resume.

- **`docs/solutions/2026-05-01-llm-capability-grant-invariants.md`** — Phase 2.6's 8 capability-grant invariants. P1-H's "write-time configuration check" pattern (skill 1MB budget + `getBytesInUse` quota gate) is the precedent for M1's plan-D6 per-step snapshot quota concept. P1-E's id-namespace separation (`skill_agent_*` / `skill_user_*` prefixes) is also the model for M1's `session_*` key namespace not colliding with `skill_*` / `agent_checkpoint_*` / etc.

- **`docs/solutions/2026-05-02-cross-tab-trust-model.md`** — Phase 3's 19 P3 invariants. M1-U5 drift card sanitization uses the `escapeUntrustedWrappers` helper introduced for Phase 3 P3-G `sanitizeTabTitle` / `sanitizeGroupName`. Stored task/tab-title strings replayed in resume confirm cards re-enter the same untrusted-data trust face.

- **`docs/solutions/security-issues/2026-05-02-wrapper-tag-escape-attack-families.md`** — 8 wrapper-tag-escape families and the idempotent ASCII-entity defense. M1's resume confirm card displaying stored LLM observations / tab metadata must run `escapeUntrustedWrappers` on those strings before render — same threat model, third surface.

### Forward references (M1's known limitations, deferred to plan)

- **Multi-turn LLM context gap** — `docs/ROADMAP.md §5`. SW currently extracts only the last user message as `task`; LLM never sees prior conversation turns. Pre-existing Phase-2-era state, not M1-introduced. Two-half fix documented (Half A simple ~10 LOC; Half B requires product decision). Defer to dedicated `/ce:brainstorm` after M1 ships.

- **`skillExecutionScopeStack` restoration on resume** — M1-U5 resumes with empty stack. Phase 2.6 R3 anti-nest is not enforced for the rest of a resumed task. M2-U1 wires the stack for real. Acceptable M1 trade-off; documented in plan.

- **Pre-snapshot SW-death window** — DisplayMessage carries the user message but agent state is tombstone (`stepIndex=0`); detect-step skips it. User sees a half-handled message; recovery limited to "send the message again". Plan notes this as a separate M1+ design problem.

### Successor work

- **M2 (multi-session UI)** — drawer + list + LLM titles + LRU archive + 30-day hard delete. Per `docs/plans/2026-05-02-001-feat-session-persistent-layer-plan.md` units U6-U9. Builds directly on M1's `session_index` + `SessionMeta.title` + `archivedAt` slots already shipped.
- **M3 (real per-session sandbox)** — per-session port (`chat-stream-${sessionId}` instead of plain `chat-stream`), per-session abort, per-session pinned tab/origin. Per plan units U10-U14. The M1 `panel-mounted` wire identity message is an explicit precursor — M3-U1 will encode `sessionId` in `port.name` and the `panel-mounted` carrier becomes redundant.
