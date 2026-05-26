import { describe, it, expect, vi } from "vitest";
import { chromeMock } from "@/test/setup";
import { addPending, cancelPending, drainPending } from "./pending-instructions";
import {
  buildSessionAgentSnapshot,
  buildSessionAgentTombstone,
  mergeSessionAgentSnapshot,
} from "@/lib/agent/loop";
import type { SessionAgentState } from "./types";

const SESSION_ID = "s1";

function freshAgentState(): SessionAgentState {
  return {
    agentMessages: [],
    pendingInstructions: [],
    stepIndex: 0,
    hasImageContent: false,
  };
}

function seedAgentState(sessionId = SESSION_ID, state: SessionAgentState = freshAgentState()) {
  chromeMock.storage.local.__store[`session_${sessionId}_agent`] = state;
}

describe("addPending", () => {
  it("appends to queue and persists", async () => {
    seedAgentState();
    await addPending(SESSION_ID, {
      chatMessageId: "msg-1",
      content: "also pin forums",
      createdAt: 1000,
    });
    const state = chromeMock.storage.local.__store[
      `session_${SESSION_ID}_agent`
    ] as SessionAgentState;
    expect(state.pendingInstructions).toEqual([
      { chatMessageId: "msg-1", content: "also pin forums", createdAt: 1000 },
    ]);
  });

  it("preserves FIFO order across multiple adds", async () => {
    seedAgentState();
    await addPending(SESSION_ID, { chatMessageId: "m1", content: "a", createdAt: 1 });
    await addPending(SESSION_ID, { chatMessageId: "m2", content: "b", createdAt: 2 });
    await addPending(SESSION_ID, { chatMessageId: "m3", content: "c", createdAt: 3 });
    const state = chromeMock.storage.local.__store[
      `session_${SESSION_ID}_agent`
    ] as SessionAgentState;
    expect(state.pendingInstructions.map((p) => p.chatMessageId)).toEqual([
      "m1",
      "m2",
      "m3",
    ]);
  });
});

describe("cancelPending", () => {
  it("removes the matching entry and returns true", async () => {
    seedAgentState();
    await addPending(SESSION_ID, { chatMessageId: "m1", content: "a", createdAt: 1 });
    await addPending(SESSION_ID, { chatMessageId: "m2", content: "b", createdAt: 2 });
    const removed = await cancelPending(SESSION_ID, "m1");
    expect(removed).toBe(true);
    const state = chromeMock.storage.local.__store[
      `session_${SESSION_ID}_agent`
    ] as SessionAgentState;
    expect(state.pendingInstructions.map((p) => p.chatMessageId)).toEqual(["m2"]);
  });

  it("returns false and no-ops when chatMessageId not present", async () => {
    seedAgentState();
    await addPending(SESSION_ID, { chatMessageId: "m1", content: "a", createdAt: 1 });
    const removed = await cancelPending(SESSION_ID, "nope");
    expect(removed).toBe(false);
    const state = chromeMock.storage.local.__store[
      `session_${SESSION_ID}_agent`
    ] as SessionAgentState;
    expect(state.pendingInstructions).toHaveLength(1);
  });

  it("returns false when session agent state missing", async () => {
    const removed = await cancelPending("nonexistent", "m1");
    expect(removed).toBe(false);
  });
});

describe("drainPending", () => {
  it("returns FIFO-ordered drained entries and empties queue", async () => {
    seedAgentState();
    await addPending(SESSION_ID, { chatMessageId: "m1", content: "a", createdAt: 1 });
    await addPending(SESSION_ID, { chatMessageId: "m2", content: "b", createdAt: 2 });
    const drained = await drainPending(SESSION_ID);
    expect(drained.map((p) => p.chatMessageId)).toEqual(["m1", "m2"]);
    const state = chromeMock.storage.local.__store[
      `session_${SESSION_ID}_agent`
    ] as SessionAgentState;
    expect(state.pendingInstructions).toEqual([]);
  });

  it("returns empty array when queue empty (no storage write)", async () => {
    seedAgentState();
    const setSpy = vi.spyOn(chromeMock.storage.local, "set");
    const drained = await drainPending(SESSION_ID);
    expect(drained).toEqual([]);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("returns empty when session missing", async () => {
    const drained = await drainPending("nonexistent");
    expect(drained).toEqual([]);
  });

  it("preserves all PendingInstruction fields including expandedForLLM/attachments", async () => {
    seedAgentState();
    await addPending(SESSION_ID, {
      chatMessageId: "m1",
      content: "user text",
      expandedForLLM: "expanded text /skill",
      attachments: [],
      quotes: [],
      createdAt: 1,
    });
    const drained = await drainPending(SESSION_ID);
    expect(drained[0]).toMatchObject({
      chatMessageId: "m1",
      content: "user text",
      expandedForLLM: "expanded text /skill",
    });
  });
});

// ── Regression: snapshot merge must not clobber pendingInstructions ───────────
//
// Issue #34 clobber-fix: buildSessionAgentSnapshot deliberately omits
// pendingInstructions from the returned object. mergeSessionAgentSnapshot
// spreads existing first, then snapshot, so a step-boundary write will
// preserve whatever addPending wrote to storage during the step's execution
// window (T2 < task-end T3).
//
// buildSessionAgentTombstone also must preserve pendingInstructions through
// mergeSessionAgentSnapshot even though tombstone detection bypasses the
// normal spread.

describe("snapshot merge preserves pendingInstructions (clobber regression)", () => {
  it("step-boundary snapshot does not erase pending instruction added mid-step", () => {
    const pending = [{ chatMessageId: "m1", content: "also pin forums", createdAt: 1000 }];
    const existing: SessionAgentState = {
      agentMessages: [{ role: "user", content: "old" }],
      pendingInstructions: pending,
      stepIndex: 1,
      hasImageContent: false,
    };
    // buildSessionAgentSnapshot omits pendingInstructions — simulates a
    // step-boundary snapshot arriving after addPending wrote to storage.
    const snapshot = buildSessionAgentSnapshot(
      [{ role: "user", content: "new" }],
      2,
    );
    expect("pendingInstructions" in snapshot).toBe(false);
    const merged = mergeSessionAgentSnapshot(existing, snapshot);
    // Pending instruction from storage must be preserved.
    expect(merged.pendingInstructions).toEqual(pending);
    // Snapshot fields still win for the fields it carries.
    expect(merged.stepIndex).toBe(2);
  });

  it("tombstone does not erase pending instruction added at task completion boundary", () => {
    const pending = [{ chatMessageId: "m2", content: "carry me over", createdAt: 2000 }];
    const existing: SessionAgentState = {
      agentMessages: [{ role: "user", content: "prev task" }],
      pendingInstructions: pending,
      stepIndex: 5,
      hasImageContent: false,
      currentFocusTabId: 42,
    };
    const tombstone = buildSessionAgentTombstone();
    const merged = mergeSessionAgentSnapshot(existing, tombstone);
    // pendingInstructions carried over for next chat-start drain (P-MTI-9).
    expect(merged.pendingInstructions).toEqual(pending);
    // Tombstone still resets agent-runtime fields.
    expect(merged.stepIndex).toBe(0);
    expect(merged.agentMessages).toEqual([]);
    expect(merged.currentFocusTabId).toBeUndefined();
  });
});
