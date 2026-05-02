import { describe, expect, it, vi } from "vitest";
import { chromeMock } from "@/test/setup";
import {
  createSession,
  getSessionAgent,
  getSessionMeta,
  getTotalBytes,
  listSessionIndex,
  removeSession,
  scrubPendingConfirm,
  setPendingConfirm,
  setSessionAgent,
  setSessionMeta,
  updateLastAccessed,
} from "./storage";
import type {
  PendingConfirmRecord,
  SessionAgentState,
  SessionMeta,
} from "./types";

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
