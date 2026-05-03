---
title: "Multi-session invariant trace (Phase 4 / M3 acceptance gate)"
date: 2026-05-03
type: solution
status: shipped
related_plan: docs/plans/2026-05-02-001-feat-session-persistent-layer-plan.md
related_solutions:
  - docs/solutions/2026-04-28-cdp-keyboard-simulation-on-canvas-editors.md
  - docs/solutions/2026-05-01-llm-capability-grant-invariants.md
  - docs/solutions/2026-05-02-cross-tab-trust-model.md
  - docs/solutions/2026-05-02-session-as-first-class-persistent-layer-m1.md
---

# Multi-session invariant trace (Phase 4 / M3 acceptance gate)

This document is the **R24 / R25 / R26 acceptance gate** the M3 plan calls
out. Every Phase 2 / 2.5 / 2.6 / 3 invariant is listed below with one of
three verdicts under multi-session execution:

  - ✅ **already-correct** — the invariant survives multi-session unchanged
       (typically because the underlying state was already function- or
       per-iteration-local).
  - 🔧 **modified** — the invariant required a code change in M3 to
       remain valid; the change lands in this branch.
  - 📝 **documented** — no code change but the invariant is restated in
       a multi-session-aware form so reviewers know what to look for.

The single-source claim is: **after M3, no Phase 2 / 2.5 / 2.6 / 3
invariant is silently broken by adding a second concurrent session**.
This document is the audit; the M3 PR is the proof.

## Multi-session model recap (M3 ship targets)

  - **Per-session port** (M3-U1) — port name `chat-stream-${sessionId}`.
    SW per-port closure (abortController, pendingConfirmations,
    keepAliveInterval, inFlightSessionIds) is naturally per-session.
    Two sidepanels in two windows can run concurrent tasks.
  - **Per-session pinned tab/origin** (M3-U2) — captured at session
    creation / activation, persisted into SessionMeta, injected into
    `runAgentLoop` ctx. Loop trusts ctx; legacy fallback to active-tab
    anchor preserved.
  - **CDP owner-token = `{sessionId, tabId}`** (M3-U3) — multi-Side-
    Panel collateral checks now name the offending session. Per-tabId
    attach mutex closes the ADV-9 attach handover race.
  - **Read/write classification + R7 lock** (M3-U4) — write tools whose
    target tab is in another active session's pinned-tab registry are
    refused at dispatch. Read tools are concurrent-safe per K2.
  - **Cross-session pinned-tab registry** (M3-U4) — derived from
    `session_index`; computed at chat-start by the SW dispatcher and
    passed verbatim into the loop via ctx.

## Phase 2 invariants (DOM action loop)

| ID | Invariant | M3 status | Notes |
|---|---|---|---|
| K-1 | informed-approval at confirm card with raw args (binary channel) | ✅ already-correct | confirm card is per-tool-call; both sessions render their own. M2-U2 added sessionId routing on confirm wire so a wrong-session approval can't execute. |
| K-8 | confirm-time origin re-verify; reject stale targets | ✅ already-correct | `confirmedTabTargets` is per-tool-call local in `loop.ts` (~line 1427). Each session has its own; no cross-session sharing. |
| Pinned tab + origin anchored at task start | 🔧 modified — anchored at session **creation** instead | `runAgentLoop` reads from `ctx.pinnedTabId/pinnedOrigin` (M3-U2). Per-iteration origin re-check (~line 705) unchanged. |
| `currentSkillScope` per task | 🔧 modified — `skillExecutionScopeStack` per `runAgentLoop` call | M2-U1 already shipped this; per-call locality + `structuredClone` of `ctx.resumedSkillScopeStack` keep the stack independent across concurrent loops. M3 unchanged. |

## Phase 2.5 invariants (CDP keyboard simulation)

