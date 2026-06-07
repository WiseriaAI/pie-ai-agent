import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { chromeMock, type FakePort } from "@/test/setup";
import {
  createSession,
  getSessionMeta,
  setSessionMeta,
  setSessionAgent,
} from "@/lib/sessions/storage";
import { setIndex } from "@/lib/idb/sessions-store";
import { _resetForTests } from "@/lib/idb/db";
import { useSession } from ".";

// Session persistence now lives in IndexedDB (the `pie` db). The shared
// test/setup.ts beforeEach only clears the chrome.storage mock, so without an
// explicit IDB reset the `pie` db would leak session records / index entries
// across tests — the prior source of flakiness in this file.
beforeEach(async () => {
  await _resetForTests();
});

// useSession lifecycle is async (it bootstraps a session on mount).
// `waitFor` lets tests synchronize with the resulting state flips.

// M2-U2 P1-11 — helper to emit a port message with the correct sessionId
// injected. All SW→panel messages now carry sessionId; the hook filter drops
// messages whose sessionId doesn't match the active session.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function emitWithSession(port: FakePort, msg: Record<string, unknown>, sessionId: string) {
  port.__emit({ ...msg, sessionId });
}

describe("useSession — bootstrap", () => {
  it("creates a session when index is empty and starts ready=false", async () => {
    const { result } = renderHook(() => useSession());

    // Pre-bootstrap: no session, not ready, no port.
    expect(result.current.sessionId).toBeNull();
    expect(result.current.ready).toBe(false);

    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(result.current.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.current.messages).toEqual([]);

    // The created session is now in storage.
    const meta = await getSessionMeta(result.current.sessionId!);
    expect(meta).not.toBeNull();
    expect(meta!.messages).toEqual([]);
  });

  it("M1-U4 / M3-U1 — opens a per-session port and sends panel-mounted on bootstrap", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    // Connect happens at mount, before any sendMessage. M3-U1 — port name
    // encodes the active sessionId so the SW can per-port-sandbox state.
    expect(chromeMock.runtime.connect).toHaveBeenCalledWith({
      name: `chat-stream-${result.current.sessionId}`,
    });
    expect(chromeMock.runtime.__ports).toHaveLength(1);

    // First message on the port is panel-mounted carrying sessionId.
    const port = chromeMock.runtime.__ports[0]!;
    expect(port.postMessage).toHaveBeenCalledWith({
      type: "panel-mounted",
      sessionId: result.current.sessionId,
    });
  });

  it("always creates a fresh empty session, ignoring any existing index entries", async () => {
    // User-requested rule: every panel mount starts in a fresh, empty
    // session. Previous behavior reloaded list[0] which made every panel
    // open feel like resuming the prior task; users prefer a clean slate
    // and to reach prior work via the SessionDrawer.
    const existing = await createSession({ now: 2000 });
    await setSessionMeta({
      ...(await getSessionMeta(existing.id))!,
      messages: [{ role: "user", content: "previously typed" }],
    });

    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(result.current.sessionId).not.toBe(existing.id);
    expect(result.current.messages).toEqual([]);
    // The pre-existing session is still in storage (drawer can find it).
    const stillThere = await getSessionMeta(existing.id);
    expect(stillThere?.messages).toEqual([
      { role: "user", content: "previously typed" },
    ]);
  });

  it("disconnects the port on unmount", async () => {
    const { result, unmount } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    // Open a port via sendMessage.
    act(() => {
      result.current.sendMessage({ content: "hi" });
    });
    const port = chromeMock.runtime.__ports[0]!;
    expect(port.disconnect).not.toHaveBeenCalled();

    // Multi-session: unmount disconnect restored in Task 10.
    unmount();
    // expect(port.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("useSession — sendMessage / streaming", () => {
  it("connects a chat-stream port and posts chat-start with text-only history", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => {
      result.current.sendMessage({ content: "hello" });
    });

    // M3-U1 — port name carries the sessionId.
    expect(chromeMock.runtime.connect).toHaveBeenCalledWith({
      name: `chat-stream-${result.current.sessionId}`,
    });
    const port = chromeMock.runtime.__ports[0]!;
    expect(port.postMessage).toHaveBeenCalledWith({
      type: "chat-start",
      messages: [{ role: "user", content: "hello" }],
      sessionId: result.current.sessionId,
    });
    expect(result.current.streaming).toBe(true);
    expect(result.current.messages).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  it("uses expandedForLLM in the wire history but keeps the typed text in display", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => {
      result.current.sendMessage({
        content: "/extract",
        expandedForLLM: "Please extract structured data from this page",
      });
    });

    const port = chromeMock.runtime.__ports[0]!;
    // Mount-immediate connection (M1-U4) means the first postMessage is
    // `panel-mounted`, so we have to find the chat-start call by type.
    const chatStartCall = port.postMessage.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "chat-start",
    );
    expect(chatStartCall).toBeDefined();
    const wirePayload = chatStartCall![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(wirePayload.messages).toEqual([
      {
        role: "user",
        content: "Please extract structured data from this page",
      },
    ]);
    // But display retains the slash form.
    expect(result.current.messages[0]).toMatchObject({
      role: "user",
      content: "/extract",
      expandedForLLM: "Please extract structured data from this page",
    });
  });

  it("M1-U4 — reuses the mount-time port, does NOT open a new one per sendMessage", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(chromeMock.runtime.__ports).toHaveLength(1);
    const port = chromeMock.runtime.__ports[0]!;

    // First sendMessage → finish → second sendMessage on same port.
    act(() => result.current.sendMessage({ content: "first" }));
    act(() => emitWithSession(port, { type: "chat-chunk", text: "ok" }, result.current.sessionId!));
    act(() => emitWithSession(port, { type: "chat-done" }, result.current.sessionId!));
    await waitFor(() => expect(result.current.streaming).toBe(false));

    act(() => result.current.sendMessage({ content: "second" }));

    // Still only one port.
    expect(chromeMock.runtime.__ports).toHaveLength(1);
    // Two chat-start posts on the same port.
    const chatStartCalls = port.postMessage.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === "chat-start",
    );
    expect(chatStartCalls).toHaveLength(2);
  });

  it("ignores sendMessage while already streaming", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => {
      result.current.sendMessage({ content: "first" });
    });
    act(() => {
      result.current.sendMessage({ content: "second" });
    });

    // Only one port opened, only one chat-start sent.
    expect(chromeMock.runtime.__ports).toHaveLength(1);
    expect(result.current.messages).toHaveLength(1);
    expect((result.current.messages[0] as { content: string }).content).toBe("first");
  });

  it("accumulates chat-chunk into streamingText", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.sendMessage({ content: "hi" }));
    const port = chromeMock.runtime.__ports[0]!;
    const sid = result.current.sessionId!;

    act(() => emitWithSession(port, { type: "chat-chunk", text: "Hel" }, sid));
    act(() => emitWithSession(port, { type: "chat-chunk", text: "lo!" }, sid));

    expect(result.current.streamingText).toBe("Hello!");
    expect(result.current.streaming).toBe(true);
  });
});

