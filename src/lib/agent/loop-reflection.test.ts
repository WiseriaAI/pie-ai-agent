import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/test/setup";
import { chromeMock } from "@/test/setup";
import type { StreamEvent } from "@/lib/model-router/types";
import type { ModelConfig } from "@/lib/model-router/types";
import type { SessionAgentState } from "@/lib/sessions/types";
import type { AgentLoopContext } from "./loop";

// ── #61(a)(b) integration test — loop detection + intra-episode reflection ──
//
// This is the only automated coverage of the reflection branch wired into
// runAgentLoop. loop.test.ts deliberately avoids mocking the full loop (it
// targets pure helpers), so this lives in its own file with a focused harness:
//
//   - streamChat (model-router) is mocked to yield the SAME `click` tool call
//     every invocation → identical step signatures, which trips detectLoop.
//     The stubbed executeScript result carries no `success:true`, so every
//     click action returns errored; that means the B-detector (repeat+error,
//     threshold 2) fires FIRST — on the 2nd identical errored step — before
//     the A-detector (exact-repeat, threshold 3) would. This test is
//     deliberately resilient to that: it does NOT pin exact step indices,
//     only that the reflect step + <reflections> injection + hard-fail +
//     early termination all occur. detectLoop's A-vs-B distinction is covered
//     separately by loop-detection.test.ts; this file only locks the
//     runAgentLoop WIRING, which is detector-agnostic (the same branch in the
//     loop handles both verdict kinds identically).
//   - getAllFramesAndDiff (frame-discovery) is mocked to return a fixed
//     reachable top frame so the per-iteration snapshot is stable without
//     wrestling chrome.webNavigation.
//   - chrome.scripting.executeScript is stubbed (the loop injects the snapshot
//     fn per iteration; the click handler also execs in-tab — both resolve to
//     benign shapes here).
//
// The signature is identical whether the click "succeeds" or "errors", so the
// wiring assertions hold regardless; the errored result simply selects which
// detector verdict (B) the loop receives.

// streamChat is a vi.fn so we can assert invocation counts.
const streamChatMock = vi.fn();
vi.mock("../model-router", () => ({
  streamChat: (...args: unknown[]) => streamChatMock(...args),
}));

// Fixed reachable top frame — avoids the real webNavigation frame-tree walk.
vi.mock("./frame-discovery", () => ({
  getAllFramesAndDiff: vi.fn(async () => [
    {
      frameId: 0,
      frameUrl: "https://example.com/",
      origin: "https://example.com",
      crossOrigin: false,
      parentFrameId: null,
      elements: [
        { index: 5, tag: "button", text: "Submit", ariaLabel: undefined, type: undefined },
      ],
    },
  ]),
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

describe("runAgentLoop — loop detection + reflection (#61 a/b)", () => {
  const SESSION_ID = "sess-reflect";
  const TAB_ID = 101;

  beforeEach(() => {
    streamChatMock.mockReset();
    // Each streamChat call yields the SAME click action but with a UNIQUE
    // tool_use id (Anthropic requires unique ids; the signature ignores id).
    let n = 0;
    streamChatMock.mockImplementation(() => {
      n++;
      return streamOf(clickStream(`t${n}`));
    });

    // Seed a tab the per-iteration origin check + snapshot will read.
    chromeMock.tabs.__tabsById.set(TAB_ID, {
      id: TAB_ID,
      url: "https://example.com/",
      title: "Example",
    });

    // chrome.scripting — the loop injects the snapshot fn per iteration; the
    // click handler also execs in-tab. Return a benign per-frame result for
    // the snapshot injection; the action exec result shape is ignored here.
    (chromeMock as unknown as { scripting: unknown }).scripting = {
      executeScript: vi.fn(async () => [
        {
          frameId: 0,
          result: {
            url: "https://example.com/",
            title: "Example",
            elements: [
              { index: 5, tag: "button", text: "Submit" },
            ],
            semantic: { headings: [], alerts: [], status: [] },
          },
        },
      ]),
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

  it("trips the detector, emits a reflect step + <reflections>, then hard-fails", async () => {
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

    // (2) A snapshot taken after a reflection carries the <reflections> tail
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

    // (3) Reflection budget exhausted → agent-done-task success:false with the
    // "stuck repeating" summary.
    const doneFail = posts.find(
      (m) =>
        m.type === "agent-done-task" &&
        m.success === false &&
        typeof m.summary === "string" &&
        (m.summary as string).includes("stuck repeating"),
    );
    expect(doneFail).toBeDefined();
  });

  it("never executes the looping tool more times than the model emitted (no runaway)", async () => {
    const onStepSnapshot = vi.fn(async () => {});
    const ctx = makeCtx(onStepSnapshot);
    await runAgentLoop(ctx);

    // The mocked click action errors every time, so the B-detector
    // (repeat+error, threshold 2) trips early, and with MAX_REFLECTIONS=2 the
    // loop hard-fails well before MAX_STEPS (30). Assert it stopped early — a
    // regression that disabled detection would run until MAX_STEPS. The bounds
    // are intentionally loose (not exact step indices) so the test stays
    // resilient to which detector verdict fires first.
    expect(streamChatMock.mock.calls.length).toBeLessThan(30);
    expect(streamChatMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
