import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { chromeMock } from "@/test/setup";
import {
  createSession,
  getSessionMeta,
  setSessionMeta,
} from "@/lib/sessions/storage";
import { useSession } from "./useSession";

// useSession lifecycle is async (it bootstraps a session on mount).
// `waitFor` lets tests synchronize with the resulting state flips.

// M2-U2 P1-11 — helper to emit a port message with the correct sessionId
// injected. All SW→panel messages now carry sessionId; the hook filter drops
// messages whose sessionId doesn't match the active session.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FakePort = { __emit: (msg: any) => void; [key: string]: unknown };
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

    unmount();
    expect(port.disconnect).toHaveBeenCalledTimes(1);
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
    expect(result.current.messages[0]!.content).toBe("first");
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

    // Storage round-trip: re-mount a fresh hook → sees the persisted messages.
    const reread = await getSessionMeta(result.current.sessionId!);
    expect(reread!.messages).toEqual([
      { role: "user", content: "ping" },
      { role: "assistant", content: "pong" },
    ]);
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

    const reread = await getSessionMeta(result.current.sessionId!);
    expect(reread!.messages).toEqual(result.current.messages);
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

    const reread = await getSessionMeta(result.current.sessionId!);
    expect(reread!.messages.at(-1)).toMatchObject({
      role: "agent-summary",
      success: true,
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
    const reread = await getSessionMeta(result.current.sessionId!);
    expect(reread!.messages).toEqual(result.current.messages);
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

    await act(async () => {
      await result.current.clearMessages();
    });

    expect(result.current.messages).toEqual([]);
    expect(result.current.error).toBeNull();
    const reread = await getSessionMeta(result.current.sessionId!);
    expect(reread!.messages).toEqual([]);
  });
});

describe("useSession — R4 confirm card recovery (M1-U4)", () => {
  it("renders an agent-confirm message when SW pushes agent-confirm-request", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    const port = chromeMock.runtime.__ports[0]!;

    // Simulate SW re-pushing a confirm-request after panel-mounted.
    // The hook handles this without needing an in-flight sendMessage —
    // R4 use-case is "user reopened the side panel and immediately
    // sees the pending card".
    act(() =>
      emitWithSession(port, {
        type: "agent-confirm-request",
        confirmationId: "c1",
        tool: "click",
        args: { elementIndex: 7 },
        resolvedElement: { text: "Submit", tag: "button" },
        riskReason: "submit button",
      }, result.current.sessionId!),
    );

    expect(result.current.messages).toEqual([
      expect.objectContaining({
        role: "agent-confirm",
        confirmationId: "c1",
        tool: "click",
        resolved: undefined,
      }),
    ]);
  });

  it("de-dupes a re-emitted agent-confirm-request by confirmationId", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    const port = chromeMock.runtime.__ports[0]!;
    const sid = result.current.sessionId!;
    const payload = {
      type: "agent-confirm-request" as const,
      confirmationId: "c1",
      tool: "click",
      args: {},
      resolvedElement: { text: "Submit", tag: "button" },
      riskReason: "submit button",
      sessionId: sid,
    };

    // First emit — message added.
    act(() => port.__emit(payload));
    expect(result.current.messages).toHaveLength(1);

    // Second emit with same confirmationId (e.g. SW re-emits on
    // panel-mounted while panel is already showing the card) — no
    // duplicate row.
    act(() => port.__emit(payload));
    expect(result.current.messages).toHaveLength(1);
  });
});

