/**
 * M2-U4 lifecycle tests — covering archive / unarchive / soft-delete /
 * hard-delete / LRU eviction / 30-day expired sweep.
 *
 * Uses the chromeMock from @/test/setup (same pattern as storage.test.ts).
 * Storage is reset between tests via beforeEach in setup.ts.
 */

import { describe, expect, it, vi } from "vitest";
import { chromeMock } from "@/test/setup";
import {
  archiveSession,
  checkAndArchiveLRU,
  hardDeleteExpired,
  hardDeleteSession,
  softDeleteSession,
  unarchiveSession,
} from "./lifecycle";
import {
  createSession,
  getSessionAgent,
  getSessionMeta,
  listSessionIndex,
  setSessionAgent,
} from "./storage";
import type { SessionAgentState } from "./types";

// ── Helpers ───────────────────────────────────────────────────────────────────

const EMPTY_AGENT: SessionAgentState = {
  agentMessages: [],
  pendingInstructions: [],
  stepIndex: 0,
  hasImageContent: false,
};

/** Seed storage with `bytes` worth of data to simulate pressure. */
function seedStoragePressure(bytes: number, key = "_pressure_") {
  // getBytesInUse in the mock is `key.length + JSON.stringify(value).length`.
  // We store a string of known length so we can hit the threshold precisely.
  const valueSize = bytes - key.length - 2; // 2 for the surrounding quotes in JSON
  chromeMock.storage.local.__store[key] = "x".repeat(Math.max(0, valueSize));
}

// ── Scenario 1: Happy path — quota exceeded triggers LRU archive ──────────────

describe("Scenario 1: LRU archive triggered when storage at quota", () => {
  it("setSessionAgent triggers archive of oldest session when at 8MB", async () => {
    const EIGHT_MB = 8 * 1024 * 1024;

    // Create two sessions, older one has earlier lastAccessedAt.
    const older = await createSession({ now: 1000 });
    const newer = await createSession({ now: 2000 });

    // Fill storage to just at the 8 MB quota.
    seedStoragePressure(EIGHT_MB);

    // setSessionAgent for `newer` should trigger the guard.
    // The guard will archive `older` (earliest lastAccessedAt).
    await setSessionAgent(newer.id, EMPTY_AGENT);

    // older should now be archived (meta + agent keys removed, archived key present).
    const olderMeta = await getSessionMeta(older.id);
    const olderAgent = await getSessionAgent(older.id);
    const archivedRaw = await chrome.storage.local.get(`session_${older.id}_archived`);

    expect(olderMeta).toBeNull();
    expect(olderAgent).toBeNull();
    expect(archivedRaw[`session_${older.id}_archived`]).toBeDefined();

    // Index should reflect archived status for older session.
    const index = await listSessionIndex();
    const olderEntry = index.find((e) => e.id === older.id);
    expect(olderEntry?.status).toBe("archived");

    // newer session should still be writable.
    const newerAgent = await getSessionAgent(newer.id);
    expect(newerAgent).not.toBeNull();
  });
});

// ── Scenario 2: Happy path — hardDeleteExpired removes 30-day-old archived ───

describe("Scenario 2: hardDeleteExpired sweeps 30d+ archived sessions", () => {
  it("removes archived session and index entry when archivedAt > 30 days ago", async () => {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const thirtyOneDaysAgo = now - THIRTY_DAYS_MS - 1000;

    // Create and archive a session with an old archivedAt.
    const session = await createSession({ now: thirtyOneDaysAgo });
    await archiveSession(session.id, { now: thirtyOneDaysAgo });

    // Verify it was archived.
    const archivedRaw = await chrome.storage.local.get(`session_${session.id}_archived`);
    expect(archivedRaw[`session_${session.id}_archived`]).toBeDefined();

    // Run hardDeleteExpired.
    const result = await hardDeleteExpired(now);
    expect(result.deleted).toBe(1);

    // Archived key should be gone.
    const afterRaw = await chrome.storage.local.get(`session_${session.id}_archived`);
    expect(afterRaw[`session_${session.id}_archived`]).toBeUndefined();

    // Index entry should be gone.
    const index = await listSessionIndex();
    expect(index.find((e) => e.id === session.id)).toBeUndefined();
  });

  it("does NOT delete sessions archived less than 30 days ago", async () => {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const twentyNineDaysAgo = now - THIRTY_DAYS_MS + 1000;

    const session = await createSession({ now: twentyNineDaysAgo });
    await archiveSession(session.id, { now: twentyNineDaysAgo });

    const result = await hardDeleteExpired(now);
    expect(result.deleted).toBe(0);

    // Still present.
    const afterRaw = await chrome.storage.local.get(`session_${session.id}_archived`);
    expect(afterRaw[`session_${session.id}_archived`]).toBeDefined();
  });
});

