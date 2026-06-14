import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerPanelPort,
  unregisterPanelPort,
  requestFromPanel,
  handlePanelResponse,
  resolvePendingByKind,
  __resetPanelRequestState,
} from "./panel-request";

function fakePort() {
  const sent: any[] = [];
  return {
    sent,
    postMessage: (m: any) => sent.push(m),
  } as unknown as chrome.runtime.Port & { sent: any[] };
}

beforeEach(() => __resetPanelRequestState());

describe("panel-request", () => {
  it("throws when no port is registered for the session", async () => {
    await expect(
      requestFromPanel("S1", "cdp-consent", {}),
    ).rejects.toThrow(/no sidepanel port/i);
  });

  it("posts a panel-request with a requestId and resolves on matching response", async () => {
    const port = fakePort();
    registerPanelPort("S1", port);
    const p = requestFromPanel<"cdp-consent">("S1", "cdp-consent", {});
    expect(port.sent).toHaveLength(1);
    const msg = port.sent[0];
    expect(msg.type).toBe("panel-request");
    expect(msg.kind).toBe("cdp-consent");
    expect(typeof msg.requestId).toBe("string");
    handlePanelResponse(msg.requestId, { ok: true, data: true });
    await expect(p).resolves.toBe(true);
  });

  it("isolates two concurrent requests by requestId (no cross-talk)", async () => {
    const port = fakePort();
    registerPanelPort("S1", port);
    const a = requestFromPanel<"cdp-consent">("S1", "cdp-consent", {});
    const b = requestFromPanel<"local-file">("S1", "local-file", {});
    const [idA, idB] = port.sent.map((m) => m.requestId);
    expect(idA).not.toBe(idB);
    handlePanelResponse(idB, { ok: true, data: { name: "f", mime: "text/plain", text: "x", truncated: false } });
    handlePanelResponse(idA, { ok: true, data: false });
    await expect(a).resolves.toBe(false);
    await expect(b).resolves.toMatchObject({ name: "f" });
  });

  it("rejects all pending for a session when the panel port unregisters", async () => {
    const port = fakePort();
    registerPanelPort("S1", port);
    const p = requestFromPanel<"cdp-consent">("S1", "cdp-consent", {});
    unregisterPanelPort("S1");
    await expect(p).rejects.toThrow(/panel closed/i);
  });

  it("rejects on timeout and posts a timeout dismiss", async () => {
    vi.useFakeTimers();
    const port = fakePort();
    registerPanelPort("S1", port);
    const p = requestFromPanel<"local-file">("S1", "local-file", {}, { timeoutMs: 1000 });
    const reqId = port.sent[0].requestId;
    const assertion = expect(p).rejects.toThrow(/timed out/i);
    vi.advanceTimersByTime(1001);
    await assertion;
    expect(port.sent.some((m) => m.type === "panel-request-timeout" && m.requestId === reqId)).toBe(true);
    vi.useRealTimers();
  });

  it("resolvePendingByKind resolves all pending of that kind and posts a resolved dismiss", async () => {
    const p1 = fakePort();
    const p2 = fakePort();
    registerPanelPort("S1", p1);
    registerPanelPort("S2", p2);
    const a = requestFromPanel<"cdp-consent">("S1", "cdp-consent", {});
    const b = requestFromPanel<"cdp-consent">("S2", "cdp-consent", {});
    resolvePendingByKind("cdp-consent", true);
    await expect(a).resolves.toBe(true);
    await expect(b).resolves.toBe(true);
    expect(p1.sent.some((m) => m.type === "panel-request-resolved")).toBe(true);
    expect(p2.sent.some((m) => m.type === "panel-request-resolved")).toBe(true);
  });

  it("rejects when panel responds with ok: false", async () => {
    const port = fakePort();
    registerPanelPort("S1", port);
    const p = requestFromPanel<"cdp-consent">("S1", "cdp-consent", {});
    handlePanelResponse(port.sent[0].requestId, { ok: false, reason: "user cancelled" });
    await expect(p).rejects.toThrow("user cancelled");
  });

  it("ignores a response for an unknown requestId", () => {
    expect(() => handlePanelResponse("nope", { ok: true, data: true })).not.toThrow();
  });
});
