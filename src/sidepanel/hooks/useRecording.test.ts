import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { RecordedAction } from "@/lib/recording/types";

// 捕获 connect 注册的 onMessage，供测试 fire 广播。`vi.mock` 工厂在文件顶部
// 被提升，所以工厂内引用的绑定必须经 `vi.hoisted` 一起提升，否则触发 TDZ。
const { send, capturedRef } = vi.hoisted(() => ({
  send: vi.fn(() => true),
  capturedRef: { current: null as ((m: unknown) => void) | null },
}));
vi.mock("@/lib/sw-connection/manager", () => ({
  swPort: {
    connect: (_sid: string, h: { onMessage?: (m: unknown) => void }) => {
      capturedRef.current = h.onMessage ?? null;
      return () => { capturedRef.current = null; };
    },
    send,
  },
}));
// 测试体里仍用 `captured` 这个名字读最新订阅者。
const captured = (m: unknown) => capturedRef.current?.(m);

import { useRecording } from "./useRecording";

beforeEach(() => {
  send.mockClear();
  capturedRef.current = null;
});

describe("useRecording", () => {
  it("startRecording routes through swPort.send (survives a dead port)", () => {
    const { result } = renderHook(() => useRecording({ sessionId: "S1" }));
    act(() => result.current.startRecording());
    expect(send).toHaveBeenCalledWith("S1", { type: "recording-start", sessionId: "S1" });
  });

  it("recording-started broadcast flips active=true", () => {
    const { result } = renderHook(() => useRecording({ sessionId: "S1" }));
    act(() => captured({ type: "recording-started", sessionId: "S1", tabId: 1, origin: "x", startedAt: 0 }));
    expect(result.current.active).toBe(true);
  });

  it("recording-action-broadcast appends action", () => {
    const { result } = renderHook(() => useRecording({ sessionId: "S1" }));
    act(() => captured({ type: "recording-started", sessionId: "S1", tabId: 1, origin: "x", startedAt: 0 }));
    const action: RecordedAction = { type: "click", label: "X", url: "u", region: "main", timestamp: 1 };
    act(() => captured({ type: "recording-action-broadcast", sessionId: "S1", action }));
    expect(result.current.actions).toEqual([action]);
  });

  it("rejects messages from other sessionId", () => {
    const { result } = renderHook(() => useRecording({ sessionId: "S1" }));
    act(() => captured({ type: "recording-started", sessionId: "S2", tabId: 1, origin: "x", startedAt: 0 }));
    expect(result.current.active).toBe(false);
  });

  it("recording-finished surfaces serializedTrace + stepCount and resets", () => {
    const onFinished = vi.fn();
    const { result } = renderHook(() => useRecording({ sessionId: "S1", onFinished }));
    act(() => {
      captured({ type: "recording-started", sessionId: "S1", tabId: 1, origin: "x", startedAt: 0 });
      captured({ type: "recording-finished", sessionId: "S1", serializedTrace: "第 1 步：点击按钮 'X'", stepCount: 1 });
    });
    expect(result.current.active).toBe(false);
    expect(result.current.actions).toEqual([]);
    expect(onFinished).toHaveBeenCalledWith("第 1 步：点击按钮 'X'", 1);
  });

  it("recording-aborted resets state and exposes reason", () => {
    const { result } = renderHook(() => useRecording({ sessionId: "S1" }));
    act(() => {
      captured({ type: "recording-started", sessionId: "S1", tabId: 1, origin: "x", startedAt: 0 });
      captured({ type: "recording-aborted", sessionId: "S1", reason: "tab-closed" });
    });
    expect(result.current.active).toBe(false);
    expect(result.current.lastAbortReason).toBe("tab-closed");
  });

  it("session change while recording fires discard via swPort.send to the PREVIOUS session", () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) => useRecording({ sessionId }),
      { initialProps: { sessionId: "S1" } },
    );
    act(() => captured({ type: "recording-started", sessionId: "S1", tabId: 1, origin: "x", startedAt: 0 }));
    send.mockClear();
    rerender({ sessionId: "S2" });
    expect(send).toHaveBeenCalledWith("S1", { type: "recording-discard", sessionId: "S1" });
    expect(result.current.active).toBe(false);
  });

  it("finishRecording posts simple recording-finish", () => {
    const { result } = renderHook(() => useRecording({ sessionId: "S1" }));
    act(() => result.current.finishRecording());
    expect(send).toHaveBeenCalledWith("S1", { type: "recording-finish", sessionId: "S1" });
  });
});
