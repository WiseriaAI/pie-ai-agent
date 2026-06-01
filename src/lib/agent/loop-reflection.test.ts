import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/test/setup";
import { chromeMock } from "@/test/setup";
import type { StreamEvent } from "@/lib/model-router/types";
import type { ModelConfig } from "@/lib/model-router";
import type { SessionAgentState } from "@/lib/sessions/types";
import type { AgentLoopContext } from "./loop";

// ── #61(a)(b) integration test — loop detection + intra-episode reflection ──
//
// This is the only automated coverage of the reflection branch wired into
// runAgentLoop. loop.test.ts deliberately avoids mocking the full loop (it
// targets pure helpers), so this lives in its own file with a focused harness:
//
//   - streamChat (model-router) is mocked to yield the SAME `click` tool call
//     for the first several invocations → identical step signatures, which
//     trips detectLoop. The stubbed executeScript result carries no
//     `success:true`, so every click action returns errored; that means the
//     B-detector (repeat+error, threshold 2) fires FIRST — on the 2nd
//     identical errored step. After enough interventions the mock yields a
//     `fail` tool call: the loop NO LONGER hard-terminates on a detected loop
//     (advisory-navigation rework), so the model itself must call done/fail
//     to end the task. These tests assert the reflect step + <reflections>
//     injection + escalation + LLM-controlled termination all occur.
//   - chrome.scripting.executeScript is stubbed for the click handler's
//     in-tab invocation. The loop no longer calls executeScript for snapshot
//     (pull-mode: read_page stamps data-pie-idx on demand; tab title comes from
//     chrome.tabs.get which is already seeded via chromeMock).
//
// NOTE: the loop is now UNBOUNDED (no MAX_STEPS ceiling). A mock that yields
// `click` forever would spin forever — every test here must eventually yield a
// `fail` (or `done`) so the model terminates the task.

// streamChat is a vi.fn so we can assert invocation counts.
const streamChatMock = vi.fn();
vi.mock("../model-router", () => ({
  streamChat: (...args: unknown[]) => streamChatMock(...args),
}));

// Import AFTER vi.mock calls so the mocks are in place.
const { runAgentLoop } = await import("./loop");

