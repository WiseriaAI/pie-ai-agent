import { describe, expect, it } from "vitest";
import "@/test/setup";
import {
  createSession,
  markFailed,
  markPaused,
  setSessionMeta,
} from "./storage";
import {
  getActivePinnedTabs,
  getCrossSessionPinnedTabIds,
} from "./pinned-tab-registry";

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
