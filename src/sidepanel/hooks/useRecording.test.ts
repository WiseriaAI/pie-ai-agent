import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRecording } from "./useRecording";
import type { RecordedAction } from "@/lib/recording/types";

interface FakePort {
  postMessage: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (m: unknown) => void) => void; removeListener: (fn: (m: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  fire: (m: unknown) => void;
}

function fakePort(): FakePort {
  let listener: ((m: unknown) => void) | null = null;
  return {
    postMessage: vi.fn(),
    onMessage: {
      addListener: (fn) => { listener = fn; },
      removeListener: (fn) => { if (listener === fn) listener = null; },
    },
    onDisconnect: { addListener: () => {} },
    fire: (m) => listener?.(m),
  };
}

describe("useRecording", () => {
  it("starts inactive", () => {
    const port = fakePort();
    const { result } = renderHook(() => useRecording({ port: port as unknown as chrome.runtime.Port, sessionId: "S1" }));
    expect(result.current.active).toBe(false);
    expect(result.current.actions).toEqual([]);
  });

  it("startRecording posts recording-start", () => {
    const port = fakePort();
    const { result } = renderHook(() => useRecording({ port: port as unknown as chrome.runtime.Port, sessionId: "S1" }));
    act(() => result.current.startRecording());
    expect(port.postMessage).toHaveBeenCalledWith({ type: "recording-start", sessionId: "S1" });
  });

  it("recording-started broadcast flips active=true", () => {
    const port = fakePort();
    const { result } = renderHook(() => useRecording({ port: port as unknown as chrome.runtime.Port, sessionId: "S1" }));
    act(() => {
      port.fire({ type: "recording-started", sessionId: "S1", tabId: 1, origin: "https://x.com", startedAt: 0 });
    });
    expect(result.current.active).toBe(true);
  });

  it("recording-action-broadcast appends action", () => {
    const port = fakePort();
    const { result } = renderHook(() => useRecording({ port: port as unknown as chrome.runtime.Port, sessionId: "S1" }));
    act(() => {
      port.fire({ type: "recording-started", sessionId: "S1", tabId: 1, origin: "https://x.com", startedAt: 0 });
    });
    const action: RecordedAction = { type: "click", label: "X", url: "u", region: "main", timestamp: 1 };
    act(() => {
      port.fire({ type: "recording-action-broadcast", sessionId: "S1", action });
    });
    expect(result.current.actions).toEqual([action]);
  });

  it("rejects messages from other sessionId", () => {
    const port = fakePort();
    const { result } = renderHook(() => useRecording({ port: port as unknown as chrome.runtime.Port, sessionId: "S1" }));
    act(() => {
      port.fire({ type: "recording-started", sessionId: "S2", tabId: 1, origin: "https://x.com", startedAt: 0 });
    });
    expect(result.current.active).toBe(false);
  });

  it("recording-finished resets state and surfaces serializedTrace + stepCount (Reframe)", () => {
    const port = fakePort();
    const onFinished = vi.fn();
    const { result } = renderHook(() => useRecording({ port: port as unknown as chrome.runtime.Port, sessionId: "S1", onFinished }));
    act(() => {
      port.fire({ type: "recording-started", sessionId: "S1", tabId: 1, origin: "https://x.com", startedAt: 0 });
      port.fire({
        type: "recording-finished",
        sessionId: "S1",
        serializedTrace: "第 1 步：点击按钮 'X'",
        stepCount: 1,
      });
    });
    expect(result.current.active).toBe(false);
    expect(result.current.actions).toEqual([]);
    expect(onFinished).toHaveBeenCalledWith("第 1 步：点击按钮 'X'", 1);
  });

  it("recording-aborted resets state and exposes reason", () => {
    const port = fakePort();
    const { result } = renderHook(() => useRecording({ port: port as unknown as chrome.runtime.Port, sessionId: "S1" }));
    act(() => {
      port.fire({ type: "recording-started", sessionId: "S1", tabId: 1, origin: "https://x.com", startedAt: 0 });
      port.fire({ type: "recording-aborted", sessionId: "S1", reason: "tab-closed" });
    });
    expect(result.current.active).toBe(false);
    expect(result.current.lastAbortReason).toBe("tab-closed");
  });

  it("session change while recording fires discard automatically", () => {
    const port = fakePort();
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useRecording({ port: port as unknown as chrome.runtime.Port, sessionId }),
      { initialProps: { sessionId: "S1" } },
    );
    act(() => {
      port.fire({ type: "recording-started", sessionId: "S1", tabId: 1, origin: "https://x.com", startedAt: 0 });
    });
    port.postMessage.mockClear();
    rerender({ sessionId: "S2" });
    expect(port.postMessage).toHaveBeenCalledWith({ type: "recording-discard", sessionId: "S1" });
    expect(result.current.active).toBe(false);
  });

  it("finishRecording posts simple recording-finish (Reframe — no payload)", () => {
    const port = fakePort();
    const { result } = renderHook(() => useRecording({ port: port as unknown as chrome.runtime.Port, sessionId: "S1" }));
    act(() => {
      port.fire({ type: "recording-started", sessionId: "S1", tabId: 1, origin: "https://x.com", startedAt: 0 });
    });
    const action: RecordedAction = { type: "click", label: "X", url: "u", region: "main", timestamp: 1 };
    act(() => {
      port.fire({ type: "recording-action-broadcast", sessionId: "S1", action });
    });
    act(() => result.current.finishRecording());
    // Reframe: SW is now the source of truth for actions; finish carries only sessionId.
    expect(port.postMessage).toHaveBeenCalledWith({ type: "recording-finish", sessionId: "S1" });
  });
});
