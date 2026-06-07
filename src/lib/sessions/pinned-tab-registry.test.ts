import { beforeEach, describe, expect, it } from "vitest";
import "@/test/setup";
import {
  createSession,
  markFailed,
  markPaused,
  setSessionMeta,
} from "./storage";
import { setIndex } from "@/lib/idb/sessions-store";
import { _resetForTests } from "@/lib/idb/db";
import {
  getActivePinnedTabs,
  getCrossSessionPinnedTabIds,
} from "./pinned-tab-registry";

beforeEach(async () => {
  await _resetForTests();
});

describe("pinned-tab-registry — getActivePinnedTabs", () => {
  it("returns active + paused sessions with a pinnedTabId", async () => {
    const a = await createSession({
      pinnedTabId: 11,
      pinnedOrigin: "https://a.example.com",
      now: 1000,
    });
    const b = await createSession({
      pinnedTabId: 12,
      pinnedOrigin: "https://b.example.com",
      now: 2000,
    });
    await markPaused(b.id);

    const list = await getActivePinnedTabs();
    expect(list).toEqual(
      expect.arrayContaining([
        { sessionId: a.id, tabId: 11, status: "active" },
        { sessionId: b.id, tabId: 12, status: "paused" },
      ]),
    );
    expect(list).toHaveLength(2);
  });

  it("skips sessions without a pinnedTabId (legacy M1/M2)", async () => {
    await createSession({ now: 1000 }); // no pinnedTabId
    const b = await createSession({
      pinnedTabId: 22,
      pinnedOrigin: "https://b.example.com",
      now: 2000,
    });

    const list = await getActivePinnedTabs();
    expect(list).toEqual([
      { sessionId: b.id, tabId: 22, status: "active" },
    ]);
  });

  it("skips failed and archived sessions", async () => {
    const a = await createSession({
      pinnedTabId: 11,
      pinnedOrigin: "https://a.example.com",
      now: 1000,
    });
    const b = await createSession({
      pinnedTabId: 12,
      pinnedOrigin: "https://b.example.com",
      now: 2000,
    });
    void a;
    await markFailed(b.id);

    // Still active should remain — only `b` is filtered out.
    const list = await getActivePinnedTabs();
    expect(list.map((e) => e.tabId)).toEqual([11]);

    // Archived also drops from the registry — simulate via setSessionMeta.
    const ametaCurrent = (await import("./storage")).getSessionMeta;
    const ametaRead = await ametaCurrent(a.id);
    if (ametaRead) {
      await setSessionMeta({
        ...ametaRead,
        status: "archived",
        archivedAt: 3000,
      });
    }
    const after = await getActivePinnedTabs();
    expect(after).toHaveLength(0);
  });
});

describe("pinned-tab-registry — getCrossSessionPinnedTabIds", () => {
  it("returns ids pinned by other sessions, excluding the caller", async () => {
    const a = await createSession({
      pinnedTabId: 11,
      pinnedOrigin: "https://a.example.com",
      now: 1000,
    });
    const b = await createSession({
      pinnedTabId: 12,
      pinnedOrigin: "https://b.example.com",
      now: 2000,
    });
    const c = await createSession({
      pinnedTabId: 13,
      pinnedOrigin: "https://c.example.com",
      now: 3000,
    });

    const fromA = await getCrossSessionPinnedTabIds(a.id);
    expect(fromA).toEqual(new Set([12, 13]));

    const fromB = await getCrossSessionPinnedTabIds(b.id);
    expect(fromB).toEqual(new Set([11, 13]));

    const fromC = await getCrossSessionPinnedTabIds(c.id);
    expect(fromC).toEqual(new Set([11, 12]));
  });

  it("returns an empty set when no other session is pinned", async () => {
    const a = await createSession({
      pinnedTabId: 11,
      pinnedOrigin: "https://a.example.com",
      now: 1000,
    });
    const result = await getCrossSessionPinnedTabIds(a.id);
    expect(result.size).toBe(0);
  });

  it("returns an empty set when the index is empty", async () => {
    const result = await getCrossSessionPinnedTabIds("nonexistent");
    expect(result.size).toBe(0);
  });
});