/** Build an async-generator that replays a fixed StreamEvent list. */
function streamOf(events: StreamEvent[]) {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

/** A single `click` tool call with a fresh tool_use id each invocation. */
function clickStream(callId: string): StreamEvent[] {
  return [
    { type: "tool-call-start", id: callId, index: 0, name: "click" },
    {
      type: "tool-call-delta",
      index: 0,
      argsDelta: JSON.stringify({ elementIndex: 5, frameId: 0 }),
    },
    { type: "tool-call-end", index: 0 },
  ];
}

/** A `fail` tool call — the model's LLM-controlled termination path. */
function failStream(callId: string, reason: string): StreamEvent[] {
  return [
    { type: "tool-call-start", id: callId, index: 0, name: "fail" },
    { type: "tool-call-delta", index: 0, argsDelta: JSON.stringify({ reason }) },
    { type: "tool-call-end", index: 0 },
  ];
}

describe("runAgentLoop — loop detection + reflection (#61 a/b)", () => {
  const SESSION_ID = "sess-reflect";
  const TAB_ID = 101;

  beforeEach(() => {
    streamChatMock.mockReset();
    // The first 4 streamChat calls yield the SAME click action (unique
    // tool_use ids; the signature ignores id) → trips the loop detector and
    // drives reflection escalation. The loop no longer hard-terminates, so on
    // the 5th call the model yields `fail` to end the task (LLM-controlled
    // termination). Without this the unbounded loop would spin forever.
    let n = 0;
    streamChatMock.mockImplementation(() => {
      n++;
      if (n >= 5) {
        return streamOf(
          failStream(`f${n}`, "Could not click the submit button after retrying."),
        );
      }
      return streamOf(clickStream(`t${n}`));
    });

    // Seed a tab the per-iteration origin check + snapshot will read.
    chromeMock.tabs.__tabsById.set(TAB_ID, {
      id: TAB_ID,
      url: "https://example.com/",
      title: "Example",
    });

    // chrome.scripting — used by the click handler's in-tab executeScript.
    // The loop no longer calls executeScript for snapshot; title comes from
    // chromeMock.tabs (seeded above). The click result shape doesn't matter
    // here — the loop only checks for success:true, and absence triggers the
    // B-detector (repeat+error) which is the desired test path.
    (chromeMock as unknown as { scripting: unknown }).scripting = {
      executeScript: vi.fn(async () => [{ frameId: 0, result: undefined }]),
    };
  });

  afterEach(() => {
    delete (chromeMock as unknown as { scripting?: unknown }).scripting;
  });

  function makeCtx(
    onStepSnapshot: (s: SessionAgentState) => Promise<void>,
  ): AgentLoopContext {
    const controller = new AbortController();
    const port = {
      name: `chat-stream-${SESSION_ID}`,
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
    } as unknown as chrome.runtime.Port;

    const modelConfig: ModelConfig = {
      provider: "anthropic",
      model: "claude-test",
      apiKey: "sk-test",
    } as ModelConfig;

    return {
      port,
      task: "click the submit button",
      modelConfig,
      signal: controller.signal,
      sessionId: SESSION_ID,
      onStepSnapshot,
      // Pin the tab so the loop uses the multi-pin anchor path (no active-tab
      // query needed) and the per-iteration origin check passes.
      pinnedTabs: [{ tabId: TAB_ID, origin: "https://example.com" }],
      initialFocusTabId: TAB_ID,
    };
  }

  it("trips the detector, emits a reflect step + <reflections>, escalates, then the model calls fail", async () => {
    const snapshots: SessionAgentState[] = [];
    const onStepSnapshot = vi.fn(async (s: SessionAgentState) => {
      // structuredClone so later in-place history mutation can't rewrite
      // what we captured at this step boundary.
      snapshots.push(structuredClone(s));
    });

    const ctx = makeCtx(onStepSnapshot);
    await runAgentLoop(ctx);

    const posts = (ctx.port.postMessage as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as Record<string, unknown>,
    );

    // (1) A reflect step is surfaced to the panel.
    const reflectSteps = posts.filter(
      (m) => m.type === "agent-step" && m.tool === "reflect",
    );
    expect(reflectSteps.length).toBeGreaterThanOrEqual(1);
    // The reflect step shows a green check (status:"ok") — the reflection
    // itself succeeded even though the skipped actions are failures.
    expect(reflectSteps[0]!.status).toBe("ok");
    expect(String(reflectSteps[0]!.observation)).toMatch(/Self-correction/);

    // (2) Escalation: past REFLECTION_ESCALATE_AFTER (2) interventions, the
    // note escalates to a blunt "self-corrected N times … call fail" directive.
    expect(
      reflectSteps.some((s) =>
        /self-corrected \d+ times/.test(String(s.observation ?? "")),
      ),
    ).toBe(true);

    // (3) A snapshot taken after a reflection carries the <reflections> tail
    // in a user observation message. Note the tail lands in the observation
    // that opens the NEXT step (it's appended to the prior step's
    // tool_result user turn, then a fresh assistant/skip turn is pushed on
    // top), so we scan ALL user messages — not just the trailing one.
    const userTextHasReflections = (s: SessionAgentState): boolean =>
      s.agentMessages.some(
        (m) =>
          m.role === "user" &&
          (typeof m.content === "string"
            ? m.content.includes("<reflections>")
            : m.content.some(
                (b) => b.type === "text" && b.text.includes("<reflections>"),
              )),
      );
    const reflectionSnapshot = snapshots.find(userTextHasReflections);
    expect(reflectionSnapshot).toBeDefined();

    // (4) Termination is LLM-controlled: the done carries the model's `fail`
    // reason — NOT any runtime-authored "stuck repeating" string (that hard-
    // stop path was removed).
    const doneFail = posts.find(
      (m) => m.type === "agent-done-task" && m.success === false,
    );
    expect(doneFail).toBeDefined();
    expect(doneFail!.summary).toContain("Could not click the submit button");
    expect(String(doneFail!.summary)).not.toMatch(/stuck repeating/);
  });

  it("does not hard-terminate on a detected loop — it runs until the model calls fail", async () => {
    const onStepSnapshot = vi.fn(async () => {});
    const ctx = makeCtx(onStepSnapshot);
    await runAgentLoop(ctx);

    // The runtime no longer ends the task on a detected loop; the mock keeps
    // clicking until its 5th call yields `fail`. So streamChat is invoked
    // exactly 5 times — proving the loop kept going past the old hard-stop
    // (which fired at intervention 2) and only stopped when the model did.
    expect(streamChatMock.mock.calls.length).toBe(5);
    const done = (ctx.port.postMessage as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((m) => m.type === "agent-done-task");
    expect(done?.success).toBe(false);
  });

  // ── #64 — oscillation (a→b→a→b) detection ──────────────────────────────────
  //
  // The existing tests use a single signature (click elementIndex:5) and
  // exercise the B-detector (repeat+error). This test instead alternates
  // between TWO distinct tool calls (elementIndex:1 and elementIndex:2) so the
  // B-detector never fires (the signature changes each step) and the
  // oscillation detector (period-2, minCycles=2, needs ≥4 steps) trips instead.
  //
  // Because the detectOscillation check requires seq.length >= p*minCycles
  // (= 2*2 = 4), the first 3 steps execute normally; the C-verdict fires on the
  // 4th. The reflect path is identical to the B/A paths, so the reflect step
  // and <reflections> tail are both produced by the same code branch — only the
  // LoopVerdict.kind value differs and changes the wording in the note.
  it("detects an a→b→a→b oscillation and emits a reflect step (#64)", async () => {
    // Override the beforeEach mock with one that alternates between two
    // distinct click targets. Use a locally scoped counter so leakage
    // between tests is impossible (each test gets a fresh mock via
    // streamChatMock.mockReset() in beforeEach, then this override is
    // applied on top within the test body itself).
    let n = 0;
    streamChatMock.mockImplementation(async function* () {
      n++;
      // After 6 alternating clicks (enough to trip the period-2 oscillation
      // detector and emit a reflect step), the model calls `fail` to end the
      // task — the loop never hard-terminates on its own.
      if (n >= 7) {
        yield { type: "tool-call-start", id: `osc-f${n}`, index: 0, name: "fail" };
        yield {
          type: "tool-call-delta",
          index: 0,
          argsDelta: JSON.stringify({ reason: "Kept alternating between two buttons." }),
        };
        yield { type: "tool-call-end", index: 0 };
        return;
      }
      // Alternate between elementIndex 1 and 2 → two distinct signatures.
      const idx = n % 2 === 0 ? 1 : 2;
      const id = `osc-t${n}`;
      yield { type: "tool-call-start", id, index: 0, name: "click" };
      yield {
        type: "tool-call-delta",
        index: 0,
        argsDelta: JSON.stringify({ elementIndex: idx, frameId: 0 }),
      };
      yield { type: "tool-call-end", index: 0 };
    });

    const onStepSnapshot = vi.fn(async () => {});
    const ctx = makeCtx(onStepSnapshot);
    await runAgentLoop(ctx);

    const posts = (ctx.port.postMessage as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as Record<string, unknown>,
    );

    // At least one reflect step must be posted for the oscillation verdict.
    const reflectSteps = posts.filter(
      (m) => m.type === "agent-step" && m.tool === "reflect",
    );
    expect(reflectSteps.length).toBeGreaterThanOrEqual(1);

    // The observation must describe the period-2 cycling.
    // buildReflectionNote produces: "you are cycling between the same 2 actions
    // (a 2-step loop) without making progress" for an oscillation verdict.
    expect(
      reflectSteps.some((s) =>
        /cycling between the same 2 actions/.test(String(s.observation ?? "")),
      ),
    ).toBe(true);
  });
});