describe("useSession — persistence boundaries", () => {
  it("appends assistant message and persists on chat-done", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.sendMessage({ content: "ping" }));
    const port = chromeMock.runtime.__ports[0]!;
    const sid = result.current.sessionId!;
    act(() => emitWithSession(port, { type: "chat-chunk", text: "pong" }, sid));
    act(() => emitWithSession(port, { type: "chat-done" }, sid));

    await waitFor(() => expect(result.current.streaming).toBe(false));

    expect(result.current.messages).toEqual([
      { role: "user", content: "ping" },
      { role: "assistant", content: "pong" },
    ]);
    expect(result.current.streamingText).toBe("");

    // Storage round-trip: re-read storage → sees the persisted messages.
    // The hook's persist is a fire-and-forget IDB write that commits on a
    // later microtask, so poll until it lands (chrome.storage used to resolve
    // synchronously; IDB does not).
    await waitFor(async () => {
      const reread = await getSessionMeta(result.current.sessionId!);
      expect(reread!.messages).toEqual([
        { role: "user", content: "ping" },
        { role: "assistant", content: "pong" },
      ]);
    });
  });

  it("persists on chat-error so the user sees prior context after switching back", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.sendMessage({ content: "ping" }));
    const port = chromeMock.runtime.__ports[0]!;
    const sid = result.current.sessionId!;
    act(() => emitWithSession(port, { type: "chat-chunk", text: "partial" }, sid));
    act(() => emitWithSession(port, { type: "chat-error", error: "rate limited" }, sid));

    await waitFor(() => expect(result.current.streaming).toBe(false));

    expect(result.current.error).toBe("rate limited");
    expect(result.current.messages).toEqual([
      { role: "user", content: "ping" },
      { role: "assistant", content: "partial" },
    ]);

    await waitFor(async () => {
      const reread = await getSessionMeta(result.current.sessionId!);
      expect(reread!.messages).toEqual(result.current.messages);
    });
  });

  it("persists on agent-done-task with a summary row", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.sendMessage({ content: "go" }));
    const port = chromeMock.runtime.__ports[0]!;
    const sid = result.current.sessionId!;
    act(() =>
      emitWithSession(port, {
        type: "agent-done-task",
        success: true,
        summary: "Done.",
        stepCount: 3,
      }, sid),
    );

    await waitFor(() => expect(result.current.streaming).toBe(false));

    expect(result.current.messages.at(-1)).toEqual({
      role: "agent-summary",
      success: true,
      summary: "Done.",
      stepCount: 3,
    });

    await waitFor(async () => {
      const reread = await getSessionMeta(result.current.sessionId!);
      expect(reread!.messages.at(-1)).toMatchObject({
        role: "agent-summary",
        success: true,
      });
    });
  });

  it("persists on unexpected onDisconnect (SW death) so partial work isn't lost", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.sendMessage({ content: "ping" }));
    const port = chromeMock.runtime.__ports[0]!;
    const sid = result.current.sessionId!;
    act(() => emitWithSession(port, { type: "chat-chunk", text: "halfway" }, sid));
    act(() => port.__triggerDisconnect());

    await waitFor(() => expect(result.current.streaming).toBe(false));

    expect(result.current.messages).toEqual([
      { role: "user", content: "ping" },
      { role: "assistant", content: "halfway" },
    ]);
    await waitFor(async () => {
      const reread = await getSessionMeta(result.current.sessionId!);
      expect(reread!.messages).toEqual(result.current.messages);
    });
  });

  it("does NOT write storage during chat-chunk (avoids streaming churn)", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.sendMessage({ content: "ping" }));
    const port = chromeMock.runtime.__ports[0]!;
    const sid = result.current.sessionId!;
    act(() => emitWithSession(port, { type: "chat-chunk", text: "Hel" }, sid));
    act(() => emitWithSession(port, { type: "chat-chunk", text: "lo" }, sid));

    // Storage is still at the seed state — sendMessage does not persist
    // mid-flow, and chat-chunk events don't either. Only done boundaries
    // write storage, which we haven't reached yet.
    const persisted = (await getSessionMeta(result.current.sessionId!))!
      .messages;
    expect(persisted).toEqual([]);

    // React state has the user message + streaming text, as expected.
    expect(result.current.messages).toEqual([
      { role: "user", content: "ping" },
    ]);
    expect(result.current.streamingText).toBe("Hello");
  });
});

