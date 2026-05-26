import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCdpOnboarding } from "./useCdpOnboarding";

interface MockPort {
  postMessage: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (m: unknown) => void) => void; removeListener: (fn: (m: unknown) => void) => void };
}

function mockPort(): { port: MockPort; trigger: (m: unknown) => void } {
  let listener: ((m: unknown) => void) | null = null;
  return {
    port: {
      postMessage: vi.fn(),
      onMessage: {
        addListener: (fn) => { listener = fn; },
        removeListener: () => { listener = null; },
      },
    },
    trigger: (m) => listener?.(m),
  };
}

describe("useCdpOnboarding", () => {
  it("returns pending=false initially", () => {
    const { port } = mockPort();
    const { result } = renderHook(() =>
      useCdpOnboarding(port as unknown as chrome.runtime.Port, "S1"),
    );
    expect(result.current.pending).toBe(false);
  });

  it("flips to pending=true on cdp-onboarding-request", () => {
    const { port, trigger } = mockPort();
    const { result } = renderHook(() =>
      useCdpOnboarding(port as unknown as chrome.runtime.Port, "S1"),
    );
    act(() => trigger({ type: "cdp-onboarding-request", sessionId: "S1" }));
    expect(result.current.pending).toBe(true);
  });

  it("answer(true) posts response and clears pending", () => {
    const { port, trigger } = mockPort();
    const { result } = renderHook(() =>
      useCdpOnboarding(port as unknown as chrome.runtime.Port, "S1"),
    );
    act(() => trigger({ type: "cdp-onboarding-request", sessionId: "S1" }));
    act(() => result.current.answer(true));
    expect(port.postMessage).toHaveBeenCalledWith({
      type: "cdp-onboarding-response",
      sessionId: "S1",
      enabled: true,
    });
    expect(result.current.pending).toBe(false);
  });

  it("ignores requests for a different sessionId", () => {
    const { port, trigger } = mockPort();
    const { result } = renderHook(() =>
      useCdpOnboarding(port as unknown as chrome.runtime.Port, "S1"),
    );
    act(() => trigger({ type: "cdp-onboarding-request", sessionId: "S2" }));
    expect(result.current.pending).toBe(false);
  });

  it("auto-clears pending on cdp-onboarding-resolved", () => {
    const { port, trigger } = mockPort();
    const { result } = renderHook(() =>
      useCdpOnboarding(port as unknown as chrome.runtime.Port, "S1"),
    );
    act(() => trigger({ type: "cdp-onboarding-request", sessionId: "S1" }));
    act(() => trigger({ type: "cdp-onboarding-resolved", sessionId: "S1", enabled: true }));
    expect(result.current.pending).toBe(false);
  });

  it("does nothing when port is null", () => {
    const { result } = renderHook(() => useCdpOnboarding(null, "S1"));
    expect(result.current.pending).toBe(false);
    // answer is callable but no-op
    expect(() => result.current.answer(true)).not.toThrow();
  });
});
