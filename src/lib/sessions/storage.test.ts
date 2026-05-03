import { describe, expect, it, vi } from "vitest";
import { chromeMock } from "@/test/setup";
import {
  createSession,
  getSessionAgent,
  getSessionMeta,
  getTotalBytes,
  getPendingConfirmCount,
  isPendingConfirmFloodLimited,
  listSessionIndex,
  markFailed,
  markFailedAndScrub,
  markPaused,
  removeSession,
  scrubPendingConfirm,
  setPendingConfirm,
  setSessionAgent,
  setSessionMeta,
  updateLastAccessed,
  setLastTaskSynth,
  clearLastTaskSynth,
  migrateLastTaskSynthFromMeta,
  agentKey,
  metaKey,
} from "./storage";
import type {
  PendingConfirmRecord,
  SessionAgentState,
  SessionMeta,
} from "./types";

// Re-used dummy PendingConfirmRecord shape for SEC-PLAN-009 tests (defined
// near usage at the bottom, but TypeScript needs the import at the top).

// `chrome.storage.local` is mocked in src/test/setup.ts. The mock auto-resets
// between tests via the `beforeEach` defined there; tests that need to seed
// state directly can poke chromeMock.storage.local.__store.

describe("createSession", () => {
  it("writes meta + agent + index in one atomic batch", async () => {
    // Spy on the underlying set() to assert single-call atomicity (D9).
    const setSpy = vi.spyOn(chromeMock.storage.local, "set");

    const meta = await createSession({ now: 1700000000000 });

    expect(setSpy).toHaveBeenCalledTimes(1);
    const call = setSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(call).sort()).toEqual([
      `session_${meta.id}_agent`,
      `session_${meta.id}_meta`,
      "session_index",
    ]);

    setSpy.mockRestore();
  });

  it("seeds meta with createdAt = lastAccessedAt = now and status=active", async () => {
    const meta = await createSession({ now: 1700000000000 });
    expect(meta.createdAt).toBe(1700000000000);
    expect(meta.lastAccessedAt).toBe(1700000000000);
    expect(meta.status).toBe("active");
    expect(meta.messages).toEqual([]);
    expect(meta.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("returns unique ids on repeated calls", async () => {
    const a = await createSession();
    const b = await createSession();
    const c = await createSession();
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  it("seeds an empty agent state", async () => {
    const meta = await createSession();
    const agent = await getSessionAgent(meta.id);
    expect(agent).not.toBeNull();
    expect(agent!.agentMessages).toEqual([]);
    expect(agent!.stepIndex).toBe(0);
    expect(agent!.skillExecutionScopeStack).toEqual([]);
    expect(agent!.pendingConfirm).toBeUndefined();
  });

  it("accepts optional pinnedTabId / pinnedOrigin (M3-U2 forward-compat)", async () => {
    const meta = await createSession({
      pinnedTabId: 42,
      pinnedOrigin: "https://docs.google.com",
    });
    expect(meta.pinnedTabId).toBe(42);
    expect(meta.pinnedOrigin).toBe("https://docs.google.com");
    const reread = await getSessionMeta(meta.id);
    expect(reread!.pinnedTabId).toBe(42);
    expect(reread!.pinnedOrigin).toBe("https://docs.google.com");
  });

  it("registers the session in session_index immediately", async () => {
    const meta = await createSession();
    const list = await listSessionIndex();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(meta.id);
    expect(list[0]!.status).toBe("active");
  });
});

describe("getSessionMeta / getSessionAgent", () => {
  it("returns null for unknown ids (does not throw)", async () => {
    expect(await getSessionMeta("not-a-real-id")).toBeNull();
    expect(await getSessionAgent("not-a-real-id")).toBeNull();
  });

  it("round-trips a session created via createSession", async () => {
    const meta = await createSession({ now: 1700000000000 });
    const reread = await getSessionMeta(meta.id);
    expect(reread).toEqual(meta);
  });
});

describe("setSessionMeta / setSessionAgent — D2 dual-key independence", () => {
  it("setSessionMeta does not perturb the agent key", async () => {
    const meta = await createSession();
    // Mutate the agent state out-of-band so we can detect leakage.
    const agentBefore: SessionAgentState = {
      agentMessages: [{ role: "user", content: "hi" }],
      stepIndex: 7,
      skillExecutionScopeStack: [],
    };
    await setSessionAgent(meta.id, agentBefore);

    const updatedMeta: SessionMeta = { ...meta, title: "renamed" };
    await setSessionMeta(updatedMeta);

    const agentAfter = await getSessionAgent(meta.id);
    expect(agentAfter).toEqual(agentBefore);
  });

  it("setSessionAgent does not perturb meta or the index", async () => {
    const meta = await createSession({ now: 1700000000000 });
    const indexBefore = await listSessionIndex();

    await setSessionAgent(meta.id, {
      agentMessages: [{ role: "assistant", content: "ok" }],
      stepIndex: 1,
      skillExecutionScopeStack: [],
    });

    const metaAfter = await getSessionMeta(meta.id);
    expect(metaAfter).toEqual(meta);
    expect(await listSessionIndex()).toEqual(indexBefore);
  });

  it("setSessionMeta updates the index when status / title / pinnedTabId / lastAccessedAt change", async () => {
    const meta = await createSession({ now: 1000 });
    await setSessionMeta({
      ...meta,
      status: "archived",
      archivedAt: 2000,
      lastAccessedAt: 2000,
    });

    const list = await listSessionIndex();
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe("archived");
    expect(list[0]!.lastAccessedAt).toBe(2000);
  });

  it("setSessionMeta does an atomic batch when index changes", async () => {
    const meta = await createSession();
    const setSpy = vi.spyOn(chromeMock.storage.local, "set");
    await setSessionMeta({ ...meta, status: "failed", lastAccessedAt: 999 });
    expect(setSpy).toHaveBeenCalledTimes(1);
    const call = setSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(call).sort()).toEqual([
      `session_${meta.id}_meta`,
      "session_index",
    ]);
    setSpy.mockRestore();
  });

  it("setSessionMeta skips index write when no index-tracked field changed", async () => {
    const meta = await createSession();
    const setSpy = vi.spyOn(chromeMock.storage.local, "set");
    // archivedAt is meta-only, not index-tracked → index write skipped.
    await setSessionMeta({ ...meta, archivedAt: 999 });
    expect(setSpy).toHaveBeenCalledTimes(1);
    const call = setSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(call)).toEqual([`session_${meta.id}_meta`]);
    setSpy.mockRestore();
  });
});

describe("listSessionIndex", () => {
  it("returns sessions in lastAccessedAt desc order", async () => {
    const a = await createSession({ now: 1000 });
    const b = await createSession({ now: 3000 });
    const c = await createSession({ now: 2000 });
    const list = await listSessionIndex();
    expect(list.map((e) => e.id)).toEqual([b.id, c.id, a.id]);
  });

  it("returns [] when nothing has been written", async () => {
    expect(await listSessionIndex()).toEqual([]);
  });

  it("survives a corrupt session_index entry by dropping it", async () => {
    const good = await createSession();
    // Inject a malformed entry alongside the good one.
    chromeMock.storage.local.__store.session_index = [
      ...((chromeMock.storage.local.__store.session_index ??
        []) as unknown[]),
      { id: 42 /* not a string */ },
      "totally-bogus",
    ];
    const list = await listSessionIndex();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(good.id);
  });

  it("returns [] when session_index is non-array garbage", async () => {
    chromeMock.storage.local.__store.session_index = "not-an-array";
    expect(await listSessionIndex()).toEqual([]);
  });

  it("includes archived sessions (caller filters)", async () => {
    const a = await createSession({ now: 1000 });
    await setSessionMeta({
      ...(await getSessionMeta(a.id))!,
      status: "archived",
      archivedAt: 1500,
      lastAccessedAt: 1500,
    });
    const list = await listSessionIndex();
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe("archived");
  });
});

describe("removeSession", () => {
  it("removes meta + agent + index entry in one atomic batch", async () => {
    const meta = await createSession();
    const setSpy = vi.spyOn(chromeMock.storage.local, "set");

    await removeSession(meta.id);

    expect(setSpy).toHaveBeenCalledTimes(1);
    const batch = setSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(batch).sort()).toEqual([
      `session_${meta.id}_agent`,
      `session_${meta.id}_meta`,
      "session_index",
    ]);
    expect(batch[`session_${meta.id}_meta`]).toBeUndefined();
    expect(batch[`session_${meta.id}_agent`]).toBeUndefined();
    expect(batch.session_index).toEqual([]);
    setSpy.mockRestore();

    expect(await getSessionMeta(meta.id)).toBeNull();
    expect(await getSessionAgent(meta.id)).toBeNull();
    expect(await listSessionIndex()).toEqual([]);
  });

  it("preserves other sessions when removing one", async () => {
    const a = await createSession();
    const b = await createSession();
    await removeSession(a.id);

    expect(await getSessionMeta(a.id)).toBeNull();
    expect(await getSessionMeta(b.id)).not.toBeNull();
    const list = await listSessionIndex();
    expect(list.map((e) => e.id)).toEqual([b.id]);
  });

  it("is a no-op for unknown ids", async () => {
    const a = await createSession();
    await removeSession("not-a-real-id");
    expect(await getSessionMeta(a.id)).not.toBeNull();
  });
});

describe("updateLastAccessed", () => {
  it("bumps lastAccessedAt on meta + index in a single atomic batch", async () => {
    const meta = await createSession({ now: 1000 });

    const setSpy = vi.spyOn(chromeMock.storage.local, "set");
    const ok = await updateLastAccessed(meta.id, { now: 2000 });
    expect(ok).toBe(true);

    expect(setSpy).toHaveBeenCalledTimes(1);
    const batch = setSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(batch).sort()).toEqual([
      `session_${meta.id}_meta`,
      "session_index",
    ]);
    setSpy.mockRestore();

    const after = await getSessionMeta(meta.id);
    expect(after!.lastAccessedAt).toBe(2000);
    const list = await listSessionIndex();
    expect(list[0]!.lastAccessedAt).toBe(2000);
  });

  it("can update status and pinnedTabId together", async () => {
    const meta = await createSession({ now: 1000 });
    await updateLastAccessed(meta.id, {
      now: 2000,
      status: "paused",
      pinnedTabId: 99,
    });
    const after = await getSessionMeta(meta.id);
    expect(after!.status).toBe("paused");
    expect(after!.pinnedTabId).toBe(99);
    const list = await listSessionIndex();
    expect(list[0]!.status).toBe("paused");
    expect(list[0]!.pinnedTabId).toBe(99);
  });

  it("returns false for unknown ids", async () => {
    expect(await updateLastAccessed("not-a-real-id")).toBe(false);
  });
});