describe("useSession — clearMessages", () => {
  it("clears React state and storage", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    // Seed messages via a chat-done flow.
    act(() => result.current.sendMessage({ content: "ping" }));
    const port = chromeMock.runtime.__ports[0]!;
    const sid = result.current.sessionId!;
    act(() => emitWithSession(port, { type: "chat-chunk", text: "pong" }, sid));
    act(() => emitWithSession(port, { type: "chat-done" }, sid));
    await waitFor(() => expect(result.current.streaming).toBe(false));

    expect(result.current.messages).toHaveLength(2);

    // Wait for the chat-done IDB persist to land before clearing — otherwise a
    // late-committing write could repopulate storage after clearMessages.
    await waitFor(async () => {
      const seeded = await getSessionMeta(result.current.sessionId!);
      expect(seeded!.messages).toHaveLength(2);
    });
    // The chat-done write fires a coarse "sessions" store-bus event whose
    // listener re-reads meta asynchronously. Let that re-read fully drain
    // (it self-echoes the 2-message state — a no-op) BEFORE clearMessages, so
    // its stale snapshot can't land after the clear. Without this drain the
    // in-flight re-read could resolve post-clear and re-adopt the 2 messages.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      await result.current.clearMessages();
    });

    // clearMessages persists [] and clears React state. The hook also rides a
    // coarse "sessions" store-bus event and re-reads meta from IDB; the empty
    // write is the last committed state, so React state settles to []. Poll to
    // let any in-flight store-change re-read callbacks drain (the IDB write +
    // its async re-read are not synchronous like the old chrome.storage mock).
    await waitFor(() => expect(result.current.messages).toEqual([]));
    expect(result.current.error).toBeNull();
    await waitFor(async () => {
      const reread = await getSessionMeta(result.current.sessionId!);
      expect(reread!.messages).toEqual([]);
    });
  });
});

