import { describe, it, expect, vi, beforeEach } from "vitest";

// runAgentLoop 在测试里被替换成一个「按预设事件序列回灌 MockPort」的假实现。
const fakeRun = vi.fn();
vi.mock("@/lib/agent/loop", () => ({ runAgentLoop: (ctx: any) => fakeRun(ctx) }));
vi.mock("@/lib/instances", () => ({
  createInstance: vi.fn(async () => "inst-1"),
  setActiveInstance: vi.fn(async () => {}),
  resolveInstanceToModelConfig: vi.fn(async () => ({ provider: "anthropic", model: "claude", apiKey: "k" })),
}));

import { __makeBridgeForTest } from "./eval-bridge";

beforeEach(() => {
  fakeRun.mockReset();
  (globalThis as any).chrome = {
    tabs: { query: vi.fn(async () => [{ id: 7, url: "https://shop.webarena.local/" }]) },
    storage: { local: { clear: vi.fn(async () => {}) } },
  };
});

describe("eval bridge getTrace", () => {
  it("extracts the final answer from the terminating done step and reports usage", async () => {
    fakeRun.mockImplementation(async (ctx: any) => {
      ctx.port.postMessage({ type: "agent-step", stepIndex: 1, tool: "read_page", args: {}, status: "ok", sessionId: ctx.sessionId });
      ctx.port.postMessage({ type: "agent-step", stepIndex: 2, tool: "done", args: { result: "The price is $42" }, status: "ok", sessionId: ctx.sessionId });
      ctx.port.postMessage({ type: "agent-usage", sessionId: ctx.sessionId, lastInputTokens: 10, lastOutputTokens: 5, totalInputTokens: 100, totalOutputTokens: 50 });
      ctx.port.postMessage({ type: "agent-done-task", success: true, summary: "The price is $42", stepCount: 2, sessionId: ctx.sessionId });
    });
    const bridge = __makeBridgeForTest();
    const { sessionId } = await bridge.startTask({ goal: "find price" });
    const done = await bridge.waitForDone({ sessionId, timeoutMs: 1000 });
    expect(done.status).toBe("done");
    const trace = await bridge.getTrace({ sessionId });
    expect(trace.answer).toBe("The price is $42");
    expect(trace.agentSelfReport.success).toBe(true);
    expect(trace.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(trace.steps).toHaveLength(2);
  });

  it("resolves waitForDone with status=error on chat-error", async () => {
    fakeRun.mockImplementation(async (ctx: any) => {
      ctx.port.postMessage({ type: "chat-error", error: "boom", sessionId: ctx.sessionId });
    });
    const bridge = __makeBridgeForTest();
    const { sessionId } = await bridge.startTask({ goal: "x" });
    const done = await bridge.waitForDone({ sessionId, timeoutMs: 1000 });
    expect(done.status).toBe("error");
    expect((await bridge.getTrace({ sessionId })).error).toBe("boom");
  });

  it("resolves waitForDone with status=timeout when nothing terminates", async () => {
    fakeRun.mockImplementation(async () => { /* never posts a terminal event */ });
    const bridge = __makeBridgeForTest();
    const { sessionId } = await bridge.startTask({ goal: "x" });
    const done = await bridge.waitForDone({ sessionId, timeoutMs: 50 });
    expect(done.status).toBe("timeout");
  });

  it("treats chat-done (plain-text termination) as done and uses accumulated chat text as the answer", async () => {
    fakeRun.mockImplementation(async (ctx: any) => {
      ctx.port.postMessage({ type: "chat-chunk", text: "Answer: 42", sessionId: ctx.sessionId });
      ctx.port.postMessage({ type: "chat-done", sessionId: ctx.sessionId });
    });
    const bridge = __makeBridgeForTest();
    const { sessionId } = await bridge.startTask({ goal: "x" });
    const done = await bridge.waitForDone({ sessionId, timeoutMs: 1000 });
    expect(done.status).toBe("done");
    expect((await bridge.getTrace({ sessionId })).answer).toBe("Answer: 42");
  });

  it("captures raw agentMessages from onStepSnapshot for offline diagnosis", async () => {
    const fakeMessages = [
      { role: "system", content: "..." },
      { role: "user", content: "find price" },
      { role: "assistant", content: "I'll read the page" },
    ];
    fakeRun.mockImplementation(async (ctx: any) => {
      await ctx.onStepSnapshot({ agentMessages: fakeMessages });
      // done 时 loop 发一个空 tombstone 快照 —— 不能清掉已捕获的历史。
      await ctx.onStepSnapshot({ agentMessages: [] });
      ctx.port.postMessage({ type: "agent-done-task", success: true, summary: "$42", stepCount: 1, sessionId: ctx.sessionId });
    });
    const bridge = __makeBridgeForTest();
    const { sessionId } = await bridge.startTask({ goal: "find price" });
    await bridge.waitForDone({ sessionId, timeoutMs: 1000 });
    const trace = await bridge.getTrace({ sessionId });
    expect(trace.agentMessages).toEqual(fakeMessages);
  });
});
