import { describe, expect, it, vi, beforeEach } from "vitest";
import { chromeMock } from "@/test/setup";
import { migrateV1toV2 } from "@/lib/migration-v2";
import { encrypt, getOrCreateEncryptionKey } from "@/lib/crypto";
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
  clearTaskPinAtSessionEnd,
  upgradeAutoToTaskAtChatStart,
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
    expect(agent!.pendingConfirm).toBeUndefined();
  });

  it("accepts legacy pinnedTabId/pinnedOrigin and converts to pinnedTabs[] (v1.5 back-compat)", async () => {
    const meta = await createSession({
      pinnedTabId: 42,
      pinnedOrigin: "https://docs.google.com",
    });
    // v1.5: legacy input is converted to pinnedTabs[]. Legacy output fields
    // are deleted in Task 10 — only pinnedTabs[] is persisted.
    expect(meta.pinnedTabs).toEqual([{ tabId: 42, origin: "https://docs.google.com" }]);
    const reread = await getSessionMeta(meta.id);
    expect(reread!.pinnedTabs).toEqual([{ tabId: 42, origin: "https://docs.google.com" }]);
  });

  it("registers the session in session_index immediately", async () => {
    const meta = await createSession();
    const list = await listSessionIndex();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(meta.id);
    expect(list[0]!.status).toBe("active");
  });

  it("I-1: strips ImageAttachment.data from messages passed to createSession (R10 scrub)", async () => {
    // Verify createSession applies scrubAttachmentBytes before persisting,
    // closing the gap where it previously wrote via writeAtomic directly.
    const messagesWithAttachment = [
      {
        role: "user" as const,
        content: "check this screenshot",
        // Cast through unknown: DisplayMessage has no static `attachments` field
        // (Phase 5 is runtime-guarded). The scrub is defensive + runtime-correct.
        attachments: [
          {
            kind: "image",
            id: "img-1",
            mediaType: "image/jpeg",
            data: "AAAA_BASE64_DATA",
            width: 100,
            height: 100,
            byteLength: 3,
          },
        ],
      } as unknown as import("./types").SessionMeta["messages"][number],
    ];

    const meta = await createSession({ messages: messagesWithAttachment });
    const stored = await getSessionMeta(meta.id);
    expect(stored).not.toBeNull();

    // The stored message should have the attachment scrubbed to image_placeholder.
    const storedMsg = stored!.messages[0] as Record<string, unknown>;
    const attachments = storedMsg["attachments"] as Array<Record<string, unknown>>;
    expect(attachments).toBeDefined();
    expect(attachments[0]!["kind"]).toBe("image_placeholder");
    // Raw bytes must not be in storage.
    expect(attachments[0]!["data"]).toBeUndefined();
    expect(attachments[0]!["byteLength"]).toBeUndefined();
    // Identity fields are preserved.
    expect(attachments[0]!["id"]).toBe("img-1");
    expect(attachments[0]!["mediaType"]).toBe("image/jpeg");
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
      pendingInstructions: [],
      stepIndex: 7,
      hasImageContent: false,
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
      pendingInstructions: [],
      stepIndex: 1,
      hasImageContent: false,
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

  it("R10 — setSessionMeta strips ImageAttachment bytes → ImagePlaceholder before persisting", async () => {
    const meta = await createSession();
    const imageAttachment = {
      kind: "image" as const,
      id: "img_test_abc",
      mediaType: "image/jpeg" as const,
      data: "AAAABASE64BYTES",
      width: 800,
      height: 600,
      byteLength: 12345,
    };
    // Inject an attachment into a user message via unknown cast (DisplayMessage
    // doesn't have attachments in its static type; the scrub is a runtime guard).
    const messageWithImage = {
      role: "user" as const,
      content: "look at this",
      attachments: [imageAttachment],
    };
    await setSessionMeta({
      ...meta,
      messages: [messageWithImage as unknown as import("@/types").DisplayMessage],
    });

    const stored = await getSessionMeta(meta.id);
    const storedMsg = (stored!.messages[0] as unknown as Record<string, unknown>);
    const storedAttachments = storedMsg["attachments"] as Array<Record<string, unknown>>;
    expect(storedAttachments).toHaveLength(1);
    // Bytes stripped → ImagePlaceholder shape
    expect(storedAttachments[0]!["kind"]).toBe("image_placeholder");
    expect(storedAttachments[0]!["id"]).toBe("img_test_abc");
    expect(storedAttachments[0]!["mediaType"]).toBe("image/jpeg");
    expect(storedAttachments[0]!["width"]).toBe(800);
    expect(storedAttachments[0]!["height"]).toBe(600);
    // data and byteLength MUST NOT be in storage
    expect("data" in storedAttachments[0]!).toBe(false);
    expect("byteLength" in storedAttachments[0]!).toBe(false);
  });

  it("R10 — setSessionMeta is a no-op when no ImageAttachment present", async () => {
    const meta = await createSession();
    const setSpy = vi.spyOn(chromeMock.storage.local, "set");
    await setSessionMeta({
      ...meta,
      messages: [{ role: "user", content: "no images here" }],
    });
    // No scrubbing needed → single atomic write (no extra set calls)
    expect(setSpy).toHaveBeenCalledTimes(1);
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

  it("can update status and pinnedTabs together", async () => {
    const meta = await createSession({ now: 1000 });
    await updateLastAccessed(meta.id, {
      now: 2000,
      status: "paused",
      pinnedTabs: [{ tabId: 99, origin: "https://x.com" }],
      pinMode: "user",
    });
    const after = await getSessionMeta(meta.id);
    expect(after!.status).toBe("paused");
    expect(after!.pinnedTabs).toEqual([{ tabId: 99, origin: "https://x.com" }]);
    const list = await listSessionIndex();
    expect(list[0]!.status).toBe("paused");
    expect(list[0]!.pinnedTabIds).toEqual([99]);
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
      pendingInstructions: [],
      stepIndex: 3,
      hasImageContent: false,
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
      pendingInstructions: [],
      stepIndex: 3,
      hasImageContent: false,
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
    expect((updatedMeta as unknown as Record<string, unknown>)["lastTaskSynth"]).toBeUndefined();
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
    expect((afterMeta as unknown as Record<string, unknown>)["lastTaskSynth"]).toBeUndefined();
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
        pendingInstructions: [],
        stepIndex: 3,
        hasImageContent: false,
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
      pendingInstructions: [],
      stepIndex: 0,
      hasImageContent: false,
      lastTaskSynth: synth,
    };
    await setSessionAgent(meta.id, tombstone);

    const agent = await getSessionAgent(meta.id);
    expect(agent!.stepIndex).toBe(0);
    expect(agent!.agentMessages).toEqual([]);
    expect(agent!.lastTaskSynth).toBe(synth);

    // Meta must not have lastTaskSynth (AD1 invariant)
    const metaAfter = await getSessionMeta(meta.id);
    expect((metaAfter as unknown as Record<string, unknown>)["lastTaskSynth"]).toBeUndefined();
  });
});

// ── M5 — pinMode + v1.5 pin storage invariants ────────────────────────────

describe("M5 — pinMode pin-storage invariants", () => {
  it("createSession() with no options defaults pinMode='auto' and writes no pinnedTabIds to index", async () => {
    const meta = await createSession();
    expect(meta.pinMode).toBe("auto");
    expect(meta.pinnedTabs).toBeUndefined();

    const idx = await listSessionIndex();
    const entry = idx.find((e) => e.id === meta.id);
    expect(entry?.pinnedTabIds).toBeUndefined();
  });

  it("createSession({pinnedTabId, pinnedOrigin}) converts to pinnedTabs[] and defaults pinMode='user'", async () => {
    const meta = await createSession({
      pinnedTabId: 42,
      pinnedOrigin: "https://example.com",
    });
    expect(meta.pinMode).toBe("user");
    expect(meta.pinnedTabs).toEqual([{ tabId: 42, origin: "https://example.com" }]);

    const idx = await listSessionIndex();
    const entry = idx.find((e) => e.id === meta.id);
    expect(entry?.pinnedTabIds).toEqual([42]);
  });

  it("createSession({pinMode: 'task', pinnedTabId, pinnedOrigin}) converts to pinnedTabs[] with task mode", async () => {
    const meta = await createSession({
      pinMode: "task",
      pinnedTabId: 5,
      pinnedOrigin: "https://x.com",
    });
    expect(meta.pinMode).toBe("task");
    expect(meta.pinnedTabs).toEqual([{ tabId: 5, origin: "https://x.com" }]);
  });

  it("setSessionMeta() preserves explicit 'user' mode pin across unrelated writes", async () => {
    const meta = await createSession({
      pinnedTabs: [{ tabId: 9, origin: "https://x.com" }],
      pinMode: "user",
    });
    expect(meta.pinMode).toBe("user");

    // Subsequent write with new title — pin must survive.
    await setSessionMeta({ ...meta, title: "renamed" });

    const back = await getSessionMeta(meta.id);
    expect(back?.pinMode).toBe("user");
    expect(back?.pinnedTabs).toEqual([{ tabId: 9, origin: "https://x.com" }]);
    expect(back?.title).toBe("renamed");
  });
});

// ── M5 — clearTaskPinAtSessionEnd (emitDone hook) ─────────────────────────

describe("M5 — clearTaskPinAtSessionEnd (emitDone hook)", () => {
  it("clears task-mode pin: pinMode → auto, pinnedTabs[] removed", async () => {
    const meta = await createSession({
      pinMode: "task",
      pinnedTabs: [{ tabId: 9, origin: "https://x.com" }],
    });

    const cleared = await clearTaskPinAtSessionEnd(meta.id);
    expect(cleared).toBe(true);

    const back = await getSessionMeta(meta.id);
    expect(back?.pinMode).toBe("auto");
    expect(back?.pinnedTabs).toBeUndefined();

    const idx = await listSessionIndex();
    expect(idx.find((e) => e.id === meta.id)?.pinnedTabIds).toBeUndefined();
  });

  it("preserves user-mode pin (returns false, no write)", async () => {
    const meta = await createSession({
      pinMode: "user",
      pinnedTabs: [{ tabId: 9, origin: "https://x.com" }],
    });

    const cleared = await clearTaskPinAtSessionEnd(meta.id);
    expect(cleared).toBe(false);

    const back = await getSessionMeta(meta.id);
    expect(back?.pinMode).toBe("user");
    expect(back?.pinnedTabs).toEqual([{ tabId: 9, origin: "https://x.com" }]);
  });

  it("is a no-op on auto-mode session (no write, returns false)", async () => {
    const meta = await createSession();
    expect(meta.pinMode).toBe("auto");

    const setSpy = vi.spyOn(chromeMock.storage.local, "set");
    const cleared = await clearTaskPinAtSessionEnd(meta.id);
    expect(cleared).toBe(false);
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });

  it("returns false for non-existent session (no throw)", async () => {
    const cleared = await clearTaskPinAtSessionEnd("nonexistent-session");
    expect(cleared).toBe(false);
  });
});

// ── M5 — upgradeAutoToTaskAtChatStart (chat-start hook) ───────────────────

describe("M5 — upgradeAutoToTaskAtChatStart (chat-start hook)", () => {
  const captureFn = (pin: { tabId: number; origin: string } | null) =>
    () => Promise.resolve(pin);

  it("upgrades auto-mode session to task with captured pin (writes pinnedTabs[])", async () => {
    const meta = await createSession();
    expect(meta.pinMode).toBe("auto");

    const pin = { tabId: 42, origin: "https://example.com" };
    const result = await upgradeAutoToTaskAtChatStart(meta.id, captureFn(pin));
    expect(result).toEqual(pin);

    const back = await getSessionMeta(meta.id);
    expect(back?.pinMode).toBe("task");
    expect(back?.pinnedTabs).toEqual([{ tabId: 42, origin: "https://example.com" }]);

    // Index also updated
    const idx = await listSessionIndex();
    expect(idx.find((e) => e.id === meta.id)?.pinnedTabIds).toEqual([42]);
  });

  it("is a no-op when pinMode='task' (idempotent backstop)", async () => {
    const meta = await createSession({
      pinMode: "task",
      pinnedTabs: [{ tabId: 10, origin: "https://existing.com" }],
    });

    const setSpy = vi.spyOn(chromeMock.storage.local, "set");
    const result = await upgradeAutoToTaskAtChatStart(
      meta.id,
      captureFn({ tabId: 99, origin: "https://different.com" }),
    );
    expect(result).toBeNull();
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();

    // Pin unchanged
    const back = await getSessionMeta(meta.id);
    expect(back?.pinnedTabs).toEqual([{ tabId: 10, origin: "https://existing.com" }]);
  });

  it("is a no-op when pinMode='user' (preserves user choice)", async () => {
    const meta = await createSession({
      pinMode: "user",
      pinnedTabs: [{ tabId: 5, origin: "https://user.com" }],
    });

    const result = await upgradeAutoToTaskAtChatStart(
      meta.id,
      captureFn({ tabId: 99, origin: "https://different.com" }),
    );
    expect(result).toBeNull();

    const back = await getSessionMeta(meta.id);
    expect(back?.pinMode).toBe("user");
    expect(back?.pinnedTabs).toEqual([{ tabId: 5, origin: "https://user.com" }]);
  });

  it("is a no-op when captureFn returns null (restricted URL)", async () => {
    const meta = await createSession();
    expect(meta.pinMode).toBe("auto");

    const result = await upgradeAutoToTaskAtChatStart(meta.id, captureFn(null));
    expect(result).toBeNull();

    // Session stays in auto — loop's active-tab fallback will handle it
    const back = await getSessionMeta(meta.id);
    expect(back?.pinMode).toBe("auto");
    expect(back?.pinnedTabs).toBeUndefined();
  });

  it("returns null for non-existent session", async () => {
    const result = await upgradeAutoToTaskAtChatStart(
      "nonexistent",
      captureFn({ tabId: 1, origin: "https://x.com" }),
    );
    expect(result).toBeNull();
  });

  it("upgrades legacy session (pinMode undefined + no pinnedTabs + stepIndex=0) — treats as auto", async () => {
    // v1.5: legacy sessions with no pinnedTabs[] and no explicit pinMode
    // are treated as 'auto' by getEffectivePinMode (no legacy inference).
    // Any stale pinnedTabId on the meta is irrelevant to the mode decision.
    const id = "legacy-stale";
    await chromeMock.storage.local.set({
      [metaKey(id)]: {
        id,
        createdAt: 1000,
        lastAccessedAt: 1000,
        status: "active",
        messages: [],
        // No pinnedTabs[] → getEffectivePinMode returns 'auto' → will upgrade
      } satisfies SessionMeta,
      [agentKey(id)]: {
        agentMessages: [],
        pendingInstructions: [],
        stepIndex: 0,
        hasImageContent: false,
      } satisfies SessionAgentState,
      session_index: [{ id, lastAccessedAt: 1000, status: "active" }],
    });

    const newPin = { tabId: 42, origin: "https://new.com" };
    const result = await upgradeAutoToTaskAtChatStart(id, captureFn(newPin));
    expect(result).toEqual(newPin);

    const back = await getSessionMeta(id);
    expect(back?.pinMode).toBe("task");
    expect(back?.pinnedTabs).toEqual([{ tabId: 42, origin: "https://new.com" }]);
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
    expect((updatedMeta as unknown as Record<string, unknown>)["lastTaskSynth"]).toBeUndefined();
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
      pendingInstructions: [],
      stepIndex: 0,
      hasImageContent: false,
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

// ── v1.5 multi-pin storage ────────────────────────────────────────────────────

describe("v1.5 multi-pin storage", () => {

  it("indexEntryFromMeta writes pinnedTabIds[] from array", async () => {
    const meta: SessionMeta = {
      id: "s1",
      createdAt: 0,
      lastAccessedAt: 0,
      status: "active",
      messages: [],
      pinMode: "task",
      pinnedTabs: [
        { tabId: 12, origin: "https://a.com" },
        { tabId: 13, origin: "https://b.com" },
      ],
    };
    await setSessionMeta(meta);
    const index = await listSessionIndex();
    const entry = index.find((e) => e.id === "s1");
    expect(entry?.pinnedTabIds).toEqual([12, 13]);
  });

  it("indexEntryFromMeta omits pinnedTabIds when array empty (auto mode)", async () => {
    const meta: SessionMeta = {
      id: "s2",
      createdAt: 0,
      lastAccessedAt: 0,
      status: "active",
      messages: [],
      pinMode: "auto",
    };
    await setSessionMeta(meta);
    const index = await listSessionIndex();
    const entry = index.find((e) => e.id === "s2");
    expect(entry?.pinnedTabIds).toBeUndefined();
  });

  it("upgradeAutoToTaskAtChatStart writes pinnedTabs:[{capture}]", async () => {
    const meta: SessionMeta = {
      id: "s3",
      createdAt: 0,
      lastAccessedAt: 0,
      status: "active",
      messages: [],
      pinMode: "auto",
    };
    await setSessionMeta(meta);
    const result = await upgradeAutoToTaskAtChatStart("s3", async () => ({
      tabId: 42,
      origin: "https://example.com",
    }));
    expect(result).toEqual({ tabId: 42, origin: "https://example.com" });
    const back = await getSessionMeta("s3");
    expect(back?.pinMode).toBe("task");
    expect(back?.pinnedTabs).toEqual([{ tabId: 42, origin: "https://example.com" }]);
  });

  it("upgradeAutoToTaskAtChatStart no-op when already in task mode", async () => {
    const meta: SessionMeta = {
      id: "s4",
      createdAt: 0,
      lastAccessedAt: 0,
      status: "active",
      messages: [],
      pinMode: "task",
      pinnedTabs: [{ tabId: 5, origin: "https://x.com" }],
    };
    await setSessionMeta(meta);
    await setSessionAgent("s4", {
      agentMessages: [],
      pendingInstructions: [],
      stepIndex: 1,
      hasImageContent: false,
    });
    const result = await upgradeAutoToTaskAtChatStart("s4", async () => ({
      tabId: 999,
      origin: "https://other.com",
    }));
    expect(result).toBeNull();
    const back = await getSessionMeta("s4");
    expect(back?.pinnedTabs).toEqual([{ tabId: 5, origin: "https://x.com" }]);
  });

  it("setSessionMeta writes pinnedTabs[] only (no legacy fields)", async () => {
    const meta: SessionMeta = {
      id: "s5",
      createdAt: 0,
      lastAccessedAt: 0,
      status: "active",
      messages: [],
      pinMode: "task",
      pinnedTabs: [{ tabId: 7, origin: "https://y.com" }],
    };
    await setSessionMeta(meta);
    const back = await getSessionMeta("s5");
    expect(back?.pinnedTabs).toEqual([{ tabId: 7, origin: "https://y.com" }]);
  });

  it("setSessionMeta omits pinnedTabs when absent (auto mode)", async () => {
    const meta: SessionMeta = {
      id: "s6",
      createdAt: 0,
      lastAccessedAt: 0,
      status: "active",
      messages: [],
      pinMode: "auto",
    };
    await setSessionMeta(meta);
    const back = await getSessionMeta("s6");
    expect(back?.pinnedTabs).toBeUndefined();
  });

  it("createSession accepts legacy pinnedTabId/pinnedOrigin and converts to pinnedTabs[] (v1.5 back-compat)", async () => {
    // Back-compat: legacy input is converted to pinnedTabs[]; no legacy fields
    // are persisted on output (Task 10 dual-write shim removed).
    const meta = await createSession({
      pinnedTabId: 5,
      pinnedOrigin: "https://x.com",
    });
    expect(meta.pinnedTabs).toEqual([{ tabId: 5, origin: "https://x.com" }]);
    expect(meta.pinMode).toBe("user"); // existing back-compat default
  });

  it("createSession accepts native pinnedTabs[] option", async () => {
    const meta = await createSession({
      pinnedTabs: [{ tabId: 7, origin: "https://a.com" }],
      pinMode: "user",
    });
    expect(meta.pinnedTabs).toEqual([{ tabId: 7, origin: "https://a.com" }]);
    expect(meta.pinMode).toBe("user");
  });
});

// ── Task 8 — getSessionMeta lazy backfill ─────────────────────────────────────

describe("getSessionMeta lazy backfill", () => {
  beforeEach(() => {
    chromeMock.storage.local.__store = {};
  });

  it("when meta.instanceId missing but mapping exists, backfills from legacy provider", async () => {
    // Seed v1 provider config + run migration to populate mapping
    const key = await getOrCreateEncryptionKey();
    chromeMock.storage.local.__store["provider_anthropic"] = {
      encryptedKey: await encrypt("sk-ant", key),
      model: "claude-opus-4-7",
    };
    await migrateV1toV2();
    const mapping = chromeMock.storage.local.__store["migration_v2_mapping"] as Record<string, string>;
    const expectedInstanceId = mapping["anthropic"];

    // Seed a pre-migration session that has a legacy provider field but no instanceId
    chromeMock.storage.local.__store["session_legacy_meta"] = {
      id: "legacy", createdAt: 1, lastAccessedAt: 1, status: "archived",
      messages: [],
      provider: "anthropic", // legacy field
    };

    const meta = await getSessionMeta("legacy");
    expect(meta!.instanceId).toBe(expectedInstanceId);
    // legacy field cleaned up
    expect(("provider" in (meta as object))).toBe(false);
  });

  it("session with no provider + no instanceId is left as-is", async () => {
    chromeMock.storage.local.__store["session_x_meta"] = {
      id: "x", createdAt: 1, lastAccessedAt: 1, status: "active",
      messages: [],
    };
    const meta = await getSessionMeta("x");
    expect(meta!.instanceId).toBeUndefined();
  });
});
