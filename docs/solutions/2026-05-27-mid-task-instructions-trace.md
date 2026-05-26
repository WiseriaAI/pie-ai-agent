# Solution Trace — Mid-task instructions (#34)

> Spec: `docs/specs/2026-05-27-mid-task-instructions-design.md`
> Plan: `docs/plans/2026-05-27-mid-task-instructions.md`
> Release: v0.15.0
> PR: TBD

## Invariants

P-MTI-1 through P-MTI-9 — see spec §9. All upheld; cross-layer tests cover each.

| ID | Statement | Test coverage |
|---|---|---|
| P-MTI-1 | `chat-instruction-add` / `cancel` must carry `sessionId`; SW scopes strictly per-session | `mid-task-instructions.test.ts` isolation suite |
| P-MTI-2 | SW is the sole `pendingInstructions` mutator; every change is `mutate → writeAtomic → broadcast` | `pending-instructions.test.ts` |
| P-MTI-3 | Loop order: abort check → drain → LLM call; aborted signal skips drain | `mid-task-instructions.test.ts` abort suite |
| P-MTI-4 | `drainPendingInstructions` is atomic (read + clear + persist + broadcast in one call) | `loop-drain.test.ts` |
| P-MTI-5 | Mid-task content is always wrapped in `<untrusted_user_message source="mid_task">`; never enters system role | `mid-task-instructions.test.ts` escape suite |
| P-MTI-6 | `chatMessageId` (panel-generated ulid) is the cross-reference key between `DisplayMessage.id` and `PendingInstruction.chatMessageId` | `mid-task-instructions.test.ts` cancel suite |
| P-MTI-7 | Cancel = panel deletes `DisplayMessage` + SW deletes `PendingInstruction`; no placeholders | `mid-task-instructions.test.ts` cancel suite |
| P-MTI-8 | On reconnect SW must proactively broadcast `chat-instruction-state` to re-sync panel | `mid-task-recovery.test.ts` reconnect suite |
| P-MTI-9 | Abort does not clear queue; queue persists across abort and drains at next `chat-start` | `mid-task-recovery.test.ts` abort-preserve suite |

## Files

### New

- `src/lib/sessions/pending-instructions.ts` — SW-side queue CRUD (`addPending` / `cancelPending` / `drainPendingInstructions`); every mutation calls `writeAtomic` then `broadcastInstructionState`
- `src/lib/agent/loop-drain.ts` — pure helpers: `buildMidTaskUserMessage` (escapes + wraps N instructions into one `<untrusted_user_message source="mid_task">` block) and `mergeCarryoverIntoMessages` (prepends drain result to `agentMessages` slice)
- `src/background/instruction-broadcast.ts` — `broadcastInstructionState` helper; centralises `chat-instruction-state` posts to the per-session port; prevents duplicate broadcast logic in multiple handlers
- `src/sidepanel/components/PendingInstructionList.tsx` — renders the pending queue above the Composer input; warm-gold dot + content text + × cancel button per row; hidden when queue is empty
- `src/__tests__/cross-layer/mid-task-instructions.test.ts` — 12 tests covering: add→drain→inject, multi-merge, cancel, reject (loop ended), abort-preserve, escape/injection-defense, per-session isolation
- `src/__tests__/cross-layer/mid-task-recovery.test.ts` — 11 tests covering: SW eviction + resume, panel reconnect broadcast, abort-then-chat-start carryover drain, paused session no-consume

### Modified