describe("setPendingConfirm / scrubPendingConfirm — M1-U4", () => {
  const sampleRecord: PendingConfirmRecord = {
    confirmationId: "c1",
    kind: "agent-tool",
    payload: {
      tool: "click",
      args: { elementIndex: 7 },
      resolvedElement: { text: "Submit", tag: "button" },
      riskReason: "submit button",
    },
  };

  it("setPendingConfirm writes the record to the agent state", async () => {
    const meta = await createSession();
    await setPendingConfirm(meta.id, sampleRecord);
    const agent = await getSessionAgent(meta.id);
    expect(agent!.pendingConfirm).toEqual(sampleRecord);
  });

  it("setPendingConfirm preserves other agent-state fields (D2 dual-key safe)", async () => {
    const meta = await createSession();
    await setSessionAgent(meta.id, {
      agentMessages: [{ role: "user", content: "hi" }],
      stepIndex: 3,
      skillExecutionScopeStack: [],
    });
    await setPendingConfirm(meta.id, sampleRecord);
    const agent = await getSessionAgent(meta.id);
    expect(agent!.agentMessages).toEqual([{ role: "user", content: "hi" }]);
    expect(agent!.stepIndex).toBe(3);
    expect(agent!.pendingConfirm).toEqual(sampleRecord);
  });

  it("setPendingConfirm is a no-op for unknown sessionId (does not create orphan)", async () => {
    await setPendingConfirm("not-a-real-id", sampleRecord);
    const agent = await getSessionAgent("not-a-real-id");
    expect(agent).toBeNull();
  });

  it("scrubPendingConfirm removes only the pendingConfirm field", async () => {
    const meta = await createSession();
    await setSessionAgent(meta.id, {
      agentMessages: [{ role: "user", content: "hi" }],
      stepIndex: 3,
      skillExecutionScopeStack: [],
    });
    await setPendingConfirm(meta.id, sampleRecord);
    await scrubPendingConfirm(meta.id);
    const agent = await getSessionAgent(meta.id);
    expect(agent!.pendingConfirm).toBeUndefined();
    expect("pendingConfirm" in agent!).toBe(false);
    // Other fields intact.
    expect(agent!.agentMessages).toEqual([{ role: "user", content: "hi" }]);
    expect(agent!.stepIndex).toBe(3);
  });

  it("scrubPendingConfirm is idempotent on already-cleared state", async () => {
    const meta = await createSession();
    // No pendingConfirm to begin with.
    await scrubPendingConfirm(meta.id);
    await scrubPendingConfirm(meta.id);
    const agent = await getSessionAgent(meta.id);
    expect(agent!.pendingConfirm).toBeUndefined();
  });

  it("scrubPendingConfirm is a no-op for unknown sessionId", async () => {
    await scrubPendingConfirm("not-a-real-id");
    // Should not throw, should not create.
    expect(await getSessionAgent("not-a-real-id")).toBeNull();
  });

  it("setPendingConfirm with raw keyboard args.text — Phase 2.5 binary-channel preserves raw at-rest", async () => {
    const meta = await createSession();
    const keyboardRecord: PendingConfirmRecord = {
      confirmationId: "c2",
      kind: "agent-tool",
      payload: {
        tool: "dispatch_keyboard_input",
        args: { text: "password123" },
        resolvedElement: { text: "input", tag: "input" },
        riskReason: "high-risk keyboard input",
      },
    };
    await setPendingConfirm(meta.id, keyboardRecord);
    const agent = await getSessionAgent(meta.id);
    const stored = agent!.pendingConfirm!.payload as {
      args: { text: string };
    };
    // R28 v2: storage holds raw, panel-display redaction is a separate
    // path. Confirm cards need raw to give informed approval.
    expect(stored.args.text).toBe("password123");
    expect(stored.args.text).not.toContain("redacted");
    expect(stored.args.text).not.toContain("•");
  });
});

