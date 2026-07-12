import { render, screen, act, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { useBridgeStatus, type BridgeStatus } from "./bridge-status";

// Drive queryBridgeStatus's underlying SW round-trip by making the sendMessage
// mock invoke its callback with a controllable current status.
function mockBridge(getCurrent: () => BridgeStatus) {
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(((...args: unknown[]) => {
    const cb = args.find((a) => typeof a === "function") as
      | ((res: unknown) => void)
      | undefined;
    cb?.(getCurrent());
    return undefined;
  }) as typeof chrome.runtime.sendMessage);
}

function Probe() {
  const s = useBridgeStatus();
  return <div data-testid="ready">{s == null ? "null" : String(s.ready)}</div>;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useBridgeStatus", () => {
  it("reflects a bridge that connects after mount (polls, not one-shot)", () => {
    vi.useFakeTimers();
    let current: BridgeStatus = { hasPermission: true, ready: false };
    mockBridge(() => current);

    render(<Probe />);
    // Initial poll at mount: not yet ready.
    expect(screen.getByTestId("ready").textContent).toBe("false");

    // Bridge finishes its handshake while the panel stays open.
    current = { hasPermission: true, ready: true };
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByTestId("ready").textContent).toBe("true");
  });

  it("reflects a bridge that disconnects while the panel stays open", () => {
    vi.useFakeTimers();
    let current: BridgeStatus = { hasPermission: true, ready: true };
    mockBridge(() => current);

    render(<Probe />);
    expect(screen.getByTestId("ready").textContent).toBe("true");

    current = { hasPermission: true, ready: false };
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByTestId("ready").textContent).toBe("false");
  });

  it("stops polling after unmount", () => {
    vi.useFakeTimers();
    mockBridge(() => ({ hasPermission: true, ready: false }));

    const { unmount } = render(<Probe />);
    vi.mocked(chrome.runtime.sendMessage).mockClear();
    unmount();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
