---
title: "Stop button hangs the agent loop — abort path didn't reach pending await points"
date: 2026-04-29
category: logic-errors
module: agent-loop
problem_type: logic_error
component: service_object
symptoms:
  - "Click Stop while a high-risk confirm card is awaiting decision → loop never ends, AgentSummary never appears"
  - "Click Stop during a pure-text streaming response → Panel sees chat-done but no agent-done-task → no summary card"
  - "Side Panel UI looks frozen mid-task even though streaming has stopped"
root_cause: async_timing
resolution_type: code_fix
severity: medium
tags:
  - abort
  - async-cancellation
  - react-loop
  - chrome-extension
  - service-worker
  - confirm-prompt
related_components:
  - background-service-worker
  - chat-port-protocol
  - agent-loop
---

# Stop button hangs the agent loop — abort path didn't reach pending await points

## Problem

The Phase 2 ReAct agent loop has multiple `await` points: streaming the LLM response, waiting for the user's high-risk confirm decision, and (Phase 2.5) executing CDP keyboard ops. Hitting Stop in the Side Panel was supposed to cancel the running task and surface a "task aborted" `AgentSummary`. In practice, two distinct paths failed silently:

1. **Stop while a confirm card is open** → loop hangs forever in `await sendConfirmRequest(...)`. No AgentSummary, no error, just a frozen UI with the confirm card still visible.
2. **Stop during pure-text streaming (no tool calls yet)** → the loop emits `chat-done` but never emits `agent-done-task`. Panel sees the stream stop but no terminal summary card appears.

Both bugs were invisible in unit tests and only surfaced under real-user testing of Phase 2.5.

## Symptoms

- Stop button click → SW abortController fires → loop should exit and emit `agent-done-task` → in both bug paths it doesn't
- Yellow CDP debugger bar can also be left up (when bug 1 fires while CDP session is active and Stop happens during the confirm wait)
- No JS error, no log, no Panel-visible state change beyond streaming pause

## What Didn't Work

- **Relying solely on `port.onDisconnect` to drain pending confirms.** Phase 2's existing drain logic worked for the "user closes Side Panel" path because closing the panel disconnects the port. But Stop just sends a `chat-abort` message — the port stays connected, so the disconnect listener never runs and pending confirmation promises stay un-resolved.
- **Assuming `signal.aborted` checks at loop iteration boundaries are sufficient.** They are sufficient if the loop is between iterations or inside the streaming for-await. They are NOT sufficient if the loop is parked inside `await sendConfirmRequest(...)` — that promise has its own resolver and ignores the signal entirely.
- **Treating zero-tool-call exit as always meaning "pure-text reply".** When abort happens mid-stream, model-router providers (`anthropic.ts`, `openai.ts`) silently `return` from their async generator instead of throwing. The for-await sees a clean end-of-stream with zero accumulated tool calls, looks identical to a real pure-text reply, and falls into the chat-done path — bypassing `finally`'s done-emit guard via `normalTextReply = true`.

## Solution

Two targeted commits that together close the abort path:

### Fix 1 — Drain pending confirms on ANY abort source (`7aab01d`)

`src/background/index.ts`, inside `chrome.runtime.onConnect.addListener`:

```typescript
// Drain any pending high-risk confirm prompts when the task is aborted
// (Stop button, kill-switch, or programmatic abort from inside the
// loop). Without this, sendConfirmRequest's promise never resolves and
// the whole runAgentLoop hangs — finally never runs, no
// agent-done-task is emitted, the Panel just sees streaming stop with
// no AgentSummary. port.onDisconnect already drains too, but Stop
// does NOT disconnect the port; this listener covers that path.
abortController.signal.addEventListener(
  "abort",
  () => {
    for (const [, resolve] of pendingConfirmations) {
      resolve(false);
    }
    pendingConfirmations.clear();
  },
  { once: true },
);
```

This hooks the drain to the abort signal directly rather than to port lifecycle. Any abort source (Stop, storage kill-switch, programmatic abort from inside the loop) now auto-resolves all pending `sendConfirmRequest` promises with `false`. The loop unhangs at its `await`, falls through to `finally`, and emits `agent-done-task` with the reason-based summary.

### Fix 2 — Distinguish abort-mid-stream from genuine pure-text reply (`9e8bbb9`)