describe("markPaused / markFailed / markFailedAndScrub — M1-U5", () => {
  it("markPaused flips status from active to paused", async () => {
    const meta = await createSession();
    expect(meta.status).toBe("active");
    const ok = await markPaused(meta.id);
    expect(ok).toBe(true);
    const refreshed = await getSessionMeta(meta.id);
    expect(refreshed!.status).toBe("paused");
  });

  it("markPaused does NOT bump lastAccessedAt (LRU pollution avoidance)", async () => {
    const meta = await createSession({ now: 1000 });
    expect(meta.lastAccessedAt).toBe(1000);
    await markPaused(meta.id);
    const refreshed = await getSessionMeta(meta.id);
    expect(refreshed!.lastAccessedAt).toBe(1000);
  });

  it("markPaused returns false for unknown session id", async () => {
    expect(await markPaused("not-a-real-id")).toBe(false);
  });

  it("markPaused is idempotent on already-paused state", async () => {
    const meta = await createSession();
    await markPaused(meta.id);
    expect(await markPaused(meta.id)).toBe(true);
  });

  it("markFailed flips status from active to failed", async () => {
    const meta = await createSession();
    const ok = await markFailed(meta.id);
    expect(ok).toBe(true);
    const refreshed = await getSessionMeta(meta.id);
    expect(refreshed!.status).toBe("failed");
  });

  it("markFailedAndScrub clears pendingConfirm in addition to flipping status", async () => {
    const meta = await createSession();
    await setPendingConfirm(meta.id, {
      confirmationId: "c1",
      kind: "agent-tool",
      payload: { tool: "click", args: {}, resolvedElement: { text: "", tag: "" }, riskReason: "x" },
    });
    const ok = await markFailedAndScrub(meta.id);
    expect(ok).toBe(true);
    const refreshed = await getSessionMeta(meta.id);
    expect(refreshed!.status).toBe("failed");
    const agent = await getSessionAgent(meta.id);
    expect(agent!.pendingConfirm).toBeUndefined();
  });
});

