import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// SW 连接服务 cutover：hook 改吃 sessionId（不再吃 port），订阅经 swPort.connect、
// 回复经 swPort.send。测试 mock swPort：捕获 connect 注册的 onMessage 供 fire，
// 记录 send 的回复 payload。`vi.mock` 工厂被提升 → 引用绑定走 vi.hoisted。
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
const trigger = (m: unknown) => capturedRef.current?.(m);

import { usePanelRequest } from "./usePanelRequest";

beforeEach(() => {
  send.mockClear();
  capturedRef.current = null;
});

describe("usePanelRequest", () => {
  it("exposes the active request for this session and clears it on respond", () => {
    const { result } = renderHook(() => usePanelRequest("S1"));
    expect(result.current.active).toBeNull();

    act(() => trigger({ type: "panel-request", sessionId: "S1", requestId: "r1", kind: "cdp-consent", payload: {} }));
    expect(result.current.active).toMatchObject({ requestId: "r1", kind: "cdp-consent" });

    act(() => result.current.respond("r1", { ok: true, data: true }));
    expect(result.current.active).toBeNull();
    expect(send).toHaveBeenCalledWith("S1", { type: "panel-response", sessionId: "S1", requestId: "r1", ok: true, data: true });
  });

  it("ignores requests for other sessions", () => {
    const { result } = renderHook(() => usePanelRequest("S1"));
    act(() => trigger({ type: "panel-request", sessionId: "S2", requestId: "r9", kind: "cdp-consent", payload: {} }));
    expect(result.current.active).toBeNull();
  });

  it("clears the active card on timeout / resolved dismiss", () => {
    const { result } = renderHook(() => usePanelRequest("S1"));
    act(() => trigger({ type: "panel-request", sessionId: "S1", requestId: "r1", kind: "cdp-consent", payload: {} }));
    act(() => trigger({ type: "panel-request-resolved", sessionId: "S1", requestId: "r1" }));
    expect(result.current.active).toBeNull();
  });
});