- `src/lib/sessions/types.ts` — added `PendingInstruction` interface; added `pendingInstructions: PendingInstruction[]` field to `SessionAgentState`
- `src/types/messages.ts` — 4 new port message types (`chat-instruction-add`, `chat-instruction-cancel`, `chat-instruction-state`, `chat-instruction-rejected`); `DisplayMessage` user variant gains optional `id?: string`
- `src/lib/agent/loop.ts` — drain step inserted at iteration top (after `readFocusFromStorage` + abort check, before LLM call); `buildSessionAgentSnapshot` updated to omit `pendingInstructions` field (see snapshot-clobber fix below)
- `src/background/index.ts` — 3 new port message handlers (`chat-instruction-add`, `chat-instruction-cancel`, `chat-instruction-state` query); chat-start path gains pre-loop carryover drain; `port.onConnect` broadcasts `chat-instruction-state` for every active session on reconnect
- `src/sidepanel/hooks/useSession/index.ts` — new actions `addPendingInstruction` / `cancelPendingInstruction`; listener for `chat-instruction-state` updates local `pendingInstructions` slice used by `PendingInstructionList`
- `src/sidepanel/hooks/useSession/port-handlers.ts` — handler for `chat-instruction-state` and `chat-instruction-rejected` incoming messages
- `src/sidepanel/hooks/useSession/runtime-map.ts` — outbound action mappings for the two new panel → SW messages
- `src/sidepanel/components/Chat.tsx` — `disabled={streaming}` → `disabled={!sessionAllowsInput}` on textarea; Queue button rendered when `streaming && input.trim()`; `PendingInstructionList` mounted above Composer border; `addPendingInstruction` action wired to Queue submit path
- `src/lib/i18n/dictionaries/en.ts` + `zh-CN.ts` — `chat.pending.*` localisation keys (`pendingTitle`, `pendingSentNextTurn`, `cancelInstruction`)
- ~16 test fixtures updated to include `pendingInstructions: []` in `SessionAgentState` snapshots

## Design decisions

The full decision table is in spec §6. Three decisions with the most downstream impact:

**1. Don't distinguish "supplement vs. redirect" at the protocol level.** The LLM judges intent from context. This avoids a UI classification step that would add friction and a new failure mode. The `source="mid_task"` wrapper attribute gives the model enough signal.

**2. `<untrusted_user_message source="mid_task">` — not a new wrapper, an extension of the existing one.** Mid-task instructions use the same `untrusted_user_message` defense as normal user messages and page snapshots. Content is run through `escapeUntrustedWrappers` before insertion. This means the entire injection-defense surface stayed the same; no new escape logic was needed.

**3. SW owns queue; panel owns chat history; `chatMessageId` links them.** Clean ownership eliminates the need for cross-writes. Panel appends its `DisplayMessage` immediately on Queue submit (optimistic local update). SW adds its `PendingInstruction` on receiving `chat-instruction-add`. Cancel is symmetric and independent on each side. The worst-case consistency failure (panel cancel message lost in transit) degrades gracefully: the LLM sees one "ghost" instruction — not a data corruption.

## Snapshot clobber fix

`buildSessionAgentSnapshot` initially included `pendingInstructions: []` as part of the state shape it persisted at every step boundary. This silently erased any queue entries added mid-step — a write-after-write bug where the snapshot at step N+1 would overwrite the queue written between step N and N+1.

Fix: `buildSessionAgentSnapshot` now omits the `pendingInstructions` field entirely. `mergeSessionAgentSnapshot` (restore path) preserves whatever value is already in storage. This ensures the queue is only ever mutated through `pending-instructions.ts`, the sole authorised path.

Regression test: `src/lib/sessions/pending-instructions.test.ts` snapshot-merge test — asserts that applying a snapshot without `pendingInstructions` to a state with a non-empty queue leaves the queue untouched.

## Cost / risk

- Manifest unchanged. No new host_permissions.
- No new tools registered with the agent (queue drain is transparent to the tool registry).
- 4 new port message types — additive; all existing message handlers unchanged.
- Per-session storage delta: ~100–200 bytes per pending entry (text + ulid + timestamp). Typical use is 1–2 entries; queue is cleared on drain.
- Production code: ~700 LOC across new + modified files. Test code: ~1100 LOC (cross-layer suites are heavy by design to cover recovery + isolation scenarios).
- No breaking wire-format changes. Old panels (no `id` on `DisplayMessage`) connect to new SW without issue; new panels connecting to old SW never receive `chat-instruction-*` messages and degrade gracefully to always-disabled Queue button.
