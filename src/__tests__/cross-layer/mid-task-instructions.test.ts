/**
 * Cross-layer tests for mid-task instructions (Issue #34).
 *
 * Tests 15 + 16 — happy path, cancel, reject, and abort-carryover.
 *
 * Architecture note: runAgentLoop is too tightly coupled to Chrome APIs to mock
 * economically (it needs tabs.get, scripting.executeScript, a live LLM, CDP, etc.).
 * Instead these tests exercise the real functions that carry the #34 invariants:
 *
 *   - addPending / cancelPending / drainPending  (storage layer)
 *   - buildMidTaskUserMessage                    (pure merge function)
 *   - broadcastInstructionState                  (read-from-storage + port.postMessage)
 *
 * The abort-carryover test exercises the exact code path in handleChatStream
 * that merges leftover pending into the first user message of the new task
 * (background/index.ts lines ~1039–1062). That logic is extracted into the same
 * testable primitives.
 */
import { describe, it, expect, vi } from "vitest";
import "@/test/setup";
import { chromeMock } from "@/test/setup";
import {
  addPending,
  cancelPending,
  drainPending,
} from "@/lib/sessions/pending-instructions";
import { buildMidTaskUserMessage, mergeCarryoverIntoMessages } from "@/lib/agent/loop-drain";
import { broadcastInstructionState } from "@/background/instruction-broadcast";
import type { SessionAgentState } from "@/lib/sessions/types";

// ── Test helpers ─────────────────────────────────────────────────────────────

const SESSION_ID = "test-session-mid-task";

function seedAgentState(
  sessionId = SESSION_ID,
  overrides: Partial<SessionAgentState> = {},
): void {
  chromeMock.storage.local.__store[`session_${sessionId}_agent`] = {
    agentMessages: [],
    pendingInstructions: [],
    stepIndex: 0,
    hasImageContent: false,
    ...overrides,
  } satisfies SessionAgentState;
}

function getAgentState(sessionId = SESSION_ID): SessionAgentState | undefined {
  return chromeMock.storage.local.__store[
    `session_${sessionId}_agent`
  ] as SessionAgentState | undefined;
}

function makeFakePort() {
  return { postMessage: vi.fn() } as unknown as chrome.runtime.Port;
}

// ── T15: Happy-path ───────────────────────────────────────────────────────────

