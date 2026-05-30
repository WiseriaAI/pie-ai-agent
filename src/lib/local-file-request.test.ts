import { describe, it, expect, vi } from "vitest";
import {
  registerLocalFilePort,
  unregisterLocalFilePort,
  requestLocalFileFromPanel,
  handleLocalFileResponse,
} from "./local-file-request";

function fakePort() {
  return { postMessage: vi.fn() } as unknown as chrome.runtime.Port;
}

describe("local-file-request round-trip", () => {
  it("posts request-local-file and resolves on ok response", async () => {
    const sessionId = "s-ok";
    const port = fakePort();
    registerLocalFilePort(sessionId, port);

    const p = requestLocalFileFromPanel(sessionId);
    expect(port.postMessage).toHaveBeenCalledWith({
      type: "request-local-file",
      sessionId,
    });

    handleLocalFileResponse(sessionId, {
      ok: true,
      name: "a.md",
      mime: "text/markdown",
      text: "hi",
      truncated: false,
    });

    await expect(p).resolves.toEqual({
      name: "a.md",
      mime: "text/markdown",
      text: "hi",
      truncated: false,
    });
    unregisterLocalFilePort(sessionId);
  });

  it("rejects on ok:false with the given reason", async () => {
    const sessionId = "s-cancel";
    registerLocalFilePort(sessionId, fakePort());
    const p = requestLocalFileFromPanel(sessionId);
    handleLocalFileResponse(sessionId, { ok: false, reason: "cancelled by user" });
    await expect(p).rejects.toThrow("cancelled by user");
    unregisterLocalFilePort(sessionId);
  });

  it("unregisterLocalFilePort rejects a pending request", async () => {
    const sessionId = "s-close";
    registerLocalFilePort(sessionId, fakePort());
    const p = requestLocalFileFromPanel(sessionId);
    unregisterLocalFilePort(sessionId);
    await expect(p).rejects.toThrow(/panel closed/);
  });

  it("throws when no port is registered for the session", async () => {
    await expect(requestLocalFileFromPanel("no-such-session")).rejects.toThrow(
      /no sidepanel port for session/,
    );
  });

  it("rejects after the timeout and notifies the panel", async () => {
    vi.useFakeTimers();
    const port = fakePort();
    registerLocalFilePort("s-timeout", port);
    const p = requestLocalFileFromPanel("s-timeout");
    // Attach the rejection handler before advancing timers so the rejection
    // isn't flagged as unhandled when the timer fires synchronously.
    const assertion = expect(p).rejects.toThrow(/timed out/);
    vi.advanceTimersByTime(120_001);
    await assertion;
    expect(port.postMessage as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.objectContaining({ type: "local-file-timeout", sessionId: "s-timeout" }),
    );
    unregisterLocalFilePort("s-timeout");
    vi.useRealTimers();
  });
});