describe("useSession — M3-U2 lock-on-send pin (post-acceptance rule)", () => {
  it("createAndActivate does NOT pre-capture — new session starts with no pin", async () => {
    // Post-acceptance rule: empty sessions can freely tab-switch; the pin
    // is captured at the moment of first sendMessage. createAndActivate
    // must NOT pre-capture, otherwise the user's at-create tab wins over
    // their actual at-send tab.
    chromeMock.tabs.__activeTab = {
      id: 42,
      url: "https://docs.example.com/foo/bar?q=1",
      title: "Docs",
      active: true,
      windowId: 1,
    };

    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    let newId: string | null = null;
    await act(async () => {
      newId = await result.current.createAndActivate();
    });
    expect(newId).not.toBeNull();
    const meta = await getSessionMeta(newId!);
    expect(meta).not.toBeNull();
    expect(meta!.pinnedTabs).toBeUndefined();
    // Hook also exposes pinnedTabs: null for the new empty session.
    expect(result.current.pinnedTabs).toBeNull();
  });

  it("bootstrap does NOT backfill an empty legacy session — the pin is captured at first send instead", async () => {
    // Empty legacy session (no messages, no pin) — under the lock-on-send
    // rule, bootstrap leaves it alone. The user can tab-switch freely
    // (PINNED follows live), and the next sendMessage captures.
    const legacy = await createSession({ now: 1000 });
    expect(legacy.pinnedTabs).toBeUndefined();

    chromeMock.tabs.__activeTab = {
      id: 99,
      url: "https://app.example.com/",
      active: true,
      windowId: 1,
    };

    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    const after = await getSessionMeta(legacy.id);
    expect(after?.pinnedTabs).toBeUndefined();
  });

  it("setActive backfills a legacy session that already has content (M1/M2 migration)", async () => {
    // Legacy = M1/M2 session whose meta predates pin support BUT which
    // already accumulated messages. We backfill so resume / next-send can
    // anchor cleanly. Pre-fresh-bootstrap rule the migration fired during
    // bootstrap; under the always-fresh-empty rule it fires the moment the
    // user reaches the legacy session via setActive (drawer click).
    const legacy = await createSession({ now: 1000 });
    await setSessionMeta({
      ...(await getSessionMeta(legacy.id))!,
      messages: [{ role: "user", content: "previously typed" }],
    });

    chromeMock.tabs.__activeTab = {
      id: 99,
      url: "https://app.example.com/",
      active: true,
      windowId: 1,
    };

    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));
    // Bootstrap created a fresh session — legacy is untouched at this point.
    expect((await getSessionMeta(legacy.id))?.pinnedTabs).toBeUndefined();

    await act(async () => {
      await result.current.setActive(legacy.id);
    });

    const after = await getSessionMeta(legacy.id);
    expect(after?.pinnedTabs).toEqual(
      expect.arrayContaining([expect.objectContaining({ tabId: 99, origin: "https://app.example.com" })]),
    );
  });

  it("first sendMessage on an empty session captures + persists the pin", async () => {
    chromeMock.tabs.__activeTab = {
      id: 55,
      url: "https://send-time.example.com/",
      active: true,
      windowId: 1,
    };

    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const id = result.current.sessionId!;

    // Pre-send: no pin
    let meta = await getSessionMeta(id);
    expect(meta?.pinnedTabs).toBeUndefined();

    act(() => {
      result.current.sendMessage({ content: "hello" });
    });

    // sendMessage's pin capture is async (await captureActivePinned +
    // await persistMessages before chat-start). Wait for the pin to land.
    await waitFor(async () => {
      meta = await getSessionMeta(id);
      expect(meta?.pinnedTabs?.[0]?.tabId).toBe(55);
    });
    expect(meta?.pinnedTabs?.[0]?.origin).toBe("https://send-time.example.com");
  });

  it("second sendMessage does NOT re-capture or overwrite the pin", async () => {
    chromeMock.tabs.__activeTab = {
      id: 55,
      url: "https://first.example.com/",
      active: true,
      windowId: 1,
    };

    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const id = result.current.sessionId!;

    act(() => {
      result.current.sendMessage({ content: "first" });
    });
    await waitFor(async () => {
      const m = await getSessionMeta(id);
      expect(m?.pinnedTabs?.[0]?.tabId).toBe(55);
    });

    // Simulate the SW completing the stream so the panel can send again.
    const port = chromeMock.runtime.__ports.at(-1)!;
    act(() => {
      emitWithSession(port, { type: "chat-done" }, id);
    });
    await waitFor(() => expect(result.current.streaming).toBe(false));

    // User switched tabs between turns.
    chromeMock.tabs.__activeTab = {
      id: 88,
      url: "https://second.example.com/",
      active: true,
      windowId: 1,
    };

    act(() => {
      result.current.sendMessage({ content: "second" });
    });
    // Wait for second send to settle.
    await waitFor(() => expect(result.current.streaming).toBe(true));

    // Pin still locked to the first-send capture (55 / first.example.com).
    const meta = await getSessionMeta(id);
    expect(meta?.pinnedTabs?.[0]?.tabId).toBe(55);
    expect(meta?.pinnedTabs?.[0]?.origin).toBe("https://first.example.com");
  });

  it("setActive does NOT overwrite an existing pin on subsequent activations", async () => {
    // Pretend the user has since switched to a different tab —
    // captureActivePinned would return id=88, but since the session
    // already has a pin, setActive must leave it alone.
    const session = await createSession({
      pinnedTabId: 7,
      pinnedOrigin: "https://original.example.com",
      now: 1000,
    });
    // Seed messages so the migration "session has content" guard is
    // satisfied — without messages, setActive's backfill branch is skipped
    // entirely (lock-on-send rule), and the test would pass trivially.
    await setSessionMeta({
      ...(await getSessionMeta(session.id))!,
      messages: [{ role: "user", content: "first" }],
    });

    chromeMock.tabs.__activeTab = {
      id: 88,
      url: "https://other.example.com/",
      active: true,
      windowId: 1,
    };

    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      await result.current.setActive(session.id);
    });
    const after = await getSessionMeta(session.id);
    expect(after?.pinnedTabs?.[0]?.tabId).toBe(7);
    expect(after?.pinnedTabs?.[0]?.origin).toBe("https://original.example.com");
  });

  it("captureActivePinned returns null for restricted URLs (loop falls back to legacy anchor)", async () => {
    chromeMock.tabs.__activeTab = {
      id: 5,
      url: "chrome://newtab/",
      active: true,
      windowId: 1,
    };

    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    // Bootstrap created a fresh session because the index was empty.
    const meta = await getSessionMeta(result.current.sessionId!);
    expect(meta?.pinnedTabs).toBeUndefined();
  });

  it("captureActivePinned returns null when tab.id is -1 (session-restore / detached tab)", async () => {
    // Chrome can return tab.id === -1 for session-restore tabs. The
    // earlier `if (!tab?.id || !tab.url)` check let -1 through (truthy).
    // Persisting it would cause a downstream chrome.tabs.get(-1) to
    // synchronously throw 'Value must be at least 0' and crash the agent
    // loop with a raw API error in chat-error.
    chromeMock.tabs.__activeTab = {
      id: -1,
      url: "https://example.com/",
      active: true,
      windowId: 1,
    };

    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    const meta = await getSessionMeta(result.current.sessionId!);
    expect(meta?.pinnedTabs).toBeUndefined();
  });

  it("captureActivePinned returns null for blob: URLs (review fix REL-2)", async () => {
    // blob:https://example.com/abc parses to a non-"null" origin so the
    // earlier captureActivePinned would have persisted a pin. The loop's
    // isRestrictedUrl rejects blob: hard, so every chat-start would emit
    // 'restricted URL' before the first iteration. Fix: filter at the
    // panel via the prefix list so the panel and loop agree.
    chromeMock.tabs.__activeTab = {
      id: 6,
      url: "blob:https://example.com/abc-123",
      active: true,
      windowId: 1,
    };

    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    const meta = await getSessionMeta(result.current.sessionId!);
    expect(meta?.pinnedTabs).toBeUndefined();
  });

  it("setActive backfills missing pin ONLY for legacy sessions that already have content", async () => {
    // Lock-on-send rule: empty session B should NOT be backfilled by
    // setActive — pin will be captured at first sendMessage instead.
    // Legacy session B WITH content SHOULD be backfilled (M1/M2 migration).
    const sessionA = await createSession({
      pinnedTabId: 1,
      pinnedOrigin: "https://a.example.com",
      now: 3000,
    });
    const sessionB_empty = await createSession({ now: 2000 });
    const sessionB_legacy = await createSession({ now: 1000 });
    await setSessionMeta({
      ...(await getSessionMeta(sessionB_legacy.id))!,
      messages: [{ role: "user", content: "old conversation" }],
    });

    chromeMock.tabs.__activeTab = {
      id: 77,
      url: "https://b.example.com/",
      active: true,
      windowId: 1,
    };

    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));
    // Bootstrap created a fresh empty session — sessionA is reachable only
    // via setActive now. (Old behavior: bootstrap selected most-recent.)

    // Switch to empty session B → no backfill.
    await act(async () => {
      await result.current.setActive(sessionB_empty.id);
    });
    const afterEmpty = await getSessionMeta(sessionB_empty.id);
    expect(afterEmpty?.pinnedTabs).toBeUndefined();
    void sessionA; // referenced for setup parity; not asserted

    // Switch to legacy-with-content session → backfill fires.
    await act(async () => {
      await result.current.setActive(sessionB_legacy.id);
    });
    const afterLegacy = await getSessionMeta(sessionB_legacy.id);
    expect(afterLegacy?.pinnedTabs?.[0]?.tabId).toBe(77);
    expect(afterLegacy?.pinnedTabs?.[0]?.origin).toBe("https://b.example.com");
  });

  it("setActive does NOT overwrite an existing pin on activation", async () => {
    const sessionA = await createSession({
      pinnedTabId: 1,
      pinnedOrigin: "https://a.example.com",
      now: 2000,
    });
    const sessionB = await createSession({
      pinnedTabId: 99,
      pinnedOrigin: "https://original.example.com",
      now: 1000,
    });
    // User has since switched to a different tab — but B already has a
    // pin, so setActive must NOT overwrite it.
    chromeMock.tabs.__activeTab = {
      id: 88,
      url: "https://other.example.com/",
      active: true,
      windowId: 1,
    };

    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));
    void sessionA; // bootstrap creates a fresh session, sessionA unused here

    await act(async () => {
      await result.current.setActive(sessionB.id);
    });

    const after = await getSessionMeta(sessionB.id);
    expect(after?.pinnedTabs?.[0]?.tabId).toBe(99);
    expect(after?.pinnedTabs?.[0]?.origin).toBe("https://original.example.com");
  });

  it("v1.5 togglePinTab cycles auto → user[A] → user[A,B] → user[B] → auto across multi-toggle (cross-layer integration)", async () => {
    // v1.5 multi-pin integration test: covers the panel→storage round-trip
    // for togglePinTab. pin-state's unit tests cover togglePinTabUserMode
    // directly, but this asserts useSession's togglePinTab callback wires
    // through getSessionMeta + setSessionMeta + onChanged correctly.
    // (Cross-layer regression per CLAUDE.md memory: high unit-test count
    // cannot replace integration tests.)
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const sid = result.current.sessionId!;

    // Pre-toggle: fresh session is auto, no pins.
    expect(result.current.pinMode).toBe("auto");
    expect(result.current.pinnedTabs).toBeNull();

    // Toggle 1: auto → user [A]
    await act(async () => {
      await result.current.togglePinTab(12, "https://a.com");
    });
    await waitFor(() => {
      expect(result.current.pinnedTabs).toEqual([
        { tabId: 12, origin: "https://a.com" },
      ]);
      expect(result.current.pinMode).toBe("user");
    });
    {
      const meta = await getSessionMeta(sid);
      expect(meta?.pinMode).toBe("user");
      expect(meta?.pinnedTabs).toEqual([
        { tabId: 12, origin: "https://a.com" },
      ]);
    }

    // Toggle 2: user [A] → user [A, B] (multi-select append)
    await act(async () => {
      await result.current.togglePinTab(13, "https://b.com");
    });
    await waitFor(() => {
      expect(result.current.pinnedTabs).toEqual([
        { tabId: 12, origin: "https://a.com" },
        { tabId: 13, origin: "https://b.com" },
      ]);
      expect(result.current.pinMode).toBe("user");
    });
    {
      const meta = await getSessionMeta(sid);
      expect(meta?.pinnedTabs).toEqual([
        { tabId: 12, origin: "https://a.com" },
        { tabId: 13, origin: "https://b.com" },
      ]);
    }

    // Toggle 3: user [A, B] → user [B] (toggling existing tab removes it)
    await act(async () => {
      await result.current.togglePinTab(12, "https://a.com");
    });
    await waitFor(() => {
      expect(result.current.pinnedTabs).toEqual([
        { tabId: 13, origin: "https://b.com" },
      ]);
      expect(result.current.pinMode).toBe("user");
    });
    {
      const meta = await getSessionMeta(sid);
      expect(meta?.pinMode).toBe("user");
      expect(meta?.pinnedTabs).toEqual([
        { tabId: 13, origin: "https://b.com" },
      ]);
    }

    // Toggle 4: user [B] → auto (last entry removed flips back to auto)
    await act(async () => {
      await result.current.togglePinTab(13, "https://b.com");
    });
    await waitFor(() => {
      expect(result.current.pinnedTabs).toBeNull();
      expect(result.current.pinMode).toBe("auto");
    });
    {
      const meta = await getSessionMeta(sid);
      expect(meta?.pinMode).toBe("auto");
      expect(meta?.pinnedTabs).toBeUndefined();
    }
  });
});

