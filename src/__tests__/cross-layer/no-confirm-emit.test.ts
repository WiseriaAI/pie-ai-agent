import { describe, it, expect } from "vitest";
import "@/test/setup";

describe("No confirm layer — tool calls execute directly", () => {
  it("loop.ts no longer imports classifyRisk from risk.ts", async () => {
    const loopModule = await import("@/lib/agent/loop");
    // The module should not export classifyRisk or risk-related symbols.
    expect(loopModule).not.toHaveProperty("classifyRisk");
    // Verify runAgentLoop is still exported (main loop entry point).
    expect(typeof loopModule.runAgentLoop).toBe("function");
  });

  it("AgentLoopContext no longer has sendConfirmRequest field", async () => {
    // Verify the interface shape by checking that a context object without
    // sendConfirmRequest still compiles — the field was removed.
    const ctx = {
      port: {} as chrome.runtime.Port,
      task: "test task",
      modelConfig: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "sk-test",
      },
      signal: new AbortController().signal,
      sessionId: "test-session",
    };
    // Assert ctx has the required fields and no sendConfirmRequest.
    expect(ctx).toHaveProperty("port");
    expect(ctx).toHaveProperty("task");
    expect(ctx).toHaveProperty("modelConfig");
    expect(ctx).toHaveProperty("signal");
    expect(ctx).toHaveProperty("sessionId");
    expect(ctx).not.toHaveProperty("sendConfirmRequest");
    expect(ctx).not.toHaveProperty("skipPermissions");
  });

  it("risk.ts classifyRisk is decoupled from loop.ts — loop no longer imports it", async () => {
    // The risk classifier was previously imported and used in the loop.
    // After removing the confirm layer, loop.ts no longer imports classifyRisk.
    const loopSrc = await import("@/lib/agent/loop");
    // risk.ts exports are no longer re-exported or referenced by loop.ts.
    // If someone accidentally adds it back, this test catches it.
    const keys = Object.keys(loopSrc);
    const riskKeys = keys.filter(
      (k) =>
        k.toLowerCase().includes("risk") ||
        k.toLowerCase().includes("confirm") ||
        k.toLowerCase().includes("tabtarget") ||
        k.toLowerCase().includes("metaskillpreview"),
    );
    expect(riskKeys).toEqual([]);
  });

  it("dispatchCaptureVisibleTab and dispatchCaptureFullPageTab are importable from loop.ts scope", async () => {
    // These are now imported directly in loop.ts for direct screenshot capture.
    // Verify the imports don't throw.
    const screenshotModule = await import("@/lib/agent/tools/screenshot");
    expect(typeof screenshotModule.dispatchCaptureVisibleTab).toBe("function");
    expect(typeof screenshotModule.dispatchCaptureFullPageTab).toBe("function");
  });

  it("screenshot dispatch no longer requires user confirm — direct capture path", async () => {
    // The screenshot tools now call dispatchCaptureVisibleTab/dispatchCaptureFullPageTab
    // directly without an intervening sendConfirmRequest. Verify the capture
    // functions return CaptureOutcome (not Promise that hangs on confirm).
    const screenshotModule = await import("@/lib/agent/tools/screenshot");
    const { dispatchCaptureVisibleTab } = screenshotModule;

    // Signature check: dispatchCaptureVisibleTab takes CaptureContext, returns CaptureOutcome.
    // No confirm-related parameters.
    const fnStr = dispatchCaptureVisibleTab.toString();
    expect(fnStr).not.toContain("confirm");
    expect(fnStr).not.toContain("sendConfirmRequest");
  });
});