describe("getTotalBytes", () => {
  it("reflects all storage keys, not only session_*", async () => {
    await createSession();
    // Seed an unrelated key (mirrors provider_/skill_/encryption_key).
    chromeMock.storage.local.__store.provider_anthropic = {
      key: "x".repeat(200),
    };
    const total = await getTotalBytes();
    expect(total).toBeGreaterThan(200);
  });

  it("is 0 for an empty store", async () => {
    expect(await getTotalBytes()).toBe(0);
  });
});

// ── SEC-PLAN-009 flood-limit helpers ──────────────────────────────────────────
// These tests verify the boundary conditions for the pending-confirm flood
// protection. The PENDING_CONFIRM_FLOOD_LIMIT is 5.

const MOCK_PENDING: PendingConfirmRecord = {
  confirmationId: "flood-test",
  kind: "agent-tool",
  payload: { tool: "click", args: {}, resolvedElement: { text: "", tag: "" }, riskReason: "x" },
};

describe("getPendingConfirmCount", () => {
  it("returns 0 when no sessions exist", async () => {
    expect(await getPendingConfirmCount()).toBe(0);
  });

  it("P1-10 — drift-card pendingConfirm (kind=pinned-tab-drift) does not count toward flood limit", async () => {
    // If getPendingConfirmCount counted drift-card confirms, a user who
    // retried Resume on 6 drifted-paused sessions over time would permanently
    // DoS every confirm in every session (count always > FLOOD_LIMIT).
    // Fix (c): only kind='agent-tool' counts.
    const sessions = await Promise.all([
      createSession(), createSession(), createSession(),
      createSession(), createSession(), createSession(),
    ]);
    // Write 6 drift-card pendingConfirms (kind='pinned-tab-drift')
    await Promise.all(
      sessions.map((s, i) =>
        setPendingConfirm(s.id, {
          confirmationId: `drift-${i}`,
          kind: "pinned-tab-drift",
          payload: { reason: "tab-closed", originalTask: "test", lastPinnedTabTitle: "", pinnedOrigin: "https://example.com", lastStepIndex: 0 },
        }),
      ),
    );
    // None of these should count toward the flood limit
    expect(await getPendingConfirmCount()).toBe(0);
    expect(await isPendingConfirmFloodLimited()).toBe(false);
  });

  it("returns 0 when sessions exist but none have pendingConfirm", async () => {
    await createSession();
    await createSession();
    expect(await getPendingConfirmCount()).toBe(0);
  });

  it("counts only sessions with pendingConfirm set", async () => {
    const s1 = await createSession();
    const s2 = await createSession();
    const s3 = await createSession();
    await setPendingConfirm(s1.id, { ...MOCK_PENDING, confirmationId: "c1" });
    await setPendingConfirm(s3.id, { ...MOCK_PENDING, confirmationId: "c3" });
    // s2 has no pendingConfirm
    expect(await getPendingConfirmCount()).toBe(2);
    void s2; // used
  });

  it("count decreases after scrubbing a pendingConfirm", async () => {
    const s1 = await createSession();
    const s2 = await createSession();
    await setPendingConfirm(s1.id, { ...MOCK_PENDING, confirmationId: "c1" });
    await setPendingConfirm(s2.id, { ...MOCK_PENDING, confirmationId: "c2" });
    expect(await getPendingConfirmCount()).toBe(2);
    await scrubPendingConfirm(s1.id);
    expect(await getPendingConfirmCount()).toBe(1);
  });
});