describe("useSession — M3-U1 per-session port routing", () => {
  it("swaps the port to a per-session name when setActive switches sessions", async () => {
    const sessionA = await createSession({ now: 1000 });
    const sessionB = await createSession({ now: 2000 });
    void sessionA;
    void sessionB;
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    // Bootstrap created a fresh session — its port is the most-recent connect.
    const freshId = result.current.sessionId!;
    expect(chromeMock.runtime.connect).toHaveBeenLastCalledWith({
      name: `chat-stream-${freshId}`,
    });
    const freshPort = chromeMock.runtime.__ports.at(-1)!;

    // Switch to sessionA — the swap behavior we want to verify is identical
    // regardless of where bootstrap landed.
    let switched: string | null = null;
    await act(async () => {
      switched = await result.current.setActive(sessionA.id);
    });
    expect(switched).toBe(sessionA.id);

    // Old port stays connected (multi-session: background tasks survive switch).
    // Old disconnect behavior removed, restored in Tasks 7+8 if needed.
    expect(chromeMock.runtime.connect).toHaveBeenLastCalledWith({
      name: `chat-stream-${sessionA.id}`,
    });
  });

  it("createAndActivate also swaps to a fresh per-session port", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const oldPort = chromeMock.runtime.__ports.at(-1)!;
    const oldId = result.current.sessionId!;

    let newId: string | null = null;
    await act(async () => {
      newId = await result.current.createAndActivate();
    });
    expect(newId).not.toBe(oldId);
    // Old port stays connected (multi-session: background tasks survive switch).
    // Old disconnect assertion removed, restored in Tasks 7+8 if needed.
    expect(chromeMock.runtime.connect).toHaveBeenLastCalledWith({
      name: `chat-stream-${newId}`,
    });
  });

});