| ID | Invariant | M3 status | Notes |
|---|---|---|---|
| Per-task lazy attach | ✅ already-correct | `cdpSession` is a per-`runAgentLoop`-call let in loop.ts. Multi-session = two loops = two cdpSessions. |
| Per-CDP-call origin & active-tab re-check | ✅ already-correct | `reverifyOriginAndActive` in `keyboard.ts` reads `ctx.tabId` (= calling session's pin) + `pinnedOrigin` from the deps closure — both are per-loop-call. |
| Owner-token guard prevents multi-Side-Panel collateral detach | 🔧 modified — owner-token is now `{sessionId, tabId}` | `cdp-session.ts` `acquireCdpSession` conflict check compares `ownerToken.sessionId`. Error message names the offending session. |
| 5-path detach idempotency (explicit / abort-signal / onDetach / kill-switch / loop finally) | ✅ already-correct | All 5 paths funnel through `detachInternal`. The new owner-token shape doesn't add or remove paths; ‘mark dead before chromeDetach’ ordering preserved. |
| Generation ID monotonic across attaches | ✅ already-correct | `nextGenerationId++` is module-level and increments on every attach. Two sessions get different generationIds. |
| Idle yellow bar / kill-switch / tab-closed → owner abort | ✅ already-correct | `onExternalDetach` callback registered per-acquire; closes over the owning session's abortController. Each session has its own. |
| Args.text redaction binary channel (confirm raw / agent-step redacted / storage raw) | ✅ already-correct | `redactArgsForPanel` is a pure function. M1-U3 R28 v2 storage-raw is a per-call snapshot via `buildSessionAgentSnapshot` (deep clone). No cross-session sharing. |
| ADV-9 attach handover race | 🔧 modified — per-tabId attach mutex via `queueTabOp` | Without this, session A's `chromeDetach` overlapping with session B's `chromeAttach` on the same tab fails with “Another debugger”. M3-U3 serializes per-tab. |

## Phase 2.6 invariants (skill autonomous CRUD)

The 8 capability-grant invariants from `2026-05-01-llm-capability-grant-invariants.md`
plus R10 first-run gate + cache invalidation:

| ID | Invariant | M3 status | Notes |
|---|---|---|---|
| P0-A | update_skill rejects builtIn=true | ✅ already-correct | Pure validation in skill-meta handler; no per-session state. |
| P0-B | parameters JSON Schema strings ≤ 2KB total | ✅ already-correct | Pure validation. |
| P0-C | update_skill taints author='agent' + clears firstRunConfirmedAt | ✅ already-correct | Storage-side mutation; both sessions read the post-update state on next iteration via skillDefByName cache invalidation. |
| P0-D | promptTemplate ≤ 8KB AND AgentConfirmCard renders SW-pre-computed effective merged skill | ✅ already-correct | confirm card payload is per-tool-call; both sessions get their own preview. |
| P1-E | additionalProperties:false + ids prefixed `skill_agent_`/`skill_user_` | ✅ already-correct | Storage-side. |
| P1-F | allowedTools required non-null array | ✅ already-correct | Pure validation. |
| P1-G | allowedTools names validated against currently-registered tool set, EXCLUDING meta tool names | ✅ already-correct | Validates against `ALL_KNOWN_NON_SKILL_TOOL_NAMES` which is a module-level constant — globally shared but read-only. |
| P1-H | 1MB skill_* storage budget | ✅ already-correct | Storage-side global budget; cross-session storage pressure already accounted for in M2-U4 LRU archive (also storage-side). |
| R10 first-run gate | ✅ already-correct | Per-iteration `skillDefByName` cache (`const Map(...)` at loop.ts:929). After meta-tool dispatch, cache is `clear()` + repopulated within the same iteration so a subsequent skill_call sees the post-update state. Two concurrent sessions each have their own iteration scope. |
| R2 / R3 anti-nest enforcement | ✅ already-correct | Reads `skillExecutionScopeStack` which is per-`runAgentLoop`-call (M2-U1). Two concurrent sessions = two stacks; no cross-session leakage. |
| Cache invalidation after meta-tool dispatch | ✅ already-correct | `skillDefByName.clear()` then re-populate inside the same iteration (loop.ts:1511). Per-iteration scope means session A's cache invalidation does not implicitly invalidate session B's — but B reads the same chrome.storage source on its own next iteration. |

## Phase 3 invariants (cross-tab tools)

P3-A through P3-V (P3-D / P3-Q / P3-R folded as documented):

| ID | Invariant | M3 status | Notes |
|---|---|---|---|
| P3-A | Per-call cross-origin args introspection in risk.ts | ✅ already-correct | `hasCrossOriginTab` is pure; called per-tool-call. |
| P3-B | Read tools also gated by high-risk confirm | ✅ already-correct | Hardcoded in classifyRisk. |
| P3-C | list_tabs output wrapped in `<untrusted_tab_metadata>` | ✅ already-correct | Pure wrap fn. |
| P3-E | Multi-tab confirm wire (`tabTargets`) + origin summary row | ✅ already-correct | Wire field is per-message; two sessions emit two messages. |
| P3-F | manifest tabGroups permission | ✅ already-correct | Manifest-level; orthogonal to multi-session. |
| P3-G | Title sanitize: line-break/control-char/escapeUntrustedWrappers | ✅ already-correct | Pure function. |
| K-8 | Confirm-time origin re-verify uses `ctx.confirmedTabTargets`, not pinnedOrigin | ✅ already-correct | `verifyConfirmedOrigin` (tabs.ts:36) is **stateless** — it takes `confirmed: Map<...>` as a parameter, no module state. Loop dispatch (loop.ts:1444) passes a per-tool-call `confirmedTabTargets` map. Two concurrent sessions: each has its own map; one session's approval cannot leak to another. **Verified by inspection of tools/tabs.ts:36 + loop.ts:1427.** |
| P3-H | Partial completion observation `ok/skipped/errors` | ✅ already-correct | Per-tool-call result shape. |
| P3-I | list_tabs cap 50 | ✅ already-correct | Pure constant. |
| P3-J | close_tabs deny pinned tab | 🔧 modified — multi-session reading via R7 lock | Per the plan, P3-J's “deny pinned by ANY active session” semantic is implemented in M3-U4 via `crossSessionPinnedTabIds`. The handler-side check in `close_tabs` (`ctx.tabId` rejection) covers the calling session's own pin; the dispatch-side R7 lock covers the cross-session case. Both layers active. |
| P3-K | incognito deliberately omitted from manifest | ✅ already-correct | Manifest-level. |
| P3-L | ≥3-reject task termination (K-10 reject side) | ✅ already-correct | `confirmRejections` Map is per-`runAgentLoop`-call. Counter is whitelist on `reason==='user-reject'` (M2-U2 Bug-fix-D). |
| P3-M | activate_tab does not re-pin | ✅ already-correct | Handler returns observation; never touches pinnedTabId. |
| P3-N | Discarded tab rejects | ✅ already-correct | Handler-side check on `verify.tab.discarded`. |
| P3-O | Shared `escapeUntrustedWrappers` helper covers all wrapper-emit sites | ✅ already-correct | Pure helper; M2-U3 adds the BOTH-list lock-step assertion. |
| P3-T | list_tabs scope=allWindows → high | ✅ already-correct | classifyRisk hardcoded. |
| P3-U | get_tab_content SW pre-fetch + content preview | ✅ already-correct | Pre-fetched content is per-tool-call ctx field. Two sessions = two pre-fetches; never shared. |
| P3-V | confirm card a11y baseline | ✅ already-correct | Panel-side rendering; sessionId routing (M2-U2) ensures the right card lands in the right UI. |
| P3-Q | BYOK trust boundary acceptance for tab metadata exposure | 📝 documented | K9 reaffirmation — sessions are not a trust boundary; metadata leakage between sessions is the user's own data. No code change. |
| G-1 acceptance gate | ✅ already-correct + 🔧 extended | Original G-1 in `risk.ts` (TAB_TOOL_NAMES classification) preserved. M3-U4 adds a parallel gate: every name in `KNOWN_*_TOOL_NAMES` must appear in `TOOL_CLASSES` (`tool-names.ts`). Same throw-at-module-load pattern. |
| G-2 acceptance gate | 📝 documented | Cross-window `move_tabs` still deferred until confirm card carries source/target window context. M3 does not change this. |

## Verified-by-inspection per-session locality (advisor F1)

These three sites were called out in the plan as “verify, not refactor”
because the surface code already used per-iteration / function-local
scope. Re-confirmed under M3:

  1. `tools/tabs.ts:36` `verifyConfirmedOrigin` — stateless function;
     accepts `confirmed: Map<number, ConfirmedTabTarget>` as an argument.
     No module-level cache. Multi-session safe by construction.
  2. `loop.ts:1427` `confirmedTabTargets` — declared with `let` inside
     the per-tool-call body of the for-loop. Goes out of scope when the
     tool call completes. Cannot leak across tool calls in the same
     session, let alone across sessions.
  3. `loop.ts:929` `skillDefByName` — `const Map(...)` at the start of
     each iteration. Re-populated each iteration from `getEnabledSkills()`
     (which reads chrome.storage.local). Two concurrent sessions: each
     has its own per-iteration cache; one session's `clear()` after a
     meta-tool dispatch does not affect the other.

These are the three sites a future “let's hoist this for performance”
refactor MUST NOT change without re-running the trace audit.

## What M3 ships (one-line per unit)

  - **M3-U1** — port name `chat-stream-${sessionId}` + SW message
    sessionId verification.
  - **M3-U2** — pinned tab/origin captured at session creation /
    activation; loop trusts ctx; legacy fallback preserved.
  - **M3-U3** — CDP `ownerToken = {sessionId, tabId}` + per-tabId
    attach/detach mutex (`queueTabOp`).
  - **M3-U4** — `TOOL_CLASSES` + build-time exhaustive check + R7 lock
    in loop dispatch (`collectCrossSessionConflicts`) +
    `pinned-tab-registry` (`getCrossSessionPinnedTabIds`).
  - **M3-U5** — this document + regression test (loop.test.ts:
    `M3-U5 — multi-session invariant regression`).

## Acceptance gate

This trace is the load-bearing artifact for R24 / R25 / R26 sign-off:
every invariant has a verdict, every 🔧 modification cites the unit
that ships it, every ✅ already-correct invariant identifies the file +
line that establishes its locality. A future PR that breaks any of
these must update this document before merge.

The corresponding regression test in `src/lib/agent/loop.test.ts`
under the “M3-U5 — multi-session invariant regression” describe block
codifies the three locality guarantees in machine-checked form.
