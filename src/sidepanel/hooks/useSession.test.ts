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

  it("M1-U4 — opens the port and sends panel-mounted on bootstrap", async () => {
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    // Connect happens at mount, before any sendMessage.
    expect(chromeMock.runtime.connect).toHaveBeenCalledWith({
      name: "chat-stream",
    });
    expect(chromeMock.runtime.__ports).toHaveLength(1);

    // First message on the port is panel-mounted carrying sessionId.
    const port = chromeMock.runtime.__ports[0]!;
    expect(port.postMessage).toHaveBeenCalledWith({
      type: "panel-mounted",
      sessionId: result.current.sessionId,
    });
  });

  it("loads the most recently accessed session from a non-empty index", async () => {
    const older = await createSession({ now: 1000 });
    const newer = await createSession({ now: 2000 });
    // Seed messages on the newer session so we can assert they reload.
    await setSessionMeta({
      ...(await getSessionMeta(newer.id))!,
      messages: [{ role: "user", content: "previously typed" }],
    });

    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(result.current.sessionId).toBe(newer.id);
    expect(result.current.messages).toEqual([
      { role: "user", content: "previously typed" },
    ]);
    // Older session not selected.
    expect(result.current.sessionId).not.toBe(older.id);
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

    expect(chromeMock.runtime.connect).toHaveBeenCalledWith({
      name: "chat-stream",
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
    act(() => port.__emit({ type: "chat-chunk", text: "ok" }));
    act(() => port.__emit({ type: "chat-done" }));
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

    act(() => port.__emit({ type: "chat-chunk", text: "Hel" }));
    act(() => port.__emit({ type: "chat-chunk", text: "lo!" }));

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
    act(() => port.__emit({ type: "chat-chunk", text: "pong" }));
    act(() => port.__emit({ type: "chat-done" }));

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
    act(() => port.__emit({ type: "chat-chunk", text: "partial" }));
    act(() => port.__emit({ type: "chat-error", error: "rate limited" }));

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
    act(() =>
      port.__emit({
        type: "agent-done-task",
        success: true,
        summary: "Done.",
        stepCount: 3,
      }),
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
    act(() => port.__emit({ type: "chat-chunk", text: "halfway" }));
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
    act(() => port.__emit({ type: "chat-chunk", text: "Hel" }));
    act(() => port.__emit({ type: "chat-chunk", text: "lo" }));

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
    act(() => port.__emit({ type: "chat-chunk", text: "pong" }));
    act(() => port.__emit({ type: "chat-done" }));
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
      port.__emit({
        type: "agent-confirm-request",
        confirmationId: "c1",
        tool: "click",
        args: { elementIndex: 7 },
        resolvedElement: { text: "Submit", tag: "button" },
        riskReason: "submit button",
      }),
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
    const payload = {
      type: "agent-confirm-request" as const,
      confirmationId: "c1",
      tool: "click",
      args: {},
      resolvedElement: { text: "Submit", tag: "button" },
      riskReason: "submit button",
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

    act(() =>
      port.__emit({
        type: "agent-confirm-request",
        confirmationId: "c1",
        tool: "click",
        args: {},
        resolvedElement: { text: "Submit", tag: "button" },
        riskReason: "submit button",
      }),
    );

    expect(result.current.messages.at(-1)).toMatchObject({
      role: "agent-confirm",
      confirmationId: "c1",
      resolved: undefined,
    });

    act(() => result.current.resolveConfirm("c1", true));

    expect(port.postMessage).toHaveBeenCalledWith({
      type: "agent-confirm-response",
      confirmationId: "c1",
      approved: true,
    });
    expect(result.current.messages.at(-1)).toMatchObject({
      role: "agent-confirm",
      confirmationId: "c1",
      resolved: "approved",
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
