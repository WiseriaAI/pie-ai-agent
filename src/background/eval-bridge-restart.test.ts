import { describe, it, expect, vi, beforeEach } from "vitest";
import { chromeMock } from "@/test/setup";

// Only the agent loop is mocked here. The REAL `@/lib/instances` module is used
// so that seedConfig actually writes the instance + active-instance pointer to
// chrome.storage.local, and startTask actually reads it back — that persisted
// boundary is exactly where the MV3 service-worker-restart bug lives.
const fakeRun = vi.fn();
vi.mock("@/lib/agent/loop", () => ({ runAgentLoop: (ctx: unknown) => fakeRun(ctx) }));

import { __makeBridgeForTest } from "./eval-bridge";

beforeEach(() => {
  fakeRun.mockReset();
  fakeRun.mockResolvedValue(undefined);
  chromeMock.tabs.__activeTab = { id: 7, url: "http://localhost:7780/admin", active: true };
});

describe("eval bridge survives MV3 SW restart between seedConfig and startTask", () => {
  it("resolves the model config from persisted storage when the in-memory bridge was rebuilt", async () => {
    // 1. seedConfig runs on whatever bridge is alive at seed time.
    const bridge1 = __makeBridgeForTest();
    await bridge1.seedConfig({ provider: "anthropic", model: "claude-opus-4-7", apiKey: "sk-test" });

    // 2. Simulate the SW being evicted during page.goto and respawning: a brand
    //    new bridge closure (in-memory seed pointer is gone). chrome.storage.local
    //    survives the restart, so the active instance is still on disk.
    const bridge2 = __makeBridgeForTest();

    // 3. startTask on the fresh bridge must NOT throw "seedConfig must be called
    //    before startTask" — it falls back to the persisted active instance.
    const { sessionId } = await bridge2.startTask({ goal: "find the best seller" });
    expect(sessionId).toMatch(/^eval-/);

    expect(fakeRun).toHaveBeenCalledTimes(1);
    const ctx = fakeRun.mock.calls[0][0] as { modelConfig: { provider: string; model: string; apiKey: string } };
    expect(ctx.modelConfig.provider).toBe("anthropic");
    expect(ctx.modelConfig.model).toBe("claude-opus-4-7");
    expect(ctx.modelConfig.apiKey).toBe("sk-test");
  });
});