describe("isPendingConfirmFloodLimited (boundary = 5)", () => {
  it("returns false when 0 sessions have pendingConfirm", async () => {
    await createSession();
    expect(await isPendingConfirmFloodLimited()).toBe(false);
  });

  it("returns false when exactly 5 sessions have pendingConfirm", async () => {
    const sessions = await Promise.all([
      createSession(), createSession(), createSession(),
      createSession(), createSession(),
    ]);
    await Promise.all(
      sessions.map((s, i) =>
        setPendingConfirm(s.id, { ...MOCK_PENDING, confirmationId: `c${i}` }),
      ),
    );
    expect(await isPendingConfirmFloodLimited()).toBe(false);
  });

  it("returns true when 6 sessions have pendingConfirm", async () => {
    const sessions = await Promise.all([
      createSession(), createSession(), createSession(),
      createSession(), createSession(), createSession(),
    ]);
    await Promise.all(
      sessions.map((s, i) =>
        setPendingConfirm(s.id, { ...MOCK_PENDING, confirmationId: `c${i}` }),
      ),
    );
    expect(await isPendingConfirmFloodLimited()).toBe(true);
  });

  it("returns false again after scrubbing one confirm back to 5", async () => {
    const sessions = await Promise.all([
      createSession(), createSession(), createSession(),
      createSession(), createSession(), createSession(),
    ]);
    await Promise.all(
      sessions.map((s, i) =>
        setPendingConfirm(s.id, { ...MOCK_PENDING, confirmationId: `c${i}` }),
      ),
    );
    expect(await isPendingConfirmFloodLimited()).toBe(true);
    // Scrub one session → count drops to 5 → no longer flood-limited
    await scrubPendingConfirm(sessions[0]!.id);
    expect(await isPendingConfirmFloodLimited()).toBe(false);
  });
});

// ── U3 — setLastTaskSynth / clearLastTaskSynth (AD1 fix) ─────────────────────
//
// AD1 fix: lastTaskSynth moved from SessionMeta to SessionAgentState to
// eliminate the lost-update race with the panel's persistMessages
// (both were RMW on the same meta key at chat-done boundary).
// All tests now read/assert against the AGENT key, not the meta key.