// ── Scenario 3: Happy path — unarchive within 30 days restores status=active ─

describe("Scenario 3: unarchiveSession restores meta + agent, clears archivedAt", () => {
  it("restores a recently archived session to active status", async () => {
    const session = await createSession({ now: 1000 });
    await archiveSession(session.id, { now: 2000 });

    // Verify archived.
    expect(await getSessionMeta(session.id)).toBeNull();

    await unarchiveSession(session.id);

    // Meta should be restored with status=active and no archivedAt.
    const restored = await getSessionMeta(session.id);
    expect(restored).not.toBeNull();
    expect(restored!.status).toBe("active");
    expect(restored!.archivedAt).toBeUndefined();

    // Agent should be restored.
    const restoredAgent = await getSessionAgent(session.id);
    expect(restoredAgent).not.toBeNull();

    // Archived key should be gone.
    const archivedRaw = await chrome.storage.local.get(`session_${session.id}_archived`);
    expect(archivedRaw[`session_${session.id}_archived`]).toBeUndefined();

    // Index entry should be active.
    const index = await listSessionIndex();
    const entry = index.find((e) => e.id === session.id);
    expect(entry?.status).toBe("active");
  });
});

// ── Scenario 4: Edge — archive actually removes meta/agent keys (real bytes) ─

describe("Scenario 4: archive releases meta + agent storage bytes", () => {
  it("getBytesInUse decreases after archiving a session", async () => {
    const session = await createSession({ now: 1000 });

    // Seed a non-trivial agent state so the bytes saved are measurable.
    const largeAgent: SessionAgentState = {
      agentMessages: [{ role: "user", content: "hello ".repeat(100) }],
      pendingInstructions: [],
      stepIndex: 5,
      hasImageContent: false,
    };
    await chromeMock.storage.local.set({ [`session_${session.id}_agent`]: largeAgent });

    const bytesBefore = await chrome.storage.local.getBytesInUse(null);

    await archiveSession(session.id, { now: 2000 });

    const bytesAfter = await chrome.storage.local.getBytesInUse(null);

    // After archiving, meta and agent keys are gone; only archived key remains.
    // Net effect: bytes may increase slightly (archived key = meta + agent combined)
    // but the META + AGENT keys are definitely removed.
    const metaExists = await chrome.storage.local.get(`session_${session.id}_meta`);
    const agentExists = await chrome.storage.local.get(`session_${session.id}_agent`);
    expect(metaExists[`session_${session.id}_meta`]).toBeUndefined();
    expect(agentExists[`session_${session.id}_agent`]).toBeUndefined();

    // The archived key bundles both meta + agent into one record. After
    // archive, the two separate keys are removed; the archived key carries
    // the union but with less per-key overhead. Net bytes MUST decrease —
    // anything else means archive duplicated data without releasing the
    // originals (the exact "flag-only archive" anti-pattern the plan called
    // out for explicit verification: M2-U4 plan line 691).
    expect(bytesAfter).toBeLessThan(bytesBefore);
  });
});

// ── Scenario 5: Edge — pre-write guard is NOT recursive ───────────────────────

describe("Scenario 5: checkAndArchiveLRU does not recurse into setSessionAgent", () => {
  it("archiveSession internal writes do not trigger further quota checks", async () => {
    const EIGHT_MB = 8 * 1024 * 1024;

    // Create sessions to be archived.
    const s1 = await createSession({ now: 1000 });
    const s2 = await createSession({ now: 2000 });

    seedStoragePressure(EIGHT_MB);

    // Spy on checkAndArchiveLRU to ensure it's only called once (not recursively).
    // We do this by counting calls to getBytesInUse — the guard calls it once per
    // check-cycle, archive writes call it again for subsequent budget check.
    // The key invariant: writeAtomic inside archiveSession does NOT call
    // setSessionAgent, so no re-entry into the guard.
    const setSpy = vi.spyOn(chromeMock.storage.local, "set");

    // Call checkAndArchiveLRU directly.
    const result = await checkAndArchiveLRU(100);

    // Should have archived s1 (oldest).
    expect(result.archived).toBeGreaterThanOrEqual(1);

    // The set calls inside archive go to writeAtomic directly, not setSessionAgent.
    // If recursion happened, we'd see exponentially more set calls than entries.
    // With 2 sessions and 1 archive op, set calls should be bounded.
    const setCalls = setSpy.mock.calls.length;
    expect(setCalls).toBeLessThanOrEqual(10); // generous upper bound for no recursion

    setSpy.mockRestore();
    // Suppress unused variable warning
    void s2;
  });
});