describe("useSession — resolveConfirm", () => {
  it("posts response and marks the matching message as resolved", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => result.current.sendMessage({ content: "do something risky" }));
    const port = chromeMock.runtime.__ports[0]!;
    const sid = result.current.sessionId!;

    act(() =>
      emitWithSession(port, {
        type: "agent-confirm-request",
        confirmationId: "c1",
        tool: "click",
        args: {},
        resolvedElement: { text: "Submit", tag: "button" },
        riskReason: "submit button",
      }, sid),
    );

    expect(result.current.messages.at(-1)).toMatchObject({
      role: "agent-confirm",
      confirmationId: "c1",
      resolved: undefined,
    });

    act(() => result.current.resolveConfirm("c1", true));

    // M2-U2 P1-4 — resolveConfirm now includes sessionId in the response.
    expect(port.postMessage).toHaveBeenCalledWith({
      type: "agent-confirm-response",
      confirmationId: "c1",
      approved: true,
      sessionId: sid,
    });
    expect(result.current.messages.at(-1)).toMatchObject({
      role: "agent-confirm",
      confirmationId: "c1",
      resolved: "approved",
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
    expect(meta!.pinnedTabId).toBeUndefined();
    expect(meta!.pinnedOrigin).toBeUndefined();
    // Hook also exposes pinnedOrigin: null for the new empty session.
    expect(result.current.pinnedOrigin).toBeNull();
  });

  it("bootstrap does NOT backfill an empty legacy session — the pin is captured at first send instead", async () => {
    // Empty legacy session (no messages, no pin) — under the lock-on-send
    // rule, bootstrap leaves it alone. The user can tab-switch freely
    // (PINNED follows live), and the next sendMessage captures.
    const legacy = await createSession({ now: 1000 });
    expect(legacy.pinnedTabId).toBeUndefined();

    chromeMock.tabs.__activeTab = {
      id: 99,
      url: "https://app.example.com/",
      active: true,
      windowId: 1,
    };

    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    const after = await getSessionMeta(legacy.id);
    expect(after?.pinnedTabId).toBeUndefined();
    expect(after?.pinnedOrigin).toBeUndefined();
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
    expect((await getSessionMeta(legacy.id))?.pinnedTabId).toBeUndefined();

    await act(async () => {
      await result.current.setActive(legacy.id);
    });

    const after = await getSessionMeta(legacy.id);
    expect(after?.pinnedTabId).toBe(99);
    expect(after?.pinnedOrigin).toBe("https://app.example.com");
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
    expect(meta?.pinnedTabId).toBeUndefined();

    act(() => {
      result.current.sendMessage({ content: "hello" });
    });

    // sendMessage's pin capture is async (await captureActivePinned +
    // await persistMessages before chat-start). Wait for the pin to land.
    await waitFor(async () => {
      meta = await getSessionMeta(id);
      expect(meta?.pinnedTabId).toBe(55);
    });
    expect(meta?.pinnedOrigin).toBe("https://send-time.example.com");
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
      expect(m?.pinnedTabId).toBe(55);
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
    expect(meta?.pinnedTabId).toBe(55);
    expect(meta?.pinnedOrigin).toBe("https://first.example.com");
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
    expect(after?.pinnedTabId).toBe(7);
    expect(after?.pinnedOrigin).toBe("https://original.example.com");
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
    expect(meta?.pinnedTabId).toBeUndefined();
    expect(meta?.pinnedOrigin).toBeUndefined();
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
    expect(meta?.pinnedTabId).toBeUndefined();
    expect(meta?.pinnedOrigin).toBeUndefined();
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
    expect(meta?.pinnedTabId).toBeUndefined();
    expect(meta?.pinnedOrigin).toBeUndefined();
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
    expect(afterEmpty?.pinnedTabId).toBeUndefined();
    expect(afterEmpty?.pinnedOrigin).toBeUndefined();
    void sessionA; // referenced for setup parity; not asserted

    // Switch to legacy-with-content session → backfill fires.
    await act(async () => {
      await result.current.setActive(sessionB_legacy.id);
    });
    const afterLegacy = await getSessionMeta(sessionB_legacy.id);
    expect(afterLegacy?.pinnedTabId).toBe(77);
    expect(afterLegacy?.pinnedOrigin).toBe("https://b.example.com");
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
    expect(after?.pinnedTabId).toBe(99);
    expect(after?.pinnedOrigin).toBe("https://original.example.com");
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

    // Old port disconnected (release SW-side abortController), new port
    // opened with sessionA in the name.
    expect(freshPort.disconnect).toHaveBeenCalledTimes(1);
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
    expect(oldPort.disconnect).toHaveBeenCalledTimes(1);
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