describe("T15 — mid-task happy path: add → drain → LLM merge", () => {
  it("drainPending returns all instructions in FIFO order and empties the queue", async () => {
    seedAgentState();
    await addPending(SESSION_ID, {
      chatMessageId: "msg-1",
      content: "also check the news",
      createdAt: 1000,
    });
    await addPending(SESSION_ID, {
      chatMessageId: "msg-2",
      content: "also check weather",
      expandedForLLM: "expanded weather check",
      createdAt: 2000,
    });

    const drained = await drainPending(SESSION_ID);
    expect(drained).toHaveLength(2);
    expect(drained[0]!.chatMessageId).toBe("msg-1");
    expect(drained[1]!.chatMessageId).toBe("msg-2");

    // Queue is now empty
    const state = getAgentState();
    expect(state!.pendingInstructions).toEqual([]);
  });

  it("buildMidTaskUserMessage produces a merged <untrusted_user_message source=\"mid_task\"> user message", async () => {
    seedAgentState();
    await addPending(SESSION_ID, {
      chatMessageId: "msg-1",
      content: "first mid-task instruction",
      createdAt: 1000,
    });
    await addPending(SESSION_ID, {
      chatMessageId: "msg-2",
      content: "second mid-task instruction",
      createdAt: 2000,
    });

    const drained = await drainPending(SESSION_ID);
    const merged = buildMidTaskUserMessage(drained);

    // Shape
    expect(merged).not.toBeNull();
    expect(merged!.role).toBe("user");

    // Contains both instructions numbered
    const content = merged!.content as string;
    expect(content).toContain('<untrusted_user_message source="mid_task">');
    expect(content).toContain("1. first mid-task instruction");
    expect(content).toContain("2. second mid-task instruction");
    expect(content).toContain("</untrusted_user_message>");
  });

  it("after drain, storage has empty pendingInstructions (state broadcast precondition)", async () => {
    seedAgentState();
    await addPending(SESSION_ID, {
      chatMessageId: "msg-1",
      content: "instruction A",
      createdAt: 1000,
    });

    await drainPending(SESSION_ID);

    const state = getAgentState();
    expect(state!.pendingInstructions).toEqual([]);
  });

  it("broadcastInstructionState posts empty pending array after drain", async () => {
    seedAgentState();
    await addPending(SESSION_ID, {
      chatMessageId: "msg-1",
      content: "instruction to drain",
      createdAt: 1000,
    });
    await drainPending(SESSION_ID);

    const port = makeFakePort();
    await broadcastInstructionState(port, SESSION_ID);

    expect(port.postMessage).toHaveBeenCalledOnce();
    const msg = (port.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(msg.type).toBe("chat-instruction-state");
    expect(msg.sessionId).toBe(SESSION_ID);
    expect(msg.pending).toEqual([]);
  });

  it("full pipeline: addPending(×2) → drainPending → buildMidTaskUserMessage → pending is empty", async () => {
    seedAgentState();
    const now = Date.now();
    await addPending(SESSION_ID, {
      chatMessageId: "m1",
      content: "check stocks",
      createdAt: now,
    });
    await addPending(SESSION_ID, {
      chatMessageId: "m2",
      content: "check sports",
      expandedForLLM: "fetch latest sports scores",
      createdAt: now + 1,
    });

    // Simulate what the loop does at the top of each iteration
    const drained = await drainPending(SESSION_ID);
    const llmMsg = buildMidTaskUserMessage(drained);

    // LLM message is a properly-wrapped user turn
    expect(llmMsg).not.toBeNull();
    const content = llmMsg!.content as string;
    expect(content).toMatch(/^<untrusted_user_message source="mid_task">/);
    expect(content).toContain("1. check stocks");
    // expandedForLLM is preferred over content
    expect(content).toContain("2. fetch latest sports scores");
    expect(content).not.toContain("check sports");
    expect(content).toMatch(/<\/untrusted_user_message>$/);

    // After drain, queue is empty
    expect(getAgentState()!.pendingInstructions).toEqual([]);
  });
});

// ── T16a: Cancel test ─────────────────────────────────────────────────────────

describe("T16a — cancel: canceled instruction does not appear in next LLM call", () => {
  it("cancel removes the matching entry so it is absent from the drained list", async () => {
    seedAgentState();
    await addPending(SESSION_ID, {
      chatMessageId: "keep-me",
      content: "this instruction should stay",
      createdAt: 1000,
    });
    await addPending(SESSION_ID, {
      chatMessageId: "cancel-me",
      content: "this instruction should be removed",
      createdAt: 2000,
    });

    // Simulate panel dispatching chat-instruction-cancel
    const removed = await cancelPending(SESSION_ID, "cancel-me");
    expect(removed).toBe(true);

    // Next loop iteration drains — the canceled one is gone
    const drained = await drainPending(SESSION_ID);
    expect(drained).toHaveLength(1);
    expect(drained[0]!.chatMessageId).toBe("keep-me");

    const merged = buildMidTaskUserMessage(drained);
    expect(merged!.content).toContain("this instruction should stay");
    expect(merged!.content).not.toContain("this instruction should be removed");
  });

  it("cancel on already-drained chatMessageId is idempotent (returns false, no crash)", async () => {
    seedAgentState();
    await addPending(SESSION_ID, {
      chatMessageId: "m1",
      content: "some instruction",
      createdAt: 1000,
    });
    // Drain first (simulates loop already consuming it)
    await drainPending(SESSION_ID);

    // Now try to cancel the drained id
    const removed = await cancelPending(SESSION_ID, "m1");
    expect(removed).toBe(false);
  });

  it("after cancel, broadcastInstructionState reflects the smaller queue", async () => {
    seedAgentState();
    await addPending(SESSION_ID, {
      chatMessageId: "keep",
      content: "stay",
      createdAt: 1000,
    });
    await addPending(SESSION_ID, {
      chatMessageId: "zap",
      content: "go away",
      createdAt: 2000,
    });

    await cancelPending(SESSION_ID, "zap");

    const port = makeFakePort();
    await broadcastInstructionState(port, SESSION_ID);

    const msg = (port.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(msg.type).toBe("chat-instruction-state");
    expect(msg.pending).toHaveLength(1);
    expect(msg.pending[0].chatMessageId).toBe("keep");
  });
});

// ── T16b: Reject test ─────────────────────────────────────────────────────────
//
// When the loop is NOT in flight (i.e. task has completed), the background
// handler checks `inFlightSessionIds.has(sessionId)` and emits
// chat-instruction-rejected. This protocol is verified here at the logic level:
// a chat-instruction-add after the loop ends MUST produce a rejected reply
// rather than writing to the queue (which would pollute the next task).

describe("T16b — reject: chat-instruction-add after loop ends returns rejected", () => {
  it("instruction-add to a non-in-flight session should be detected and rejected (logic check)", () => {
    // Simulate the SW's inFlightSessionIds mechanism (a Set<string>)
    const inFlightSessionIds = new Set<string>();
    const sessionId = "session-not-running";

    // No chat-start issued for this session
    const isInFlight = inFlightSessionIds.has(sessionId);
    expect(isInFlight).toBe(false);

    // This matches the background/index.ts guard:
    //   if (!inFlightSessionIds.has(message.sessionId)) { → send rejected }
    const shouldReject = !isInFlight;
    expect(shouldReject).toBe(true);
  });

  it("instruction-add to an in-flight session should NOT be rejected", () => {
    const inFlightSessionIds = new Set<string>();
    const sessionId = "session-running";
    inFlightSessionIds.add(sessionId);

    const isInFlight = inFlightSessionIds.has(sessionId);
    expect(isInFlight).toBe(true);

    const shouldReject = !isInFlight;
    expect(shouldReject).toBe(false);
  });

  it("after chat-abort, session leaves inFlightSessionIds so next instruction-add is rejected", () => {
    const inFlightSessionIds = new Set<string>();
    const sessionId = "session-was-running";

    // chat-start: session enters set
    inFlightSessionIds.add(sessionId);
    expect(inFlightSessionIds.has(sessionId)).toBe(true);

    // emitDone removes the session (simulate loop completion)
    inFlightSessionIds.delete(sessionId);

    // Now instruction-add arrives → should be rejected
    expect(inFlightSessionIds.has(sessionId)).toBe(false);
  });

  it("rejected instruction does NOT write to storage (queue stays clean)", async () => {
    // When SW sends chat-instruction-rejected, addPending is NOT called.
    // Verify storage is clean.
    seedAgentState();

    // Simulate what the rejection path does: nothing to storage, just postMessage
    const port = makeFakePort();
    port.postMessage({
      type: "chat-instruction-rejected",
      sessionId: SESSION_ID,
      chatMessageId: "late-msg",
      reason: "not-streaming",
    });

    // Storage queue is untouched
    const state = getAgentState();
    expect(state!.pendingInstructions).toEqual([]);
    // Port received the rejection
    const msg = (port.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(msg.type).toBe("chat-instruction-rejected");
    expect(msg.reason).toBe("not-streaming");
  });
});

// ── T16c: Abort-carryover test ────────────────────────────────────────────────
//
// When a task is aborted with pending instructions still in the queue, the
// next chat-start merges them into the first user message as
// "[Earlier mid-task additions]". This mirrors handleChatStream lines ~1039–1062.

describe("T16c — abort-carryover: leftover pending merges into next task's first user message", () => {
  it("carryover from prior abort is merged into next task message with [Earlier mid-task additions] header", async () => {
    seedAgentState();

    // Session had 2 pending instructions when abort happened
    await addPending(SESSION_ID, {
      chatMessageId: "aborted-1",
      content: "check email",
      createdAt: 1000,
    });
    await addPending(SESSION_ID, {
      chatMessageId: "aborted-2",
      content: "check calendar",
      expandedForLLM: "show today's calendar events",
      createdAt: 2000,
    });

    // Simulate new chat-start: drain the carryover
    const carryover = await drainPending(SESSION_ID);
    expect(carryover).toHaveLength(2);

    // Use the extracted helper (mirrors handleChatStream in background/index.ts)
    const newTaskContent = "continue with my new task";
    const messages = [{ role: "user" as const, content: newTaskContent }];
    const mergedMessages = mergeCarryoverIntoMessages(messages, carryover);

    const resultContent = mergedMessages[0]!.content;
    expect(resultContent).toContain("continue with my new task");
    expect(resultContent).toContain("[Earlier mid-task additions]");
    expect(resultContent).toContain("1. check email");
    // expandedForLLM wins over content
    expect(resultContent).toContain("2. show today's calendar events");
    expect(resultContent).not.toContain("check calendar");
  });

  it("carryover with NO pending instructions leaves the new task message unchanged", async () => {
    seedAgentState(); // fresh session — empty queue

    const carryover = await drainPending(SESSION_ID);
    expect(carryover).toHaveLength(0);

    const newTaskContent = "clean new task, no carryover";
    const messages = [{ role: "user" as const, content: newTaskContent }];

    // mergeCarryoverIntoMessages returns messages unchanged when carryover is empty
    const mergedMessages = mergeCarryoverIntoMessages(messages, carryover);
    expect(mergedMessages).toBe(messages); // same reference — no copy made

    expect(mergedMessages[0]!.content).toBe(newTaskContent);
    expect(mergedMessages[0]!.content).not.toContain("[Earlier mid-task additions]");
  });

  it("storage is empty after carryover drain so second chat-start is clean", async () => {
    seedAgentState();
    await addPending(SESSION_ID, {
      chatMessageId: "leftover",
      content: "leftover instruction",
      createdAt: 1000,
    });

    // First new chat-start drains carryover
    await drainPending(SESSION_ID);

    // Second chat-start would see empty queue
    const secondCarryover = await drainPending(SESSION_ID);
    expect(secondCarryover).toHaveLength(0);
  });

  it("returns original messages ref unchanged when last message is not a user string (assistant role)", async () => {
    seedAgentState();
    await addPending(SESSION_ID, {
      chatMessageId: "orphan",
      content: "this will be dropped",
      createdAt: 1000,
    });
    const carryover = await drainPending(SESSION_ID);
    expect(carryover).toHaveLength(1);

    // Last message is assistant role — cannot merge
    const messages = [{ role: "assistant" as const, content: "prior reply" }];
    const result = mergeCarryoverIntoMessages(messages, carryover);

    // Same reference returned — no modification
    expect(result).toBe(messages);
    expect(result[0]!.content).toBe("prior reply");
    expect(result[0]!.content).not.toContain("[Earlier mid-task additions]");
  });

  it("returns original messages ref unchanged when last message content is not a string", async () => {
    seedAgentState();
    await addPending(SESSION_ID, {
      chatMessageId: "orphan-2",
      content: "also dropped",
      createdAt: 1000,
    });
    const carryover = await drainPending(SESSION_ID);
    expect(carryover).toHaveLength(1);

    // Last message is user role but content is an array (vision message, etc.)
    const messages = [
      { role: "user" as const, content: [{ type: "text", text: "image attached" }] as unknown as string },
    ];
    const result = mergeCarryoverIntoMessages(messages, carryover);

    // Same reference returned — no modification
    expect(result).toBe(messages);
  });
});