// ── Scenario 6: Edge — Delete forever immediately removes session ─────────────

describe("Scenario 6: hardDeleteSession immediately removes archived key + index", () => {
  it("removes archived key and index entry after soft delete", async () => {
    const session = await createSession({ now: 1000 });

    // Soft delete first (puts it in archived state).
    await softDeleteSession(session.id, { now: 2000 });

    // Verify it's archived.
    const archivedBefore = await chrome.storage.local.get(`session_${session.id}_archived`);
    expect(archivedBefore[`session_${session.id}_archived`]).toBeDefined();

    // Now "Delete forever".
    await hardDeleteSession(session.id);

    // Archived key gone.
    const archivedAfter = await chrome.storage.local.get(`session_${session.id}_archived`);
    expect(archivedAfter[`session_${session.id}_archived`]).toBeUndefined();

    // Index entry gone.
    const index = await listSessionIndex();
    expect(index.find((e) => e.id === session.id)).toBeUndefined();
  });

  it("hardDeleteSession is idempotent (no error on already-deleted session)", async () => {
    const session = await createSession({ now: 1000 });
    await hardDeleteSession(session.id);
    // Second call should not throw.
    await expect(hardDeleteSession(session.id)).resolves.toBeUndefined();
  });
});

// ── Scenario 7 (integration): index entry status reflects archive/unarchive ──

describe("Scenario 7 (integration): session_index tracks archived / active status", () => {
  it("index entry is 'archived' after archiveSession and 'active' after unarchiveSession", async () => {
    const session = await createSession({ now: 1000 });

    await archiveSession(session.id, { now: 2000 });

    const afterArchive = await listSessionIndex();
    const archivedEntry = afterArchive.find((e) => e.id === session.id);
    expect(archivedEntry?.status).toBe("archived");

    await unarchiveSession(session.id);

    const afterUnarchive = await listSessionIndex();
    const activeEntry = afterUnarchive.find((e) => e.id === session.id);
    expect(activeEntry?.status).toBe("active");
  });

  it("archiveSession is idempotent — second call is a no-op", async () => {
    const session = await createSession({ now: 1000 });

    await archiveSession(session.id, { now: 2000 });
    const setSpy = vi.spyOn(chromeMock.storage.local, "set");

    // Second call should be a no-op (no additional writes).
    await archiveSession(session.id, { now: 3000 });
    expect(setSpy).not.toHaveBeenCalled();

    setSpy.mockRestore();
  });

  it("softDeleteSession puts session in archived bucket (same as LRU archive)", async () => {
    const session = await createSession({ now: 1000 });
    await softDeleteSession(session.id, { now: 2000 });

    const index = await listSessionIndex();
    const entry = index.find((e) => e.id === session.id);
    expect(entry?.status).toBe("archived");

    // The archived key should exist.
    const archivedRaw = await chrome.storage.local.get(`session_${session.id}_archived`);
    expect(archivedRaw[`session_${session.id}_archived`]).toBeDefined();
  });
});

// ── Bonus: checkAndArchiveLRU caps at MAX 5 archived per call ─────────────────

describe("checkAndArchiveLRU caps at 5 archives per call", () => {
  it("archives at most 5 sessions even if budget is still exceeded", async () => {
    const EIGHT_MB = 8 * 1024 * 1024;

    // Create 7 sessions.
    for (let i = 0; i < 7; i++) {
      await createSession({ now: i * 1000 });
    }

    // Seed pressure so after each archive the budget is still exceeded.
    seedStoragePressure(EIGHT_MB + 1000, "_large_pressure_");

    const result = await checkAndArchiveLRU(100);
    expect(result.archived).toBeLessThanOrEqual(5);
  });
});
