import { describe, it, expect, vi, beforeEach } from "vitest";
import { chromeMock } from "@/test/setup";
import { isCdpInputEnabled } from "@/lib/cdp-input-enabled";
import { getSessionMeta } from "@/lib/sessions/storage";

// Real instances + real sessions storage (chromeMock-backed); only the agent
// loop is mocked. These two pre-wiring steps are what the real extension does at
// chat-start but the thin eval bridge skipped — without them, CDP input (click/
// type) and open_url tab-pinning are physically broken in eval, regardless of
// the model.
const fakeRun = vi.fn();
vi.mock("@/lib/agent/loop", () => ({ runAgentLoop: (ctx: unknown) => fakeRun(ctx) }));

import { __makeBridgeForTest } from "./eval-bridge";

beforeEach(() => {
  fakeRun.mockReset();
  fakeRun.mockResolvedValue(undefined);
  chromeMock.tabs.__activeTab = { id: 7, url: "http://localhost:7780/admin", active: true };
});

describe("eval bridge pre-wires the headless harness (no human, no sidepanel)", () => {
  it("Fix A — seedConfig pre-grants CDP input so click/type never needs sidepanel consent", async () => {
    const bridge = __makeBridgeForTest();
    expect(await isCdpInputEnabled()).toBe(undefined); // off by default → would hit consent path
    await bridge.seedConfig({ provider: "anthropic", model: "claude-opus-4-7", apiKey: "sk-test" });
    expect(await isCdpInputEnabled()).toBe(true);
  });

  it("Fix B — startTask seeds a SessionMeta keyed by the eval sessionId so open_url's pin append persists", async () => {
    const bridge = __makeBridgeForTest();
    await bridge.seedConfig({ provider: "anthropic", model: "claude-opus-4-7", apiKey: "sk-test" });
    const { sessionId } = await bridge.startTask({ goal: "find the best seller" });

    const meta = await getSessionMeta(sessionId);
    expect(meta).not.toBeNull();
    expect(meta!.pinnedTabs).toEqual([{ tabId: 7, origin: "http://localhost:7780" }]);
    // The loop's appendPinnedTab does getSessionMeta → setSessionMeta; that no-ops
    // when the meta is absent. A present meta is the bridge's whole contribution.
  });

  it("Fix C — startTask injects a value-only answer directive (the scorer exact-matches the bare value, not prose)", async () => {
    const bridge = __makeBridgeForTest();
    await bridge.seedConfig({ provider: "anthropic", model: "claude-opus-4-7", apiKey: "sk-test" });
    await bridge.startTask({ goal: "What is the top best-selling product in 2022?" });

    const ctx = fakeRun.mock.calls[0][0] as { task: string };
    expect(ctx.task).toContain("What is the top best-selling product in 2022?");
    // WebArena's AgentResponseEvaluator compares the normalized answer for set
    // equality against the bare expected value — a verbose sentence never matches.
    expect(ctx.task).toContain("ONLY the precise value");
    expect(ctx.task).toContain("no explanation");
  });
});
