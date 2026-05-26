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
