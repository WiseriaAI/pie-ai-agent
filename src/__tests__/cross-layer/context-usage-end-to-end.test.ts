import { describe, expect, it } from "vitest";
import "@/test/setup";
import {
  buildSessionAgentTombstone,
  mergeContextUsage,
  mergeSessionAgentSnapshot,
} from "@/lib/agent/loop";
import {
  getSessionAgent,
  setSessionAgent,
} from "@/lib/sessions/storage";
import type { SessionAgentState } from "@/lib/sessions/types";

describe("issue #59 — context usage end-to-end", () => {
  it("persist → post: SW's RMW pattern produces the right SessionAgentState shape", async () => {
    const sessionId = "e2e-1";
    // Simulate step 1
    await setSessionAgent(sessionId, {
      agentMessages: [{ role: "user", content: "hi" }],
      stepIndex: 1,
      hasImageContent: false,
    });
    const cur1 = await getSessionAgent(sessionId);
    const next1 = mergeContextUsage(cur1?.contextUsage, {
      inputTokens: 1200,
      outputTokens: 80,
    });
    await setSessionAgent(sessionId, {
      ...(cur1 as SessionAgentState),
      contextUsage: next1,
    });
    const after1 = await getSessionAgent(sessionId);
    expect(after1?.contextUsage).toEqual({
      totalInputTokens: 1200,
      totalOutputTokens: 80,
      lastInputTokens: 1200,
      lastOutputTokens: 80,
    });

    // Simulate step 2 (RMW again)
    const cur2 = await getSessionAgent(sessionId);
    const next2 = mergeContextUsage(cur2?.contextUsage, {
      inputTokens: 800,
      outputTokens: 50,
    });
    await setSessionAgent(sessionId, {
      ...(cur2 as SessionAgentState),
      contextUsage: next2,
    });
    const after2 = await getSessionAgent(sessionId);
    expect(after2?.contextUsage).toEqual({
      totalInputTokens: 2000,
      totalOutputTokens: 130,
      lastInputTokens: 800,
      lastOutputTokens: 50,
    });
  });

  it("cross-task carry: tombstone preserves cumulative, next task can keep accumulating", async () => {
    const sessionId = "e2e-2";

    // Task 1, two steps
    await setSessionAgent(sessionId, {
      agentMessages: [{ role: "user", content: "task1" }],
      stepIndex: 1,
      hasImageContent: false,
      contextUsage: mergeContextUsage(undefined, {
        inputTokens: 1000,
        outputTokens: 50,
      }),
    });
    const t1mid = await getSessionAgent(sessionId);
    await setSessionAgent(sessionId, {
      ...(t1mid as SessionAgentState),
      contextUsage: mergeContextUsage(t1mid?.contextUsage, {
        inputTokens: 1500,
        outputTokens: 70,
      }),
    });

    // Task 1 ends — tombstone with carry
    const beforeTomb = await getSessionAgent(sessionId);
    const tomb = buildSessionAgentTombstone(undefined, beforeTomb?.contextUsage);
    await setSessionAgent(sessionId, tomb);
    const afterTomb = await getSessionAgent(sessionId);
    expect(afterTomb?.contextUsage?.totalInputTokens).toBe(2500);
    expect(afterTomb?.stepIndex).toBe(0);
    expect(afterTomb?.agentMessages).toEqual([]);

    // Task 2 starts — first step
    await setSessionAgent(sessionId, {
      agentMessages: [{ role: "user", content: "task2" }],
      stepIndex: 1,
      hasImageContent: false,
      contextUsage: afterTomb?.contextUsage, // carry into fresh state
    });
    const t2start = await getSessionAgent(sessionId);
    await setSessionAgent(sessionId, {
      ...(t2start as SessionAgentState),
      contextUsage: mergeContextUsage(t2start?.contextUsage, {
        inputTokens: 600,
        outputTokens: 30,
      }),
    });
    const final = await getSessionAgent(sessionId);
    expect(final?.contextUsage?.totalInputTokens).toBe(3100);
    expect(final?.contextUsage?.lastInputTokens).toBe(600);
  });

  it("snapshot-merge between steps does not clobber contextUsage", async () => {
    const existing: SessionAgentState = {
      agentMessages: [{ role: "user", content: "x" }],
      stepIndex: 2,
      hasImageContent: false,
      currentFocusTabId: 42,
      contextUsage: {
        totalInputTokens: 7000,
        totalOutputTokens: 300,
        lastInputTokens: 1100,
        lastOutputTokens: 60,
      },
    };
    const stepSnapshot: SessionAgentState = {
      agentMessages: [
        { role: "user", content: "x" },
        { role: "assistant", content: "y" },
      ],
      stepIndex: 3,
      hasImageContent: false,
    };
    const merged = mergeSessionAgentSnapshot(existing, stepSnapshot);
    expect(merged.contextUsage).toEqual(existing.contextUsage);
    expect(merged.currentFocusTabId).toBe(42);
    expect(merged.stepIndex).toBe(3);
  });
});