describe("useSession — abort", () => {
  it("posts chat-abort to the active port", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.sendMessage({ content: "ping" }));
    const port = chromeMock.runtime.__ports[0]!;

    act(() => result.current.abort());
    expect(port.postMessage).toHaveBeenCalledWith({ type: "chat-abort" });
  });

  it("is a no-op when no port is active", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    // No sendMessage yet — abort should not throw.
    expect(() => result.current.abort()).not.toThrow();
  });
});

describe("setActive — multi-session port lifecycle (#30)", () => {
  it("does not disconnect the previous session's port on switch", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const idA = result.current.sessionId!;
    const portA = chromeMock.runtime.__ports.at(-1)!;

    // Create a second session
    let idB: string | null = null;
    await act(async () => {
      idB = await result.current.createAndActivate();
    });
    const portB = chromeMock.runtime.__ports.at(-1)!;

    expect(portA.disconnect).not.toHaveBeenCalled();
    expect(portB).not.toBe(portA);
    expect(result.current.sessionId).toBe(idB);
  });

  it("does not refuse setActive while streaming", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const idA = result.current.sessionId!;

    // Pre-create a second session in storage
    const { id: idB } = await createSession({ now: 2000 });

    // Start streaming on session A
    act(() => {
      result.current.sendMessage({ content: "hello" });
    });
    expect(result.current.streaming).toBe(true);

    // Switch to session B while streaming — should NOT return null (streaming guard removed)
    let switched: string | null = null;
    await act(async () => {
      switched = await result.current.setActive(idB);
    });
    expect(switched).not.toBeNull();
    expect(switched).toBe(idB);
  });

  it("setActive rehydrates slot.usage from SessionAgentState.contextUsage (#59)", async () => {
    const id = "sess-rehydrate";
    await setSessionMeta({
      id,
      createdAt: 1,
      lastAccessedAt: 1,
      status: "active",
      messages: [],
    });
    await setSessionAgent(id, {
      agentMessages: [],
      pendingInstructions: [],
      stepIndex: 0,
      hasImageContent: false,
      contextUsage: {
        totalInputTokens: 5000,
        totalOutputTokens: 200,
        lastInputTokens: 1000,
        lastOutputTokens: 50,
      },
    });
    await setIndex([
      { id, lastAccessedAt: 1, status: "active", messageCount: 0 },
    ]);

    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.setActive(id);
    });

    await waitFor(() => {
      expect(result.current.usage).toEqual({
        totalInputTokens: 5000,
        totalOutputTokens: 200,
        lastInputTokens: 1000,
        lastOutputTokens: 50,
      });
    });
  });

  it("setActive on a session with no prior usage returns undefined usage (#59)", async () => {
    const id = "sess-no-usage";
    await setSessionMeta({
      id,
      createdAt: 1,
      lastAccessedAt: 1,
      status: "active",
      messages: [],
    });
    // Intentionally NO agent record — simulates a session that exists but
    // never had an LLM call complete.
    await setIndex([
      { id, lastAccessedAt: 1, status: "active", messageCount: 0 },
    ]);

    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      await result.current.setActive(id);
    });

    await waitFor(() => {
      expect(result.current.sessionId).toBe(id);
    });
    expect(result.current.usage).toBeUndefined();
  });
});

