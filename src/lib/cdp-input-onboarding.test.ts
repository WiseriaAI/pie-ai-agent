import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerPanelPort, __resetPanelRequestState } from "./panel-request";
import { requestCdpInputConsent, onCdpInputEnabledChanged } from "./cdp-input-onboarding";

const setEnabled = vi.fn();
vi.mock("./cdp-input-enabled", () => ({
  setCdpInputEnabled: (...a: unknown[]) => setEnabled(...a),
}));

function fakePort() {
  const sent: any[] = [];
  return { sent, postMessage: (m: any) => sent.push(m) } as unknown as chrome.runtime.Port & { sent: any[] };
}

beforeEach(() => {
  __resetPanelRequestState();
  setEnabled.mockReset();
  setEnabled.mockResolvedValue(undefined);
});

describe("cdp-input-onboarding adapter", () => {
  it("persists the flag after the user grants via panel", async () => {
    const port = fakePort();
    registerPanelPort("S1", port);
    const p = requestCdpInputConsent("S1");
    // 模拟 panel 通过 handlePanelResponse 放行
    const { handlePanelResponse } = await import("./panel-request");
    handlePanelResponse(port.sent[0].requestId, { ok: true, data: true });
    await expect(p).resolves.toBe(true);
    expect(setEnabled).toHaveBeenCalledWith(true);
  });

  it("out-of-band: another session flipping the flag auto-resolves pending consent as true", async () => {
    const port = fakePort();
    registerPanelPort("S1", port);
    const p = requestCdpInputConsent("S1");
    onCdpInputEnabledChanged(true);
    await expect(p).resolves.toBe(true);
    // 卡片消失消息已发
    expect(port.sent.some((m) => m.type === "panel-request-resolved")).toBe(true);
    // resolve 续作仍持久化 flag（幂等）
    expect(setEnabled).toHaveBeenCalledWith(true);
  });

  it("onCdpInputEnabledChanged ignores non-true states", async () => {
    const port = fakePort();
    registerPanelPort("S1", port);
    const p = requestCdpInputConsent("S1");
    onCdpInputEnabledChanged(false);
    // 仍 pending；用一个真实响应收尾避免悬挂
    const { handlePanelResponse } = await import("./panel-request");
    handlePanelResponse(port.sent[0].requestId, { ok: true, data: false });
    await expect(p).resolves.toBe(false);
  });
});
