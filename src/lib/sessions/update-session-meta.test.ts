// Regression tests for the SessionMeta lost-update race (pin-tab bug).
//
// Root cause: SessionMeta is a single full record and multiple writers
// (panel persistMessages, SW updateLastAccessed, SW chat-start pin upgrade,
// loop appendPinnedTab, ...) each did getSessionMeta → mutate → setSessionMeta
// across TWO separate IDB transactions. Interleaved read-modify-writes lost
// updates — most visibly the chat-start task pin, which broke the side-panel
// pin bar and made focus_tab fail mid-loop.
//
// Fix: `updateSessionMeta(id, transform)` runs get → transform → put inside a
// SINGLE readwrite IDB transaction (sessions + session_index). IDB serializes
// readwrite transactions on the same store, so the transform always sees the
// latest committed meta and concurrent patches compose instead of clobbering.

import { describe, expect, it, beforeEach } from "vitest";
import "@/test/setup";
import { _resetForTests } from "@/lib/idb/db";
import {
  createSession,
  getSessionMeta,
  setSessionMeta,
  updateSessionMeta,
  persistSessionMessages,
  listSessionIndex,
} from "./storage";
import type { SessionMeta } from "./types";

beforeEach(async () => {
  await _resetForTests();
});

const PIN = { tabId: 42, origin: "https://example.com" };

async function seedTaskPinnedSession(): Promise<SessionMeta> {
  const meta = await createSession();
  const pinned: SessionMeta = {
    ...meta,
    pinMode: "task",
    pinnedTabs: [PIN],
  };
  await setSessionMeta(pinned);
  return pinned;
}

describe("updateSessionMeta", () => {
  it("transform sees the latest committed meta (stale-snapshot writers cannot clobber the pin)", async () => {
    const meta = await createSession();
    // Simulate the SW chat-start pin upgrade landing AFTER a writer captured
    // its stale snapshot: the snapshot is `meta` (no pin), storage now has one.
    await setSessionMeta({ ...meta, pinMode: "task", pinnedTabs: [PIN] });

    // A patch-style writer only touches its own fields; the pin must survive.
    const wrote = await updateSessionMeta(meta.id, (current) => ({
      ...current,
      messages: [{ role: "user", content: "hi" }],
      lastAccessedAt: 12345,
    }));

    expect(wrote).toBe(true);
    const after = await getSessionMeta(meta.id);
    expect(after?.pinMode).toBe("task");
    expect(after?.pinnedTabs).toEqual([PIN]);
    expect(after?.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("concurrent patches compose without lost updates", async () => {
    const meta = await createSession();
    await setSessionMeta({ ...meta, title: "0" });

    // 50 concurrent increments through separate readwrite transactions.
    // The old two-transaction read-modify-write pattern loses updates here.
    await Promise.all(
      Array.from({ length: 50 }, () =>
        updateSessionMeta(meta.id, (current) => ({
          ...current,
          title: String(Number(current.title) + 1),
        })),
      ),
    );

    const after = await getSessionMeta(meta.id);
    expect(after?.title).toBe("50");
  });

  it("returns false and writes nothing when transform returns null", async () => {
    const pinned = await seedTaskPinnedSession();

    const wrote = await updateSessionMeta(pinned.id, () => null);

    expect(wrote).toBe(false);
    const after = await getSessionMeta(pinned.id);
    expect(after?.pinnedTabs).toEqual([PIN]);
  });

  it("returns false when transform returns the same reference (no-op)", async () => {
    const pinned = await seedTaskPinnedSession();
    const wrote = await updateSessionMeta(pinned.id, (current) => current);
    expect(wrote).toBe(false);
  });

  it("returns false for a nonexistent session", async () => {
    const wrote = await updateSessionMeta("nope", (current) => current);
    expect(wrote).toBe(false);
  });

  it("keeps the session index in sync (title + lastAccessedAt)", async () => {
    const meta = await createSession();

    await updateSessionMeta(meta.id, (current) => ({
      ...current,
      title: "renamed",
      lastAccessedAt: 1700000099000,
    }));

    const index = await listSessionIndex();
    const entry = index.find((e) => e.id === meta.id);
    expect(entry?.title).toBe("renamed");
    expect(entry?.lastAccessedAt).toBe(1700000099000);
  });
});

describe("persistSessionMessages (panel message persistence, patch semantics)", () => {
  it("preserves a task pin written after the caller's snapshot (the pin-bar bug)", async () => {
    const meta = await createSession();
    // SW chat-start upgrade wrote the task pin...
    await setSessionMeta({ ...meta, pinMode: "task", pinnedTabs: [PIN] });

    // ...then the panel persists messages. Old code wrote back its stale
    // no-pin snapshot wholesale, erasing the pin from storage.
    await persistSessionMessages(meta.id, [
      { role: "user", content: "second message" },
    ]);

    const after = await getSessionMeta(meta.id);
    expect(after?.pinMode).toBe("task");
    expect(after?.pinnedTabs).toEqual([PIN]);
    expect(after?.messages).toEqual([
      { role: "user", content: "second message" },
    ]);
  });

  it("derives a title from the first user message when title is empty", async () => {
    const meta = await createSession();
    await persistSessionMessages(meta.id, [
      { role: "user", content: "hello world" },
    ]);
    const after = await getSessionMeta(meta.id);
    expect(after?.title).toBeTruthy();
  });

  it("does not write to archived sessions", async () => {
    const meta = await createSession();
    await setSessionMeta({ ...meta, status: "archived" });

    await persistSessionMessages(meta.id, [{ role: "user", content: "x" }]);

    const after = await getSessionMeta(meta.id);
    expect(after?.messages ?? []).toEqual([]);
  });
});