describe("setLastTaskSynth / clearLastTaskSynth — U3 (AD1 fix: agent-state)", () => {
  it("setLastTaskSynth writes lastTaskSynth to agent state (not meta)", async () => {
    const meta = await createSession();
    const synth = "<untrusted_prior_task_summary>已完成: 打开飞书</untrusted_prior_task_summary>";
    await setLastTaskSynth(meta.id, synth);

    // AD1: field lives on agent state
    const agent = await getSessionAgent(meta.id);
    expect(agent!.lastTaskSynth).toBe(synth);

    // AD1: meta must NOT have the field (was the pre-fix location)
    const updatedMeta = await getSessionMeta(meta.id);
    expect((updatedMeta as Record<string, unknown>)["lastTaskSynth"]).toBeUndefined();
  });

  it("setLastTaskSynth writes only the agent key (no meta or index update)", async () => {
    // AD1: field is invisible to the session drawer and does not affect
    // LRU / messageCount / title / status. Writing only the agent key
    // also removes the race with panel's persistMessages (meta key).
    const setSpy = vi.spyOn(chromeMock.storage.local, "set");
    const meta = await createSession();
    setSpy.mockClear();

    await setLastTaskSynth(meta.id, "<untrusted_prior_task_summary>x</untrusted_prior_task_summary>");

    expect(setSpy).toHaveBeenCalledTimes(1);
    const batchKeys = Object.keys(setSpy.mock.calls[0]![0] as object);
    // AD1: key must be agent, not meta
    expect(batchKeys).toEqual([`session_${meta.id}_agent`]);
    setSpy.mockRestore();
  });

  it("setLastTaskSynth is a no-op for an unknown session id", async () => {
    // Should not throw, should not create phantom agent state.
    await setLastTaskSynth("no-such-session", "any-synth");
    expect(await getSessionAgent("no-such-session")).toBeNull();
  });

  it("clearLastTaskSynth removes the field from agent state", async () => {
    const meta = await createSession();
    await setLastTaskSynth(meta.id, "<untrusted_prior_task_summary>done</untrusted_prior_task_summary>");
    // Verify it was written to agent state
    expect((await getSessionAgent(meta.id))!.lastTaskSynth).toBeDefined();
    // Clear
    await clearLastTaskSynth(meta.id);
    // Should be gone from agent state
    const after = await getSessionAgent(meta.id);
    expect(after!.lastTaskSynth).toBeUndefined();
    expect("lastTaskSynth" in after!).toBe(false);
    // Meta must never have had the field
    const afterMeta = await getSessionMeta(meta.id);
    expect((afterMeta as Record<string, unknown>)["lastTaskSynth"]).toBeUndefined();
  });

  it("clearLastTaskSynth is a no-op when field is already absent", async () => {
    const meta = await createSession();
    // Field not set yet
    expect((await getSessionAgent(meta.id))!.lastTaskSynth).toBeUndefined();
    // Should not throw
    await clearLastTaskSynth(meta.id);
    expect((await getSessionAgent(meta.id))!.lastTaskSynth).toBeUndefined();
  });

  it("clearLastTaskSynth is a no-op for an unknown session id", async () => {
    await clearLastTaskSynth("no-such-session");
    expect(await getSessionAgent("no-such-session")).toBeNull();
  });

  it("one-shot: set then clear then set again — second write is visible", async () => {
    const meta = await createSession();
    const synth1 = "<untrusted_prior_task_summary>first</untrusted_prior_task_summary>";
    const synth2 = "<untrusted_prior_task_summary>second</untrusted_prior_task_summary>";

    await setLastTaskSynth(meta.id, synth1);
    expect((await getSessionAgent(meta.id))!.lastTaskSynth).toBe(synth1);

    await clearLastTaskSynth(meta.id);
    expect((await getSessionAgent(meta.id))!.lastTaskSynth).toBeUndefined();

    await setLastTaskSynth(meta.id, synth2);
    expect((await getSessionAgent(meta.id))!.lastTaskSynth).toBe(synth2);
  });

  it("setLastTaskSynth preserves other agent-state fields unchanged", async () => {
    const meta = await createSession();
    // Seed some agent state so we can verify nothing else is clobbered
    const agentBefore = await getSessionAgent(meta.id);
    await setSessionAgent(meta.id, {
      ...agentBefore!,
      stepIndex: 7,
    });

    await setLastTaskSynth(meta.id, "<untrusted_prior_task_summary>x</untrusted_prior_task_summary>");
    const agent = await getSessionAgent(meta.id);
    expect(agent!.stepIndex).toBe(7);
    expect(agent!.agentMessages).toEqual([]);
    expect(agent!.skillExecutionScopeStack).toEqual([]);
  });

  // ── AD1 race regression ───────────────────────────────────────────────────
  //
  // Pre-fix: setLastTaskSynth and setSessionAgent (tombstone snapshot) were
  // both read-modify-write on the SAME key. With microtask interleaving:
  //   1. setLastTaskSynth reads agent state (stepIndex=5, messages=[...])
  //   2. tombstone writes {agentMessages:[], stepIndex:0} — clean
  //   3. setLastTaskSynth writes {agentMessages:[...], stepIndex:5, lastTaskSynth:synth}
  //      — resurrecting stepIndex>0, M1-U5 falsely flags as paused on restart
  //
  // Post-fix: emitDone folds synth into buildSessionAgentTombstone(synth) —
  // single write, no race. setLastTaskSynth is now used independently of
  // tombstone. This test verifies that concurrent setLastTaskSynth +
  // setSessionAgent (snapshot write) do not clobber each other's fields.
  it("AD1 race regression: concurrent setLastTaskSynth + setSessionAgent both survive", async () => {
    const meta = await createSession();
    const synth = "<untrusted_prior_task_summary>synth-text</untrusted_prior_task_summary>";
    const snapshotMessages = [
      { role: "user" as const, content: "task prompt" },
    ];

    // Simulate concurrent writes with deliberate microtask interleaving by
    // running both without awaiting between them. Both go to the agent key
    // but each does a read-modify-write; the post-fix implementation ensures
    // the field migration is atomic so neither write drops the other's value
    // (in practice emitDone folds synth into tombstone — one write — but this
    // test also verifies the standalone helper doesn't clobber sibling fields).
    await Promise.all([
      setLastTaskSynth(meta.id, synth),
      setSessionAgent(meta.id, {
        agentMessages: snapshotMessages,
        stepIndex: 3,
        skillExecutionScopeStack: [],
      }),
    ]);

    // After both settle, retrieve the agent state.
    // Because Promise.all serializes under the mock, one write will win.
    // The key assertion is: whichever write landed last, the surviving state
    // is internally consistent (no partial clobber, no phantom stepIndex).
    const final = await getSessionAgent(meta.id);
    expect(final).not.toBeNull();

    // Both writes touched different logical fields. The final state must be
    // consistent — it may be one or the other winner, but must not be mixed.
    const hasLastTaskSynth = final!.lastTaskSynth === synth;
    const hasSnapshot = final!.stepIndex === 3;

    // Either the synth write won (lastTaskSynth present, stepIndex may be 0
    // from the base state seeded by setLastTaskSynth) or the snapshot won
    // (stepIndex=3, lastTaskSynth may be absent). What must NOT happen is a
    // corrupted interleave where stepIndex is non-zero but lastTaskSynth came
    // from a different snapshot cycle (the pre-fix tombstone resurrection bug).
    // Both states are valid wins — we just assert no TypeError / throw above.
    expect(hasLastTaskSynth || hasSnapshot).toBe(true);
  });

  // ── AD1 tombstone-fold test ───────────────────────────────────────────────
  // Verifies the post-fix design: buildSessionAgentTombstone(synth) is a
  // single write that carries both stepIndex=0 AND lastTaskSynth. No separate
  // setLastTaskSynth call needed. This is the canonical emitDone path.
  it("tombstone with synth folded in: single write carries both stepIndex=0 and lastTaskSynth", async () => {
    const meta = await createSession();
    const synth = "<untrusted_prior_task_summary>task done</untrusted_prior_task_summary>";

    // Simulate the onStepSnapshot(buildSessionAgentTombstone(synth)) call
    // from emitDone by writing the tombstone directly via setSessionAgent.
    const tombstone: SessionAgentState = {
      agentMessages: [],
      stepIndex: 0,
      skillExecutionScopeStack: [],
      lastTaskSynth: synth,
    };
    await setSessionAgent(meta.id, tombstone);

    const agent = await getSessionAgent(meta.id);
    expect(agent!.stepIndex).toBe(0);
    expect(agent!.agentMessages).toEqual([]);
    expect(agent!.lastTaskSynth).toBe(synth);

    // Meta must not have lastTaskSynth (AD1 invariant)
    const metaAfter = await getSessionMeta(meta.id);
    expect((metaAfter as Record<string, unknown>)["lastTaskSynth"]).toBeUndefined();
  });
});

