/**
 * M2-U4 lifecycle tests — covering archive / unarchive / soft-delete /
 * hard-delete / 30-day expired sweep.
 *
 * Storage now lives in IndexedDB; tests seed/read via the sessions-store +
 * storage helpers and reset the IDB between tests via `_resetForTests`.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { _resetForTests } from "@/lib/idb/db";
import {
  getSessionRecord,
  putSessionRecord,
} from "@/lib/idb/sessions-store";
import {
  archiveSession,
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
  archivedKey,
} from "./storage";
import type { SessionAgentState } from "./types";
import { saveRecords } from "@/lib/scratchpad/service";
import { readScratchpad } from "@/lib/scratchpad/store";

beforeEach(async () => {
  await _resetForTests();
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
    expect(await getSessionRecord(archivedKey(session.id))).toBeDefined();

    // Run hardDeleteExpired.
    const result = await hardDeleteExpired(now);
    expect(result.deleted).toBe(1);

    // Archived key should be gone.
    expect(await getSessionRecord(archivedKey(session.id))).toBeUndefined();

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
    expect(await getSessionRecord(archivedKey(session.id))).toBeDefined();
  });

  it("does NOT delete corrupt archive entries missing archivedAt (MAX_SAFE_INTEGER fallback)", async () => {
    const now = Date.now();
    const session = await createSession({ now: 1000 });
    await archiveSession(session.id, { now: 2000 });

    // Corrupt the archive payload: strip archivedAt off the embedded meta.
    const payload = await getSessionRecord<{ meta: Record<string, unknown> }>(
      archivedKey(session.id),
    );
    expect(payload).toBeDefined();
    const corrupt = { ...payload!, meta: { ...payload!.meta } };
    delete corrupt.meta.archivedAt;
    await putSessionRecord(archivedKey(session.id), corrupt);

    // Sweep far in the future — a corrupt entry must survive (not be treated
    // as very-old) so it stays visible for manual triage.
    const result = await hardDeleteExpired(now + 365 * 24 * 60 * 60 * 1000);
    expect(result.deleted).toBe(0);
    expect(await getSessionRecord(archivedKey(session.id))).toBeDefined();
  });

  it("reclaims the scratchpad of an expired session (no orphan leak)", async () => {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const thirtyOneDaysAgo = now - THIRTY_DAYS_MS - 1000;

    const session = await createSession({ now: thirtyOneDaysAgo });
    // Scratchpad survives archive, so seed it then archive.
    await saveRecords(session.id, "products", [{ url: "a" }], { dedupeKey: "url" });
    await archiveSession(session.id, { now: thirtyOneDaysAgo });

    // Sanity: scratchpad still present after archive.
    const beforeSweep = await readScratchpad(session.id);
    expect(beforeSweep.collections.products?.records).toHaveLength(1);

    const result = await hardDeleteExpired(now);
    expect(result.deleted).toBe(1);

    // Scratchpad must be reclaimed by the sweep (read-miss → empty).
    const afterSweep = await readScratchpad(session.id);
    expect(afterSweep.collections).toEqual({});
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
    expect(await getSessionRecord(archivedKey(session.id))).toBeUndefined();

    // Index entry should be active.
    const index = await listSessionIndex();
    const entry = index.find((e) => e.id === session.id);
    expect(entry?.status).toBe("active");
  });
});

// ── Scenario 4: Edge — archive actually removes meta/agent keys ───────────────

describe("Scenario 4: archive releases meta + agent records", () => {
  it("meta + agent records are removed after archiving (only archived key remains)", async () => {
    const session = await createSession({ now: 1000 });

    // Seed a non-trivial agent state.
    const largeAgent: SessionAgentState = {
      agentMessages: [{ role: "user", content: "hello ".repeat(100) }],
      pendingInstructions: [],
      stepIndex: 5,
      hasImageContent: false,
    };
    await putSessionRecord(`${session.id}:agent`, largeAgent);

    await archiveSession(session.id, { now: 2000 });

    // After archiving, meta and agent records are gone; only archived remains.
    expect(await getSessionRecord(`${session.id}:meta`)).toBeUndefined();
    expect(await getSessionRecord(`${session.id}:agent`)).toBeUndefined();
    expect(await getSessionRecord(archivedKey(session.id))).toBeDefined();
  });
});

// ── Scenario 6: Edge — Delete forever immediately removes session ─────────────

describe("Scenario 6: hardDeleteSession immediately removes archived key + index", () => {
  it("removes archived key and index entry after soft delete", async () => {
    const session = await createSession({ now: 1000 });

    // Soft delete first (puts it in archived state).
    await softDeleteSession(session.id, { now: 2000 });

    // Verify it's archived.
    expect(await getSessionRecord(archivedKey(session.id))).toBeDefined();

    // Now "Delete forever".
    await hardDeleteSession(session.id);

    // Archived key gone.
    expect(await getSessionRecord(archivedKey(session.id))).toBeUndefined();

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

    // Snapshot the archived payload after the first archive.
    const firstPayload = await getSessionRecord(archivedKey(session.id));

    // Second call with a different `now` should be a no-op — the archived
    // payload (which carries archivedAt=2000) must be unchanged.
    await archiveSession(session.id, { now: 3000 });
    const secondPayload = await getSessionRecord(archivedKey(session.id));
    expect(secondPayload).toEqual(firstPayload);
  });

  it("softDeleteSession puts session in archived bucket (same as direct archive)", async () => {
    const session = await createSession({ now: 1000 });
    await softDeleteSession(session.id, { now: 2000 });

    const index = await listSessionIndex();
    const entry = index.find((e) => e.id === session.id);
    expect(entry?.status).toBe("archived");

    // The archived key should exist.
    expect(await getSessionRecord(archivedKey(session.id))).toBeDefined();
  });
});