describe("pinned-tab-registry — R7 lock gated on currently-running sessions", () => {
  it("only counts tabs owned by sessions in runningSessionIds", async () => {
    await setIndex([
        { id: "self", lastAccessedAt: 1, status: "active", pinnedTabIds: [10], messageCount: 1 },
        { id: "running", lastAccessedAt: 2, status: "active", pinnedTabIds: [20], messageCount: 1 },
        // idle: status active (e.g. an aborted task that kept its pin) but
        // NOT currently executing a loop → must not block the foreground session.
        { id: "idle", lastAccessedAt: 3, status: "active", pinnedTabIds: [30], messageCount: 1 },
        // paused historical session (SW restart) — also not running.
        { id: "paused", lastAccessedAt: 4, status: "paused", pinnedTabIds: [40], messageCount: 1 },
      ]);
    const set = await getCrossSessionPinnedTabIds("self", new Set(["running"]));
    expect(set.has(20)).toBe(true);
    expect(set.has(30)).toBe(false); // idle owner no longer locks
    expect(set.has(40)).toBe(false); // paused owner no longer locks
    expect(set.has(10)).toBe(false); // caller always excluded
  });

  it("empty runningSessionIds means no cross-session locks at all", async () => {
    await setIndex([
        { id: "self", lastAccessedAt: 1, status: "active", pinnedTabIds: [10], messageCount: 1 },
        { id: "other", lastAccessedAt: 2, status: "active", pinnedTabIds: [20], messageCount: 1 },
      ]);
    const set = await getCrossSessionPinnedTabIds("self", new Set());
    expect(set.size).toBe(0);
  });

  it("omitting runningSessionIds preserves legacy all-active/paused behavior", async () => {
    await setIndex([
        { id: "self", lastAccessedAt: 1, status: "active", pinnedTabIds: [10], messageCount: 1 },
        { id: "other", lastAccessedAt: 2, status: "active", pinnedTabIds: [20], messageCount: 1 },
      ]);
    const set = await getCrossSessionPinnedTabIds("self");
    expect(set).toEqual(new Set([20]));
  });
});

describe("v1.5 multi-pin registry", () => {
  it("getActivePinnedTabs expands pinnedTabIds[] into per-tab entries", async () => {
    await setIndex([
        {
          id: "sA",
          lastAccessedAt: 1,
          status: "active",
          pinnedTabIds: [12, 13, 14],
          messageCount: 3,
        },
        {
          id: "sB",
          lastAccessedAt: 2,
          status: "active",
          pinnedTabIds: [99],
          messageCount: 1,
        },
      ]);
    const all = await getActivePinnedTabs();
    expect(all).toEqual(
      expect.arrayContaining([
        { sessionId: "sA", tabId: 12, status: "active" },
        { sessionId: "sA", tabId: 13, status: "active" },
        { sessionId: "sA", tabId: 14, status: "active" },
        { sessionId: "sB", tabId: 99, status: "active" },
      ]),
    );
    expect(all).toHaveLength(4);
  });

  it("getCrossSessionPinnedTabIds returns the union excluding caller", async () => {
    await setIndex([
        { id: "self", lastAccessedAt: 1, status: "active", pinnedTabIds: [10, 11], messageCount: 1 },
        { id: "other", lastAccessedAt: 2, status: "active", pinnedTabIds: [20, 21], messageCount: 1 },
      ]);
    const set = await getCrossSessionPinnedTabIds("self");
    expect(set.has(20)).toBe(true);
    expect(set.has(21)).toBe(true);
    expect(set.has(10)).toBe(false);
    expect(set.has(11)).toBe(false);
  });
});