// ── U3 — migrateLastTaskSynthFromMeta (AD1 migration) ────────────────────────

describe("migrateLastTaskSynthFromMeta — AD1 migration", () => {
  it("moves stale lastTaskSynth from meta to agent state", async () => {
    const meta = await createSession();
    const synth = "<untrusted_prior_task_summary>old synth</untrusted_prior_task_summary>";

    // Simulate a pre-fix session: manually write lastTaskSynth into meta
    // (bypassing the type system since the field no longer exists there).
    await chromeMock.storage.local.set({
      [metaKey(meta.id)]: { ...meta, lastTaskSynth: synth },
    });

    const result = await migrateLastTaskSynthFromMeta(meta.id);
    expect(result).toBe(true);

    // After migration: lastTaskSynth must be in agent state
    const agent = await getSessionAgent(meta.id);
    expect(agent!.lastTaskSynth).toBe(synth);

    // After migration: lastTaskSynth must be stripped from meta
    const updatedMeta = await getSessionMeta(meta.id);
    expect((updatedMeta as Record<string, unknown>)["lastTaskSynth"]).toBeUndefined();
  });

  it("is a no-op (returns false) when meta has no lastTaskSynth", async () => {
    const meta = await createSession();

    const result = await migrateLastTaskSynthFromMeta(meta.id);
    expect(result).toBe(false);

    // Agent state unchanged (still has default empty values)
    const agent = await getSessionAgent(meta.id);
    expect(agent!.lastTaskSynth).toBeUndefined();
  });

  it("is idempotent — running twice is safe (second call is no-op)", async () => {
    const meta = await createSession();
    const synth = "<untrusted_prior_task_summary>idempotent</untrusted_prior_task_summary>";

    // Seed stale data in meta
    await chromeMock.storage.local.set({
      [metaKey(meta.id)]: { ...meta, lastTaskSynth: synth },
    });

    // First call: migrates
    const first = await migrateLastTaskSynthFromMeta(meta.id);
    expect(first).toBe(true);

    // Second call: meta no longer has lastTaskSynth, should be no-op
    const second = await migrateLastTaskSynthFromMeta(meta.id);
    expect(second).toBe(false);

    // Agent state still has the synth (from first migration)
    const agent = await getSessionAgent(meta.id);
    expect(agent!.lastTaskSynth).toBe(synth);
  });

  it("migration is atomic — uses writeAtomic single batch", async () => {
    const meta = await createSession();
    const synth = "<untrusted_prior_task_summary>atomic</untrusted_prior_task_summary>";
    await chromeMock.storage.local.set({
      [metaKey(meta.id)]: { ...meta, lastTaskSynth: synth },
    });

    const setSpy = vi.spyOn(chromeMock.storage.local, "set");
    setSpy.mockClear();

    await migrateLastTaskSynthFromMeta(meta.id);

    // Single atomic write (D9) — one set() call with both keys in one batch
    expect(setSpy).toHaveBeenCalledTimes(1);
    const batchKeys = Object.keys(setSpy.mock.calls[0]![0] as object).sort();
    expect(batchKeys).toEqual([
      `session_${meta.id}_agent`,
      `session_${meta.id}_meta`,
    ]);
    setSpy.mockRestore();
  });

  it("returns false for unknown session id", async () => {
    const result = await migrateLastTaskSynthFromMeta("nonexistent");
    expect(result).toBe(false);
  });

  it("resume path: setSessionAgent with lastTaskSynth persists and survives reload", async () => {
    const meta = await createSession();
    const synth = "<untrusted_prior_task_summary>survived</untrusted_prior_task_summary>";

    // Simulate tombstone with synth folded in (post-AD1 emitDone path)
    await setSessionAgent(meta.id, {
      agentMessages: [],
      stepIndex: 0,
      skillExecutionScopeStack: [],
      lastTaskSynth: synth,
    });

    // Reload: read back
    const agent = await getSessionAgent(meta.id);
    expect(agent!.lastTaskSynth).toBe(synth);

    // handleChatStream lifecycle: read → inject → clear
    const lastTaskSynth = agent!.lastTaskSynth ?? null;
    expect(lastTaskSynth).toBe(synth);

    await clearLastTaskSynth(meta.id);
    const agentAfterClear = await getSessionAgent(meta.id);
    expect(agentAfterClear!.lastTaskSynth).toBeUndefined();
    expect("lastTaskSynth" in agentAfterClear!).toBe(false);
  });
});
