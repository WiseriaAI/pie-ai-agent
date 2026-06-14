import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePanelRequest } from "./usePanelRequest";

function fakePort() {
  const listeners: Array<(m: unknown) => void> = [];
  const sent: any[] = [];
  return {
    sent,
    trigger: (m: unknown) => listeners.forEach((l) => l(m)),
    onMessage: {
      addListener: (l: (m: unknown) => void) => listeners.push(l),
      removeListener: () => {},
    },
    postMessage: (m: any) => sent.push(m),
  } as unknown as chrome.runtime.Port & { sent: any[]; trigger: (m: unknown) => void };
}

describe("usePanelRequest", () => {
  it("exposes the active request for this session and clears it on respond", () => {
    const port = fakePort();
    const { result } = renderHook(() => usePanelRequest(port, "S1"));
    expect(result.current.active).toBeNull();

    act(() => port.trigger({ type: "panel-request", sessionId: "S1", requestId: "r1", kind: "cdp-consent", payload: {} }));
    expect(result.current.active).toMatchObject({ requestId: "r1", kind: "cdp-consent" });

    act(() => result.current.respond("r1", { ok: true, data: true }));
    expect(result.current.active).toBeNull();
    expect(port.sent).toContainEqual({ type: "panel-response", sessionId: "S1", requestId: "r1", ok: true, data: true });
  });

  it("ignores requests for other sessions", () => {
    const port = fakePort();
    const { result } = renderHook(() => usePanelRequest(port, "S1"));
    act(() => port.trigger({ type: "panel-request", sessionId: "S2", requestId: "r9", kind: "cdp-consent", payload: {} }));
    expect(result.current.active).toBeNull();
  });

  it("clears the active card on timeout / resolved dismiss", () => {
    const port = fakePort();
    const { result } = renderHook(() => usePanelRequest(port, "S1"));
    act(() => port.trigger({ type: "panel-request", sessionId: "S1", requestId: "r1", kind: "cdp-consent", payload: {} }));
    act(() => port.trigger({ type: "panel-request-resolved", sessionId: "S1", requestId: "r1" }));
    expect(result.current.active).toBeNull();
  });
});