describe("unmount lifecycle (#30)", () => {
  it("disconnects every port in portsRef on unmount", async () => {
    const { result, unmount } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const portA = chromeMock.runtime.__ports.at(-1)!;
    let idB: string | null = null;
    await act(async () => {
      idB = await result.current.createAndActivate();
    });
    const portB = chromeMock.runtime.__ports.at(-1)!;
    expect(portA.disconnect).not.toHaveBeenCalled();
    expect(portB.disconnect).not.toHaveBeenCalled();
    unmount();
    expect(portA.disconnect).toHaveBeenCalledTimes(1);
    expect(portB.disconnect).toHaveBeenCalledTimes(1);
  });
});

// SW idle-out (MV3 ~30s 空闲后 SW 被 Chrome 终止) 让 panel 这侧的 port
// 静默断开。如果不清 portsRef + 不重连，下一次 sendMessage 会在 dead port
// 上 postMessage 抛 "Attempting to use a disconnected port object"，side
// panel 卡死在 streaming 状态。
describe("port lifecycle — SW idle-out / disconnect recovery", () => {
  it("port disconnect 后 sendMessage 自动新建 port 并发送 chat-start", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(chromeMock.runtime.__ports).toHaveLength(1);
    const stale = chromeMock.runtime.__ports[0]!;
    // 模拟 SW idle-out — port 在 panel 侧静默断开。
    act(() => stale.__triggerDisconnect());

    act(() => result.current.sendMessage({ content: "after revival" }));

    // 应该有第二条 port（lazy reconnect）。
    expect(chromeMock.runtime.__ports).toHaveLength(2);
    const fresh = chromeMock.runtime.__ports[1]!;
    expect(fresh.name).toBe(`chat-stream-${result.current.sessionId}`);

    // chat-start 落在新 port 上，旧 port 不再收到任何 chat-start。
    const staleChatStart = stale.postMessage.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "chat-start",
    );
    expect(staleChatStart).toBeUndefined();
    const freshChatStart = fresh.postMessage.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "chat-start",
    );
    expect(freshChatStart).toBeDefined();

    expect(result.current.streaming).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("postMessage 抛 disconnected 错时静默重连重发（用户透明）", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    const stale = chromeMock.runtime.__ports[0]!;
    // 模拟 race：port 还在 portsRef 但 postMessage 已抛 disconnected。
    // 只有 chat-start 会抛（panel-mounted 已发完）。
    stale.postMessage.mockImplementationOnce(() => {
      throw new Error("Attempting to use a disconnected port object");
    });

    act(() => result.current.sendMessage({ content: "hello" }));

    // 第一次 postMessage 在 stale 上失败 → lazy reconnect → 在新 port 上成功。
    expect(chromeMock.runtime.__ports).toHaveLength(2);
    const fresh = chromeMock.runtime.__ports[1]!;
    const freshChatStart = fresh.postMessage.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "chat-start",
    );
    expect(freshChatStart).toBeDefined();
    expect(result.current.streaming).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("两次 postMessage 连续失败 → revert streaming + 写 error", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    const mountPort = chromeMock.runtime.__ports[0]!;
    mountPort.postMessage.mockImplementation(() => {
      throw new Error("Attempting to use a disconnected port object");
    });

    // 让 lazy reconnect 后的新 port 也立刻抛错。完成测试后还原 connect
    // 的 default 实现，避免污染后续 test（vi 不会自动 reset implementation）。
    const origImpl = chromeMock.runtime.connect.getMockImplementation()!;
    chromeMock.runtime.connect.mockImplementation((info) => {
      const p = origImpl(info);
      p.postMessage.mockImplementation(() => {
        throw new Error("Attempting to use a disconnected port object");
      });
      return p;
    });

    try {
      act(() => result.current.sendMessage({ content: "hello" }));

      // streaming 必须 revert，否则 UI 永远卡在 spinner 上。
      await waitFor(() => expect(result.current.streaming).toBe(false));
      expect(result.current.error).toBe("Unable to reach the background service. Please retry.");
      // 用户消息仍持久化（不丢），用户可重试。
      expect(result.current.messages).toEqual([
        { role: "user", content: "hello" },
      ]);
    } finally {
      chromeMock.runtime.connect.mockImplementation(origImpl);
    }
  });

  it("disconnect 时 portsRef 中身份不匹配的新 port 不被误删", async () => {
    // 保护手动 reconnect 场景：sibling 重连可能已写入新 port，此时 stale
    // disconnect 不该把新 port 从 portsRef 移除。createAndActivate 后旧
    // session 的 port 仍然独立挂在 portsRef 里，断开旧 session 的 port
    // 不应影响新 session。
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    const portA = chromeMock.runtime.__ports[0]!;
    const idA = result.current.sessionId!;

    let idB: string | null = null;
    await act(async () => {
      idB = await result.current.createAndActivate();
    });
    const portB = chromeMock.runtime.__ports[1]!;
    expect(portB.name).toBe(`chat-stream-${idB}`);

    // 断开 A 的 port — B 的 port 不该被波及，B 上 sendMessage 不重连。
    act(() => portA.__triggerDisconnect());
    act(() => result.current.sendMessage({ content: "on B" }));

    expect(chromeMock.runtime.__ports).toHaveLength(2);
    const bChatStart = portB.postMessage.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "chat-start",
    );
    expect(bChatStart).toBeDefined();
    void idA; // silence unused
  });
});

describe("useSession — quote-needs-reconnect nudge", () => {
  it("force-reconnects the current session's port so the SW can drain the stashed quote", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    const sid = result.current.sessionId!;
    expect(chromeMock.runtime.__ports).toHaveLength(1);
    const firstPort = chromeMock.runtime.__ports[0]!;

    // SW broadcasts the nudge (its streaming port is dead after an idle/restart
    // while the panel stayed mounted). The panel must drop its stale port and
    // reconnect the SAME session so onConnect drains the pending quote here.
    act(() => chromeMock.runtime.__emitMessage({ type: "quote-needs-reconnect" }));

    expect(firstPort.disconnect).toHaveBeenCalled();
    expect(chromeMock.runtime.__ports).toHaveLength(2);
    expect(chromeMock.runtime.connect).toHaveBeenLastCalledWith({
      name: `chat-stream-${sid}`,
    });
  });

  it("ignores unrelated runtime messages", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(chromeMock.runtime.__ports).toHaveLength(1);

    act(() => chromeMock.runtime.__emitMessage({ type: "something-else" }));

    expect(chromeMock.runtime.__ports).toHaveLength(1);
  });
});