`src/lib/agent/loop.ts`, after the streaming `for-await`:

```typescript
for await (const event of streamChat(modelConfig, windowedHistory, signal, toolDefinitions)) {
  if (signal.aborted) return; // → finally
  // ... event handling ...
}

// NEW: distinguish abort-mid-stream from genuine pure-text reply
if (signal.aborted) return; // → finally with reason-based summary

// Pure text response (no tool calls) — finish as normal chat
if (completedToolCalls.length === 0) {
  port.postMessage({ type: "chat-done" });
  normalTextReply = true;
  return;
}
```

The new check sits between the `for-await` exit and the zero-tool-calls branch. When abort fires mid-stream, the providers' silent `return` from their generators makes the for-await exit cleanly — but we still need to recognize this as an abort (not as a genuine pure-text reply that should suppress `agent-done-task`). The explicit `signal.aborted` check ensures we fall to `finally` with `normalTextReply` still false, so the reason-based summary fires.

## Why This Works

The general principle: **in an async system with multiple `await` points, abort signals must be wired to every one of them — not just the iteration boundary**.

The Phase 2 code was missing this in two places:

1. **The confirm gate.** `sendConfirmRequest` returns a `Promise<boolean>` that only resolves when the Panel posts `agent-confirm-response`. The promise is opaque to the abort signal — it has no awareness that the task was cancelled. Hooking the drain to `abortController.signal` directly makes abort the trigger for resolving all such promises with `false`, replacing the panel-response trigger when no panel response will come.

2. **The provider-level abort handling.** Anthropic and OpenAI provider streams treat abort as "stop emitting events", not "throw". They silently end the generator. Without an explicit post-stream `signal.aborted` check, the loop can't tell "stream finished with zero tool calls because the LLM gave a pure-text reply" apart from "stream was aborted before any tool calls accumulated". The check restores that distinction.

The fix in both cases is the same shape: **explicit signal-aware code at the await point**, not implicit propagation. AbortSignal is not magic — it only works on code that explicitly listens to it.

## Prevention

For any future async lifecycle work in this codebase or similar:

- **Audit every `await` for signal-awareness.** When you add an `await` whose promise is resolved by an external event (port message, network response, user click), ask: "If `signal` aborts before the external event fires, does this promise ever resolve?" If not, you need an explicit drain hooked to the signal.

- **Don't trust silent generator exits.** When a streaming async iterator can exit via `return` (rather than throw) in response to abort, downstream code that examines accumulated state must explicitly re-check `signal.aborted` before classifying the outcome. The accumulated state alone (e.g. "zero tool calls") cannot distinguish "stream finished" from "stream cancelled".

- **Drain registries on signal, not on transport-layer events.** Phase 2 originally hooked drain to `port.onDisconnect`, which only catches "user closed the Side Panel". Abort sources that don't touch the transport (Stop button, kill-switch, programmatic) need their own coverage. Prefer hooking drain to the *abort signal itself* — it's the single source of truth for "task is over".

- **Test the matrix.** For any new await-able operation in a cancellable loop, verify:
  - Abort BEFORE the await: signal already fired → await rejects or returns immediately
  - Abort DURING the await: external event never fires → drain releases the await
  - Abort AFTER the await completes: normal completion path; abort handled by next iteration check

  All three cases must result in a single observable outcome (e.g. `agent-done-task` once, with the right summary). Manual integration testing in the actual UI is non-negotiable here — unit tests with mocked signals tend to mask the silent-exit case.

## Related Issues

- Phase 2.5 plan: `docs/plans/2026-04-28-001-feat-phase2.5-cdp-keyboard-simulation-plan.md` — Unit 5's `try/finally` restructure in `runAgentLoop` is what made these two fixes meaningfully observable. Pre-Unit-5, the loop's many silent early returns masked the same bugs by never emitting `agent-done-task` to begin with.
- Spike verdict: `docs/solutions/2026-04-28-cdp-keyboard-simulation-on-canvas-editors.md` — separate doc for the CDP path validation; this learning is about the loop lifecycle, not CDP itself.
- Commits: `9e8bbb9` (loop.ts post-stream abort check), `7aab01d` (background/index.ts confirm drain on signal abort).
