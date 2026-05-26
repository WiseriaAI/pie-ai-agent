import { describe, it, expect, beforeEach, vi } from "vitest";
import { addPending, cancelPending, drainPending } from "./pending-instructions";
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

beforeEach(() => {
  const data: Record<string, unknown> = {};
  // @ts-expect-error mock
  global.chrome = {
    storage: {
      local: {
        get: vi.fn((keys) => {
          const want = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of want) if (k in data) out[k] = data[k];
          return Promise.resolve(out);
        }),
        set: vi.fn((kv: Record<string, unknown>) => {
          Object.assign(data, kv);
          return Promise.resolve();
        }),
      },
    },
  };
  data[`session_${SESSION_ID}_agent`] = freshAgentState();
});

describe("addPending", () => {
  it("appends to queue and persists", async () => {
    await addPending(SESSION_ID, {
      chatMessageId: "msg-1",
      content: "also pin forums",
      createdAt: 1000,
    });
    const state = (await chrome.storage.local.get(`session_${SESSION_ID}_agent`))[
      `session_${SESSION_ID}_agent`
    ] as SessionAgentState;
    expect(state.pendingInstructions).toEqual([
      { chatMessageId: "msg-1", content: "also pin forums", createdAt: 1000 },
    ]);
  });

  it("preserves FIFO order across multiple adds", async () => {
    await addPending(SESSION_ID, { chatMessageId: "m1", content: "a", createdAt: 1 });
    await addPending(SESSION_ID, { chatMessageId: "m2", content: "b", createdAt: 2 });
    await addPending(SESSION_ID, { chatMessageId: "m3", content: "c", createdAt: 3 });
    const state = (await chrome.storage.local.get(`session_${SESSION_ID}_agent`))[
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
    await addPending(SESSION_ID, { chatMessageId: "m1", content: "a", createdAt: 1 });
    await addPending(SESSION_ID, { chatMessageId: "m2", content: "b", createdAt: 2 });
    const removed = await cancelPending(SESSION_ID, "m1");
    expect(removed).toBe(true);
    const state = (await chrome.storage.local.get(`session_${SESSION_ID}_agent`))[
      `session_${SESSION_ID}_agent`
    ] as SessionAgentState;
    expect(state.pendingInstructions.map((p) => p.chatMessageId)).toEqual(["m2"]);
  });

  it("returns false and no-ops when chatMessageId not present", async () => {
    await addPending(SESSION_ID, { chatMessageId: "m1", content: "a", createdAt: 1 });
    const removed = await cancelPending(SESSION_ID, "nope");
    expect(removed).toBe(false);
    const state = (await chrome.storage.local.get(`session_${SESSION_ID}_agent`))[
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
    await addPending(SESSION_ID, { chatMessageId: "m1", content: "a", createdAt: 1 });
    await addPending(SESSION_ID, { chatMessageId: "m2", content: "b", createdAt: 2 });
    const drained = await drainPending(SESSION_ID);
    expect(drained.map((p) => p.chatMessageId)).toEqual(["m1", "m2"]);
    const state = (await chrome.storage.local.get(`session_${SESSION_ID}_agent`))[
      `session_${SESSION_ID}_agent`
    ] as SessionAgentState;
    expect(state.pendingInstructions).toEqual([]);
  });

  it("returns empty array when queue empty (no storage write)", async () => {
    const setSpy = vi.spyOn(chrome.storage.local, "set");
    const drained = await drainPending(SESSION_ID);
    expect(drained).toEqual([]);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("returns empty when session missing", async () => {
    const drained = await drainPending("nonexistent");
    expect(drained).toEqual([]);
  });

  it("preserves all PendingInstruction fields including expandedForLLM/attachments", async () => {
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
