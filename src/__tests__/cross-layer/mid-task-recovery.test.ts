/**
 * Cross-layer recovery tests for mid-task instructions (Issue #34).
 *
 * Task 17 — two recovery scenarios:
 *
 *   1. SW restart preserves queue: pending instructions survive because
 *      they are persisted in chrome.storage.local (not SW module memory).
 *      After SW eviction, a resumed session can still drain them.
 *
 *   2. Panel reconnect broadcast: when a panel disconnects and reconnects
 *      with the same sessionId, the SW calls broadcastInstructionState
 *      which re-emits the current pending queue so the panel can re-decorate
 *      pending bubbles.
 *
 * Both scenarios are tested against the real functions that carry the
 * persistence invariant — no mocking of the agent loop itself.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@/test/setup";
import {
  addPending,
  drainPending,
} from "@/lib/sessions/pending-instructions";
import { setSessionAgent, getSessionAgent } from "@/lib/sessions/storage";
import { _resetForTests } from "@/lib/idb/db";
import { broadcastInstructionState } from "@/background/instruction-broadcast";
import { buildMidTaskUserMessage } from "@/lib/agent/loop-drain";
import type { SessionAgentState } from "@/lib/sessions/types";

// ── Test helpers ─────────────────────────────────────────────────────────────

const SESSION_ID = "test-session-recovery";

beforeEach(async () => {
  await _resetForTests();
});

// Seeds the session agent state into IDB. Post-migration, the queue persists in
// the `pie` IDB database (sessions store, `${id}:agent` record) rather than
// chrome.storage.local — IDB likewise survives SW eviction.
async function seedAgentState(
  sessionId = SESSION_ID,
  overrides: Partial<SessionAgentState> = {},
): Promise<void> {
  await setSessionAgent(sessionId, {
    agentMessages: [],
    pendingInstructions: [],
    stepIndex: 1, // in-flight task
    hasImageContent: false,
    ...overrides,
  } satisfies SessionAgentState);
}

async function getAgentState(
  sessionId = SESSION_ID,
): Promise<SessionAgentState | undefined> {
  return (await getSessionAgent(sessionId)) ?? undefined;
}

function makeFakePort() {
  return { postMessage: vi.fn() } as unknown as chrome.runtime.Port;
}

// ── T17a: SW restart preserves queue ─────────────────────────────────────────
//
// SW module-level state is volatile (cleared on eviction). However, all
// pending instructions are persisted in chrome.storage.local (the
// `session_${id}_agent` key). After SW restart, the storage data is intact
// and the queue can still be drained.

describe("T17a — SW restart preserves pending queue", () => {
  it("pending instructions survive SW eviction (chrome.storage.local persists)", async () => {
    await seedAgentState();

    // chat-start → user adds 2 pending instructions during streaming
    await addPending(SESSION_ID, {
      chatMessageId: "pi-1",
      content: "also bookmark this",
      createdAt: 1000,
    });
    await addPending(SESSION_ID, {
      chatMessageId: "pi-2",
      content: "also translate the page",
      createdAt: 2000,
    });

    // Verify queue exists in storage
    const beforeEviction = await getAgentState();
    expect(beforeEviction!.pendingInstructions).toHaveLength(2);

    // ── Simulate SW eviction ──────────────────────────────────────────────
    // SW eviction clears module-level JS state (e.g. inFlightSessionIds,
    // port references, AbortController). Storage is NOT affected.
    // In vitest we model this by noting: chrome.storage.local.__store
    // still contains the data — only the SW module's in-memory objects
    // would be lost, but all persistent state comes from storage.
    //
    // The session-recovery machinery (handlePanelMounted → detectAndMarkPaused)
    // then transitions the session to 'paused'. Once the user clicks "Resume",
    // handleResumeRequest re-runs drainPending at the first loop iteration.
    // We test just the storage-persists invariant here.

    // Storage is still intact (chrome.storage.local persists across restarts)
    const afterEviction = await getAgentState();
    expect(afterEviction!.pendingInstructions).toHaveLength(2);
    expect(afterEviction!.pendingInstructions[0]!.chatMessageId).toBe("pi-1");
    expect(afterEviction!.pendingInstructions[1]!.chatMessageId).toBe("pi-2");
  });

  it("after SW restart, resumed session drains pending and produces correct LLM message", async () => {
    await seedAgentState();

    await addPending(SESSION_ID, {
      chatMessageId: "resume-instr-1",
      content: "also search for alternatives",
      createdAt: 1000,
    });

    // Simulate SW eviction (only module state is lost, storage is intact)
    // After panel reconnects and user resumes → handleResumeRequest calls
    // drainPending at the top of the first loop iteration

    const drained = await drainPending(SESSION_ID);
    expect(drained).toHaveLength(1);
    expect(drained[0]!.chatMessageId).toBe("resume-instr-1");

    const llmMsg = buildMidTaskUserMessage(drained);
    expect(llmMsg).not.toBeNull();
    expect(llmMsg!.content).toContain('<untrusted_user_message source="mid_task">');
    expect(llmMsg!.content).toContain("also search for alternatives");

    // Queue is now empty
    expect((await getAgentState())!.pendingInstructions).toEqual([]);
  });

  it("agent state is durably readable across SW restart (IDB persists)", async () => {
    const sessionId = "recovery-key-format";
    await seedAgentState(sessionId);

    await addPending(sessionId, {
      chatMessageId: "key-test",
      content: "test instruction",
      createdAt: 1000,
    });

    // Post-migration the queue lives in the `pie` IDB database (record id
    // `${sessionId}:agent`), which survives SW eviction. The SW reads it back
    // via getSessionAgent on startup during detectAndMarkPaused/
    // handlePanelMounted — the durability invariant is what matters, not the
    // legacy chrome.storage key string.
    const rawState = await getSessionAgent(sessionId);
    expect(rawState).toBeDefined();
    expect(rawState!.pendingInstructions).toHaveLength(1);
    expect(rawState!.pendingInstructions[0]!.content).toBe("test instruction");
  });

  it("SW restart with multiple sessions: each session's queue is independent", async () => {
    const idA = "recovery-session-A";
    const idB = "recovery-session-B";
    await seedAgentState(idA);
    await seedAgentState(idB);

    await addPending(idA, {
      chatMessageId: "a-1",
      content: "instruction for A",
      createdAt: 1000,
    });
    await addPending(idB, {
      chatMessageId: "b-1",
      content: "instruction for B",
      createdAt: 1000,
    });
    await addPending(idB, {
      chatMessageId: "b-2",
      content: "second for B",
      createdAt: 2000,
    });

    // After SW eviction, both sessions retain their independent queues
    expect((await getAgentState(idA))!.pendingInstructions).toHaveLength(1);
    expect((await getAgentState(idB))!.pendingInstructions).toHaveLength(2);

    // Drain A only — B is unaffected
    const drainedA = await drainPending(idA);
    expect(drainedA).toHaveLength(1);
    expect(drainedA[0]!.chatMessageId).toBe("a-1");

    expect((await getAgentState(idA))!.pendingInstructions).toHaveLength(0);
    expect((await getAgentState(idB))!.pendingInstructions).toHaveLength(2);
  });

  it("SW restart + no pending: drainPending returns empty (no crash, no spurious message)", async () => {
    await seedAgentState();
    // No addPending calls — task aborted before user added anything

    const drained = await drainPending(SESSION_ID);
    expect(drained).toHaveLength(0);

    const msg = buildMidTaskUserMessage(drained);
    expect(msg).toBeNull(); // null means "don't push to history"
  });
});

// ── T17b: Panel reconnect broadcast ──────────────────────────────────────────
//
// When a panel reconnects after a disconnect (port dies on SW eviction or
// panel re-mount), the SW's handlePanelMounted calls broadcastInstructionState
// which reads from storage and emits the current pending queue.
// The panel uses this to re-decorate pending bubbles with the "pending" badge.

describe("T17b — panel reconnect: SW broadcasts current pending state", () => {
  it("broadcastInstructionState re-emits current pending queue after panel reconnect", async () => {
    await seedAgentState();
    await addPending(SESSION_ID, {
      chatMessageId: "pending-on-reconnect-1",
      content: "check my messages",
      createdAt: 1500,
    });
    await addPending(SESSION_ID, {
      chatMessageId: "pending-on-reconnect-2",
      content: "then summarise",
      createdAt: 2500,
    });

    // Simulate panel reconnect: new port is created, panel-mounted handler
    // calls broadcastInstructionState on the new port
    const reconnectedPort = makeFakePort();
    await broadcastInstructionState(reconnectedPort, SESSION_ID);

    expect(reconnectedPort.postMessage).toHaveBeenCalledOnce();
    const msg = (reconnectedPort.postMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(msg.type).toBe("chat-instruction-state");
    expect(msg.sessionId).toBe(SESSION_ID);
    expect(msg.pending).toHaveLength(2);
    expect(msg.pending[0].chatMessageId).toBe("pending-on-reconnect-1");
    expect(msg.pending[1].chatMessageId).toBe("pending-on-reconnect-2");
  });

  it("broadcastInstructionState emits slim payload (chatMessageId + createdAt only)", async () => {
    await seedAgentState();
    await addPending(SESSION_ID, {
      chatMessageId: "slim-test",
      content: "full content not in broadcast",
      expandedForLLM: "also not in broadcast",
      createdAt: 9999,
    });

    const port = makeFakePort();
    await broadcastInstructionState(port, SESSION_ID);

    const msg = (port.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const entry = msg.pending[0];
    expect(entry.chatMessageId).toBe("slim-test");
    expect(entry.createdAt).toBe(9999);
    // Content and expandedForLLM are NOT in the broadcast (panel doesn't need them)
    expect(entry.content).toBeUndefined();
    expect(entry.expandedForLLM).toBeUndefined();
  });

  it("reconnect with empty queue broadcasts empty pending array (no residue from prior task)", async () => {
    await seedAgentState();
    // No pending added (task completed cleanly or never started)

    const port = makeFakePort();
    await broadcastInstructionState(port, SESSION_ID);

    const msg = (port.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(msg.type).toBe("chat-instruction-state");
    expect(msg.pending).toEqual([]);
  });

  it("reconnect after partial cancel: broadcast reflects remaining pending only", async () => {
    const { cancelPending } = await import(
      "@/lib/sessions/pending-instructions"
    );
    await seedAgentState();
    await addPending(SESSION_ID, {
      chatMessageId: "stay-1",
      content: "keep this",
      createdAt: 1000,
    });
    await addPending(SESSION_ID, {
      chatMessageId: "gone-2",
      content: "remove this",
      createdAt: 2000,
    });
    await cancelPending(SESSION_ID, "gone-2");

    // Panel reconnects → broadcast should show only 'stay-1'
    const port = makeFakePort();
    await broadcastInstructionState(port, SESSION_ID);

    const msg = (port.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(msg.pending).toHaveLength(1);
    expect(msg.pending[0].chatMessageId).toBe("stay-1");
  });

  it("reconnect with missing session agent state: broadcast sends empty pending (graceful)", async () => {
    // No seedAgentState — session agent key doesn't exist in storage
    const missingSessionId = "session-that-does-not-exist";

    const port = makeFakePort();
    await broadcastInstructionState(port, missingSessionId);

    const msg = (port.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(msg.type).toBe("chat-instruction-state");
    expect(msg.sessionId).toBe(missingSessionId);
    expect(msg.pending).toEqual([]);
  });

  it("multiple reconnects on the same port each get the current snapshot", async () => {
    await seedAgentState();
    await addPending(SESSION_ID, {
      chatMessageId: "p1",
      content: "first",
      createdAt: 1000,
    });

    const port = makeFakePort();

    // First reconnect
    await broadcastInstructionState(port, SESSION_ID);
    const call1 = (port.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call1.pending).toHaveLength(1);

    // More instructions added mid-task
    await addPending(SESSION_ID, {
      chatMessageId: "p2",
      content: "second",
      createdAt: 2000,
    });

    // Second reconnect (port re-mounts) — fresh call reflects updated queue
    await broadcastInstructionState(port, SESSION_ID);
    const call2 = (port.postMessage as ReturnType<typeof vi.fn>).mock.calls[1]![0];
    expect(call2.pending).toHaveLength(2);
  });
});
